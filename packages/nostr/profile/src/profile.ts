import { isValidEventStructure, type NostrEvent } from "dacci-nostr-nips";

/** NIP-01 kind 0 metadata, parsed from the JSON content. */
export interface Profile {
  pubkey: string;
  /** When the metadata was published, for a joined date. */
  createdAt?: number;
  name?: string;
  displayName?: string;
  about?: string;
  picture?: string;
  nip05?: string;
  banner?: string;
}

export interface ProfileQuery {
  /** Resolve one batch. Returns whatever the relays could provide. */
  (authors: string[]): Promise<NostrEvent[]>;
}

export interface ProfileStoreOptions {
  /** Delay before a queued batch goes out, to coalesce bursts. */
  flushDelayMs?: number;
  /** Max pubkeys per REQ, to stay under relay filter limits. */
  batchSize?: number;
  baseRetryMs?: number;
  maxRetryMs?: number;
  maxAttempts?: number;
  /** Called whenever the cache changes, so views can re-render. */
  onChange?: () => void;
}

type Entry =
  | { status: "loaded"; profile: Profile }
  | { status: "loading" }
  | { status: "failed"; attempts: number; retryAt: number };

const HEX64 = /^[0-9a-f]{64}$/;

export function parseProfile(event: NostrEvent): Profile | null {
  if (event.kind !== 0 || !HEX64.test(event.pubkey)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(event.content);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const meta = raw as Record<string, unknown>;
  const text = (key: string): string | undefined =>
    typeof meta[key] === "string" && (meta[key] as string).length > 0
      ? (meta[key] as string)
      : undefined;
  return {
    pubkey: event.pubkey,
    createdAt: event.created_at,
    name: text("name"),
    displayName: text("display_name"),
    about: text("about"),
    picture: text("picture"),
    nip05: text("nip05"),
    banner: text("banner"),
  };
}

/** Name to show: display_name wins over name, then nip05. */
export function profileLabel(profile: Profile | null): string | null {
  if (profile === null) return null;
  return profile.displayName ?? profile.name ?? profile.nip05 ?? null;
}

/**
 * Resolves NIP-01 metadata for pubkeys, with the properties the feed needs:
 * never ask twice for a user that is already loaded or in flight, and push
 * failures onto a retry queue that is retried in batches with backoff.
 */
export class ProfileStore {
  private readonly entries = new Map<string, Entry>();
  private readonly queued = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private inFlight = false;

  private readonly flushDelayMs: number;
  private readonly batchSize: number;
  private readonly baseRetryMs: number;
  private readonly maxRetryMs: number;
  private readonly maxAttempts: number;
  private readonly onChange: (() => void) | undefined;

  constructor(
    private readonly query: ProfileQuery,
    options: ProfileStoreOptions = {},
  ) {
    this.flushDelayMs = options.flushDelayMs ?? 60;
    this.batchSize = options.batchSize ?? 50;
    this.baseRetryMs = options.baseRetryMs ?? 3000;
    this.maxRetryMs = options.maxRetryMs ?? 60000;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.onChange = options.onChange;
  }

  private notify(): void {
    this.onChange?.();
  }

  /** Loaded profile, or null while it is missing, loading or failed. */
  peek(pubkey: string): Profile | null {
    const entry = this.entries.get(pubkey);
    return entry !== undefined && entry.status === "loaded"
      ? entry.profile
      : null;
  }

  isLoading(pubkey: string): boolean {
    return this.entries.get(pubkey)?.status === "loading";
  }

  /**
   * Queues unknown or failed users. Loaded and in-flight users are ignored,
   * so a feed that renders the same author 50 times still costs one query.
   */
  request(pubkeys: Iterable<string>): void {
    let added = false;
    for (const pubkey of pubkeys) {
      if (!HEX64.test(pubkey)) continue;
      const entry = this.entries.get(pubkey);
      if (entry !== undefined && entry.status !== "failed") continue;
      if (entry !== undefined && entry.status === "failed") {
        if (entry.attempts >= this.maxAttempts) continue;
        if (entry.retryAt > Date.now()) continue;
      }
      if (this.queued.has(pubkey)) continue;
      this.queued.add(pubkey);
      this.entries.set(pubkey, { status: "loading" });
      added = true;
    }
    if (added) {
      this.notify();
      this.scheduleFlush();
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.flushDelayMs);
  }

  private async flush(): Promise<void> {
    if (this.inFlight || this.queued.size === 0) return;
    this.inFlight = true;
    try {
      while (this.queued.size > 0) {
        const batch = [...this.queued].slice(0, this.batchSize);
        for (const pubkey of batch) this.queued.delete(pubkey);
        await this.resolveBatch(batch);
      }
    } finally {
      this.inFlight = false;
      this.notify();
    }
  }

  private async resolveBatch(authors: string[]): Promise<void> {
    let events: NostrEvent[] = [];
    try {
      events = (await this.query(authors)).filter((event) =>
        isValidEventStructure(event),
      );
    } catch {
      events = [];
    }

    // Replaceable event: the newest metadata per pubkey wins.
    const newest = new Map<string, NostrEvent>();
    for (const event of events) {
      const current = newest.get(event.pubkey);
      if (
        current === undefined ||
        event.created_at > current.created_at ||
        (event.created_at === current.created_at && event.id < current.id)
      ) {
        newest.set(event.pubkey, event);
      }
    }

    for (const pubkey of authors) {
      const event = newest.get(pubkey);
      const profile = event === undefined ? null : parseProfile(event);
      if (profile !== null) {
        this.entries.set(pubkey, { status: "loaded", profile });
        continue;
      }
      const previous = this.entries.get(pubkey);
      const attempts =
        previous !== undefined && previous.status === "failed"
          ? previous.attempts + 1
          : 1;
      if (attempts > this.maxAttempts) {
        // Give up; request() will not resurrect it on its own.
        this.entries.set(pubkey, {
          status: "failed",
          attempts,
          retryAt: Number.POSITIVE_INFINITY,
        });
        continue;
      }
      const delay = Math.min(this.baseRetryMs * 2 ** (attempts - 1), this.maxRetryMs);
      this.entries.set(pubkey, {
        status: "failed",
        attempts,
        retryAt: Date.now() + delay,
      });
      this.scheduleRetry(pubkey, delay);
    }
  }

  /**
   * Puts a failed user back on the queue once its backoff expires. The
   * retry goes through the queue, so a relay that keeps failing is not
   * hammered and the whole batch is re-resolved together.
   */
  private scheduleRetry(pubkey: string, delay: number): void {
    const timer = setTimeout(() => {
      this.retryTimers.delete(pubkey);
      const entry = this.entries.get(pubkey);
      if (entry === undefined || entry.status !== "failed") return;
      if (entry.attempts > this.maxAttempts) return;
      this.queued.add(pubkey);
      this.scheduleFlush();
    }, delay);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.retryTimers.set(pubkey, timer);
  }

  /** Drops everything, e.g. after a relay set change. */
  clear(): void {
    this.entries.clear();
    this.queued.clear();
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

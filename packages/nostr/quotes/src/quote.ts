import {
  hasValidId,
  isHex64,
  isValidEventStructure,
  type NostrEvent,
} from "dacci-nostr-nips";

/**
 * NIP-18 embeds: a repost points at the note it reposts with an `e` tag and a
 * quote repost adds `q`, so every post may show the note it embeds. Resolving
 * those ids one at a time costs a request per card, so they are batched into
 * a single `ids` filter, the same way profile metadata is batched by author.
 */
export interface EmbedQuery {
  /** Resolve one batch of ids. Returns whatever the relays could provide. */
  (ids: string[]): Promise<NostrEvent[]>;
}

export interface EmbedStoreOptions {
  /** Delay before a queued batch goes out, to coalesce bursts. */
  flushDelayMs?: number;
  /** Max ids per REQ. Relays commonly cap a filter, so batches stay small. */
  batchSize?: number;
  baseRetryMs?: number;
  maxRetryMs?: number;
  maxAttempts?: number;
  /** Called whenever the cache changes, so views can re-render. */
  onChange?: () => void;
}

type Entry =
  | { status: "loaded"; event: NostrEvent }
  | { status: "loading" }
  | { status: "failed"; attempts: number; retryAt: number };

/**
 * Resolves embedded notes by id, with the properties a feed needs: a post
 * that quotes the same note 50 times costs one query, and a note no relay
 * has does not block the posts around it.
 */
export class EmbedStore {
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
    private readonly query: EmbedQuery,
    options: EmbedStoreOptions = {},
  ) {
    this.flushDelayMs = options.flushDelayMs ?? 60;
    this.batchSize = options.batchSize ?? 50;
    this.baseRetryMs = options.baseRetryMs ?? 3000;
    this.maxRetryMs = options.maxRetryMs ?? 60000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.onChange = options.onChange;
  }

  private notify(): void {
    this.onChange?.();
  }

  /** The embedded note, or null while it is missing, loading or failed. */
  peek(id: string): NostrEvent | null {
    const entry = this.entries.get(id);
    return entry !== undefined && entry.status === "loaded"
      ? entry.event
      : null;
  }

  isLoading(id: string): boolean {
    return this.entries.get(id)?.status === "loading";
  }

  /**
   * Queues unknown ids. Loaded and in-flight ids are ignored, and failures
   * are retried with backoff, so a relay that lacks the note is not hammered.
   */
  request(ids: Iterable<string>): void {
    let added = false;
    for (const id of ids) {
      if (!isHex64(id)) continue;
      const entry = this.entries.get(id);
      if (entry !== undefined && entry.status !== "failed") continue;
      if (entry !== undefined && entry.status === "failed") {
        if (entry.attempts >= this.maxAttempts) continue;
        if (entry.retryAt > Date.now()) continue;
      }
      if (this.queued.has(id)) continue;
      this.queued.add(id);
      this.entries.set(id, { status: "loading" });
      added = true;
    }
    if (added) {
      this.notify();
      this.scheduleFlush();
    }
  }

  /**
   * Seeds a note that is already known, so no query is made for it. A view
   * that is waiting on this id renders only after the change is announced.
   */
  put(event: NostrEvent): void {
    const entry = this.entries.get(event.id);
    if (entry !== undefined && entry.status === "loaded") return;
    this.entries.set(event.id, { status: "loaded", event });
    this.notify();
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
        for (const id of batch) this.queued.delete(id);
        await this.resolveBatch(batch);
      }
    } finally {
      this.inFlight = false;
      this.notify();
    }
  }

  private async resolveBatch(ids: string[]): Promise<void> {
    let events: NostrEvent[] = [];
    try {
      events = (await this.query(ids)).filter(
        (event) =>
          // Structure first, then identity: a relay returning the requested id
          // with rewritten content matches the lookup below, so the check that
          // the id is the hash of the fields is the attribution itself. The id
          // check is one sha256 (~5µs); the signature is not verified here, as
          // on the relay path, for the same cost reason.
          isValidEventStructure(event) && hasValidId(event),
      );
    } catch {
      events = [];
    }

    const found = new Map<string, NostrEvent>();
    for (const event of events) found.set(event.id, event);

    for (const id of ids) {
      const event = found.get(id);
      if (event !== undefined) {
        this.entries.set(id, { status: "loaded", event });
        continue;
      }
      const previous = this.entries.get(id);
      // A note that arrived while the request was out is known, whatever the
      // relay says. Overwriting it with a failure is what made an embed vanish:
      // the reader was already looking at that note elsewhere on the feed, so it
      // was seeded, and a relay that no longer had it (NIP-09, retention) took it
      // back out of the card that quoted it.
      if (previous !== undefined && previous.status === "loaded") continue;
      const attempts =
        previous !== undefined && previous.status === "failed"
          ? previous.attempts + 1
          : 1;
      if (attempts > this.maxAttempts) {
        // Give up. A post whose note nobody has shows a placeholder instead
        // of a spinner, and request() will not resurrect it on its own.
        this.entries.set(id, {
          status: "failed",
          attempts,
          retryAt: Number.POSITIVE_INFINITY,
        });
        continue;
      }
      const delay = Math.min(
        this.baseRetryMs * 2 ** (attempts - 1),
        this.maxRetryMs,
      );
      this.entries.set(id, {
        status: "failed",
        attempts,
        retryAt: Date.now() + delay,
      });
      this.scheduleRetry(id, delay);
    }
  }

  /**
   * Puts a failed id back on the queue once its backoff expires, through the
   * same batch path so a slow relay is not hammered.
   */
  private scheduleRetry(id: string, delay: number): void {
    const timer = setTimeout(() => {
      this.retryTimers.delete(id);
      const entry = this.entries.get(id);
      if (entry === undefined || entry.status !== "failed") return;
      if (entry.attempts > this.maxAttempts) return;
      this.queued.add(id);
      this.scheduleFlush();
    }, delay);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.retryTimers.set(id, timer);
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

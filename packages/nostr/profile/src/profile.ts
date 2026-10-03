import {
  emojisIn,
  hasValidId,
  isValidEventStructure,
  type Emoji,
  type NostrEvent,
} from "dacci-nostr-nips";

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
  /**
   * The whole published object, not only the fields above.
   *
   * NIP-01 replaces the entire profile with each event, so a client that
   * republished only the fields it knows would delete everything else the
   * author had. The unknown keys have to travel with the known ones.
   */
  metadata: Record<string, unknown>;
  /**
   * The NIP-30 shortcodes this profile defines, which NIP-30 says its `name`
   * and `about` are written with.
   */
  emojis: Emoji[];
}

export interface ProfileQuery {
  /**
   * Resolve one batch, and **throw when not one relay answered**.
   *
   * An empty array therefore means "asked, and there is nothing", which is the
   * only answer that lets the store record an author as having no profile. A
   * thrown error means the question is still open, and the store must not
   * answer it with a guess.
   */
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
  /**
   * How long one batch may take before it counts as failed. Past every
   * production timeout on purpose: this is the backstop, not the budget.
   */
  batchTimeoutMs?: number;
  /** Called whenever the cache changes, so views can re-render. */
  onChange?: () => void;
}

/**
 * What the store knows about one author.
 *
 * `absent` and `failed` are different answers and must not be merged. "Asked
 * and there is no profile" is a fact about the author; "the lookup never came
 * back" is an absence of information, and anything that writes has to be able
 * to tell them apart. Treating the second as the first turns a failed read into
 * an empty profile, and publishing that empties the reader's real one.
 */
type Entry =
  | { status: "loaded"; profile: Profile }
  | { status: "absent" }
  | { status: "loading"; attempts: number }
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
  // A JSON array is an object as far as `typeof` is concerned, and it parses. A
  // profile that is `[1,2,3]` is not a profile: carrying it through would spread
  // its indices into the next save, publishing `{"0":1,"1":2,…}` as the author's
  // metadata. The same guard is in `metadata.ts` and `nip11.ts`; this one was
  // missing.
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
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
    // The whole object travels with the parsed fields, so republishing the
    // profile keeps whatever else the author put in it.
    metadata: meta,
    // NIP-30 puts the shortcodes for `name` and `about` on the profile itself.
    emojis: emojisIn(event),
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

/**
 * A batch that never comes back must not park the store. Every production
 * query settles on its own — relay timeouts at each layer — but the store
 * cannot prove that about the function it was handed, and one stuck promise
 * held `inFlight` forever: every later author queued and never resolved for
 * the rest of the session. Past the deadline the batch fails like any other
 * failure, which the retry below already knows how to handle.
 */
function withBatchTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("batch timed out")), ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

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
  private readonly batchTimeoutMs: number;
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
    this.batchTimeoutMs = options.batchTimeoutMs ?? 15000;
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

  /**
   * Puts an event this client published into the cache.
   *
   * `request()` ignores an author it already has, which is right for a stranger
   * and wrong for the reader's own profile: the profile they just published is
   * the newest one there is, and the header has to show it at once rather than
   * after a reload.
   */
  put(event: NostrEvent): void {
    const profile = parseProfile(event);
    if (profile === null) return;
    this.entries.set(profile.pubkey, { status: "loaded", profile });
    this.notify();
  }

  isLoading(pubkey: string): boolean {
    return this.entries.get(pubkey)?.status === "loading";
  }

  /**
   * Whether an author's profile is known: found, or asked for and found not to
   * exist.
   *
   * This is the difference between "this person has no profile" and "this
   * person's profile has not arrived yet", and the two must not be confused by
   * anything that writes: publishing a profile built on a lookup that never
   * answered would replace a real profile with an empty one. A failed lookup is
   * therefore **not** resolved.
   */
  resolved(pubkey: string): boolean {
    const status = this.entries.get(pubkey)?.status;
    return status === "loaded" || status === "absent";
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
      // The count of attempts so far travels with the entry. Dropping it here
      // reset the counter to zero on every caller-driven retry, so `maxAttempts`
      // was a number nothing could reach: a view that re-requested on a timer
      // asked forever, and the author was never resolved and never given up on.
      this.entries.set(pubkey, {
        status: "loading",
        attempts: entry !== undefined && entry.status === "failed" ? entry.attempts : 0,
      });
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
    let events: NostrEvent[] | null = null;
    try {
      events = (await withBatchTimeout(this.query(authors), this.batchTimeoutMs)).filter(
        (event) =>
          // Same attribution rule as the quote store: the id must be the hash
          // of the fields, or a relay can put attacker words under anyone's
          // name and avatar. Signature verification stays on the paths that
          // act on the profile, for the same cost reason as elsewhere.
          isValidEventStructure(event) && hasValidId(event),
      );
    } catch {
      // The batch was not answered. Everything in it stays unknown, so the
      // authors keep their old state and are queued again below.
      events = null;
    }

    if (events !== null) {
      // Replaceable event: the newest metadata per pubkey wins. Only kind 0
      // competes: a relay answering extra kinds for the author — a newer kind
      // 1 beside the real kind 0 — used to win the recency race, and the
      // profile that was right there went down the `failOnce` retry path
      // instead of loading.
      const newest = new Map<string, NostrEvent>();
      for (const event of events) {
        if (event.kind !== 0) continue;
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
        if (event === undefined) {
          // Asked and answered: this author has no profile. That is an answer,
          // not a gap, so it is recorded as one and never re-asked.
          this.entries.set(pubkey, { status: "absent" });
          continue;
        }
        const profile = parseProfile(event);
        if (profile === null) {
          // Answered, with something that is not a profile. Recording that as
          // "no profile" resolves the author with nothing to show — and
          // `resolved` is exactly what lets the editor write, so the next save
          // would replace a real profile the app merely failed to read. Kept as a
          // question instead, which is the direction that cannot destroy anything.
          this.failOnce(pubkey);
          continue;
        }
        this.entries.set(pubkey, { status: "loaded", profile });
      }
      return;
    }

    for (const pubkey of authors) {
      const previous = this.entries.get(pubkey);
      // A resolved author keeps its answer: a quiet relay must not turn
      // "this person has no profile" back into a question.
      // Only a settled author keeps its answer. A queued retry is `failed`, not
      // `loading`, and skipping it here is what made the retry queue retry once
      // and then go quiet: the attempt was never counted, no timer was armed,
      // and the author stayed unresolved for the rest of the session.
      if (
        previous !== undefined &&
        (previous.status === "loaded" || previous.status === "absent")
      ) {
        continue;
      }
      this.failOnce(pubkey);
    }
  }

  /** Records one unanswered attempt for an author and queues the retry. */
  private failOnce(pubkey: string): void {
    const previous = this.entries.get(pubkey);
    // Every unresolved state carries its count, so this is one more than however
    // many have already been tried. A settled author is never failed, so the
    // loaded and absent states cannot reach here.
    const attempts =
      previous !== undefined && "attempts" in previous ? previous.attempts + 1 : 1;
    if (attempts > this.maxAttempts) {
      // Give up; request() will not resurrect it on its own.
      this.entries.set(pubkey, {
        status: "failed",
        attempts,
        retryAt: Number.POSITIVE_INFINITY,
      });
      return;
    }
    const delay = Math.min(this.baseRetryMs * 2 ** (attempts - 1), this.maxRetryMs);
    this.entries.set(pubkey, { status: "failed", attempts, retryAt: Date.now() + delay });
    this.scheduleRetry(pubkey, delay);
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

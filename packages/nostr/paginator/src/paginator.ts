import {
  compareEvents,
  type Filter,
  type NostrEvent,
} from "dacci-nostr-nips";
import type { RelayConnection } from "dacci-nostr-ws";

export type PageCoverage = "complete" | "partial";

/** Sentinel for "the relay did not answer within the round deadline". */
const TIMEOUT = Symbol("relay-timeout");
/**
 * Extra time the backstop waits past the transport's own deadline, so the
 * transport's answer — including whatever events reached it in time — is the
 * one that is used.
 */
const TIMEOUT_MARGIN_MS = 250;

export interface TimelinePage {
  events: NostrEvent[];
  coverage: PageCoverage;
  pendingRelays: string[];
  /** URLs of relays waiting for NIP-42 auth. UI should prompt for login. */
  authRequiredRelays: string[];
}

export interface PaginatorOptions {
  pageSize?: number;
  baseLimit?: number;
  maxLimit?: number;
  maxRounds?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  queryTimeoutMs?: number;
  /**
   * Per-relay deadline for one page round. A relay that misses it is marked
   * offline for this round so the page can render without it; its cursor is
   * untouched, so nothing is skipped when it is retried.
   */
  roundTimeoutMs?: number;
}

interface RelayCursor {
  until: number;
  limit: number;
  seenAtBoundary: Set<string>;
  noProgressRounds: number;
}

interface RelayState {
  url: string;
  connection: RelayConnection;
  cursor: RelayCursor;
  exhausted: boolean;
  offline: boolean;
  needsSplit: boolean;
  /** Relay demands NIP-42 auth. Excluded until a signer is configured. */
  needsAuth: boolean;
  failCount: number;
  nextRetryAt: number;
}

interface RelayBatch {
  relay: string;
  events: NostrEvent[];
  eose: boolean;
  failed: boolean;
  receivedCount: number;
  queriedUntil: number;
  queriedLimit: number;
  oldestTimestamp?: number;
  authRequired: boolean;
}

/**
 * Multi-relay timeline paginator with independent per-relay cursors,
 * boundary re-fetch with limit expansion, global watermark commit,
 * and per-page coverage reporting.
 */
export class TimelinePaginator {
  private readonly relays = new Map<string, RelayState>();
  private readonly events = new Map<string, NostrEvent>();
  private readonly displayed = new Set<string>();
  private loading = false;

  private readonly pageSize: number;
  private readonly baseLimit: number;
  private readonly maxLimit: number;
  private readonly maxRounds: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly queryTimeoutMs: number;
  private readonly roundTimeoutMs: number;
  private readonly nowMs: () => number;

  constructor(
    connections: RelayConnection[],
    private readonly baseFilter: Omit<Filter, "until" | "limit">,
    options: PaginatorOptions = {},
    nowMs: () => number = Date.now,
  ) {
    this.pageSize = options.pageSize ?? 100;
    this.baseLimit = options.baseLimit ?? 100;
    this.maxLimit = options.maxLimit ?? 500;
    this.maxRounds = options.maxRounds ?? 10;
    this.baseBackoffMs = options.baseBackoffMs ?? 1000;
    this.maxBackoffMs = options.maxBackoffMs ?? 30000;
    this.queryTimeoutMs = options.queryTimeoutMs ?? 10000;
    this.roundTimeoutMs = options.roundTimeoutMs ?? 3500;
    this.nowMs = nowMs;
    const now = Math.floor(this.nowMs() / 1000);
    for (const connection of connections) {
      this.relays.set(connection.url, {
        url: connection.url,
        connection,
        cursor: {
          until: now,
          limit: this.baseLimit,
          seenAtBoundary: new Set(),
          noProgressRounds: 0,
        },
        exhausted: false,
        offline: false,
        needsSplit: false,
        needsAuth: false,
        failCount: 0,
        nextRetryAt: 0,
      });
    }
  }

  async loadNextPage(): Promise<TimelinePage> {
    if (this.loading) {
      return {
        events: [],
        coverage: this.coverage(),
        pendingRelays: this.pendingRelays(),
        authRequiredRelays: this.authRequiredRelays(),
      };
    }
    this.loading = true;
    try {
      let rounds = 0;
      while (this.countCommittable() < this.pageSize && rounds < this.maxRounds) {
        const active = this.getActiveRelays();
        if (active.length === 0) break;
        const results = await Promise.allSettled(
          active.map((state) => this.fetchRelay(state)),
        );
        for (const result of results) {
          if (result.status !== "fulfilled") continue;
          this.merge(result.value);
          this.updateCursor(result.value);
        }
        rounds++;
      }
      return this.buildPage();
    } finally {
      this.loading = false;
    }
  }

  hasMore(): boolean {
    return (
      [...this.relays.values()].some((r) => !r.exhausted) ||
      this.countCommittable() > 0
    );
  }

  reset(): void {
    const now = Math.floor(this.nowMs() / 1000);
    for (const state of this.relays.values()) {
      state.cursor = {
        until: now,
        limit: this.baseLimit,
        seenAtBoundary: new Set(),
        noProgressRounds: 0,
      };
      state.exhausted = false;
      state.offline = false;
      state.needsSplit = false;
      state.needsAuth = false;
      state.failCount = 0;
      state.nextRetryAt = 0;
    }
    this.events.clear();
    this.displayed.clear();
  }

  private getActiveRelays(): RelayState[] {
    const now = this.nowMs();
    for (const state of this.relays.values()) {
      // A relay parked for auth becomes usable as soon as a signer exists,
      // which is exactly what happens when the session is restored after a
      // reload. NIP-42 is per connection, so the retry can answer it.
      if (state.needsAuth && state.connection.hasSigner) {
        state.needsAuth = false;
      }
    }
    return [...this.relays.values()].filter(
      (r) =>
        !r.exhausted &&
        !r.needsSplit &&
        !r.needsAuth &&
        (!r.offline || now >= r.nextRetryAt),
    );
  }

  private async fetchRelay(state: RelayState): Promise<RelayBatch> {
    const queriedUntil = state.cursor.until;
    const queriedLimit = state.cursor.limit;
    const timeoutMs = Math.min(this.roundTimeoutMs, this.queryTimeoutMs);
    let guardTimer: ReturnType<typeof setTimeout> | undefined;
    // The deadline is enforced here rather than trusted to the transport:
    // a relay that accepts the socket and then goes quiet must not hold the
    // whole page hostage. It is marked offline for this round (Section 23)
    // and retried later; its cursor is untouched, so nothing is skipped.
    const result = await Promise.race([
      state.connection.query(
        { ...this.baseFilter, until: queriedUntil, limit: queriedLimit },
        timeoutMs,
      ),
      // A backstop for a transport that fails to honour its own deadline, and
      // only that. It gets a margin because the transport is the only thing
      // that knows which events made it before the deadline expired, and racing
      // it to the same instant would throw those away whenever this timer
      // happened to be scheduled first.
      new Promise<typeof TIMEOUT>((resolve) => {
        const timer = setTimeout(
          () => resolve(TIMEOUT),
          timeoutMs + TIMEOUT_MARGIN_MS,
        );
        guardTimer = timer;
        // Do not keep the process alive for the deadline.
        (timer as unknown as { unref?: () => void }).unref?.();
      }),
    ]).catch(() => ({
      events: [],
      eose: false,
      failed: true,
      authRequired: false,
    }));
    if (guardTimer !== undefined) clearTimeout(guardTimer);
    if (result === TIMEOUT) {
      return {
        relay: state.url,
        events: [],
        eose: false,
        failed: true,
        receivedCount: 0,
        queriedUntil,
        queriedLimit,
        authRequired: false,
      };
    }
    let oldestTimestamp: number | undefined;
    for (const event of result.events) {
      if (oldestTimestamp === undefined || event.created_at < oldestTimestamp) {
        oldestTimestamp = event.created_at;
      }
    }
    return {
      relay: state.url,
      events: result.events,
      eose: result.eose,
      failed: result.failed || !result.eose,
      receivedCount: result.events.length,
      queriedUntil,
      queriedLimit,
      oldestTimestamp,
      authRequired: result.authRequired,
    };
  }

  private merge(batch: RelayBatch): void {
    // A batch that failed is not a batch to throw away. The transport keeps the
    // events that arrived before the deadline and hands them over precisely so
    // they survive, and each one passed the same checks as any other: a relay
    // that streamed a page and then went quiet has still sent real events, and
    // dropping them means a relay a little under load contributes nothing, ever.
    // The cursor is left alone by `updateCursor`, so the range is asked again and
    // nothing is skipped.
    for (const event of batch.events) {
      this.events.set(event.id, event);
    }
  }

  private updateCursor(batch: RelayBatch): void {
    const state = this.relays.get(batch.relay);
    if (!state || state.exhausted) return;
    const cursor = state.cursor;

    if (batch.failed) {
      if (batch.authRequired) {
        if (state.connection.hasSigner) {
          // The signer is attached, so the challenge was answered late (for
          // example right after a reload). Retry on the next round instead
          // of backing off: AUTH is per connection, not a transport fault.
          state.offline = false;
          state.nextRetryAt = 0;
          return;
        }
        // NIP-42 gate: retrying without a signer spins forever, so park
        // the relay until credentials exist. Cursor unchanged.
        state.needsAuth = true;
        return;
      }
      state.offline = true;
      state.failCount += 1;
      state.nextRetryAt =
        this.nowMs() +
        Math.min(
          this.baseBackoffMs * 2 ** (state.failCount - 1),
          this.maxBackoffMs,
        );
      return;
    }
    state.offline = false;
    state.failCount = 0;
    state.nextRetryAt = 0;

    if (batch.receivedCount === 0) {
      // Nothing came back, so there is nothing older to ask for.
      state.exhausted = true;
      return;
    }
    const oldest = batch.oldestTimestamp ?? batch.queriedUntil;
    if (oldest < batch.queriedUntil) {
      // Older ground was covered, so there may be more below it. This is what
      // keeps a capped relay's history reachable: NIP-01 lets a relay limit what
      // it will serve, so a relay whose `max_limit` is under the request answers
      // with fewer events than asked on every single round. Reading the page
      // length alone ended its history on the first round, left the cursor at
      // the top, and had `coverage` report "complete" while everything older
      // than that first page was unreachable.
      cursor.until = oldest;
      cursor.limit = this.baseLimit;
      cursor.seenAtBoundary = new Set();
      cursor.noProgressRounds = 0;
      return;
    }
    if (batch.receivedCount < batch.queriedLimit) {
      // Less than was asked for, and nothing older came back with it: the relay
      // gave everything it had. Both halves matter. A short page on its own
      // only means the relay has a cap, while no progress on its own is the
      // same-second burst below, which is answered by asking again.
      state.exhausted = true;
      return;
    }
    let progressed = false;
    for (const event of batch.events) {
      if (event.created_at !== cursor.until) continue;
      if (!cursor.seenAtBoundary.has(event.id)) {
        cursor.seenAtBoundary.add(event.id);
        progressed = true;
      }
    }
    if (progressed) {
      cursor.noProgressRounds = 0;
      return;
    }
    cursor.limit = Math.min(cursor.limit * 2, this.maxLimit);
    cursor.noProgressRounds += 1;
    if (cursor.limit >= this.maxLimit && cursor.noProgressRounds >= 2) {
      state.needsSplit = true;
    }
  }

  private globalWatermark(): number {
    // Only relays that actually took part in this pass can raise the bar.
    // An exhausted, offline or auth-gated relay would otherwise pin the
    // watermark at "now" and commit nothing, which is the opposite of what
    // Section 13 wants. With no blocking relay left, everything gathered is
    // committable; coverage is reported as partial whenever that happens.
    const blocking = [...this.relays.values()].filter(
      (r) => !r.exhausted && !r.needsSplit && !r.needsAuth && !r.offline,
    );
    if (blocking.length === 0) return -Infinity;
    return Math.min(...blocking.map((r) => r.cursor.until));
  }

  private countCommittable(): number {
    const watermark = this.globalWatermark();
    let count = 0;
    for (const event of this.events.values()) {
      if (!this.displayed.has(event.id) && event.created_at > watermark) {
        count++;
      }
    }
    return count;
  }

  private buildPage(): TimelinePage {
    const watermark = this.globalWatermark();
    const events = [...this.events.values()]
      .filter((event) => event.created_at > watermark)
      .sort(compareEvents)
      .filter((event) => !this.displayed.has(event.id))
      .slice(0, this.pageSize);
    for (const event of events) {
      this.displayed.add(event.id);
    }
    return {
      events,
      coverage: this.coverage(),
      pendingRelays: this.pendingRelays(),
      authRequiredRelays: this.authRequiredRelays(),
    };
  }

  private coverage(): PageCoverage {
    return [...this.relays.values()].every((r) => r.exhausted)
      ? "complete"
      : "partial";
  }

  private pendingRelays(): string[] {
    return [...this.relays.values()]
      .filter((r) => !r.exhausted)
      .map((r) => r.url);
  }

  private authRequiredRelays(): string[] {
    return [...this.relays.values()]
      .filter((r) => r.needsAuth)
      .map((r) => r.url);
  }
}

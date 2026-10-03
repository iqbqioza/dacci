import type { Filter } from "dacci-nostr-nips";
import type { NostrEvent } from "dacci-nostr-nips";
import { encodeNpub } from "dacci-nostr-nips";
import { RelayConnection } from "dacci-nostr-ws";
import { TimelinePaginator } from "dacci-nostr-paginator";

const connections = new Map<string, RelayConnection>();

export function getConnection(url: string): RelayConnection {
  let conn = connections.get(url);
  if (conn === undefined) {
    conn = new RelayConnection(url);
    connections.set(url, conn);
  }
  return conn;
}

export function eachConnection(run: (conn: RelayConnection) => void): void {
  for (const conn of connections.values()) run(conn);
}

/**
 * Closes and drops pooled connections the set no longer names.
 *
 * Removing a relay left its socket open: nothing ever closed it, so the dead
 * relay held a connection until the tab did. Closing answers whatever is
 * still waiting on it rather than stranding it, and deleting it from the pool
 * means the next use dials fresh instead of reusing a closed socket.
 */
export function pruneConnections(urls: string[]): void {
  const keep = new Set(urls);
  for (const [url, conn] of connections) {
    if (keep.has(url)) continue;
    conn.close();
    connections.delete(url);
  }
}

export type TimelineFilter = Omit<Filter, "until" | "limit">;

export function createTimeline(
  relayUrls: string[],
  filter: TimelineFilter,
  /** Injection seam for tests; production always uses the shared pool. */
  connections?: RelayConnection[],
): TimelinePaginator {
  return new TimelinePaginator(
    relayUrls.map((url, index) => connections?.[index] ?? getConnection(url)),
    filter,
    {
      pageSize: 30,
      baseLimit: 100,
      maxLimit: 500,
      roundTimeoutMs: 2500,
    },
  );
}

/** Kinds a home feed shows: text notes and NIP-22 comments. */
export const HOME_KINDS = [1, 1111];

/**
 * Kinds a profile shows: text notes and NIP-22 comments.
 *
 * Shared with the profile's live stream on purpose. The two read the same
 * timeline, and a kind the paginator asks for but the stream does not is one
 * that can never arrive: the paginator's `until` only ever moves backwards, so
 * a comment published after it was built has exactly one route in, and filtering
 * it out here left the "Replies and notes" tab short of it until a full reset.
 */
export const PROFILE_KINDS = [1, 1111];

/**
 * Home feed: own posts when signed in, otherwise the global firehose. Notes
 * and NIP-22 comments come in one query because the tabs need both and no
 * relay can filter "has no e tag".
 */
export function createHomeTimeline(
  relayUrls: string[],
  authors?: string[],
): TimelinePaginator {
  return createTimeline(
    relayUrls,
    authors === undefined ? { kinds: HOME_KINDS } : { kinds: HOME_KINDS, authors },
  );
}

/**
 * Everything addressed to one pubkey: mentions and replies (kind 1, NIP-27
 * `#p` tag), long-form replies (kind 1111, NIP-22, which carry the same `p`
 * tag for the person being replied to), reposts (kind 6, NIP-18 `p` tag) and
 * reactions (kind 7, NIP-25 `p` tag).
 *
 * 1111 is here because an answer under the reader's own reply is addressed to
 * them as much as an answer under a post is, and leaving it out would make that
 * the one notification they never see.
 *
 * Limitation: a repost that omits the `p` tag is not addressable and cannot
 * be discovered by any filter, so it is out of reach by protocol design.
 */
export const NOTIFICATION_KINDS = [1, 6, 7, 1111];

/**
 * Client-side guard: relays only answer what they indexed, so the merged
 * result is filtered again. Self-authored events are never notifications.
 */
export function isNotification(event: NostrEvent, pubkey: string): boolean {
  if (event.pubkey === pubkey) return false;
  return (
    NOTIFICATION_KINDS.includes(event.kind) &&
    event.tags.some((tag) => tag[0] === "p" && tag[1] === pubkey)
  );
}

export function createNotificationTimeline(
  relayUrls: string[],
  pubkey: string,
  connections?: RelayConnection[],
): TimelinePaginator {
  return createTimeline(
    relayUrls,
    { kinds: NOTIFICATION_KINDS, "#p": [pubkey] },
    connections,
  );
}

export function shortId(id: string): string {
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

/**
 * A pubkey shortened in the form a post would have written it, so a name that
 * cannot be resolved still reads as the same person everywhere else. A pubkey
 * that will not encode falls back to the hex, which says the same thing.
 */
export function shortNpub(pubkey: string): string {
  const npub = encodeNpub(pubkey);
  if (npub === null) return shortId(pubkey);
  return `${npub.slice(0, 11)}…${npub.slice(-4)}`;
}

/**
 * Shown instead of a time that cannot be a time.
 *
 * NIP-01 puts no upper bound on `created_at` and a relay will serve whatever it
 * was sent, so a post can arrive dated beyond the year 275,760 — past what a
 * JavaScript `Date` can hold at all. `toLocaleString` answers that with the
 * literal string "Invalid Date", which is not a time and not an explanation, so
 * it is caught here instead.
 */
export const UNKNOWN_TIME = "—";

export function formatTime(createdAt: number): string {
  const date = new Date(createdAt * 1000);
  if (!Number.isFinite(date.getTime())) return UNKNOWN_TIME;
  return date.toLocaleString("ja-JP");
}

/** The same guard for a registration date, which comes off a profile. */
export function formatDate(seconds: number): string {
  const date = new Date(seconds * 1000);
  if (!Number.isFinite(date.getTime())) return UNKNOWN_TIME;
  return date.toLocaleDateString("ja-JP");
}

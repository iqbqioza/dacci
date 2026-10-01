import type { Filter } from "dacci-nostr-nips";
import type { NostrEvent } from "dacci-nostr-nips";
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
 * `#p` tag), reposts (kind 6, NIP-18 `p` tag) and reactions (kind 7, NIP-25
 * `p` tag).
 *
 * Limitation: a repost that omits the `p` tag is not addressable and cannot
 * be discovered by any filter, so it is out of reach by protocol design.
 */
export const NOTIFICATION_KINDS = [1, 6, 7];

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

export function formatTime(createdAt: number): string {
  return new Date(createdAt * 1000).toLocaleString("ja-JP");
}

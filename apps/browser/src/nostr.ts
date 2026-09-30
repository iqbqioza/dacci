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

export function createTimeline(
  relayUrls: string[],
  authors?: string[],
): TimelinePaginator {
  return new TimelinePaginator(
    relayUrls.map(getConnection),
    authors === undefined ? { kinds: [1] } : { kinds: [1], authors },
    { pageSize: 30, baseLimit: 100, maxLimit: 500, roundTimeoutMs: 2500 },
  );
}

export function shortId(id: string): string {
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

export function formatTime(createdAt: number): string {
  return new Date(createdAt * 1000).toLocaleString("ja-JP");
}

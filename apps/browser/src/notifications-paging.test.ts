import { isHex64, type Filter, type NostrEvent } from "dacci-nostr-nips";
import { RelayConnection } from "dacci-nostr-ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearEventCache } from "./event-cache.js";

const SELF = "1".repeat(64);
const OTHER = "2".repeat(64);

/** One notification addressed to the reader, a second older than the first. */
function notification(at: number, index: number): NostrEvent {
  const base = {
    pubkey: OTHER,
    created_at: at,
    kind: 1,
    tags: [["p", SELF]],
    content: `n${index}`,
  };
  // A real id: 64 hex characters that follow from the index. The obvious
  // `\`${index}\`.repeat(64)` is 128 characters for every index past 9, so a
  // fixture of a hundred notifications was ninety of them the shape no relay
  // could ever serve — and the dedupe being tested was being tested over events
  // the transport would have rejected.
  return { ...base, id: noteId(index), sig: "s".repeat(128) };
}

/**
 * 64 hex characters for a notification, from its index.
 *
 * 16 per digit keeps every id the same length whatever the index, which is the
 * property the old fixture lost: a repeating index is 64 characters for one digit
 * and 128 for two.
 */
function noteId(index: number): string {
  return index.toString(16).padStart(16, "0").repeat(4).slice(0, 64);
}

const tick = (ms = 0): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const queries: Filter[] = [];
/** A relay holding enough history that one page cannot cover it. */
let store: NostrEvent[] = [];

beforeEach(() => {
  queries.length = 0;
  store = [];
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  clearEventCache();
  vi.doUnmock("./nostr.js");
  vi.doUnmock("./relays.js");
});

/**
 * The notification store with only the transport stubbed out. The module is
 * imported fresh so its module-level signals start empty, as on a page load.
 *
 * The real `createNotificationTimeline` closes over the real `getConnection`,
 * so stubbing that alone would leave the feed dialling a live relay. The
 * factory is replaced instead, and it builds a genuine `TimelinePaginator` —
 * the paging under test is the real one.
 */
async function withStore(): Promise<typeof import("./notifications-feed.js")> {
  vi.resetModules();
  const { TimelinePaginator } = await import("dacci-nostr-paginator");
  vi.doMock("./relays.js", () => ({
    useRelays: () => ({ readRelays: () => ["wss://read.example"] }),
  }));
  vi.doMock("./nostr.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./nostr.js")>();
    return {
      ...actual,
      createNotificationTimeline: (urls: string[], pubkey: string) =>
        new TimelinePaginator(
          urls.map((url) => {
            const conn = new RelayConnection(url, () => {
              throw new Error("no socket in unit test");
            });
            vi.spyOn(conn, "query").mockImplementation(async (filter) => {
              queries.push(filter);
              // A relay answers newest first, up to the limit it was asked for.
              const until = filter.until ?? Number.MAX_SAFE_INTEGER;
              const matched = store
                .filter((e) => e.created_at <= until)
                .sort((a, b) => b.created_at - a.created_at)
                .slice(0, filter.limit ?? 100);
              return {
                events: matched,
                failed: false,
                eose: true,
                authRequired: false,
              };
            });
            return conn;
          }),
          { kinds: actual.NOTIFICATION_KINDS, "#p": [pubkey] },
          { pageSize: 30, baseLimit: 100, maxLimit: 500, roundTimeoutMs: 2500 },
        ),
    };
  });
  return import("./notifications-feed.js");
}

describe("notifications paging", () => {
  it("walks back through history instead of asking for page one again", async () => {
    // 150 notifications, one per second, older ones further back. One page is
    // capped at 30, so reaching the end must take several rounds.
    store = Array.from({ length: 150 }, (_, i) => notification(2000 - i, i));

    const store_ = await withStore();
    store_.ensureNotifications(SELF);
    await tick(5);
    expect(store_.useNotifications().events().length).toBe(30);

    for (let round = 0; round < 10 && store_.useNotifications().hasMore(); round += 1) {
      store_.loadMoreNotifications();
      await tick(5);
    }

    // Every notification in the store is reachable, and the reader is told the
    // history is finished instead of being offered a button that leads nowhere.
    expect(store_.useNotifications().events().length).toBe(150);
    expect(store_.useNotifications().hasMore()).toBe(false);
    // The walk really went back in time: a second round asked for events older
    // than the newest page. A fresh paginator every time would ask for the same
    // newest page again and the list would stop growing.
    expect(queries.length).toBeGreaterThan(1);
    const bounds = queries.map((q) => q.until ?? Number.MAX_SAFE_INTEGER);
    expect(bounds.slice(1).every((until, i) => until < bounds[i]!)).toBe(true);
  });

  it("never shows the same notification twice", async () => {
    store = Array.from({ length: 150 }, (_, i) => notification(2000 - i, i));
    const store_ = await withStore();
    store_.ensureNotifications(SELF);
    await tick(5);
    for (let round = 0; round < 10 && store_.useNotifications().hasMore(); round += 1) {
      store_.loadMoreNotifications();
      await tick(5);
    }
    const ids = store_.useNotifications().events().map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(150);
  });
});

describe("the fixtures these tests page through", () => {
  it("are events the transport could actually have delivered", () => {
    // A relay serves 64 hex characters, and `relay.ts` rejects anything else
    // before an event reaches a store. A fixture that does not is not a smaller
    // case of the same thing — it is a case the real code never sees, so a test
    // paging through it is not paging through anything the app would show.
    const many = Array.from({ length: 200 }, (_, i) => notification(1000 + i, i));
    expect(many.length).toBe(200);
    for (const event of many) {
      expect(isHex64(event.id), `id is ${event.id.length} characters`).toBe(
        true,
      );
    }
    // Distinct, or the dedupe being tested would be testing nothing.
    expect(new Set(many.map((e) => e.id)).size).toBe(200);
  });
});

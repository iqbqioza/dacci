import type { NostrEvent } from "dacci-nostr-nips";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearEventCache } from "./event-cache.js";
import { directReplies, replyParent } from "./replies.js";

function post(
  id: string,
  tags: string[][] = [],
  kind = 1,
  createdAt = 1000,
): NostrEvent {
  return {
    id,
    pubkey: "a".repeat(64),
    created_at: createdAt,
    kind,
    tags,
    content: "x",
    sig: "s".repeat(128),
  };
}

const POST = "1".repeat(64);
const REPLY = "2".repeat(64);
const DEEPER = "3".repeat(64);

const tick = (ms = 0): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const queries: Array<Record<string, unknown>> = [];
let answerWith: NostrEvent[] = [];

beforeEach(() => {
  queries.length = 0;
  answerWith = [];
});

afterEach(() => {
  clearEventCache();
  vi.doUnmock("./nostr.js");
  vi.doUnmock("./relays.js");
});

/**
 * Loads the store with the relay layer stubbed out. The module is imported
 * fresh per test so its module-level signals start empty, exactly as they do
 * on a page load.
 */
async function withStore(
  answer?: { failed: boolean; events?: NostrEvent[] },
): Promise<typeof import("./replies-feed.js")> {
  vi.resetModules();
  vi.doMock("./relays.js", () => ({
    useRelays: () => ({ readRelays: () => ["wss://read.example"] }),
  }));
  vi.doMock("./nostr.js", () => ({
    getConnection: (url: string) => ({
      url,
      query: async (filter: Record<string, unknown>) => {
        queries.push(filter);
        return {
          events: answer?.events ?? answerWith,
          failed: answer?.failed ?? false,
        };
      },
    }),
  }));
  return import("./replies-feed.js");
}

/** A promise the test settles by hand, so a round can be held open. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("replies feed", () => {
  it("asks again when no relay answered, instead of settling on 'no replies'", async () => {
    // Nobody answering is not the same as nobody having any. Settling it here
    // left the id in `asked`, so the thread read "no replies" for the rest of
    // the session with nothing left to fetch it back — while the relays were
    // merely quiet or refusing.
    const store = await withStore({ failed: true });
    await store.loadReplies(POST);
    const view = store.useReplies(POST);
    expect(view.searched()).toBe(false);
    expect(view.events()).toEqual([]);
    // Asking again is allowed, and a relay that now answers settles it.
    const healthy = await withStore({
      failed: false,
      events: [post(REPLY, [["e", POST, "", "reply", "x"]], 1, 100)],
    });
    await healthy.loadReplies(POST);
    expect(healthy.useReplies(POST).searched()).toBe(true);
    expect(healthy.useReplies(POST).events()).toHaveLength(1);
  });

  it("treats a relay that refused as silence, not as an empty thread", async () => {
    // One relay refusing says nothing about the post. Reading it as an answer
    // would tell the reader a post nobody replied to that simply had not been
    // served.
    vi.resetModules();
    vi.doMock("./relays.js", () => ({
      useRelays: () => ({ readRelays: () => ["wss://a", "wss://b"] }),
    }));
    vi.doMock("./nostr.js", () => ({
      getConnection: (url: string) => ({
        url,
        query: async () =>
          url === "wss://a"
            ? { events: [], failed: true }
            : { events: [], failed: false },
      }),
    }));
    const store = await import("./replies-feed.js");
    await store.loadReplies(POST);
    // One relay did answer, with nothing — so this really is a post with no
    // answers, and the thread can say so.
    expect(store.useReplies(POST).searched()).toBe(true);
  });

  it("throws away an answer that lands after the relay set was dropped", async () => {
    const gate = deferred<{ events: NostrEvent[]; failed: boolean }>();
    vi.resetModules();
    vi.doMock("./relays.js", () => ({
      useRelays: () => ({ readRelays: () => ["wss://read.example"] }),
    }));
    vi.doMock("./nostr.js", () => ({
      getConnection: () => ({ url: "wss://read.example", query: () => gate.promise }),
    }));
    const store = await import("./replies-feed.js");

    const round = store.loadReplies(POST);
    await tick();
    // The reader changes their relays while the round is still out.
    store.resetReplies();
    gate.resolve({
      events: [post(REPLY, [["e", POST, "", "reply", "x"]], 1, 100)],
      failed: false,
    });
    await round;

    // The answer was fetched from a relay that is no longer being read, so it
    // does not appear in the fresh thread.
    expect(store.useReplies(POST).events()).toEqual([]);
    expect(store.useReplies(POST).searched()).toBe(false);
  });

  it("asks for both kinds and the post's own id", async () => {
    const store = await withStore();
    await store.loadReplies(POST);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toEqual({ kinds: [1, 1111], "#e": [POST] });
  });

  it("keeps only the direct answers, oldest first", async () => {
    const store = await withStore();
    answerWith = [
      post(DEEPER, [
        ["e", POST, "", "root", "x"],
        ["e", REPLY, "", "reply", "x"],
      ], 1, 300),
      post(REPLY, [["e", POST, "", "reply", "x"]], 1, 100),
    ];
    await store.loadReplies(POST);
    const events = store.useReplies(POST).events();
    expect(events.map((e) => e.id)).toEqual([REPLY]);
  });

  it("shows a NIP-22 comment alongside a NIP-10 reply", async () => {
    const store = await withStore();
    const comment = post(
      "4".repeat(64),
      [
        ["E", POST, "", "x"],
        ["K", "1"],
        ["e", POST, "", "x"],
        ["k", "1"],
      ],
      1111,
      200,
    );
    answerWith = [post(REPLY, [["e", POST, "", "reply", "x"]], 1, 100), comment];
    await store.loadReplies(POST);
    expect(store.useReplies(POST).events().map((e) => e.id)).toEqual([
      REPLY,
      comment.id,
    ]);
  });

  it("never asks about the same post twice", async () => {
    const store = await withStore();
    await store.loadReplies(POST);
    await store.loadReplies(POST);
    await tick();
    expect(queries).toHaveLength(1);
  });

  it("keeps each post's answers to itself", async () => {
    const store = await withStore();
    await store.loadReplies(POST);
    const other = "5".repeat(64);
    answerWith = [post(REPLY, [["e", other, "", "reply", "x"]])];
    await store.loadReplies(other);
    expect(store.useReplies(POST).events()).toHaveLength(0);
    expect(store.useReplies(other).events().map((e) => e.id)).toEqual([REPLY]);
  });

  it("reports a post with no answers as searched", async () => {
    const store = await withStore();
    await store.loadReplies(POST);
    const state = store.useReplies(POST);
    expect(state.events()).toEqual([]);
    expect(state.loading()).toBe(false);
    expect(state.searched()).toBe(true);
  });

  it("ignores an empty post id", async () => {
    const store = await withStore();
    await store.loadReplies("");
    expect(queries).toHaveLength(0);
  });

  it("forgets everything on a reset, so a relay change can be re-queried", async () => {
    const store = await withStore();
    answerWith = [post(REPLY, [["e", POST, "", "reply", "x"]])];
    await store.loadReplies(POST);
    expect(store.useReplies(POST).events()).toHaveLength(1);
    store.resetReplies();
    expect(store.useReplies(POST).events()).toEqual([]);
    expect(store.useReplies(POST).searched()).toBe(false);
    await store.loadReplies(POST);
    expect(queries).toHaveLength(2);
  });

  it("shows a reply the reader just wrote without asking a relay", async () => {
    const store = await withStore();
    const mine = post(REPLY, [["e", POST, "", "reply", "x"]], 1, 500);
    store.addReply(mine);
    expect(store.useReplies(POST).events().map((e) => e.id)).toEqual([REPLY]);
    // Nothing was asked, so the list is not waiting on a relay.
    expect(queries).toHaveLength(0);
    expect(store.useReplies(POST).searched()).toBe(true);
  });

  it("keeps a written reply in conversation order", async () => {
    const store = await withStore();
    answerWith = [post("5".repeat(64), [["e", POST, "", "reply", "x"]], 1, 100)];
    await store.loadReplies(POST);
    // Written after the one already there, so it belongs at the end.
    store.addReply(post(REPLY, [["e", POST, "", "reply", "x"]], 1, 900));
    const ids = store.useReplies(POST).events().map((e) => e.id);
    expect(ids).toEqual(["5".repeat(64), REPLY]);
  });

  it("ignores a post that answers nothing", async () => {
    const store = await withStore();
    store.addReply(post(REPLY));
    expect(store.useReplies(REPLY).events()).toEqual([]);
  });
});

describe("directReplies on the store's own output", () => {
  it("agrees with the classifier the store used", () => {
    const reply = post(REPLY, [["e", POST, "", "reply", "x"]]);
    expect(replyParent(reply)).toBe(POST);
    expect(directReplies([reply], POST)).toHaveLength(1);
  });
});


describe("a thread's own state", () => {
  const OTHER_POST = "9".repeat(64);

  it("does not carry one thread's answer over to a post never asked about", async () => {
    // The two flags were one value for the whole app, so they read as if they
    // described the thread on screen and did not. One thread resolved, and every
    // post after it claimed to have been searched — so a post nobody had ever
    // queried rendered "this post has no replies yet", a conclusion stated
    // about a post the client had not asked a single relay about.
    const store = await withStore({ failed: false, events: [] });
    await store.loadReplies(POST);
    expect(store.useReplies(POST).searched()).toBe(true);

    // A different post, never asked about: nothing is known about it yet.
    const other = store.useReplies(OTHER_POST);
    expect(other.searched()).toBe(false);
    expect(other.loading()).toBe(false);
    expect(other.events()).toEqual([]);
  });

  it("keeps a half-answered thread reading as still loading", async () => {
    // Two posts opened in a row: the first is still out when the second is asked
    // for. With one flag, the first round settling cleared it for both, so the
    // thread on screen stopped saying it was loading while its own answers were
    // still in flight — and a half-loaded thread read as a complete one.
    const gate = deferred<{ events: NostrEvent[]; failed: boolean }>();
    vi.resetModules();
    vi.doMock("./relays.js", () => ({
      useRelays: () => ({ readRelays: () => ["wss://read.example"] }),
    }));
    vi.doMock("./nostr.js", () => ({
      getConnection: (url: string) => ({
        url,
        query: async (filter: Record<string, unknown>) => {
          queries.push(filter);
          if ((filter["#e"] as string[])[0] === POST) return gate.promise;
          return { events: [], failed: false };
        },
      }),
    }));
    const store = await import("./replies-feed.js");

    const first = store.loadReplies(POST);
    await tick();
    expect(store.useReplies(POST).loading()).toBe(true);

    // The other post answers at once, and must not stand in for the first.
    await store.loadReplies(OTHER_POST);
    expect(store.useReplies(OTHER_POST).loading()).toBe(false);
    expect(store.useReplies(POST).loading()).toBe(true);

    gate.resolve({ events: [], failed: false });
    await first;
    expect(store.useReplies(POST).loading()).toBe(false);
    expect(store.useReplies(POST).searched()).toBe(true);
  });
});

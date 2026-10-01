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
async function withStore(): Promise<typeof import("./replies-feed.js")> {
  vi.resetModules();
  vi.doMock("./relays.js", () => ({
    useRelays: () => ({ readRelays: () => ["wss://read.example"] }),
  }));
  vi.doMock("./nostr.js", () => ({
    getConnection: (url: string) => ({
      url,
      query: async (filter: Record<string, unknown>) => {
        queries.push(filter);
        return { events: answerWith, failed: false };
      },
    }),
  }));
  return import("./replies-feed.js");
}

describe("replies feed", () => {
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
        ["e", POST, "", "x", "root"],
        ["e", REPLY, "", "x", "reply"],
      ], 1, 300),
      post(REPLY, [["e", POST, "", "x", "reply"]], 1, 100),
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
    answerWith = [post(REPLY, [["e", POST, "", "x", "reply"]], 1, 100), comment];
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
    answerWith = [post(REPLY, [["e", other, "", "x", "reply"]])];
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
    answerWith = [post(REPLY, [["e", POST, "", "x", "reply"]])];
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
    const mine = post(REPLY, [["e", POST, "", "x", "reply"]], 1, 500);
    store.addReply(mine);
    expect(store.useReplies(POST).events().map((e) => e.id)).toEqual([REPLY]);
    // Nothing was asked, so the list is not waiting on a relay.
    expect(queries).toHaveLength(0);
    expect(store.useReplies(POST).searched()).toBe(true);
  });

  it("keeps a written reply in conversation order", async () => {
    const store = await withStore();
    answerWith = [post("5".repeat(64), [["e", POST, "", "x", "reply"]], 1, 100)];
    await store.loadReplies(POST);
    // Written after the one already there, so it belongs at the end.
    store.addReply(post(REPLY, [["e", POST, "", "x", "reply"]], 1, 900));
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
    const reply = post(REPLY, [["e", POST, "", "x", "reply"]]);
    expect(replyParent(reply)).toBe(POST);
    expect(directReplies([reply], POST)).toHaveLength(1);
  });
});

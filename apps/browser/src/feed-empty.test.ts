import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NostrEvent } from "dacci-nostr-nips";
import { clearEventCache } from "./event-cache.js";

/**
 * The home timeline and the notifications list, against a page that could not be
 * fetched.
 *
 * The profile feed has its own file for this; these two have the identical line
 * and the identical message, and had nothing. An empty list and a list nobody
 * could ask for look the same to a view, and one message cannot honestly serve
 * both — on the home timeline that message is "there are no posts yet", which
 * sends a reader to check nothing at all.
 */
function post(id: string, createdAt = 1000): NostrEvent {
  return {
    id,
    pubkey: "9".repeat(64),
    created_at: createdAt,
    kind: 1,
    tags: [],
    content: "x",
    sig: "s".repeat(128),
  };
}

const tick = (ms = 0): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** The store, with one page's worth of answer the test controls. */
async function withPage(
  page: { events: NostrEvent[]; failedRelays: string[] },
  module: "./home-feed.js" | "./notifications-feed.js",
): Promise<{ events: () => NostrEvent[]; failed: () => boolean }> {
  vi.resetModules();
  vi.doMock("./relays.js", () => ({
    useRelays: () => ({ readRelays: () => ["wss://read.example"] }),
    useFeed: () => ({ feedAuthors: () => null }),
  }));
  const paginator = {
    loadNextPage: async () => ({
      events: page.events,
      coverage: "partial" as const,
      pendingRelays: page.failedRelays,
      authRequiredRelays: [],
      failedRelays: page.failedRelays,
    }),
    hasMore: () => true,
  };
  // Each feed builds its own timeline, and the factory is the only thing that
  // differs — so all three are stubbed and the test picks by module.
  vi.doMock("./nostr.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./nostr.js")>()),
    createTimeline: () => paginator,
    createHomeTimeline: () => paginator,
    createNotificationTimeline: () => paginator,
  }));
  const store = await import(module);
  const view =
    module === "./notifications-feed.js"
      ? (store as typeof import("./notifications-feed.js")).useNotifications()
      : (store as typeof import("./home-feed.js")).useHomeFeed();
  if (module === "./notifications-feed.js") {
    (store as typeof import("./notifications-feed.js")).ensureNotifications(
      "9".repeat(64),
    );
  } else {
    (store as typeof import("./home-feed.js")).resetHomeFeed();
  }
  return view;
}

const DEAD = { events: [] as NostrEvent[], failedRelays: ["wss://dead.example"] };
const EMPTY = { events: [] as NostrEvent[], failedRelays: [] };
const SOME = { events: [post("a".repeat(64))], failedRelays: ["wss://dead.example"] };

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  clearEventCache();
  vi.doUnmock("./nostr.js");
  vi.doUnmock("./relays.js");
});

describe("a feed whose page could not be fetched", () => {
  it("says so on the home timeline instead of saying it is empty", async () => {
    const feed = await withPage(DEAD, "./home-feed.js");
    await tick();
    expect(feed.events()).toEqual([]);
    expect(feed.failed()).toBe(true);
  });

  it("says nothing is wrong when the relays simply have nothing", async () => {
    // The other half, and the one a fix written as "treat every empty feed as a
    // failure" would break: a working relay saying "no posts" is a fact, and it is
    // what the empty message is for.
    const feed = await withPage(EMPTY, "./home-feed.js");
    await tick();
    expect(feed.failed()).toBe(false);
  });

  it("does not call a feed with posts a failure", async () => {
    // The message is only for an empty list. A timeline full of posts is not
    // unreachable, however many of its relays are.
    const feed = await withPage(SOME, "./home-feed.js");
    await tick();
    expect(feed.events()).toHaveLength(1);
    expect(feed.failed()).toBe(false);
  });

  it("says so on the notifications list too", async () => {
    const feed = await withPage(DEAD, "./notifications-feed.js");
    await tick();
    expect(feed.events()).toEqual([]);
    expect(feed.failed()).toBe(true);
  });

  it("says nothing is wrong when the notifications relays simply have nothing", async () => {
    // The other half, on this feed too: a relay that answered "no notifications"
    // has answered, and turning that into a failure would put an error in front of
    // a reader who has none.
    const feed = await withPage(EMPTY, "./notifications-feed.js");
    await tick();
    expect(feed.failed()).toBe(false);
  });
});

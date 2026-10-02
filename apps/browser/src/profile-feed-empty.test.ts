import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NostrEvent } from "dacci-nostr-nips";
import { clearEventCache } from "./event-cache.js";

const AUTHOR = "9".repeat(64);

function post(id: string, createdAt = 1000): NostrEvent {
  return {
    id,
    pubkey: AUTHOR,
    created_at: createdAt,
    kind: 1,
    tags: [],
    content: "x",
    sig: "s".repeat(128),
  };
}

const tick = (ms = 0): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The profile feed with one page's worth of answer, so the difference between
 * "this person has not posted" and "nobody could be asked" can be driven from a
 * test. The paginator is the only thing stubbed; the store around it is the real
 * one, because the whole question is what the store concludes.
 */
type Answer = {
  events: NostrEvent[];
  failedRelays: string[];
  coverage?: "complete" | "partial";
};

async function withTimeline(
  answer: () => Answer | Promise<Answer>,
): Promise<typeof import("./profile-feed.js")> {
  vi.resetModules();
  vi.doMock("./relays.js", () => ({
    useRelays: () => ({ readRelays: () => ["wss://read.example"] }),
  }));
  vi.doMock("./nostr.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./nostr.js")>()),
    createTimeline: () => ({
      loadNextPage: async () => {
        const page = await answer();
        return {
          events: page.events,
          coverage: page.coverage ?? "partial",
          pendingRelays: page.failedRelays,
          authRequiredRelays: [],
          failedRelays: page.failedRelays,
        };
      },
      hasMore: () => true,
    }),
  }));
  return import("./profile-feed.js");
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  clearEventCache();
  vi.doUnmock("./nostr.js");
  vi.doUnmock("./relays.js");
});

describe("a profile whose post could not be fetched", () => {
  it("does not report an unreachable profile as one that never posted", async () => {
    // "この人の投稿はまだありません" is a claim about a third party, and it is
    // false every time the reason is that no relay answered. The view has no way
    // to tell those apart from the page it is handed, so the page has to say.
    const store = await withTimeline(() => ({ events: [], failedRelays: ["wss://read.example"] }));
    store.openProfile(AUTHOR);
    await tick();
    const feed = store.useProfileFeed();
    expect(feed.events()).toEqual([]);
    expect(feed.failed()).toBe(true);
  });

  it("reports a profile that answered with nothing as genuinely empty", async () => {
    // The other half, and the one that would be lost by simply treating every
    // empty list as a failure: a working relay saying "nothing here" is a fact
    // about the person, not about the connection.
    const store = await withTimeline(() => ({ events: [], failedRelays: [], coverage: "complete" as const }));
    store.openProfile(AUTHOR);
    await tick();
    expect(store.useProfileFeed().failed()).toBe(false);
  });

  it("does not call a profile with posts a failure", async () => {
    // The message is only for an empty list. A profile that has posts is not
    // unreachable, however many of its relays are.
    const store = await withTimeline(() => ({
      events: [post("a".repeat(64))],
      failedRelays: ["wss://dead.example"],
    }));
    store.openProfile(AUTHOR);
    await tick();
    const feed = store.useProfileFeed();
    expect(feed.events()).toHaveLength(1);
    expect(feed.failed()).toBe(false);
  });

  it("forgets the failure the moment a new profile starts loading", async () => {
    // Otherwise the previous subject's verdict is shown against the new one for
    // as long as its own round is out — "this person's posts could not be
    // fetched" about someone whose posts have not been asked for yet. The reset
    // is what clears it, so it is the reset that has to be pinned.
    let call = 0;
    const store = await withTimeline(() => {
      call += 1;
      if (call === 1) return { events: [], failedRelays: ["wss://read.example"] };
      // The second round never comes back, so the state under test is the one
      // the reset left behind rather than one a later answer overwrites.
      return new Promise<Answer>(() => {});
    });
    store.openProfile(AUTHOR);
    await tick();
    expect(store.useProfileFeed().failed()).toBe(true);
    store.openProfile("8".repeat(64));
    await tick();
    expect(store.useProfileFeed().failed()).toBe(false);
  });

  it("does not carry one subject's failure over to the next", async () => {
    // Otherwise the next reader of the same person is told their posts could not
    // be fetched, from a round that is long over.
    let refuse = true;
    const store = await withTimeline(() =>
      refuse
        ? { events: [], failedRelays: ["wss://read.example"] }
        : { events: [post("a".repeat(64))], failedRelays: [] },
    );
    store.openProfile(AUTHOR);
    await tick();
    expect(store.useProfileFeed().failed()).toBe(true);
    // The relays come back, and the next subject's own round succeeds — so this
    // is about a second author, not about re-opening the first. Re-opening the
    // same subject is a no-op by design, and the reset between subjects is what
    // the test above covers.
    refuse = false;
    store.openProfile("8".repeat(64));
    await tick();
    expect(store.useProfileFeed().failed()).toBe(false);
  });
});

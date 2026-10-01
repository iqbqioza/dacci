import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NostrEvent } from "dacci-nostr-nips";

const GONE = "1".repeat(64);
const KEPT = "2".repeat(64);

function post(id: string): NostrEvent {
  return { id } as unknown as NostrEvent;
}

describe("deleted posts", () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  it("hides a post that has been deleted", async () => {
    const store = await import("./deleted.js");
    store.markDeleted([GONE]);
    expect(store.isDeleted(GONE)).toBe(true);
    expect(store.isDeleted(KEPT)).toBe(false);
    expect(store.withoutDeleted([post(GONE), post(KEPT)])).toEqual([post(KEPT)]);
  });

  it("hands back the very list it was given when nothing is deleted", async () => {
    // The feeds hand their loaded array in on every read, so the untouched
    // case must not copy it: that would redraw every list for nothing.
    const store = await import("./deleted.js");
    const events = [post(KEPT)];
    expect(store.withoutDeleted(events)).toBe(events);
  });

  it("ignores a second deletion of the same post", async () => {
    const store = await import("./deleted.js");
    store.markDeleted([GONE]);
    store.markDeleted([GONE]);
    store.markDeleted([KEPT, KEPT]);
    expect(store.withoutDeleted([post(GONE), post(KEPT)])).toEqual([]);
  });
});

describe("a post is the reader's own", () => {
  it("is so only when the reader is signed in and matches", async () => {
    const store = await import("./deleted.js");
    const own = { ...post(KEPT), pubkey: "9".repeat(64) } as NostrEvent;
    expect(store.isOwn(own, "9".repeat(64))).toBe(true);
    expect(store.isOwn(own, "8".repeat(64))).toBe(false);
    expect(store.isOwn(own, null)).toBe(false);
  });
});

describe("syncDeleted", () => {
  function kind5(id: string, tags: string[][], at = 1000): unknown {
    return {
      id,
      kind: 5,
      pubkey: "9".repeat(64),
      created_at: at,
      content: "",
      tags,
      sig: "c".repeat(128),
    };
  }

  beforeEach(() => {
    vi.resetModules();
    vi.doMock("./relays.js", () => ({
      useRelays: () => ({ readRelays: () => ["wss://read.example"] }),
    }));
  });

  afterEach(() => {
    vi.doUnmock("./nostr.js");
    vi.doUnmock("./relays.js");
  });

  it("hides the posts the reader deleted in another client", async () => {
    vi.doMock("./nostr.js", () => ({
      getConnection: () => ({
        query: async () => ({ failed: false, events: [kind5("a".repeat(64), [["e", GONE]])] }),
      }),
    }));
    const store = await import("./deleted.js");
    await store.syncDeleted("9".repeat(64));
    expect(store.isDeleted(GONE)).toBe(true);
  });

  it("reads the reader's own kind 5 alone, so an old deletion is not missed", async () => {
    // The reader's recent posts are queried for what they have done, and a
    // deletion from last year falls outside that window.
    const asked: unknown[] = [];
    vi.doMock("./nostr.js", () => ({
      getConnection: () => ({
        query: async (filter: unknown) => {
          asked.push(filter);
          return { failed: false, events: [] };
        },
      }),
    }));
    const store = await import("./deleted.js");
    await store.syncDeleted("9".repeat(64));
    expect(asked[0]).toMatchObject({ kinds: [5], authors: ["9".repeat(64)] });
  });

  it("keeps what it knows when no relay answered", async () => {
    // A quiet relay must not put a deleted post back on screen.
    vi.doMock("./nostr.js", () => ({
      getConnection: () => ({ query: async () => ({ failed: true }) }),
    }));
    const store = await import("./deleted.js");
    store.markDeleted([GONE]);
    await store.syncDeleted("9".repeat(64));
    expect(store.isDeleted(GONE)).toBe(true);
  });
});
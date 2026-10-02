import type { NostrEvent } from "dacci-nostr-nips";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ME = "1".repeat(64);
const OTHER = "2".repeat(64);

/** A NIP-09 request the reader published, naming what it takes away. */
function deletion(id: string, pubkey = ME, at = 1000): NostrEvent {
  return {
    id: id.padEnd(64, "0"),
    pubkey,
    created_at: at,
    kind: 5,
    tags: [["e", id]],
    content: "",
    sig: "s".repeat(128),
  };
}

/** A relay answer the test releases when it chooses. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let release: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: release };
}

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock("./nostr.js");
  vi.doUnmock("./relays.js");
});

/**
 * The store with the relay layer stubbed. `answer` is consulted per call, so a
 * test can make a read hang and then let it land late. It is given the filter
 * too, so a stub can answer for the reader a filter actually names.
 */
async function withStore(
  answer: (
    url: string,
    author: string | undefined,
  ) => Promise<{ failed: boolean; events: NostrEvent[] }>,
): Promise<typeof import("./deleted.js")> {
  vi.doMock("./relays.js", () => ({
    useRelays: () => ({ readRelays: () => ["wss://a", "wss://b"] }),
  }));
  vi.doMock("./nostr.js", () => ({
    getConnection: (url: string) => ({
      url,
      query: (filter: { authors?: string[] }) =>
        answer(url, filter.authors?.[0]),
    }),
  }));
  return import("./deleted.js");
}

describe("deleted posts", () => {
  it("hides a post a NIP-09 request has taken away", async () => {
    const store = await withStore(async () => ({
      failed: false,
      events: [deletion("a".repeat(64))],
    }));
    await store.syncDeleted(ME);
    expect(store.isDeleted("a".repeat(64))).toBe(true);
    const kept = {
      id: "b".repeat(64),
      pubkey: OTHER,
      created_at: 1,
      kind: 1,
      tags: [],
      content: "x",
      sig: "s".repeat(128),
    };
    expect(store.withoutDeleted([kept])).toEqual([kept]);
    expect(store.withoutDeleted([kept, { ...kept, id: "a".repeat(64) }])).toEqual([
      kept,
    ]);
  });

  it("starts empty for the next reader", async () => {
    const store = await withStore(async () => ({
      failed: false,
      events: [deletion("a".repeat(64))],
    }));
    await store.syncDeleted(ME);
    expect(store.isDeleted("a".repeat(64))).toBe(true);
    // The reader signs out and someone else signs in on the same browser. The
    // first reader's deletions are not this reader's business, and they must
    // not be able to hide a post from someone who never deleted it.
    store.resetDeleted();
    expect(store.isDeleted("a".repeat(64))).toBe(false);
  });

  it("does not carry one reader's deletions into another without a reset", async () => {
    const store = await withStore(async (url, author) =>
      url === "wss://a" && author === ME
        ? { failed: false, events: [deletion("a".repeat(64))] }
        : { failed: false, events: [] },
    );
    await store.syncDeleted(ME);
    expect(store.isDeleted("a".repeat(64))).toBe(true);
    // A second reader syncing their own requests replaces the set outright, so
    // nothing of the first reader survives into it.
    await store.syncDeleted(OTHER);
    expect(store.isDeleted("a".repeat(64))).toBe(false);
  });

  it("throws away a read that settles after the reader changed", async () => {
    const late = deferred<{ failed: boolean; events: NostrEvent[] }>();
    const store = await withStore(async (url) =>
      url === "wss://a"
        ? late.promise
        : { failed: false, events: [] },
    );
    const reading = store.syncDeleted(ME);
    await tick();
    // The reader changes while the read is out.
    store.resetDeleted();
    late.resolve({ failed: false, events: [deletion("a".repeat(64))] });
    await reading;
    // Writing it would apply the old reader's deletions to the new reader.
    expect(store.isDeleted("a".repeat(64))).toBe(false);
  });

  it("keeps what it knows when no relay answers", async () => {
    let call = 0;
    const store = await withStore(async () => {
      call += 1;
      return call === 1
        ? { failed: false, events: [deletion("a".repeat(64))] }
        : { failed: true, events: [] };
    });
    await store.syncDeleted(ME);
    expect(store.isDeleted("a".repeat(64))).toBe(true);
    // A quiet relay must not undo a deletion that was already established.
    await store.syncDeleted(ME);
    expect(store.isDeleted("a".repeat(64))).toBe(true);
  });
});

import type { NostrEvent } from "dacci-nostr-nips";
import { describe, expect, it, vi } from "vitest";
import { EmbedStore } from "./quote.js";

const A = "1".repeat(64);
const B = "2".repeat(64);
const C = "3".repeat(64);

function note(id: string, pubkey: string, content = "x"): NostrEvent {
  // The id is fixed rather than derived, because the store keys on the id a
  // post asks for and these tests look notes up by that id.
  return {
    id,
    pubkey,
    created_at: 100,
    kind: 1,
    tags: [],
    content,
    sig: "s".repeat(128),
  };
}

const tick = (ms = 0): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("EmbedStore", () => {
  it("batches a burst of ids into one query", async () => {
    const query = vi.fn(async (ids: string[]) => ids.map((id) => note(id, A)));
    const store = new EmbedStore(query, { flushDelayMs: 1, batchSize: 50 });
    store.request([A, B, C, A, A]);
    await tick(20);
    // One REQ for the whole burst, not one per card.
    expect(query).toHaveBeenCalledTimes(1);
    expect([...query.mock.calls[0][0]].sort()).toEqual([A, B, C]);
    expect(store.peek(A)?.content).toBe("x");
    store.clear();
  });

  it("never asks twice for an id it already has", async () => {
    const query = vi.fn(async (ids: string[]) => ids.map((id) => note(id, A)));
    const store = new EmbedStore(query, { flushDelayMs: 1 });
    store.request([A]);
    await tick(20);
    store.request([A]);
    await tick(20);
    expect(query).toHaveBeenCalledTimes(1);
    store.clear();
  });

  it("seeds a known note so no query is made for it", async () => {
    const query = vi.fn(async () => []);
    const store = new EmbedStore(query, { flushDelayMs: 1 });
    const known = note(A, A, "already here");
    store.put(known);
    store.request([A]);
    await tick(20);
    expect(query).not.toHaveBeenCalled();
    expect(store.peek(A)).toEqual(known);
    store.clear();
  });

  it("announces a seeded note, so a waiting view can render it", async () => {
    const query = vi.fn(async () => []);
    const onChange = vi.fn();
    const store = new EmbedStore(query, { flushDelayMs: 1, onChange });
    const known = note(A, A);
    store.put(known);
    // A view waiting on this id renders only once the change is announced.
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(store.peek(A)).toEqual(known);
    // Seeding the same note again is not a change worth announcing.
    store.put(known);
    expect(onChange).toHaveBeenCalledTimes(1);
    store.clear();
  });

  it("retries an id no relay had, then gives up", async () => {
    const query = vi.fn(async () => []);
    const store = new EmbedStore(query, {
      flushDelayMs: 1,
      // Long enough that a single tick covers exactly one attempt.
      baseRetryMs: 30,
      maxRetryMs: 60,
      maxAttempts: 2,
    });
    store.request([A]);
    await tick(20);
    expect(query).toHaveBeenCalledTimes(1);
    // Backoff puts it back on the queue, then the attempt cap stops it.
    await tick(40);
    expect(query.mock.calls.length).toBeGreaterThan(1);
    await tick(80);
    const settled = query.mock.calls.length;
    await tick(120);
    expect(query).toHaveBeenCalledTimes(settled);
    expect(store.peek(A)).toBeNull();
    store.clear();
  });

  it("keeps a note that arrived during a retry", async () => {
    let attempt = 0;
    const query = vi.fn(async (ids: string[]) => {
      attempt += 1;
      return attempt === 1 ? [] : ids.map((id) => note(id, A));
    });
    const store = new EmbedStore(query, {
      flushDelayMs: 1,
      baseRetryMs: 30,
      maxRetryMs: 60,
    });
    store.request([A]);
    await tick(80);
    expect(store.peek(A)?.content).toBe("x");
    store.clear();
  });

  it("ignores an id that is not an event id", async () => {
    const query = vi.fn(async () => []);
    const store = new EmbedStore(query, { flushDelayMs: 1 });
    store.request(["not-an-id", "30023:" + A + ":slug"]);
    await tick(20);
    expect(query).not.toHaveBeenCalled();
    store.clear();
  });

  it("discards a reply that is not a valid event", async () => {
    const query = vi.fn(async (ids: string[]) =>
      ids.map((id) => ({ ...note(id, A), sig: "short" })),
    );
    const store = new EmbedStore(query, { flushDelayMs: 1, maxAttempts: 0 });
    store.request([A]);
    await tick(20);
    expect(store.peek(A)).toBeNull();
    store.clear();
  });

  it("survives a query that throws", async () => {
    const query = vi.fn(async () => {
      throw new Error("relay down");
    });
    const store = new EmbedStore(query, { flushDelayMs: 1, maxAttempts: 0 });
    store.request([A]);
    await tick(20);
    expect(store.peek(A)).toBeNull();
    store.clear();
  });

  it("drops everything on clear", async () => {
    const query = vi.fn(async (ids: string[]) => ids.map((id) => note(id, A)));
    const store = new EmbedStore(query, { flushDelayMs: 1 });
    store.request([A]);
    await tick(20);
    expect(store.peek(A)).not.toBeNull();
    store.clear();
    expect(store.peek(A)).toBeNull();
    // A cleared id is unknown again, so a later post may request it.
    store.request([A]);
    await tick(20);
    expect(query).toHaveBeenCalledTimes(2);
    store.clear();
  });

  it("does not coalesce a request that arrives while one is in flight", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const query = vi.fn(async (ids: string[]) => {
      await gate;
      return ids.map((id) => note(id, A));
    });
    const store = new EmbedStore(query, { flushDelayMs: 1, batchSize: 1 });
    store.request([A, B]);
    await tick(20);
    // B is queued behind the in-flight A, so a second round runs for it.
    store.request([C]);
    release();
    await tick(20);
    const batches = query.mock.calls.map((call) => call[0] as string[]);
    expect(batches.flat().sort()).toEqual([A, B, C].sort());
    store.clear();
  });
});

describe("a note that arrives while its request is out", () => {
  it("is not thrown away when the relay's answer lacks it", async () => {
    // The reachable case: a feed shows a note as a post of its own *and* a
    // repost of it, so the embed is seeded from what the feed already holds
    // while another card's request for the same id is still in flight. A relay
    // that no longer has the note — NIP-09, a retention policy — answers without
    // it, and the answer used to overwrite the seeded note with a failure. The
    // quoted card then showed a placeholder for something the reader was looking
    // at two cards above.
    const query = vi.fn(async () => []);
    const store = new EmbedStore(query, { flushDelayMs: 1 });
    store.request([A]);
    const known = note(A, A, "on screen already");
    store.put(known);
    await tick(20);
    expect(store.peek(A)).toEqual(known);
    store.clear();
  });

  it("still lets a failed request be retried when nothing seeded it", async () => {
    // The other half. The guard above is about a note that exists, and must not
    // become a way to make a genuinely missing note look present — nor a way to
    // stop the retries that eventually surface it.
    let call = 0;
    const query = vi.fn(async (ids: string[]) => {
      call += 1;
      return call === 1 ? [] : ids.map((id) => note(id, A));
    });
    const store = new EmbedStore(query, { flushDelayMs: 1, baseRetryMs: 1 });
    store.request([A]);
    await tick(20);
    // Asked again, and the note is there the second time.
    expect(query.mock.calls.length).toBeGreaterThan(1);
    expect(store.peek(A)?.id).toBe(A);
    store.clear();
  });
});

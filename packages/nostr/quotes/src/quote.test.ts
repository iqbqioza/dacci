import { computeEventId, type NostrEvent } from "dacci-nostr-nips";
import { describe, expect, it, vi } from "vitest";
import { EmbedStore } from "./quote.js";

const PUB = "1".repeat(64);

function note(pubkey: string, content: string): NostrEvent {
  // The id is derived, because the store checks that an answer's id is the
  // hash of its own fields: a relay returning the requested id with rewritten
  // content must not match the lookup. Tests ask for notes by their real ids.
  const base = { pubkey, created_at: 100, kind: 1, tags: [], content };
  return { ...base, id: computeEventId(base), sig: "s".repeat(128) };
}

const NOTE_A = note(PUB, "a");
const NOTE_B = note(PUB, "b");
const NOTE_C = note(PUB, "c");
// The ids the tests ask for are the notes' own.
const A = NOTE_A.id;
const B = NOTE_B.id;
const C = NOTE_C.id;

const BY_ID = new Map([NOTE_A, NOTE_B, NOTE_C].map((n) => [n.id, n]));

/** What a relay holding these notes answers. */
function answer(ids: string[]): NostrEvent[] {
  const out: NostrEvent[] = [];
  for (const id of ids) {
    const found = BY_ID.get(id);
    if (found !== undefined) out.push(found);
  }
  return out;
}

const tick = (ms = 0): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("EmbedStore", () => {
  it("batches a burst of ids into one query", async () => {
    const query = vi.fn(async (ids: string[]) => answer(ids));
    const store = new EmbedStore(query, { flushDelayMs: 1, batchSize: 50 });
    store.request([A, B, C, A, A]);
    await tick(20);
    // One REQ for the whole burst, not one per card.
    expect(query).toHaveBeenCalledTimes(1);
    expect([...query.mock.calls[0][0]].sort()).toEqual([A, B, C]);
    expect(store.peek(A)?.content).toBe("a");
    store.clear();
  });

  it("never asks twice for an id it already has", async () => {
    const query = vi.fn(async (ids: string[]) => answer(ids));
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
    const known = note(PUB, "already here");
    store.put(known);
    store.request([known.id]);
    await tick(20);
    expect(query).not.toHaveBeenCalled();
    expect(store.peek(known.id)).toEqual(known);
    store.clear();
  });

  it("announces a seeded note, so a waiting view can render it", async () => {
    const query = vi.fn(async () => []);
    const onChange = vi.fn();
    const store = new EmbedStore(query, { flushDelayMs: 1, onChange });
    const known = note(PUB, "already here");
    store.put(known);
    // A view waiting on this id renders only once the change is announced.
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(store.peek(known.id)).toEqual(known);
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
      return attempt === 1 ? [] : answer(ids);
    });
    const store = new EmbedStore(query, {
      flushDelayMs: 1,
      baseRetryMs: 30,
      maxRetryMs: 60,
    });
    store.request([A]);
    await tick(80);
    expect(store.peek(A)?.content).toBe("a");
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
    const query = vi.fn(async () => [{ ...NOTE_A, sig: "short" }]);
    const store = new EmbedStore(query, { flushDelayMs: 1, maxAttempts: 0 });
    store.request([A]);
    await tick(20);
    expect(store.peek(A)).toBeNull();
    store.clear();
  });

  it("discards a reply whose id is not the hash of its fields", async () => {
    // A relay returning the requested id with rewritten content matches the
    // lookup by id, so the check that the id IS the hash of the fields is the
    // attribution itself. Without it the card renders attacker words as
    // someone else's note.
    const forged = { ...NOTE_A, content: "attacker words" };
    const query = vi.fn(async () => [forged]);
    const store = new EmbedStore(query, { flushDelayMs: 1, maxAttempts: 0 });
    store.request([NOTE_A.id]);
    await tick(20);
    expect(store.peek(NOTE_A.id)).toBeNull();
    store.clear();
  });

  it("gives up on a query that never settles, and stays usable", async () => {
    // A batch with no deadline held `inFlight` until the query answered, so
    // one stuck promise parked every later id for the rest of the session.
    // Past the deadline the batch fails like any other failure.
    let calls = 0;
    const query = vi.fn(async (ids: string[]) => {
      calls += 1;
      if (calls === 1) await new Promise(() => undefined);
      return answer(ids);
    });
    const store = new EmbedStore(query, {
      flushDelayMs: 1,
      batchTimeoutMs: 30,
      maxAttempts: 2,
      baseRetryMs: 10,
      maxRetryMs: 20,
    });
    store.request([NOTE_A.id]);
    await tick(120);
    // The stuck batch failed on the deadline, the retry went out on its own,
    // and the note loaded. Without the deadline the first query would still
    // be out and nothing after it would ever resolve.
    expect(query.mock.calls.length).toBeGreaterThan(1);
    expect(store.peek(NOTE_A.id)?.content).toBe("a");
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
    const query = vi.fn(async (ids: string[]) => answer(ids));
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
      return answer(ids);
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
    const known = note(PUB, "on screen already");
    store.request([known.id]);
    store.put(known);
    await tick(20);
    expect(store.peek(known.id)).toEqual(known);
    store.clear();
  });

  it("still lets a failed request be retried when nothing seeded it", async () => {
    // The other half. The guard above is about a note that exists, and must not
    // become a way to make a genuinely missing note look present — nor a way to
    // stop the retries that eventually surface it.
    let call = 0;
    const query = vi.fn(async (ids: string[]) => {
      call += 1;
      return call === 1 ? [] : answer(ids);
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

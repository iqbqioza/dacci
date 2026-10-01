import { computeEventId, type NostrEvent } from "dacci-nostr-nips";
import { describe, expect, it, vi } from "vitest";
import {
  parseProfile,
  profileLabel,
  ProfileStore,
} from "./profile.js";

const A = "1".repeat(64);
const B = "2".repeat(64);
const C = "3".repeat(64);

function metaEvent(pubkey: string, content: string, at = 100): NostrEvent {
  const base = { pubkey, created_at: at, kind: 0, tags: [], content };
  return { ...base, id: computeEventId(base), sig: "s".repeat(128) };
}

const tick = (ms = 0): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("parseProfile", () => {
  it("reads the NIP-01 metadata fields", () => {
    const event = metaEvent(
      A,
      JSON.stringify({
        name: "alice",
        display_name: "Alice",
        picture: "https://example/a.png",
        nip05: "alice@example.com",
      }),
    );
    const profile = parseProfile(event);
    expect(profile?.name).toBe("alice");
    expect(profile?.displayName).toBe("Alice");
    expect(profile?.picture).toBe("https://example/a.png");
    expect(profileLabel(profile)).toBe("Alice");
  });

  it("keeps the fields it does not parse", () => {
    // NIP-01 replaces the whole profile, so republishing one has to carry the
    // rest along. A parsed profile that only holds the known fields cannot do
    // that.
    const event = metaEvent(
      A,
      JSON.stringify({ name: "alice", lud16: "alice@wallet.example" }),
    );
    expect(parseProfile(event)?.metadata).toEqual({
      name: "alice",
      lud16: "alice@wallet.example",
    });
  });

  it("rejects other kinds and broken JSON", () => {
    expect(parseProfile({ ...metaEvent(A, "{}"), kind: 1 })).toBeNull();
    expect(parseProfile(metaEvent(A, "not json"))).toBeNull();
  });

  it("falls back name, then nip05", () => {
    expect(
      profileLabel(parseProfile(metaEvent(A, JSON.stringify({ name: "a" })))),
    ).toBe("a");
    expect(
      profileLabel(
        parseProfile(metaEvent(A, JSON.stringify({ nip05: "a@x.test" }))),
      ),
    ).toBe("a@x.test");
    expect(profileLabel(parseProfile(metaEvent(A, "{}")))).toBeNull();
  });
});

describe("ProfileStore", () => {
  it("batches a burst of authors into one query", async () => {
    const query = vi.fn(async (authors: string[]) =>
      authors.includes(A) ? [metaEvent(A, JSON.stringify({ name: "a" }))] : [],
    );
    const store = new ProfileStore(query, { flushDelayMs: 1, batchSize: 50 });
    store.request([A, B, C, A, A]);
    await tick(20);
    // One REQ for the whole burst, not one per author.
    expect(query).toHaveBeenCalledTimes(1);
    expect([...query.mock.calls[0][0]].sort()).toEqual([A, B, C]);
    expect(store.peek(A)?.name).toBe("a");
    store.clear();
  });

  it("never asks twice for a loaded user", async () => {
    const query = vi.fn(async () => [metaEvent(A, JSON.stringify({ name: "a" }))]);
    const store = new ProfileStore(query, { flushDelayMs: 1 });
    store.request([A]);
    await tick(20);
    store.request([A, A, A]);
    await tick(20);
    expect(query).toHaveBeenCalledTimes(1);
    store.clear();
  });

  it("does not re-query a user whose batch is still in flight", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const query = vi.fn(async () => {
      await gate;
      return [metaEvent(A, JSON.stringify({ name: "a" }))];
    });
    const store = new ProfileStore(query, { flushDelayMs: 1 });
    store.request([A]);
    await tick(10);
    // Still loading: a second request from another card must not fire a REQ.
    expect(store.isLoading(A)).toBe(true);
    store.request([A, A]);
    await tick(10);
    expect(query).toHaveBeenCalledTimes(1);
    release();
    await tick(10);
    expect(store.peek(A)?.name).toBe("a");
    store.clear();
  });

  it("notifies the view layer when the cache changes", async () => {
    const changes: number[] = [];
    const query = vi.fn(async () => [metaEvent(A, JSON.stringify({ name: "a" }))]);
    const store = new ProfileStore(query, {
      flushDelayMs: 1,
      onChange: () => changes.push(1),
    });
    store.request([A]);
    await tick(20);
    // Once when queued, once when the batch resolved.
    expect(changes.length).toBe(2);
    store.clear();
  });

  it("retries failures in a batched queue with backoff", async () => {
    let attempt = 0;
    const query = vi.fn(async () => {
      attempt += 1;
      return attempt === 1 ? [] : [metaEvent(A, JSON.stringify({ name: "late" }))];
    });
    const store = new ProfileStore(query, {
      flushDelayMs: 1,
      baseRetryMs: 60,
      maxAttempts: 4,
    });
    store.request([A]);
    await tick(20);
    // First attempt failed: unresolved, but queued for a retry.
    expect(store.peek(A)).toBeNull();
    await tick(120);
    expect(store.peek(A)?.name).toBe("late");
    store.clear();
  });

  it("gives up after maxAttempts instead of hammering", async () => {
    const query = vi.fn(async () => []);
    const store = new ProfileStore(query, {
      flushDelayMs: 1,
      baseRetryMs: 1,
      maxAttempts: 2,
    });
    store.request([A]);
    await tick(20);
    await tick(40);
    await tick(40);
    const callsAtGiveUp = query.mock.calls.length;
    await tick(60);
    // No further attempts once it gave up.
    expect(query.mock.calls.length).toBe(callsAtGiveUp);
    store.clear();
  });

  it("ignores malformed pubkeys", async () => {
    const query = vi.fn(async () => []);
    const store = new ProfileStore(query, { flushDelayMs: 1 });
    store.request(["", "nope", "ZZ".repeat(32)]);
    await tick(10);
    expect(query).not.toHaveBeenCalled();
    store.clear();
  });

  it("takes a profile this client published, over the one it already had", async () => {
    // `request()` ignores an author it already knows, so the profile a reader
    // has just replaced would stay on screen until a reload.
    const query = vi.fn(async () => [metaEvent(A, JSON.stringify({ name: "old" }))]);
    const store = new ProfileStore(query, { flushDelayMs: 1 });
    store.request([A]);
    await tick(20);
    expect(store.peek(A)?.name).toBe("old");
    store.put(metaEvent(A, JSON.stringify({ name: "new" }), 200));
    expect(store.peek(A)?.name).toBe("new");
    store.clear();
  });

  it("notifies the view when a profile is put", () => {
    const changes: number[] = [];
    const store = new ProfileStore(async () => [], {
      onChange: () => changes.push(1),
    });
    store.put(metaEvent(A, JSON.stringify({ name: "a" })));
    expect(changes).toHaveLength(1);
  });

  it("ignores an event that is not a profile", () => {
    const store = new ProfileStore(async () => [], {
      onChange: () => {
        throw new Error("must not notify");
      },
    });
    store.put({ ...metaEvent(A, "{}"), kind: 1 });
    expect(store.peek(A)).toBeNull();
  });
});

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

  it("reads the NIP-30 emoji a profile defines for its own name and bio", () => {
    // NIP-30 puts the shortcodes on the profile itself, so `name` and `about`
    // can be drawn with them without asking a relay for anything.
    const event = metaEvent(
      A,
      JSON.stringify({ name: "Alex Gleason :soapbox:" }),
      100,
    );
    event.tags = [["emoji", "soapbox", "https://x/soapbox.png"]];
    expect(parseProfile(event)?.emojis).toEqual([
      { code: "soapbox", url: "https://x/soapbox.png" },
    ]);
  });

  it("has no emoji on a profile that defines none", () => {
    expect(parseProfile(metaEvent(A, JSON.stringify({ name: "a" })))?.emojis).toEqual([]);
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

  it("refuses a profile whose id is not the hash of its fields", async () => {
    // A relay returning anyone's pubkey with rewritten metadata matches the
    // author lookup, so the check that the id IS the hash is the attribution:
    // without it the name and avatar under a real person's key are the
    // attacker's choice.
    const genuine = metaEvent(A, JSON.stringify({ name: "alice" }));
    const forged = {
      ...genuine,
      content: JSON.stringify({
        name: "mallory",
        picture: "https://attacker.example/x.png",
      }),
    };
    const query = vi.fn(async () => [forged]);
    const store = new ProfileStore(query, { flushDelayMs: 1, maxAttempts: 0 });
    store.request([A]);
    await tick(20);
    // Fetched, and refused: the relay answered, but nothing it said is adopted.
    expect(query).toHaveBeenCalledTimes(1);
    expect(store.peek(A)).toBeNull();
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
      // A lookup that did not answer throws. An empty array would mean the
      // author has no profile, which is an answer and is not retried.
      if (attempt === 1) throw new Error("no relay answered");
      return [metaEvent(A, JSON.stringify({ name: "late" }))];
    });
    const store = new ProfileStore(query, {
      flushDelayMs: 1,
      baseRetryMs: 60,
      maxAttempts: 4,
    });
    store.request([A]);
    await tick(20);
    // First attempt went unanswered: unknown, not resolved, queued for a retry.
    expect(store.peek(A)).toBeNull();
    expect(store.resolved(A)).toBe(false);
    await tick(120);
    expect(store.peek(A)?.name).toBe("late");
    store.clear();
  });

  it("records an author a relay answered about as having no profile", async () => {
    const query = vi.fn(async () => []);
    const store = new ProfileStore(query, { flushDelayMs: 1 });
    store.request([A]);
    await tick(20);
    // Asked and answered with nothing is a fact about the author, so it is
    // resolved: the editor may build on it.
    expect(store.peek(A)).toBeNull();
    expect(store.resolved(A)).toBe(true);
    expect(store.isLoading(A)).toBe(false);
    store.clear();
  });

  it("never re-asks an author a relay answered about", async () => {
    const query = vi.fn(async () => []);
    const store = new ProfileStore(query, { flushDelayMs: 1 });
    store.request([A]);
    await tick(20);
    store.request([A]);
    await tick(20);
    expect(query).toHaveBeenCalledTimes(1);
    store.clear();
  });

  it("does not turn a profile it already has into an unanswered one", async () => {
    // A relay going quiet must never cost a name that is already on screen.
    let answer = true;
    const query = vi.fn(async () => {
      if (!answer) throw new Error("no relay answered");
      return [metaEvent(A, JSON.stringify({ name: "known" }))];
    });
    const store = new ProfileStore(query, { flushDelayMs: 1 });
    store.request([A]);
    await tick(20);
    expect(store.peek(A)?.name).toBe("known");
    answer = false;
    store.request([A, B]);
    await tick(20);
    expect(store.peek(A)?.name).toBe("known");
    store.clear();
  });

  it("gives up after maxAttempts instead of hammering", async () => {
    // The query has to *fail*, not answer with nothing. An empty array is the
    // store's word for "asked, and this author has no profile", which resolves
    // the author on the first round and leaves nothing to retry — so a test
    // written that way asserted that a queue nobody used stayed quiet.
    const query = vi.fn(async () => {
      throw new Error("no relay answered");
    });
    const store = new ProfileStore(query, {
      flushDelayMs: 1,
      baseRetryMs: 1,
      maxRetryMs: 4,
      maxAttempts: 2,
    });
    store.request([A]);
    await tick(30);
    const callsAtGiveUp = query.mock.calls.length;
    await tick(60);
    // No further attempts once it gave up.
    expect(query.mock.calls.length).toBe(callsAtGiveUp);
    // And it tried more than once first, or "gave up" would mean nothing.
    expect(callsAtGiveUp).toBeGreaterThan(1);
    store.clear();
  });

  it("keeps retrying while a relay is quiet, up to the limit", async () => {
    // The reason the queue exists: a relay that is briefly unreachable while a
    // feed loads. It has to retry, and the count of attempts has to be kept —
    // reset on each round, and the author would be asked forever.
    let attempts = 0;
    const query = vi.fn(async () => {
      attempts += 1;
      // Quiet for the first two rounds, then the relay comes back.
      if (attempts < 3) throw new Error("no relay answered");
      return [metaEvent(A, JSON.stringify({ name: "late" }), 100)];
    });
    const store = new ProfileStore(query, {
      flushDelayMs: 1,
      baseRetryMs: 1,
      maxRetryMs: 4,
      maxAttempts: 5,
    });
    store.request([A]);
    await tick(60);
    expect(store.peek(A)?.name).toBe("late");
    expect(store.resolved(A)).toBe(true);
    expect(attempts).toBe(3);
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

describe("an answer that is not a profile", () => {
  it("refuses a JSON array rather than carrying its indices through", () => {
    // An array is an object as far as `typeof` goes, and it parses. Carried
    // through, the next save spreads its indices into the metadata: the author's
    // profile would be republished as `{"0":1,"1":2,…}`.
    expect(parseProfile(metaEvent(A, "[1,2,3]"))).toBeNull();
    expect(parseProfile(metaEvent(A, '"just a string"'))).toBeNull();
    expect(parseProfile(metaEvent(A, "not json at all"))).toBeNull();
  });

  it("gives up on a query that never settles, and stays usable", async () => {
    // Same backstop as the quote store: one stuck batch held `inFlight`
    // forever, and every later author queued behind it for the session.
    let calls = 0;
    const query = vi.fn(async (authors: string[]) => {
      calls += 1;
      if (calls === 1) await new Promise<NostrEvent[]>(() => undefined);
      return [metaEvent(A, JSON.stringify({ name: "a" }))];
    });
    const store = new ProfileStore(query, {
      flushDelayMs: 1,
      batchTimeoutMs: 30,
      maxAttempts: 5,
      baseRetryMs: 1,
      maxRetryMs: 2,
    });
    store.request([A]);
    await tick(80);
    // Not parked: the retry went out and the profile loaded.
    expect(query.mock.calls.length).toBeGreaterThan(1);
    expect(store.peek(A)?.name).toBe("a");
    store.clear();
  });

  it("does not resolve an author whose profile it merely failed to read", async () => {
    // The dangerous half. "Answered with something unparseable" and "this author
    // has no profile" are different facts, and the store kept only one of them.
    // Resolving the author with nothing to show is what lets the profile editor
    // write — so a kind 0 the app could not parse became a reason to overwrite a
    // real profile with an empty one.
    const store = new ProfileStore(
      async () => [metaEvent(A, "not json at all", 100)],
      { flushDelayMs: 1, baseRetryMs: 1, maxRetryMs: 2, maxAttempts: 1 },
    );
    store.request([A]);
    await tick(40);
    expect(store.peek(A)).toBeNull();
    expect(store.resolved(A)).toBe(false);
    store.clear();
  });

  it("does not let a newer other-kind event beat the author's kind 0", async () => {
    // A relay answering extra kinds for the author — a newer kind 1 beside
    // the real kind 0 — used to win the recency race, and the profile that
    // was right there went down the retry path instead of loading.
    const kind0 = metaEvent(A, JSON.stringify({ name: "alice" }), 100);
    // Valid in every way except it is not a profile: the kind filter, not the
    // id check, is what must refuse it.
    const noiseBase = {
      pubkey: A,
      created_at: 200,
      kind: 1,
      tags: [],
      content: "hi",
    };
    const noise = {
      ...noiseBase,
      id: computeEventId(noiseBase),
      sig: "s".repeat(128),
    };
    const store = new ProfileStore(async () => [noise, kind0], {
      flushDelayMs: 1,
    });
    store.request([A]);
    await tick(20);
    expect(store.peek(A)?.name).toBe("alice");
    expect(store.resolved(A)).toBe(true);
    store.clear();
  });

  it("still records an author nobody has written a profile for", async () => {
    // The other half, and the one that would be lost by treating every empty
    // answer as unanswerable: a working relay saying "nothing here" is a fact
    // about the author, and it is what lets the editor open on a blank profile.
    const store = new ProfileStore(async () => [], { flushDelayMs: 1 });
    store.request([A]);
    await tick(20);
    expect(store.peek(A)).toBeNull();
    expect(store.resolved(A)).toBe(true);
    store.clear();
  });
});

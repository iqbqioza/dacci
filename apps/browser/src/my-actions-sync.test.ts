import type { NostrEvent } from "dacci-nostr-nips";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ME = "1".repeat(64);
const OTHER = "2".repeat(64);
const POST = "a".repeat(64);
const REACTION = "b".repeat(64);

class MemoryStorage {
  private readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

/** A NIP-25 reaction by the reader, naming the post it is on. */
function reaction(at = 1000): NostrEvent {
  return {
    id: REACTION,
    pubkey: ME,
    created_at: at,
    kind: 7,
    tags: [["e", POST]],
    content: "+",
    sig: "s".repeat(128),
  };
}

/** The reader's NIP-09 request taking that reaction back. */
function undo(at = 1100): NostrEvent {
  return {
    id: "c".repeat(64),
    pubkey: ME,
    created_at: at,
    kind: 5,
    tags: [["e", REACTION]],
    content: "",
    sig: "s".repeat(128),
  };
}

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A promise the test settles by hand, so a round can be held open. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  const storage = new MemoryStorage();
  (globalThis as { localStorage?: Storage }).localStorage =
    storage as unknown as Storage;
  // The store races every relay against a 5 s deadline, so a relay that never
  // answers is waited out by advancing the clock rather than by sitting here.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock("./nostr.js");
  vi.doUnmock("./relays.js");
  vi.doUnmock("./auth.js");
});

/**
 * The store signed in, with the transport answering per relay so a test can
 * make one relay answer and another stay silent.
 */
async function signedIn(
  answer: (url: string) => Promise<{ failed: boolean; events: NostrEvent[] }>,
): Promise<typeof import("./my-actions.js")> {
  vi.doMock("./auth.js", () => ({
    useAuth: () => ({ pubkey: () => ME }),
  }));
  vi.doMock("./relays.js", () => ({
    useRelays: () => ({ readRelays: () => ["wss://a", "wss://b"] }),
  }));
  vi.doMock("./nostr.js", () => ({
    getConnection: (url: string) => ({ url, query: () => answer(url) }),
  }));
  const store = await import("./my-actions.js");
  store.adoptMyActivity(ME);
  return store;
}

describe("reconciling with the relays", () => {
  it("throws away an answer that lands after the reader changed", async () => {
    // The round is raced against a 5 s deadline, so signing out and back in
    // while it is out is an ordinary outcome. This account's posts would then
    // carry the previous reader's reactions, and the next edit would write that
    // mixture under this account's key for good.
    let who: string | null = ME;
    vi.doMock("./auth.js", () => ({
      useAuth: () => ({ pubkey: () => who }),
    }));
    vi.doMock("./relays.js", () => ({
      useRelays: () => ({ readRelays: () => ["wss://a"] }),
    }));
    const gate = deferred<{ failed: boolean; events: NostrEvent[] }>();
    vi.doMock("./nostr.js", () => ({
      getConnection: () => ({ url: "wss://a", query: () => gate.promise }),
    }));
    const store = await import("./my-actions.js");
    store.adoptMyActivity(ME);

    const round = store.syncMyActivity();
    await tick();
    // The reader signs out and someone else signs in while the round is out.
    who = null;
    store.adoptMyActivity(null);
    who = OTHER;
    store.adoptMyActivity(OTHER);
    gate.resolve({ failed: false, events: [reaction()] });
    await round;

    // The answer was about ME and belongs to nobody here.
    expect(store.hasDone("react", POST)).toBe(false);
  });

  it("records an action under the account that signed, not the one on screen", async () => {
    // The publish resolves after a signing prompt and up to five seconds of
    // relay time. Recording against whoever signed in meanwhile would put an id
    // this account never signed into this account's stored map, and its action
    // row would offer to undo it with a NIP-09 under the wrong key.
    let who: string | null = ME;
    vi.doMock("./auth.js", () => ({
      useAuth: () => ({ pubkey: () => who }),
    }));
    vi.doMock("./relays.js", () => ({
      useRelays: () => ({ readRelays: () => ["wss://a"] }),
    }));
    vi.doMock("./nostr.js", () => ({
      getConnection: () => ({
        url: "wss://a",
        query: async () => ({ failed: true, events: [] }),
      }),
    }));
    const store = await import("./my-actions.js");
    store.adoptMyActivity(ME);

    // ME signs the reaction, then OTHER is on screen by the time it resolves.
    who = OTHER;
    store.adoptMyActivity(OTHER);
    store.markReacted(POST, REACTION, ME);

    expect(store.hasDone("react", POST)).toBe(false);
    // Recorded with the account it belongs to, the same account's own use does.
    who = ME;
    store.adoptMyActivity(ME);
    store.markReacted(POST, REACTION, ME);
    expect(store.hasDone("react", POST)).toBe(true);
  });

  it("keeps an action when one relay answers with nothing and another is silent", async () => {
    // One relay has nothing of the reader's; the other never answers. Neither
    // of them has seen the reader's whole history, so neither may say the
    // reaction never happened.
    const store = await signedIn(async (url) =>
      url === "wss://a"
        ? { failed: false, events: [] }
        : new Promise(() => {}),
    );
    store.markReacted(POST, REACTION);
    expect(store.hasDone("react", POST)).toBe(true);

    void store.syncMyActivity();
    await vi.advanceTimersByTimeAsync(6000);
    expect(store.hasDone("react", POST)).toBe(true);
    // And it must not be written away, or the loss survives the next reload.
    const persisted = localStorage.getItem(`dacci.my-activity:${ME}`);
    expect(persisted).toContain(POST);
  });

  it("keeps an action the queried window does not reach", async () => {
    // A full window means older events exist that were never asked for, so the
    // answer is not entitled to remove what it did not see.
    const full = Array.from({ length: 500 }, (_, i) => ({
      ...reaction(2000 + i),
      id: `${i.toString().padStart(4, "0")}`.padEnd(64, "0"),
      tags: [["e", `${i}`.padStart(64, "0")]],
    }));
    const store = await signedIn(async () => ({
      failed: false,
      events: full,
    }));
    store.markReacted(POST, REACTION);
    await store.syncMyActivity();
    expect(store.hasDone("react", POST)).toBe(true);
  });

  it("still undoes an action the relays show a NIP-09 request for", async () => {
    // The one thing an incomplete answer is allowed to remove: a deletion it
    // actually carries.
    const store = await signedIn(async (url) =>
      url === "wss://a"
        ? { failed: false, events: [reaction(), undo()] }
        : new Promise(() => {}),
    );
    store.markReacted(POST, REACTION);
    expect(store.hasDone("react", POST)).toBe(true);
    void store.syncMyActivity();
    await vi.advanceTimersByTimeAsync(6000);
    expect(store.hasDone("react", POST)).toBe(false);
  });

  it("takes the answer as the whole truth when every relay covers it", async () => {
    const store = await signedIn(async () => ({
      failed: false,
      events: [reaction()],
    }));
    store.markReacted(POST, REACTION);
    void store.syncMyActivity();
    await vi.advanceTimersByTimeAsync(100);
    // Kept, because the relays did report it.
    expect(store.hasDone("react", POST)).toBe(true);
    expect(store.activityFor(POST).react).toBe(REACTION);
  });

  it("leaves the state alone when no relay answers", async () => {
    // Every relay silent is not a relay saying the reader has done nothing.
    // Without this round actually being run, the guard that keeps the reader's
    // actions out of the erase path has no coverage at all — the test would
    // pass whatever the answer did.
    const store = await signedIn(
      async () => new Promise(() => {}) as Promise<{ failed: boolean; events: NostrEvent[] }>,
    );
    store.markReacted(POST, REACTION);
    expect(store.hasDone("react", POST)).toBe(true);

    const round = store.syncMyActivity();
    await vi.advanceTimersByTimeAsync(6000);
    await round;

    expect(store.hasDone("react", POST)).toBe(true);
    // And it must not be written away either, or the loss outlives a reload.
    expect(localStorage.getItem(`dacci.my-activity:${ME}`)).toContain(POST);
  });
});

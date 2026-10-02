import {
  fixturePubkey,
  forgedAs,
  signAs,
} from "./fixture-event.js";
import type { NostrEvent } from "dacci-nostr-nips";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ME = fixturePubkey("me");
const OTHER = fixturePubkey("other");
const POST = "a".repeat(64);

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

/**
 * A NIP-25 reaction by the reader, naming the post it is on.
 *
 * Signed, because reconciling against these events is what erases an action the
 * reader took, and an unsigned answer from a relay must not be able to do that.
 */
/** The fields of the reader's reaction, without the signing. */
function reactionFields() {
  return { created_at: 1000, kind: 7, tags: [["e", POST]], content: "+" };
}

function reaction(at = 1000): NostrEvent {
  return signAs("me", {
    created_at: at,
    kind: 7,
    tags: [["e", POST]],
    content: "+",
  });
}

/** The reader's NIP-09 request taking that reaction back. */
function undo(at = 1100): NostrEvent {
  return signAs("me", {
    created_at: at,
    kind: 5,
    tags: [["e", reactionId()]],
    content: "",
  });
}

/**
 * The id of the reaction `undo()` takes back.
 *
 * A real signature makes the id depend on every field including `created_at`, so
 * it cannot be a constant beside the fixture — and a fixture that pretended
 * otherwise was describing an event no client could have signed.
 */
function reactionId(): string {
  return reaction(1000).id;
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
    store.markReacted(POST, reactionId(), ME);

    expect(store.hasDone("react", POST)).toBe(false);
    // Recorded with the account it belongs to, the same account's own use does.
    who = ME;
    store.adoptMyActivity(ME);
    store.markReacted(POST, reactionId(), ME);
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
    store.markReacted(POST, reactionId());
    expect(store.hasDone("react", POST)).toBe(true);

    void store.syncMyActivity();
    await vi.advanceTimersByTimeAsync(6000);
    expect(store.hasDone("react", POST)).toBe(true);
    // And it must not be written away, or the loss survives the next reload.
    const persisted = localStorage.getItem(`dacci.my-activity:${ME}`);
    expect(persisted).toContain(POST);
  });

  it("keeps an action the queried window does not reach", { timeout: 20_000 }, async () => {
    // A full window means older events exist that were never asked for, so the
    // answer is not entitled to remove what it did not see.
    //
    // 50 is the window the app asks for, and a full one is the case this test
    // exists for: fewer than that and the store would treat the answer as the
    // whole truth. It is written out rather than imported because a test that
    // read the constant could not tell that the constant had changed.
    // Each reaction is signed separately, which is what it costs to fill a
    // window: the id is the hash of the author's own fields, so a fixture that
    // overwrote it was describing 500 events no client could have produced.
    const full = Array.from({ length: 50 }, (_, i) =>
      signAs("me", {
        created_at: 2000 + i,
        kind: 7,
        tags: [["e", `${i}`.padStart(64, "0")]],
        content: "+",
      }),
    );
    const store = await signedIn(async () => ({
      failed: false,
      events: full,
    }));
    store.markReacted(POST, reactionId());
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
    store.markReacted(POST, reactionId());
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
    store.markReacted(POST, reactionId());
    void store.syncMyActivity();
    await vi.advanceTimersByTimeAsync(100);
    // Kept, because the relays did report it.
    expect(store.hasDone("react", POST)).toBe(true);
    expect(store.activityFor(POST).react).toBe(reactionId());
  });

  it("leaves the state alone when no relay answers", async () => {
    // Every relay silent is not a relay saying the reader has done nothing.
    // Without this round actually being run, the guard that keeps the reader's
    // actions out of the erase path has no coverage at all — the test would
    // pass whatever the answer did.
    const store = await signedIn(
      async () => new Promise(() => {}) as Promise<{ failed: boolean; events: NostrEvent[] }>,
    );
    store.markReacted(POST, reactionId());
    expect(store.hasDone("react", POST)).toBe(true);

    const round = store.syncMyActivity();
    await vi.advanceTimersByTimeAsync(6000);
    await round;

    expect(store.hasDone("react", POST)).toBe(true);
    // And it must not be written away either, or the loss outlives a reload.
    expect(localStorage.getItem(`dacci.my-activity:${ME}`)).toContain(POST);
  });
});

describe("an answer the reader did not sign", () => {
  it("cannot erase an action the reader took", async () => {
    // Reconciling against these events is what removes an action, so an answer a
    // relay made up is an answer that deletes. The fixtures in this file are
    // signed, and saying so is not the same as feeding one unsigned: without
    // this, a reader's own reactions are kept because the store never sees an
    // unsigned answer, and the guard that keeps them has no coverage at all.
    // The forgery is for a *different* post, and that is what does the damage: a
    // complete answer replaces the whole activity map, so the reader's reaction
    // to POST is not in it and disappears. A forgery that mentioned POST would
    // merely re-add what was already there, which is not an erasure at all.
    const store = await signedIn(async () => ({
      failed: false,
      events: [
        forgedAs("me", {
          created_at: 1000,
          kind: 7,
          tags: [["e", "9".repeat(64)]],
          content: "+",
        }),
      ],
    }));
    store.markReacted(POST, reactionId(), ME);
    expect(store.hasDone("react", POST)).toBe(true);
    const round = store.syncMyActivity();
    await vi.advanceTimersByTimeAsync(6000);
    await round;
    // A relay that answered with nothing the reader signed has not said the
    // reader did nothing.
    expect(store.hasDone("react", POST)).toBe(true);
    expect(store.activityFor(POST).react).toBe(reactionId());
  });

  it("still takes a signed answer as the whole truth", async () => {
    // The other half, so the guard cannot be satisfied by simply never removing
    // anything: a signed answer that does not mention the action means the reader
    // undid it, and that has to be honoured.
    const store = await signedIn(async () => ({
      failed: false,
      events: [],
    }));
    store.markReacted(POST, reactionId(), ME);
    const round = store.syncMyActivity();
    await vi.advanceTimersByTimeAsync(100);
    await round;
    expect(store.hasDone("react", POST)).toBe(false);
  });
});

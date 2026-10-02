import type { NostrEvent } from "dacci-nostr-nips";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ME = "1".repeat(64);
const ALICE = "2".repeat(64);
const BOB = "3".repeat(64);

/** A relay answer the test releases when it chooses. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let release: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: release };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Who the fake vault is signed in as; the tests change this mid-flight. */
let signedInAs: string | null = ME;

/** The store is module level, so a fresh import gives a clean list. */
async function freshStore() {
  vi.resetModules();
  return import("./my-follows.js");
}

/** The kind 3 events a relay answers the list query with. */
function listEvent(tags: string[][], at = 2000, pubkey = ME): NostrEvent {
  return {
    id: "a".repeat(64),
    kind: 3,
    pubkey,
    created_at: at,
    content: "",
    tags,
    sig: "c".repeat(128),
  };
}

/** A relay that answers the list query, and records what was published. */
function answerWith(
  events: unknown[],
  published: unknown[] = [],
  options: { answer?: boolean } = {},
): void {
  const answering = options.answer ?? true;
  vi.doMock("./nostr.js", () => ({
    getConnection: (url: string) => ({
      url,
      query: async () =>
        answering ? { failed: false, events } : { failed: false, events: [] },
      publish: async (event: unknown) => {
        published.push(event);
        return { accepted: true };
      },
    }),
  }));
}

/** Waits for the list read the store kicked off to settle. */
async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.resetModules();
  signedInAs = ME;
  // The vault and the relay list are the only two things the store reaches
  // for, and both are answered here rather than by a real network.
  vi.doMock("./auth.jsx", () => ({
    useAuth: () => ({ pubkey: () => signedInAs }),
    getSigner: () => ({
      signEvent: async (template: unknown) => ({ ...(template as object) }),
    }),
  }));
  answerWith([listEvent([["p", ALICE]])]);
  vi.doMock("./relays.js", () => ({
    useRelays: () => ({
      readRelays: () => ["wss://read.example"],
      writeRelays: () => ["wss://write.example"],
    }),
    // The publisher reports each relay's outcome through this, so the store
    // keeps a per-relay state the panel shows.
    noteWriteResult: () => undefined,
  }));
});

afterEach(() => {
  vi.doUnmock("./auth.jsx");
  vi.doUnmock("./compose.js");
  vi.doUnmock("./nostr.js");
  vi.doUnmock("./relays.js");
});

describe("my follows", () => {
  it("knows who the reader follows once the list has been read", async () => {
    const store = await freshStore();
    store.requestMyFollows();
    await settled();
    expect(store.useFollowState(ALICE).following()).toBe(true);
    expect(store.useFollowState(BOB).following()).toBe(false);
  });

  it("asks for the list only once", async () => {
    const asked: unknown[] = [];
    vi.doMock("./nostr.js", () => ({
      getConnection: () => ({
        query: async (filter: unknown) => {
          asked.push(filter);
          return { failed: false, events: [listEvent([["p", ALICE]])] };
        },
      }),
    }));
    const store = await freshStore();
    store.requestMyFollows();
    await settled();
    store.requestMyFollows();
    store.requestMyFollows();
    await settled();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ kinds: [3], authors: [ME] });
  });

  it("stays unknown when no relay answered, so the button cannot lie", async () => {
    // A reader whose list could not be read must not be shown "フォロー": the
    // press would publish a list built from nothing and drop everyone else.
    vi.doMock("./nostr.js", () => ({
      getConnection: () => ({ query: async () => ({ failed: true }) }),
    }));
    const store = await freshStore();
    store.requestMyFollows();
    await settled();
    expect(store.useFollowState(ALICE).following()).toBeNull();
  });

  it("reads a reader who has never followed anyone as an empty list", async () => {
    // No kind 3 at all is a list with nobody in it, which is known: refusing
    // to ever follow would be worse than showing the button straight away.
    answerWith([]);
    const store = await freshStore();
    store.requestMyFollows();
    await settled();
    expect(store.useFollowState(ALICE).following()).toBe(false);
  });

  it("takes the newest list, because the kind is replaceable", async () => {
    answerWith([
      listEvent([["p", BOB]], 1000),
      listEvent([["p", ALICE], ["p", BOB]], 3000),
    ]);
    const store = await freshStore();
    store.requestMyFollows();
    await settled();
    expect(store.useFollowState(BOB).following()).toBe(true);
  });

  it("publishes the whole list with one more name in it", async () => {
    const published: unknown[] = [];
    answerWith([listEvent([["p", ALICE]])], published);
    const store = await freshStore();
    store.requestMyFollows();
    await settled();
    await store.useFollowState(BOB).toggle();
    // NIP-02 has no event for one follow: the list is republished whole, so the
    // people already in it have to survive.
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      kind: 3,
      pubkey: ME,
      tags: [["p", ALICE], ["p", BOB]],
    });
    expect(store.useFollowState(BOB).following()).toBe(true);
    expect(store.useFollowState(ALICE).following()).toBe(true);
  });

  it("keeps the relay hint of the people already in the list", async () => {
    const published: unknown[] = [];
    answerWith(
      [listEvent([["p", ALICE, "wss://relay.example", "alice"]])],
      published,
    );
    const store = await freshStore();
    store.requestMyFollows();
    await settled();
    await store.useFollowState(BOB).toggle();
    expect(published[0]).toMatchObject({
      tags: [["p", ALICE, "wss://relay.example", "alice"], ["p", BOB]],
    });
  });

  it("unfollows by publishing the list without the name", async () => {
    const published: unknown[] = [];
    answerWith([listEvent([["p", ALICE], ["p", BOB]])], published);
    const store = await freshStore();
    store.requestMyFollows();
    await settled();
    await store.useFollowState(ALICE).toggle();
    expect(published[0]).toMatchObject({ tags: [["p", BOB]] });
    expect(store.useFollowState(ALICE).following()).toBe(false);
  });

  it("refuses to publish while the list is still unknown", async () => {
    // Publishing from an empty list would silently unfollow everyone the
    // reader follows on every other client.
    const published: unknown[] = [];
    vi.doMock("./nostr.js", () => ({
      getConnection: () => ({ query: async () => ({ failed: true }) }),
      publish: async (event: unknown) => {
        published.push(event);
        return { accepted: true };
      },
    }));
    const store = await freshStore();
    store.requestMyFollows();
    await settled();
    await store.useFollowState(BOB).toggle();
    expect(published).toHaveLength(0);
    expect(store.useFollowState(BOB).following()).toBeNull();
  });

  it("reports a publish no relay accepted, and keeps the list as it was", async () => {
    vi.doMock("./compose.js", () => ({ publishEvent: async () => null }));
    const store = await freshStore();
    store.requestMyFollows();
    await settled();
    await store.useFollowState(BOB).toggle();
    expect(store.useFollowState(BOB).following()).toBe(false);
  });

  it("refuses to follow oneself", async () => {
    const published: unknown[] = [];
    answerWith([], published);
    const store = await freshStore();
    store.requestMyFollows();
    await settled();
    await store.useFollowState(ME).toggle();
    expect(published).toHaveLength(0);
  });

  it("does nothing while signed out", async () => {
    const published: unknown[] = [];
    answerWith([], published);
    const store = await freshStore();
    signedInAs = null;
    // Nobody follows anybody when there is no reader, which is known rather
    // than unknown, so the button is offered rather than stuck on loading.
    expect(store.useFollowState(ALICE).following()).toBe(false);
    await store.useFollowState(ALICE).toggle();
    expect(published).toHaveLength(0);
  });

  it("does not show one reader's list to another", async () => {
    const store = await freshStore();
    store.requestMyFollows();
    await settled();
    expect(store.useFollowState(ALICE).following()).toBe(true);
    signedInAs = "9".repeat(64);
    store.requestMyFollows();
    expect(store.useFollowState(ALICE).following()).toBeNull();
  });

  it("throws away a read that settles after the reader changed", async () => {
    // The list of the reader who signed out must never be written under the
    // key of the reader who signed in: publishing it would replace that
    // reader's whole follow list.
    const first = deferred<NostrEvent[]>();
    const second = deferred<NostrEvent[]>();
    const sent: unknown[] = [];
    let call = 0;
    vi.doMock("./nostr.js", () => ({
      getConnection: () => ({
        query: async () => {
          call += 1;
          const events = call === 1 ? await first.promise : await second.promise;
          return { failed: false, events };
        },
        publish: async (event: unknown) => {
          sent.push(event);
          return { accepted: true };
        },
      }),
    }));
    const store = await freshStore();
    store.requestMyFollows();
    await tick();
    // The reader signs out and someone else signs in while the read is out.
    signedInAs = "9".repeat(64);
    store.requestMyFollows();
    await tick();
    // The new reader's list answers first, then the old reader's does.
    second.resolve([listEvent([["p", BOB]], 2000, "9".repeat(64))]);
    await settled();
    first.resolve([listEvent([["p", ALICE]], 2000, ME)]);
    await settled();
    expect(store.useFollowState(ALICE).following()).toBe(false);
    expect(store.useFollowState(BOB).following()).toBe(true);
    // And nothing of the first reader's list can be published.
    await store.useFollowState(ALICE).toggle();
    expect(sent[0]).toMatchObject({ tags: [["p", BOB], ["p", ALICE]] });
  });

  it("reads the new reader's list even when the old read is still out", async () => {
    // The old read must not leave `pending` set, or the new reader's own read
    // is never asked for and the button waits for nothing.
    const first = deferred<NostrEvent[]>();
    let call = 0;
    vi.doMock("./nostr.js", () => ({
      getConnection: () => ({
        query: async () => {
          call += 1;
          return call === 1
            ? { failed: false, events: await first.promise }
            : { failed: false, events: [] };
        },
      }),
    }));
    const store = await freshStore();
    store.requestMyFollows();
    await tick();
    signedInAs = "9".repeat(64);
    store.requestMyFollows();
    await settled();
    expect(call).toBe(2);
    expect(store.useFollowState(ALICE).following()).toBe(false);
    first.resolve([]);
    await settled();
  });

  it("forgets the list on a reset, so it is read again", async () => {
    const store = await freshStore();
    store.requestMyFollows();
    await settled();
    store.resetMyFollows();
    expect(store.useFollowState(ALICE).following()).toBeNull();
  });
});
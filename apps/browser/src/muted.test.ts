import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ME = "1".repeat(64);
const ALICE = "2".repeat(64);
const BOB = "3".repeat(64);

let signedInAs: string | null = ME;

async function freshStore() {
  vi.resetModules();
  return import("./muted.js");
}

/** The kind 10000 events a relay answers the list query with. */
function listEvent(tags: string[][], at = 2000): unknown {
  return {
    id: "a".repeat(64),
    kind: 10000,
    pubkey: ME,
    created_at: at,
    content: "",
    tags,
    sig: "c".repeat(128),
  };
}

function answerWith(
  events: unknown[],
  published: unknown[] = [],
  options: { answering?: boolean } = {},
): void {
  const answering = options.answering ?? true;
  vi.doMock("./nostr.js", () => ({
    getConnection: (url: string) => ({
      url,
      query: async () => (answering ? { failed: false, events } : { failed: true }),
      publish: async (event: unknown) => {
        published.push(event);
        return { accepted: true };
      },
    }),
  }));
}

async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.resetModules();
  signedInAs = ME;
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
    noteWriteResult: () => undefined,
  }));
});

afterEach(() => {
  vi.doUnmock("./auth.jsx");
  vi.doUnmock("./compose.js");
  vi.doUnmock("./nostr.js");
  vi.doUnmock("./relays.js");
});

describe("my mutes", () => {
  it("knows who is muted once the list has been read", async () => {
    const store = await freshStore();
    store.requestMyMutes();
    await settled();
    expect(store.useMuteState(ALICE).muted()).toBe(true);
    expect(store.useMuteState(BOB).muted()).toBe(false);
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
    store.requestMyMutes();
    await settled();
    store.requestMyMutes();
    await settled();
    // NIP-51 kind 10000, read on its own so the list is not lost to whatever
    // window a shared query would have.
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ kinds: [10000], authors: [ME] });
  });

  it("stays unknown when no relay answered, so the row cannot lie", async () => {
    answerWith([], [], { answering: false });
    const store = await freshStore();
    store.requestMyMutes();
    await settled();
    expect(store.useMuteState(ALICE).muted()).toBeNull();
  });

  it("reads a reader who has never muted anyone as an empty list", async () => {
    answerWith([]);
    const store = await freshStore();
    store.requestMyMutes();
    await settled();
    expect(store.useMuteState(ALICE).muted()).toBe(false);
  });

  it("takes the newest list, because the kind is replaceable", async () => {
    answerWith([
      listEvent([["p", ALICE]], 1000),
      listEvent([["p", ALICE], ["p", BOB]], 3000),
    ]);
    const store = await freshStore();
    store.requestMyMutes();
    await settled();
    expect(store.useMuteState(BOB).muted()).toBe(true);
  });

  it("republishes the whole list with one more name in it", async () => {
    const published: unknown[] = [];
    answerWith([listEvent([["p", ALICE]])], published);
    const store = await freshStore();
    store.requestMyMutes();
    await settled();
    await store.useMuteState(BOB).toggle();
    expect(published[0]).toMatchObject({
      kind: 10000,
      pubkey: ME,
      tags: [["p", ALICE], ["p", BOB]],
    });
    expect(store.useMuteState(BOB).muted()).toBe(true);
  });

  it("keeps the hashtags and words of the list when a name is added", async () => {
    // NIP-51 lets a mute list hold those too, and republishing the list to add
    // one person must not delete them.
    const published: unknown[] = [];
    answerWith([listEvent([["p", ALICE], ["word", "scam"]])], published);
    const store = await freshStore();
    store.requestMyMutes();
    await settled();
    await store.useMuteState(BOB).toggle();
    expect(published[0]).toMatchObject({
      tags: [["p", ALICE], ["word", "scam"], ["p", BOB]],
    });
  });

  it("unmutes by publishing the list without the name", async () => {
    const published: unknown[] = [];
    answerWith([listEvent([["p", ALICE], ["p", BOB]])], published);
    const store = await freshStore();
    store.requestMyMutes();
    await settled();
    await store.useMuteState(ALICE).toggle();
    expect(published[0]).toMatchObject({ tags: [["p", BOB]] });
    expect(store.useMuteState(ALICE).muted()).toBe(false);
  });

  it("refuses to publish while the list is still unknown", async () => {
    // A list that was never read is not an empty list: publishing one built
    // from it would un-mute everyone, in every client.
    const published: unknown[] = [];
    answerWith([], published, { answering: false });
    const store = await freshStore();
    store.requestMyMutes();
    await settled();
    await store.useMuteState(BOB).toggle();
    expect(published).toHaveLength(0);
    expect(store.useMuteState(BOB).muted()).toBeNull();
  });

  it("keeps the list as it was when no relay took the request", async () => {
    vi.doMock("./compose.js", () => ({ publishEvent: async () => null }));
    const store = await freshStore();
    store.requestMyMutes();
    await settled();
    await store.useMuteState(BOB).toggle();
    expect(store.useMuteState(BOB).muted()).toBe(false);
  });

  it("refuses to mute oneself", async () => {
    const published: unknown[] = [];
    answerWith([], published);
    const store = await freshStore();
    store.requestMyMutes();
    await settled();
    await store.useMuteState(ME).toggle();
    expect(published).toHaveLength(0);
  });

  it("does nothing while signed out", async () => {
    const published: unknown[] = [];
    answerWith([], published);
    const store = await freshStore();
    signedInAs = null;
    // Nobody mutes anybody when there is no reader, which is known rather than
    // unknown, so the row is offered rather than stuck on loading.
    expect(store.useMuteState(ALICE).muted()).toBe(false);
    await store.useMuteState(ALICE).toggle();
    expect(published).toHaveLength(0);
  });

  it("does not show one reader's list to another", async () => {
    const store = await freshStore();
    store.requestMyMutes();
    await settled();
    expect(store.useMuteState(ALICE).muted()).toBe(true);
    signedInAs = "9".repeat(64);
    store.requestMyMutes();
    expect(store.useMuteState(ALICE).muted()).toBeNull();
  });

  it("forgets the list on a reset, so it is read again", async () => {
    const store = await freshStore();
    store.requestMyMutes();
    await settled();
    store.resetMyMutes();
    expect(store.useMuteState(ALICE).muted()).toBeNull();
  });
});

describe("which posts a mute covers", () => {
  it("hides a muted author's posts, and only once the list is read", async () => {
    answerWith([listEvent([["p", ALICE]])]);
    const store = await freshStore();
    // Before the list is read nothing is muted, because a feed that hid posts
    // on a guess would be hiding posts nobody asked it to hide.
    expect(store.isMutedAuthor(ALICE)).toBe(false);
    store.requestMyMutes();
    await settled();
    expect(store.isMutedAuthor(ALICE)).toBe(true);
    expect(store.isMutedAuthor(BOB)).toBe(false);
  });
});
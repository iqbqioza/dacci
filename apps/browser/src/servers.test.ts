import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addServer, BUILTIN_SERVERS, removeServer } from "./servers.js";

/** The store is module level, so a fresh import gives a clean list. */
async function freshStore() {
  vi.resetModules();
  return import("./servers.js");
}

/** The servers the reader configured, without the app's own. */
function own(store: Awaited<ReturnType<typeof freshStore>>): string[] {
  return store
    .useUploadServers()
    .mine()
    .map((server) => server.url);
}

/** The store persists to localStorage, which node has no. */
function useFakeStorage(): void {
  const store = new Map<string, string>();
  const fake: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => [...store.keys()][index] ?? null,
    removeItem: (key: string) => void store.delete(key),
    setItem: (key: string, value: string) => void store.set(key, value),
  };
  (globalThis as { localStorage?: Storage }).localStorage = fake;
}

/** A relay that answers the list query with a fixed set of events. */
function answerWith(
  events: unknown[],
  asked: unknown[] = [],
): void {
  vi.doMock("./nostr.js", () => ({
    getConnection: (url: string) => ({
      url,
      query: async (filter: unknown) => {
        asked.push(filter);
        return { failed: false, events };
      },
    }),
  }));
}

/** A kind 10063 list event, as a client would have published it. */
function listEvent(
  urls: string[],
  options: { kind?: number; at?: number; id?: string } = {},
): unknown {
  return {
    id: options.id ?? "b".repeat(64),
    kind: options.kind ?? 10063,
    created_at: options.at ?? 2000,
    content: "",
    tags: urls.map((url) => ["server", url]),
  };
}

beforeEach(() => {
  useFakeStorage();
  // The store publishes on every edit, so the relay layer is stubbed out
  // unless a test asks for the published shape.
  vi.resetModules();
  vi.doMock("./compose.js", () => ({ publishEvent: async () => null }));
  vi.doMock("./auth.js", () => ({ useAuth: () => ({ pubkey: () => null }) }));
  answerWith([]);
  vi.doMock("./relays.js", () => ({
    useRelays: () => ({ readRelays: () => ["wss://read.example"] }),
  }));
});

afterEach(() => {
  vi.doUnmock("./auth.js");
  vi.doUnmock("./nostr.js");
  vi.doUnmock("./relays.js");
});

describe("upload servers", () => {
  it("offers the built-in servers before the reader has added any", async () => {
    const store = await freshStore();
    // The app's own servers are the floor, so a reader who has configured
    // nothing still has somewhere to upload.
    expect(store.useUploadServers().all()).toEqual(BUILTIN_SERVERS);
  });

  it("puts a reader's own server below the built-in ones", async () => {
    const store = await freshStore();
    expect(store.addServer("https://my.blossom.example")).toBe("ok");
    const all = store.useUploadServers().all();
    expect(all.slice(0, BUILTIN_SERVERS.length)).toEqual(BUILTIN_SERVERS);
    expect(all[all.length - 1].url).toBe("https://my.blossom.example");
  });

  it("refuses a url that is not http(s)", async () => {
    const store = await freshStore();
    expect(store.addServer("ftp://files.example")).toBe("invalid");
    expect(store.addServer("files.example")).toBe("invalid");
    expect(store.addServer("")).toBe("invalid");
    expect(store.useUploadServers().all()).toEqual(BUILTIN_SERVERS);
  });

  it("refuses the same server twice, ignoring a trailing slash", async () => {
    const store = await freshStore();
    expect(store.addServer("https://files.example/")).toBe("ok");
    expect(store.addServer("https://files.example")).toBe("duplicate");
    expect(own(store)).toEqual(["https://files.example"]);
  });

  it("refuses one the app already offers, so it is not listed twice", async () => {
    const store = await freshStore();
    expect(store.addServer(BUILTIN_SERVERS[0].url)).toBe("duplicate");
    expect(
      store.useUploadServers().all().filter((s) => s.url === BUILTIN_SERVERS[0].url),
    ).toHaveLength(1);
  });

  it("removes a server", async () => {
    const store = await freshStore();
    store.addServer("https://files.example");
    store.removeServer("https://files.example");
    expect(own(store)).toEqual([]);
    // The app's own are not the reader's, so removing one changes nothing.
    expect(store.useUploadServers().all()).toEqual(BUILTIN_SERVERS);
  });

  it("keeps the list across a reload", async () => {
    const store = await freshStore();
    store.addServer("https://my.blossom.example");
    // A reload is a fresh module, so the stored list is what carries over.
    const reloaded = await freshStore();
    expect(own(reloaded)).toEqual(["https://my.blossom.example"]);
  });

  it("keeps the built-in servers when the stored list is unusable", async () => {
    localStorage.setItem("dacci.servers", "{ not json");
    const store = await freshStore();
    await store.loadServers();
    expect(store.useUploadServers().all()).toEqual(BUILTIN_SERVERS);
  });

  it("keeps a built-in once when a published list names it too", async () => {
    // A list published on another client can name a server the app already
    // offers, and the reader should not see the same address twice.
    const pubkey = "a".repeat(64);
    const first = BUILTIN_SERVERS[0].url;
    vi.resetModules();
    vi.doMock("./auth.js", () => ({ useAuth: () => ({ pubkey: () => pubkey }) }));
    vi.doMock("./compose.js", () => ({ publishEvent: async () => null }));
    answerWith([listEvent([first, "https://other.example"])]);
    const store = await import("./servers.js");
    await store.loadServers();
    const urls = store.useUploadServers().all().map((s) => s.url);
    expect(urls.filter((url) => url === first)).toHaveLength(1);
    expect(urls).toContain("https://other.example");
  });
});

describe("loadServers", () => {
  it("reads the published list when signed in", async () => {
    const pubkey = "a".repeat(64);
    const asked: unknown[] = [];
    vi.resetModules();
    vi.doMock("./auth.js", () => ({ useAuth: () => ({ pubkey: () => pubkey }) }));
    vi.doMock("./compose.js", () => ({ publishEvent: async () => null }));
    answerWith([listEvent(["https://published.example"])], asked);

    const store = await import("./servers.js");
    await store.loadServers();
    expect(own(store)).toEqual(["https://published.example"]);
    expect(asked).toHaveLength(1);
  });

  it("keeps the stored list when the account published nothing", async () => {
    const pubkey = "a".repeat(64);
    vi.resetModules();
    vi.doMock("./auth.js", () => ({ useAuth: () => ({ pubkey: () => pubkey }) }));
    vi.doMock("./compose.js", () => ({ publishEvent: async () => null }));
    answerWith([]);
    const store = await import("./servers.js");
    await store.loadServers();
    // Nothing published, so the app's own servers are still what is offered.
    expect(store.useUploadServers().all()).toEqual(BUILTIN_SERVERS);
  });

  it("asks for both list kinds in one filter", async () => {
    const pubkey = "a".repeat(64);
    const asked: unknown[] = [];
    vi.resetModules();
    vi.doMock("./auth.js", () => ({ useAuth: () => ({ pubkey: () => pubkey }) }));
    vi.doMock("./compose.js", () => ({ publishEvent: async () => null }));
    answerWith([], asked);
    const store = await import("./servers.js");
    await store.loadServers();
    // One round covers both, and a NIP-96 list is still worth reading.
    expect(asked).toEqual([{ kinds: [10063, 10096], authors: [pubkey] }]);
  });

  it("reads a list published under the deprecated kind 10096 too", async () => {
    const pubkey = "a".repeat(64);
    vi.resetModules();
    vi.doMock("./auth.js", () => ({ useAuth: () => ({ pubkey: () => pubkey }) }));
    vi.doMock("./compose.js", () => ({ publishEvent: async () => null }));
    // The account only has the deprecated kind, and the relay answers the list
    // query with it rather than with nothing.
    answerWith([listEvent(["https://old.example"], { kind: 10096 })]);
    const store = await import("./servers.js");
    await store.loadServers();
    expect(own(store)).toEqual(["https://old.example"]);
  });

  it("serves both kinds when the account published each", async () => {
    const pubkey = "a".repeat(64);
    vi.resetModules();
    vi.doMock("./auth.js", () => ({ useAuth: () => ({ pubkey: () => pubkey }) }));
    vi.doMock("./compose.js", () => ({ publishEvent: async () => null }));
    answerWith([
      listEvent(["https://current.example"], { kind: 10063, at: 1000 }),
      listEvent(["https://older.example"], { kind: 10096, at: 3000, id: "c".repeat(64) }),
    ]);
    const store = await import("./servers.js");
    await store.loadServers();
    // A reader who moved from the old kind to the new one keeps the servers
    // they had, since the old event is not superseded.
    expect(own(store).sort()).toEqual([
      "https://current.example",
      "https://older.example",
    ]);
  });

  it("keeps only the newest copy of a replaceable event", async () => {
    const pubkey = "a".repeat(64);
    vi.resetModules();
    vi.doMock("./auth.js", () => ({ useAuth: () => ({ pubkey: () => pubkey }) }));
    vi.doMock("./compose.js", () => ({ publishEvent: async () => null }));
    // Two relays holding different versions of the same replaceable list:
    // one has caught up, the other still answers with the previous copy.
    vi.doMock("./nostr.js", () => ({
      getConnection: (url: string) => ({
        url,
        query: async () => ({
          failed: false,
          events: [
            listEvent(["https://new.example"], { at: 2000 }),
            listEvent(["https://old.example"], { at: 1000, id: "c".repeat(64) }),
          ],
        }),
      }),
    }));
    const store = await import("./servers.js");
    await store.loadServers();
    // The stale copy must not put back a server the reader removed.
    expect(own(store)).toEqual(["https://new.example"]);
  });

  it("ignores an event of another kind that a relay returns anyway", async () => {
    const pubkey = "a".repeat(64);
    vi.resetModules();
    vi.doMock("./auth.js", () => ({ useAuth: () => ({ pubkey: () => pubkey }) }));
    vi.doMock("./compose.js", () => ({ publishEvent: async () => null }));
    // A relay is free to answer with more than it was asked for. The
    // account's only real list is the deprecated kind; everything else here is
    // someone else's data.
    answerWith([
      listEvent(["https://old.example"], { kind: 10096, at: 1000 }),
      {
        id: "d".repeat(64),
        kind: 30078,
        created_at: 3000,
        content: "https://not-ours.example",
        tags: [["d", "some-other-app"]],
      },
    ]);
    const store = await import("./servers.js");
    await store.loadServers();
    // Another app's private record must not become a server.
    expect(own(store)).toEqual(["https://old.example"]);
  });

  it("serves overlapping callers one round of queries", async () => {
    const pubkey = "a".repeat(64);
    let rounds = 0;
    vi.resetModules();
    vi.doMock("./auth.js", () => ({ useAuth: () => ({ pubkey: () => pubkey }) }));
    vi.doMock("./compose.js", () => ({ publishEvent: async () => null }));
    vi.doMock("./nostr.js", () => ({
      getConnection: (url: string) => ({
        url,
        query: async () => {
          rounds += 1;
          return { failed: false, events: [] };
        },
      }),
    }));
    const store = await import("./servers.js");
    // The start of the app can ask from the session restore and from the
    // identity change at once; that must not double the relay traffic.
    await Promise.all([store.loadServers(), store.loadServers(), store.loadServers()]);
    expect(rounds).toBe(1);
  });

  it("does not let a late relay answer undo a change just made", async () => {
    const pubkey = "a".repeat(64);
    let answer: unknown[] = [];
    vi.resetModules();
    vi.doMock("./auth.js", () => ({ useAuth: () => ({ pubkey: () => pubkey }) }));
    vi.doMock("./compose.js", () => ({
      publishEvent: async (template: Record<string, unknown>) => ({
        ...template,
        id: "f".repeat(64),
        sig: "e".repeat(128),
      }),
    }));
    vi.doMock("./nostr.js", () => ({
      getConnection: (url: string) => ({
        url,
        query: async () => ({ failed: false, events: answer }),
      }),
    }));
    const store = await import("./servers.js");
    await store.addServerAndPublish("https://mine.example");
    // The relay still answers with the list from before the edit, published
    // earlier than the one the reader just wrote.
    answer = [listEvent(["https://stale.example"], { at: 1 })];
    await store.loadServers();
    expect(own(store)).toEqual(["https://mine.example"]);
  });

  it("brings in a list published on another client", async () => {
    const pubkey = "a".repeat(64);
    let answer: unknown[] = [];
    vi.resetModules();
    vi.doMock("./auth.js", () => ({ useAuth: () => ({ pubkey: () => pubkey }) }));
    vi.doMock("./compose.js", () => ({ publishEvent: async () => null }));
    vi.doMock("./nostr.js", () => ({
      getConnection: (url: string) => ({
        url,
        query: async () => ({ failed: false, events: answer }),
      }),
    }));
    const store = await import("./servers.js");
    store.addServer("https://mine.example");
    answer = [listEvent(["https://elsewhere.example"], { at: 4000 })];
    await store.loadServers();
    expect(own(store)).toEqual(["https://elsewhere.example"]);
  });
});

describe("publishServers", () => {
  /** A signed-in store whose publishes are recorded instead of sent. */
  async function signedIn() {
    const pubkey = "a".repeat(64);
    const sent: Array<Record<string, unknown>> = [];
    vi.resetModules();
    vi.doMock("./auth.js", () => ({ useAuth: () => ({ pubkey: () => pubkey }) }));
    vi.doMock("./compose.js", () => ({
      publishEvent: async (template: Record<string, unknown>) => {
        sent.push(template);
        return { ...template, id: "f".repeat(64), sig: "e".repeat(128) };
      },
    }));
    return { store: await import("./servers.js"), sent, pubkey };
  }

  it("publishes the list as a kind 10063 (BUD-03) event when a server is added", async () => {
    const { store, sent, pubkey } = await signedIn();
    await store.addServerAndPublish("https://my.blossom.example");

    // One event, and every listed server a `server` tag, so another client
    // reads the same list from the same event.
    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe(10063);
    expect(sent[0].pubkey).toBe(pubkey);
    expect(sent[0].tags).toEqual([["server", "https://my.blossom.example"]]);
    // BUD-03 says the content field is not used, so it stays empty.
    expect(sent[0].content).toBe("");
  });

  it("publishes only the reader's own servers, never the app's", async () => {
    const { store, sent } = await signedIn();
    await store.addServerAndPublish("https://my.blossom.example");

    // BUD-03 has a client upload to the first server in the list, so a
    // client's own defaults written there would take uploads away from the
    // server the reader chose.
    expect(sent[0].tags).toEqual([["server", "https://my.blossom.example"]]);
  });

  it("publishes the shortened list when a server is removed", async () => {
    const { store, sent } = await signedIn();
    store.addServer("https://files.example");
    await store.removeServerAndPublish("https://files.example");
    expect(sent[0].tags).toEqual([]);
  });

  it("publishes nothing when the reader is not signed in", async () => {
    const store = await freshStore();
    store.addServer("https://files.example");
    // Without a key there is nothing to sign with, and the local list still
    // holds for this browser.
    expect(await store.publishServers()).toBe(false);
    expect(own(store)).toEqual(["https://files.example"]);
  });
});

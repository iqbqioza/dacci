import type { NostrEvent } from "dacci-nostr-nips";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addServer, BUILTIN_SERVERS, removeServer } from "./servers.js";
import {
  fixturePubkey,
  forgedAs,
  signAs,
} from "./fixture-event.js";

/** The account whose BUD-03 list these tests publish. */
const READER = fixturePubkey("reader");

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

/**
 * A kind 10063 list event, as a client would have published it.
 *
 * Signed, because this list is where the app sends the reader's uploads. A relay
 * that could serve one the reader never signed would be choosing where their
 * signed Blossom and NIP-98 authorizations go.
 */
function listEvent(
  urls: string[],
  options: { kind?: number; at?: number; author?: string } = {},
): NostrEvent {
  return signAs(options.author ?? "reader", {
    kind: options.kind ?? 10063,
    created_at: options.at ?? 2000,
    content: "",
    tags: urls.map((url) => ["server", url]),
  });
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
    const pubkey = READER;
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
    const pubkey = READER;
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
    const pubkey = READER;
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
    const pubkey = READER;
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
    const pubkey = READER;
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
    const pubkey = READER;
    vi.resetModules();
    vi.doMock("./auth.js", () => ({ useAuth: () => ({ pubkey: () => pubkey }) }));
    vi.doMock("./compose.js", () => ({ publishEvent: async () => null }));
    answerWith([
      listEvent(["https://current.example"], { kind: 10063, at: 1000 }),
      listEvent(["https://older.example"], { kind: 10096, at: 3000 }),
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
    const pubkey = READER;
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
            listEvent(["https://old.example"], { at: 1000 }),
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
    const pubkey = READER;
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
    const pubkey = READER;
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
    const pubkey = READER;
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
    // The account's list is read first, which is what lets it be written at all.
    await store.loadServers();
    await store.addServerAndPublish("https://mine.example");
    // The relay still answers with the list from before the edit, published
    // earlier than the one the reader just wrote.
    answer = [listEvent(["https://stale.example"], { at: 1 })];
    await store.loadServers();
    expect(own(store)).toEqual(["https://mine.example"]);
  });

  it("does not publish a list it never read", async () => {
    // The servers on this device may be all this device ever saw, and BUD-03
    // replaces the whole list, so writing them would delete every server the
    // reader configured on another client.
    const pubkey = READER;
    const sent: unknown[] = [];
    vi.resetModules();
    vi.doMock("./auth.js", () => ({ useAuth: () => ({ pubkey: () => pubkey }) }));
    vi.doMock("./compose.js", () => ({
      publishEvent: async (template: Record<string, unknown>) => {
        sent.push(template);
        return { ...template, id: "f".repeat(64), sig: "e".repeat(128) };
      },
    }));
    // Every relay refuses, so the round never answered.
    vi.doMock("./nostr.js", () => ({
      getConnection: () => ({
        url: "wss://read.example",
        query: async () => ({ failed: true, events: [] }),
      }),
    }));
    const store = await import("./servers.js");
    await store.loadServers();
    await store.addServerAndPublish("https://my.blossom.example");
    expect(sent).toEqual([]);
    // The edit is still on screen; it just was not published.
    expect(own(store)).toEqual(["https://my.blossom.example"]);
  });

  it("does not publish one account's read on behalf of the next", async () => {
    // The gate has to belong to the account, not to the app. Signing out reads
    // no list but has nothing to publish, and treating that as "read" left the
    // gate open for whoever signed in next — so an account whose own list was
    // never read could publish this device's list and lose their own servers.
    let pubkey: string | null = READER;
    let answering = true;
    const sent: unknown[] = [];
    vi.resetModules();
    vi.doMock("./auth.js", () => ({ useAuth: () => ({ pubkey: () => pubkey }) }));
    vi.doMock("./compose.js", () => ({
      publishEvent: async (template: Record<string, unknown>) => {
        sent.push(template);
        return { ...template, id: "f".repeat(64), sig: "e".repeat(128) };
      },
    }));
    vi.doMock("./nostr.js", () => ({
      getConnection: () => ({
        url: "wss://read.example",
        query: async () =>
          answering
            ? { failed: false, events: [] }
            : { failed: true, events: [] },
      }),
    }));
    const store = await import("./servers.js");

    // The first account's list is read and answered, so its gate opens.
    await store.loadServers();

    // Signing out reads nothing and has nothing to publish.
    answering = false;
    pubkey = null;
    await store.loadServers();

    // A different account signs in, and its own list is never answered.
    pubkey = "b".repeat(64);
    await store.loadServers();
    await store.addServerAndPublish("https://my.blossom.example");

    // That account's list was never read, so nothing goes out under it — even
    // though an earlier account's read is still on file.
    expect(sent).toEqual([]);
  });

  it("still publishes for an account whose own list has been read", async () => {
    // The guard above only refuses the wrong account. Pinning the other half
    // matters as much: a gate that never opens is worse than no gate.
    const pubkey = READER;
    const sent: unknown[] = [];
    vi.resetModules();
    vi.doMock("./auth.js", () => ({ useAuth: () => ({ pubkey: () => pubkey }) }));
    vi.doMock("./compose.js", () => ({
      publishEvent: async (template: Record<string, unknown>) => {
        sent.push(template);
        return { ...template, id: "f".repeat(64), sig: "e".repeat(128) };
      },
    }));
    vi.doMock("./nostr.js", () => ({
      getConnection: () => ({
        url: "wss://read.example",
        query: async () => ({ failed: false, events: [] }),
      }),
    }));
    const store = await import("./servers.js");
    await store.loadServers();
    await store.addServerAndPublish("https://my.blossom.example");
    expect(sent).toHaveLength(1);
  });

  it("publishes once the list has been read, even when nothing was published", async () => {
    // Asked and answered with nothing is an answer: it says the account has no
    // list, so publishing one cannot lose anything.
    const pubkey = READER;
    const sent: unknown[] = [];
    vi.resetModules();
    vi.doMock("./auth.js", () => ({ useAuth: () => ({ pubkey: () => pubkey }) }));
    vi.doMock("./compose.js", () => ({
      publishEvent: async (template: Record<string, unknown>) => {
        sent.push(template);
        return { ...template, id: "f".repeat(64), sig: "e".repeat(128) };
      },
    }));
    answerWith([]);
    const store = await import("./servers.js");
    await store.loadServers();
    await store.addServerAndPublish("https://my.blossom.example");
    expect(sent).toHaveLength(1);
  });

  it("brings in a list published on another client", async () => {
    const pubkey = READER;
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
    const pubkey = READER;
    const sent: Array<Record<string, unknown>> = [];
    vi.resetModules();
    vi.doMock("./auth.js", () => ({ useAuth: () => ({ pubkey: () => pubkey }) }));
    vi.doMock("./compose.js", () => ({
      publishEvent: async (template: Record<string, unknown>) => {
        sent.push(template);
        return { ...template, id: "f".repeat(64), sig: "e".repeat(128) };
      },
    }));
    // The account's published list is read before anything is written: a list
    // this device never read must not be published as the account's.
    answerWith([]);
    const store = await import("./servers.js");
    await store.loadServers();
    return { store, sent, pubkey };
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

describe("an answer that is not worth verifying in full", () => {
  /** How many times the expensive check ran, which is what this is about. */
  let verified: number;

  beforeEach(() => {
    verified = 0;
    vi.doMock("./authored.js", async (importOriginal) => {
      const real = await importOriginal<typeof import("./authored.js")>();
      return {
        ...real,
        isSignedBy: (event: NostrEvent, pubkey: string): boolean => {
          verified += 1;
          return real.isSignedBy(event, pubkey);
        },
      };
    });
  });

  it("does not spend the tab on a relay's worth of forgeries", { timeout: 20_000 }, async () => {
    // The filter carries no `limit` on purpose — relays disagree about which
    // kinds they store, so every reply is merged. That makes the answer the one
    // unbounded input here, and a signature check is hundreds of times the cost
    // of the id check. Verifying before narrowing meant one relay could spend the
    // reader's main thread on every app start, for events nothing would read.
    //
    // The budget is generous because building a hundred signed fixtures is real
    // work, and a test that fails when the machine is busy is not a test.
    const READER = fixturePubkey("reader");
    const forged = Array.from({ length: 100 }, (_, i) =>
      forgedAs("reader", {
        created_at: 2000 + i,
        kind: 10063,
        content: "",
        tags: [["server", `https://forged-${i}.example`]],
      }),
    );
    vi.resetModules();
    vi.doMock("./auth.js", () => ({ useAuth: () => ({ pubkey: () => READER }) }));
    vi.doMock("./nostr.js", () => ({
      getConnection: () => ({
        url: "wss://a",
        query: async () => ({ failed: false, events: forged }),
      }),
    }));
    const store = await import("./servers.js");

    await store.loadServers();

    // Nothing forged is used, and the tab was not held. The budget is counted
    // rather than timed: a wall-clock assertion here would only say which machine
    // the suite ran on, and would pass on a fast one however wrong the order is.
    expect(
      store.useUploadServers().all().map((s: { url: string }) => s.url),
    ).not.toContain("https://forged-0.example");
    // A handful, not a hundred: the walk is bounded per kind, whatever the
    // relay chose to send.
    expect(verified).toBeLessThanOrEqual(4 * 2);
  });

  it("still uses the real list when a newer forgery is merged in beside it", async () => {
    // Relays merge, so a forgery timestamped newer arrives alongside the truth.
    // Narrowing to the newest per kind and stopping there would drop the forgery
    // and throw the real event away with it, leaving the reader on the built-in
    // servers for no reason at all.
    const READER = fixturePubkey("reader");
    vi.resetModules();
    vi.doMock("./auth.js", () => ({ useAuth: () => ({ pubkey: () => READER }) }));
    vi.doMock("./nostr.js", () => ({
      getConnection: () => ({
        url: "wss://a",
        query: async () => ({
          failed: false,
          events: [
            listEvent(["https://mine.example"], { at: 1000 }),
            forgedAs("reader", {
              created_at: 9000,
              kind: 10063,
              content: "",
              tags: [["server", "https://attacker.example"]],
            }),
          ],
        }),
      }),
    }));
    const store = await import("./servers.js");
    await store.loadServers();

    const urls = store.useUploadServers().all().map((s: { url: string }) => s.url);
    expect(urls).toContain("https://mine.example");
    expect(urls).not.toContain("https://attacker.example");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { loginWithNsec, logout, restoreSession, useAuth } from "./auth.jsx";
import { useFeed } from "./relays.js";

function stubStorage() {
  const store = new Map<string, string>();
  const session = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => session.get(key) ?? null,
    setItem: (key: string, value: string) => void session.set(key, value),
    removeItem: (key: string) => void session.delete(key),
  });
  return { store, session };
}

const PUBKEY = "b".repeat(64);

/**
 * Whether the relay connection the mock below hands out is holding a signer.
 *
 * The only thing that mock records about a connection, and the thing signing out
 * exists to change: what the reader can publish with is decided here, not by any
 * signal the interface draws.
 */
let lastConnection: { hasSigner: boolean } | null = null;
function connectionSigner(): boolean {
  return lastConnection?.hasSigner === true;
}

/**
 * Signing out restores the default relay set, and every set change fires a status
 * refresh over the whole set — so `beforeEach` was dialling four public relays
 * before each test even began. The assertions here are about the session, never
 * about a relay.
 *
 * Hoisted rather than done per test because `./auth.jsx` is imported statically
 * above, so by the time a `beforeEach` runs the transport is already resolved.
 */
vi.mock(new URL("../src/nostr.ts", import.meta.url).pathname, () => {
  // One connection, handed to whoever asks. Replacing only the socket and leaving
  // the shape of a connection intact means the code that walks connections —
  // attaching a signer on sign-in, detaching it on sign-out — still runs here,
  // and still means what it did.
  const connection = (url: string) => {
    const conn = {
      url,
      hasSigner: false,
      setSigner: (signer: unknown) => {
        conn.hasSigner = signer !== undefined;
      },
      query: async () => ({
        events: [],
        eose: true,
        failed: true,
        authRequired: false,
      }),
      publish: async () => ({ accepted: false }),
      subscribe: () => () => {},
      close: () => {},
    };
    lastConnection = conn;
    return conn;
  };
  return {
    getConnection: connection,
    eachConnection: (run: (conn: unknown) => void) => {
      run(connection("wss://stubbed.example"));
    },
    pruneConnections: () => undefined,
  };
});

beforeEach(() => {
  stubStorage();
  logout();
  vi.unstubAllGlobals();
  stubStorage();
});

describe("restoreSession", () => {
  it("restores a persisted NIP-07 login without network", async () => {
    const { store } = stubStorage();
    store.set("dacci.auth", JSON.stringify({ pubkey: PUBKEY, method: "nip07" }));
    vi.stubGlobal("nostr", {
      getPublicKey: async () => PUBKEY,
      signEvent: async () => {
        throw new Error("unused");
      },
    });
    const restored = await restoreSession({ queryFn: async () => [] });
    expect(restored).toBe(true);
    expect(useAuth().pubkey()).toBe(PUBKEY);
    // No relay list found: feed falls back to self-only.
    expect(useFeed().feedAuthors()).toEqual([PUBKEY]);
    logout();
  });

  it("drops stale nsec sessions that cannot be restored", async () => {
    const { store } = stubStorage();
    store.set(
      "dacci.auth",
      JSON.stringify({ pubkey: PUBKEY, method: "nsec-session" }),
    );
    const restored = await restoreSession({ queryFn: async () => [] });
    expect(restored).toBe(false);
    expect(useAuth().pubkey()).toBeNull();
    expect(store.has("dacci.auth")).toBe(false);
  });

  it("waits for an extension that is injected late", async () => {
    const { store } = stubStorage();
    store.set("dacci.auth", JSON.stringify({ pubkey: PUBKEY, method: "nip07" }));
    // Extensions inject window.nostr asynchronously after the reload.
    setTimeout(() => {
      vi.stubGlobal("nostr", {
        getPublicKey: async () => PUBKEY,
        signEvent: async () => {
          throw new Error("unused");
        },
      });
    }, 300);
    const restored = await restoreSession({ queryFn: async () => [] });
    expect(restored).toBe(true);
    expect(useAuth().pubkey()).toBe(PUBKEY);
    expect(useAuth().restoring()).toBe(false);
    logout();
  });

  it("keeps the stored entry when the extension never shows up", async () => {
    const { store } = stubStorage();
    store.set("dacci.auth", JSON.stringify({ pubkey: PUBKEY, method: "nip07" }));
    const restored = await restoreSession({ queryFn: async () => [] });
    expect(restored).toBe(false);
    expect(useAuth().restoring()).toBe(false);
    // Kept so the next reload can retry once the extension is ready.
    expect(store.has("dacci.auth")).toBe(true);
  });

  it("never rejects when the browser refuses every storage call", async () => {
  // The old path read the entry inside a try and, when the read threw, cleaned up
  // by calling `removeItem` — from inside the catch, where a second refusal threw
  // again and left the promise rejected. `App.tsx` starts the upload-server read
  // in a `then` on this promise, so the reader got the built-in servers and an
  // unhandled rejection over a browser that had simply said no.
    stubStorage();
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("storage refused");
      },
      setItem: () => {
        throw new Error("storage refused");
      },
      removeItem: () => {
        throw new Error("storage refused");
      },
    });
    await expect(
      restoreSession({ queryFn: async () => [] }),
    ).resolves.toBe(false);
    expect(useAuth().restoring()).toBe(false);
    expect(useAuth().pubkey()).toBeNull();
  });

  it("does not reject when the tab's storage cannot be read either", async () => {
    // The secret read sits outside the try that guards the stored entry, so it
    // has to answer for itself: a refusal here used to reject the restore, and
    // with it the upload-server read chained onto it.
    stubStorage();
    const { store } = stubStorage();
    store.set(
      "dacci.auth",
      JSON.stringify({ pubkey: PUBKEY, method: "nsec-session" }),
    );
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("storage refused");
      },
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    await expect(
      restoreSession({ queryFn: async () => [] }),
    ).resolves.toBe(false);
    expect(useAuth().pubkey()).toBeNull();
  });

  it("keeps the resolved relay set when the session cannot be restored", async () => {
    const { store } = stubStorage();
    store.set(
      "dacci.auth",
      JSON.stringify({ pubkey: PUBKEY, method: "nip07" }),
    );
    store.set(
      "dacci.relays",
      JSON.stringify(["wss://personal.example"]),
    );
    // Extension present but rejecting the request.
    vi.stubGlobal("nostr", {
      getPublicKey: async () => {
        throw new Error("locked");
      },
      signEvent: async () => {
        throw new Error("unused");
      },
    });
    const restored = await restoreSession({ queryFn: async () => [] });
    expect(restored).toBe(false);
    // The relay set is a session preference, not part of the auth entry.
    expect(JSON.parse(store.get("dacci.relays") ?? "[]")).toEqual([
      "wss://personal.example",
    ]);
  });

  it("ignores corrupt storage", async () => {
    const { store } = stubStorage();
    store.set("dacci.auth", "{broken");
    expect(await restoreSession({ queryFn: async () => [] })).toBe(false);
    expect(store.has("dacci.auth")).toBe(false);
  });
});

describe("loginWithNsec", () => {
  // Signing in reads the reader's profile, feed and relay list from the relays.
  // Left to the real lookup, this opened sockets to real relays, so the result
  // depended on someone else's uptime — it failed on a slow network and passed
  // on a fast one. Nothing here is about the relays.
  const offline = { queryFn: async () => [] };

  it("does not wait out the deadline when every relay has answered", async () => {
    // A reader with no contact list and no relay list is the ordinary case, and
    // every relay answering "nothing" is an answer. Treating it as "has not
    // answered yet" made signing in sit out the full deadline for each of the
    // three lookups, so a first sign-in took seconds to find nothing.
    stubStorage();
    const started = Date.now();
    expect(await loginWithNsec("11".repeat(32), offline.queryFn)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1500);
    logout();
  });
  // Signing in reads the reader's profile, feed and relay list from the relays.
  // Left to the real lookup this test opened sockets to real relays, which is
  // what made it fail on a slow network and pass on a fast one — a unit test
  // whose result depended on someone else's uptime. Nothing here is about the
  // relays, so they are asked through a stub that answers immediately.

  it("rejects invalid input", async () => {
    stubStorage();
    expect(await loginWithNsec("not-a-key", offline.queryFn)).toBe(false);
    expect(useAuth().pubkey()).toBeNull();
  });

  it("signs in anyway when the browser refuses to remember it", async () => {
    // A reader whose browser will not keep the session has not typed a bad key,
    // and saying so sends them off to check a key that was fine all along. The
    // login works; it is only the reload that will not.
    const { session } = stubStorage();
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("storage refused");
      },
      setItem: () => {
        throw new Error("storage refused");
      },
      removeItem: () => {
        throw new Error("storage refused");
      },
    });
    const secret = "11".repeat(32);
    expect(await loginWithNsec(secret, offline.queryFn)).toBe(true);
    expect(useAuth().authError()).toBeNull();
    expect(useAuth().pubkey()).not.toBeNull();
    // The nsec secret is in the tab's own storage, which did work.
    expect(session.get("dacci.nsec")).toBe(secret);
    logout();
  });

  it("signs in even when the tab's own storage refuses the secret", async () => {
    // The same refusal, one store over: the write that keeps the secret for a
    // reload sits inside the try meant for a bad key, so a browser that would not
    // take it reported "秘密鍵が不正です" for a key it had just accepted. The
    // signer is in memory either way, so the visit works.
    stubStorage();
    vi.stubGlobal("sessionStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("storage refused");
      },
      removeItem: () => undefined,
    });
    expect(await loginWithNsec("11".repeat(32), offline.queryFn)).toBe(true);
    expect(useAuth().authError()).toBeNull();
    expect(useAuth().pubkey()).not.toBeNull();
    logout();
  });

  it("drops the signer from every connection even when storage refuses", async () => {
    // The step that made signing out mean anything: `applySignerToConnections(null)`
    // ran *after* the storage removal, so a `removeItem` that threw took it with
    // it and every relay connection kept the key. The interface said signed out
    // and anything published was still signed as the reader — the one outcome
    // worse than a logout that does not finish.
    stubStorage();
    expect(await loginWithNsec("11".repeat(32), offline.queryFn)).toBe(true);
    expect(connectionSigner()).toBe(true);
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => {
        throw new Error("storage refused");
      },
    });
    logout();
    expect(useAuth().pubkey()).toBeNull();
    expect(connectionSigner()).toBe(false);
  });

  it("restores the session after a reload", async () => {
    const { store, session } = stubStorage();
    const secret = "11".repeat(32);
    expect(await loginWithNsec(secret, offline.queryFn)).toBe(true);
    expect(useAuth().pubkey()).not.toBeNull();
    const pubkey = useAuth().pubkey();
    // Secret is session-scoped only, never in localStorage.
    expect(session.get("dacci.nsec")).toBe(secret);
    expect(store.has("dacci.nsec")).toBe(false);
    expect(JSON.parse(store.get("dacci.auth") ?? "{}").method).toBe("nsec-session");

    // Reload: the module state is gone, storage is not.
    useAuth().pubkey();
    logout();
    expect(useAuth().pubkey()).toBeNull();
    // logout wipes it, so put the session back to model a reload instead.
    store.set("dacci.auth", JSON.stringify({ pubkey, method: "nsec-session" }));
    session.set("dacci.nsec", secret);
    const restored = await restoreSession({ queryFn: async () => [] });
    expect(restored).toBe(true);
    expect(useAuth().pubkey()).toBe(pubkey);
    logout();
  });
});

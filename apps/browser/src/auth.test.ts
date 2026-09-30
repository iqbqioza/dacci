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
  it("rejects invalid input", async () => {
    stubStorage();
    expect(await loginWithNsec("not-a-key")).toBe(false);
    expect(useAuth().pubkey()).toBeNull();
  });

  it("restores the session after a reload", async () => {
    const { store, session } = stubStorage();
    const secret = "11".repeat(32);
    expect(await loginWithNsec(secret)).toBe(true);
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

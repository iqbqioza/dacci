import { beforeEach, describe, expect, it, vi } from "vitest";
import { loginWithNsec, logout, restoreSession, useAuth } from "./auth.jsx";
import { useFeed } from "./relays.js";

function stubStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
  return store;
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
    const store = stubStorage();
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
    const store = stubStorage();
    store.set(
      "dacci.auth",
      JSON.stringify({ pubkey: PUBKEY, method: "nsec-session" }),
    );
    const restored = await restoreSession({ queryFn: async () => [] });
    expect(restored).toBe(false);
    expect(useAuth().pubkey()).toBeNull();
    expect(store.has("dacci.auth")).toBe(false);
  });

  it("ignores corrupt storage", async () => {
    const store = stubStorage();
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
});

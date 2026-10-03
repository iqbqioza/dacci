import { afterEach, describe, expect, it, vi } from "vitest";
import { safeStorage } from "./storage.js";

/** A store that answers, to show the guard passes a working one through. */
function working(): Map<string, string> {
  const store = new Map<string, string>();
  return store;
}

function stub(store: Partial<Storage>): void {
  vi.stubGlobal("localStorage", store);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("safeStorage", () => {
  it("reads, writes and removes through a store that works", () => {
    const store = working();
    stub({
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    });
    const local = safeStorage("local");
    expect(local.get("dacci.theme")).toBeNull();
    local.set("dacci.theme", "dark");
    expect(local.get("dacci.theme")).toBe("dark");
    local.remove("dacci.theme");
    expect(local.get("dacci.theme")).toBeNull();
  });

  it("answers null when the read throws", () => {
    // The read is the one place a throw is easy to mistake for a missing value:
    // both are "nothing there", and neither is a reason to stop what asked.
    stub({
      getItem: () => {
        throw new Error("storage refused");
      },
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    expect(safeStorage("local").get("dacci.theme")).toBeNull();
  });

  it("swallows a refused write and a refused removal", () => {
    stub({
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
      removeItem: () => {
        throw new Error("storage refused");
      },
    });
    const local = safeStorage("local");
    expect(() => local.set("dacci.auth", "{}")).not.toThrow();
    expect(() => local.remove("dacci.auth")).not.toThrow();
  });

  it("answers for a store that is not there at all", () => {
    // Blocked for the origin: the property access itself throws in some browsers
    // and is simply absent in others, and neither may reach the caller.
    stub({});
    expect(safeStorage("local").get("dacci.theme")).toBeNull();
    expect(() => safeStorage("local").set("x", "y")).not.toThrow();
    vi.stubGlobal("localStorage", undefined);
    expect(safeStorage("local").get("dacci.theme")).toBeNull();
  });

  it("answers when merely reaching the store throws", () => {
    // Storage blocked for the origin is not a missing property but a getter that
    // throws a `SecurityError`, so the guard has to be around the lookup as well
    // as around the calls on it. Guarding only the calls would leave every caller
    // that asks for the store holding the same exception it was meant to be spared.
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: () => {
        throw new Error("storage is blocked for this origin");
      },
    });
    const local = safeStorage("local");
    expect(local.get("dacci.theme")).toBeNull();
    expect(() => local.set("dacci.theme", "dark")).not.toThrow();
    expect(() => local.remove("dacci.theme")).not.toThrow();
    expect(safeStorage("session").get("dacci.nsec")).toBeNull();
  });

  it("keeps the two stores apart", () => {
    // The session copy holds the nsec and the local one must never, so a helper
    // that answered from the wrong store would put a secret where it outlives the
    // tab.
    const local = new Map<string, string>();
    const session = new Map<string, string>();
    stub({
      getItem: (key: string) => local.get(key) ?? null,
      setItem: (key: string, value: string) => void local.set(key, value),
      removeItem: (key: string) => void local.delete(key),
    });
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => session.get(key) ?? null,
      setItem: (key: string, value: string) => void session.set(key, value),
      removeItem: (key: string) => void session.delete(key),
    });
    safeStorage("session").set("dacci.nsec", "11".repeat(32));
    expect(session.get("dacci.nsec")).toBe("11".repeat(32));
    expect(local.has("dacci.nsec")).toBe(false);
    expect(safeStorage("local").get("dacci.nsec")).toBeNull();
  });
});
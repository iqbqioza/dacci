import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
const fakeStorage: Storage = {
  get length() {
    return store.size;
  },
  clear: () => store.clear(),
  getItem: (key: string) => store.get(key) ?? null,
  key: (index: number) => [...store.keys()][index] ?? null,
  removeItem: (key: string) => void store.delete(key),
  setItem: (key: string, value: string) => void store.set(key, value),
};

/** A fresh visit to the app: the store is module level, so a new import is. */
async function visit() {
  vi.resetModules();
  return import("./sensitive.js");
}

beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: Storage }).localStorage = fakeStorage;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sensitive mode", () => {
  it("covers a warned post until the reader acts, by default", async () => {
    // Most clients blur and ask, and a reader who has not said otherwise is
    // taken to want that rather than to want no filtering at all.
    const { useSensitiveMode } = await visit();
    expect(useSensitiveMode().mode()).toBe("blur");
  });

  it("keeps the chosen covering", async () => {
    const { useSensitiveMode } = await visit();
    const { mode, setMode } = useSensitiveMode();
    setMode("hide");
    expect(mode()).toBe("hide");
    expect(store.get("dacci.sensitive")).toBe("hide");
  });

  it("reads the choice back on the next visit", async () => {
    store.set("dacci.sensitive", "show");
    const { useSensitiveMode } = await visit();
    expect(useSensitiveMode().mode()).toBe("show");
  });

  it("ignores a stored value it does not know", async () => {
    store.set("dacci.sensitive", "maybe");
    const { useSensitiveMode } = await visit();
    expect(useSensitiveMode().mode()).toBe("blur");
  });

  it("applies for this visit even when storage is refused", async () => {
    (globalThis as { localStorage?: Storage }).localStorage = {
      ...fakeStorage,
      getItem: () => {
        throw new Error("no storage");
      },
      setItem: () => {
        throw new Error("no storage");
      },
    };
    const { useSensitiveMode } = await visit();
    const { mode, setMode } = useSensitiveMode();
    setMode("hide");
    expect(mode()).toBe("hide");
  });

  it("has a label for every covering", async () => {
    const { SENSITIVE_MODE_LABELS } = await visit();
    for (const id of ["show", "blur", "hide"] as const) {
      expect(SENSITIVE_MODE_LABELS[id].length).toBeGreaterThan(0);
    }
  });
});

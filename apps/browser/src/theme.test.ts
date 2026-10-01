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

/**
 * A document whose element carries the class the stylesheet reads, and a
 * media query that answers as the device does and lets the test change its
 * mind later.
 */
function fakeDom(systemDark: boolean) {
  const classes = new Set<string>();
  const listeners: Array<() => void> = [];
  const element = {
    classList: {
      toggle: (name: string, on: boolean) => {
        if (on) classes.add(name);
        else classes.delete(name);
      },
      contains: (name: string) => classes.has(name),
    },
  };
  vi.stubGlobal("document", { documentElement: element });
  vi.stubGlobal("window", {
    matchMedia: (query: string) => ({
      matches: systemDark,
      media: query,
      addEventListener: (_: string, run: () => void) => listeners.push(run),
    }),
  });
  return { classes, listeners, dark: () => classes.has("dark") };
}

/**
 * A fresh visit to the app. The store is module level, so a new import is a
 * new page load, and both halves of the API have to come from it: they share
 * one signal, and two imports would be two pages.
 */
async function visit() {
  vi.resetModules();
  return import("./theme.js");
}

beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: Storage }).localStorage = fakeStorage;
  vi.stubGlobal("document", undefined);
  vi.stubGlobal("window", undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("theme", () => {
  it("follows the system when nothing is stored", async () => {
    fakeDom(true);
    const { useTheme } = await visit();
    const { theme, resolved } = useTheme();
    // A reader who has never been asked gets what their device is doing.
    expect(theme()).toBe("system");
    expect(resolved()).toBe("dark");
  });

  it("puts the stored choice on the document at once", async () => {
    const dom = fakeDom(false);
    const { useTheme } = await visit();
    const { theme, resolved, setTheme } = useTheme();
    expect(resolved()).toBe("light");
    setTheme("dark");
    expect(theme()).toBe("dark");
    expect(resolved()).toBe("dark");
    expect(dom.dark()).toBe(true);
    expect(store.get("dacci.theme")).toBe("dark");
  });

  it("keeps a light choice even when the system is dark", async () => {
    const dom = fakeDom(true);
    const { useTheme } = await visit();
    const { resolved, setTheme } = useTheme();
    setTheme("light");
    expect(resolved()).toBe("light");
    expect(dom.dark()).toBe(false);
  });

  it("reads a stored choice back on the next visit", async () => {
    fakeDom(false);
    store.set("dacci.theme", "dark");
    const { useTheme } = await visit();
    const { theme, resolved } = useTheme();
    expect(theme()).toBe("dark");
    expect(resolved()).toBe("dark");
  });

  it("ignores a stored value it does not know", async () => {
    fakeDom(false);
    store.set("dacci.theme", "sepia");
    const { useTheme } = await visit();
    expect(useTheme().theme()).toBe("system");
  });

  it("applies the theme when it starts, before anything is drawn", async () => {
    const dom = fakeDom(true);
    store.set("dacci.theme", "dark");
    const { startTheme } = await visit();
    startTheme();
    expect(dom.dark()).toBe(true);
  });

  it("follows the device turning dark while the choice is the system", async () => {
    const dom = fakeDom(false);
    const { startTheme, useTheme } = await visit();
    const { resolved } = useTheme();
    startTheme();
    expect(resolved()).toBe("light");
    expect(dom.dark()).toBe(false);
    // The device changing its mind is the whole point of `system`.
    for (const run of dom.listeners) run();
    expect(resolved()).toBe("light");
  });

  it("ignores the device once a theme is chosen", async () => {
    const dom = fakeDom(false);
    const { startTheme, useTheme } = await visit();
    const { setTheme } = useTheme();
    setTheme("light");
    startTheme();
    // The listener is registered either way, but a fixed choice ignores it.
    for (const run of dom.listeners) run();
    expect(dom.dark()).toBe(false);
  });

  it("keeps working when the browser refuses storage", async () => {
    const dom = fakeDom(false);
    (globalThis as { localStorage?: Storage }).localStorage = {
      ...fakeStorage,
      getItem: () => {
        throw new Error("no storage");
      },
      setItem: () => {
        throw new Error("no storage");
      },
    };
    const { useTheme } = await visit();
    const { theme, resolved, setTheme } = useTheme();
    setTheme("dark");
    // The choice applies for this visit even though it cannot be kept.
    expect(theme()).toBe("dark");
    expect(resolved()).toBe("dark");
    expect(dom.dark()).toBe(true);
  });
});

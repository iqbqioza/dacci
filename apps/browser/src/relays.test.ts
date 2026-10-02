import { computeEventId, type NostrEvent } from "dacci-nostr-nips";
import { describe, expect, it, vi } from "vitest";
import { fixturePubkey, signAs } from "./fixture-event.js";
import {
  addRelay,
  applyLoginFeed,
  applyLoginRelaySet,
  clearFeed,
  DEFAULT_RELAYS,
  initRelays,
  refreshStatuses,
  removeRelay,
  restoreDefaults,
  setRelayMode,
  useFeed,
  useRelays,
} from "./relays.js";

function makeListEvent(
  pubkey: string,
  createdAt: number,
  relays: string[],
): NostrEvent {
  return signAs("reader", {
    created_at: createdAt,
    kind: 10002,
    tags: relays.map((url) => ["r", url]),
    content: "",
  });
}

/**
 * The reader's own pubkey.
 *
 * Every list in this file is a relay list or a follow list the reader
 * published, and both are now read only if the reader signed them — so the
 * fixtures are signed by the same label the constant is derived from.
 */
const PUBKEY = fixturePubkey("reader");

/**
 * Changing the relay set fires a status refresh over the whole set, and this
 * file changes the set in every test — so without a stub each one dialled every
 * relay in it, four of them public, and the result depended on whether they were
 * up. The assertions here are about the set a test builds, never about a relay.
 *
 * Hoisted rather than done per test because `./relays.js` is imported statically
 * above, so by the time a `beforeEach` runs the transport is already resolved.
 */
vi.mock(new URL("../src/nostr.ts", import.meta.url).pathname, () => ({
  getConnection: (url: string) => ({
    url,
    query: async () => ({
      events: [],
      eose: true,
      failed: true,
      authRequired: false,
    }),
  }),
}));

describe("applyLoginRelaySet", () => {
  it("switches to the read relays of the newest list", async () => {
    restoreDefaults();
    const oldList = makeListEvent(PUBKEY, 100, ["wss://old.example"]);
    const newList = makeListEvent(PUBKEY, 200, [
      "wss://new-a.example",
      "wss://new-b.example",
    ]);
    await applyLoginRelaySet(PUBKEY, async (url) =>
      url === DEFAULT_RELAYS[0] ? [oldList, newList] : [],
    );
    expect(useRelays().relayUrls()).toEqual([
      "wss://new-a.example",
      "wss://new-b.example",
    ]);
  });

  it("keeps the current set when no list exists", async () => {
    restoreDefaults();
    await applyLoginRelaySet(PUBKEY, async () => []);
    expect(useRelays().relayUrls()).toEqual(DEFAULT_RELAYS);
  });

  it("keeps write-only relays out of reads and in writes", async () => {
    restoreDefaults();
    // Marked relays, which is the part of NIP-65 this test is about, and signed
    // by the reader so the store will read it at all.
    const event = signAs("reader", {
      created_at: 100,
      kind: 10002,
      content: "",
      tags: [
        ["r", "wss://read.example", "read"],
        ["r", "wss://write.example", "write"],
      ],
    });
    await applyLoginRelaySet(PUBKEY, async () => [event]);
    const relays = useRelays();
    expect(relays.relayUrls()).toEqual([
      "wss://read.example",
      "wss://write.example",
    ]);
    expect(relays.readRelays()).toEqual(["wss://read.example"]);
    // A read-only relay never receives what the reader publishes.
    expect(relays.writeRelays()).toEqual(["wss://write.example"]);
    expect(relays.relayEntries()).toEqual([
      { url: "wss://read.example", mode: "read" },
      { url: "wss://write.example", mode: "write" },
    ]);
    restoreDefaults();
  });
});

function makeContactsEvent(pubkey: string, createdAt: number, follows: string[]) {
  return signAs("reader", {
    created_at: createdAt,
    kind: 3,
    tags: follows.map((p) => ["p", p]),
    content: "",
  });
}

describe("applyLoginFeed", () => {
  it("adopts follows plus self from the newest list", async () => {
    restoreDefaults();
    const oldList = makeContactsEvent(PUBKEY, 100, ["a".repeat(64)]);
    const newList = makeContactsEvent(PUBKEY, 200, [
      "b".repeat(64),
      "c".repeat(64),
    ]);
    await applyLoginFeed(PUBKEY, async () => [oldList, newList]);
    expect(useFeed().feedAuthors()).toEqual([
      PUBKEY,
      "b".repeat(64),
      "c".repeat(64),
    ]);
    clearFeed();
  });

  it("falls back to self-only without a list", async () => {
    restoreDefaults();
    await applyLoginFeed(PUBKEY, async () => []);
    expect(useFeed().feedAuthors()).toEqual([PUBKEY]);
    clearFeed();
  });
});

describe("relay/feed persistence", () => {
  function stubStorage() {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    });
    vi.stubGlobal("sessionStorage", {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    });
    return store;
  }

  it("persists the switched set", async () => {
    stubStorage();
    try {
      await applyLoginRelaySet(PUBKEY, async () => [
        makeListEvent(PUBKEY, 100, [
          "wss://personal-a.example",
          "wss://personal-b.example",
        ]),
      ]);
      expect(useRelays().relayUrls()).toEqual([
        "wss://personal-a.example",
        "wss://personal-b.example",
      ]);
      expect(JSON.parse(localStorage.getItem("dacci.relays") ?? "[]")).toEqual([
        { url: "wss://personal-a.example", mode: "both" },
        { url: "wss://personal-b.example", mode: "both" },
      ]);
    } finally {
      vi.unstubAllGlobals();
      clearFeed();
      restoreDefaults();
    }
  });

  it("restores the persisted set on init instead of defaults", () => {
    stubStorage();
    try {
      localStorage.setItem(
        "dacci.relays",
        JSON.stringify([
          "wss://personal-a.example",
          "wss://personal-b.example",
        ]),
      );
      initRelays();
      expect(useRelays().relayUrls()).toEqual([
        "wss://personal-a.example",
        "wss://personal-b.example",
      ]);
    } finally {
      vi.unstubAllGlobals();
      clearFeed();
      restoreDefaults();
    }
  });

  it("resolves on the first answering relay, not the slowest one", async () => {
    const store = stubStorage();
    try {
      store.set(
        "dacci.relays",
        JSON.stringify([
          "wss://slow.example",
          "wss://fast.example",
          "wss://dead.example",
        ]),
      );
      initRelays();
      const started = Date.now();
      await applyLoginRelaySet(PUBKEY, async (url) => {
        if (url === "wss://dead.example") {
          // Never answers: only the deadline can end the wait.
          return new Promise<NostrEvent[]>(() => {});
        }
        if (url === "wss://slow.example") {
          await new Promise((r) => setTimeout(r, 900));
          return [];
        }
        return [makeListEvent(PUBKEY, 1, ["wss://answer.example"])];
      });
      expect(Date.now() - started).toBeLessThan(700);
      expect(useRelays().relayUrls()).toEqual(["wss://answer.example"]);
    } finally {
      vi.unstubAllGlobals();
      clearFeed();
      restoreDefaults();
    }
  });

  it("restores the persisted feed as well", () => {
    stubStorage();
    try {
      // The stored feed is validated, so it has to hold real hex keys.
      const self = "1".repeat(64);
      const followed = "2".repeat(64);
      localStorage.setItem("dacci.relays", JSON.stringify(["wss://personal.example"]));
      localStorage.setItem("dacci.feed", JSON.stringify([self, followed]));
      initRelays();
      expect(useFeed().feedAuthors()).toEqual([self, followed]);
    } finally {
      vi.unstubAllGlobals();
      clearFeed();
      restoreDefaults();
    }
  });

  it("falls back to defaults on corrupt storage", () => {
    stubStorage();
    try {
      localStorage.setItem("dacci.relays", "{broken");
      initRelays();
      expect(useRelays().relayUrls()).toEqual(DEFAULT_RELAYS);
    } finally {
      vi.unstubAllGlobals();
      restoreDefaults();
    }
  });
});

describe("relay set editing", () => {
  it("normalizes the URL and rejects duplicates and junk", () => {
    restoreDefaults();
    expect(addRelay("  wss://New.Example/  ")).toEqual({ ok: true });
    expect(useRelays().relayUrls()).toContain("wss://New.Example");
    expect(addRelay("wss://New.Example")).toEqual({
      ok: false,
      reason: "duplicate",
    });
    expect(addRelay("https://not-a-relay.example")).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(addRelay("")).toEqual({ ok: false, reason: "invalid" });
    restoreDefaults();
  });

  it("adds a relay with a chosen mode", () => {
    restoreDefaults();
    addRelay("wss://write-only.example", "write");
    const relays = useRelays();
    expect(relays.readRelays()).not.toContain("wss://write-only.example");
    expect(relays.writeRelays()).toContain("wss://write-only.example");
    restoreDefaults();
  });

  it("switches a relay between read, write and both", () => {
    restoreDefaults();
    const url = DEFAULT_RELAYS[0];
    setRelayMode(url, "read");
    expect(useRelays().writeRelays()).not.toContain(url);
    expect(useRelays().readRelays()).toContain(url);
    setRelayMode(url, "write");
    expect(useRelays().readRelays()).not.toContain(url);
    expect(useRelays().writeRelays()).toContain(url);
    setRelayMode(url, "both");
    expect(useRelays().readRelays()).toContain(url);
    expect(useRelays().writeRelays()).toContain(url);
    restoreDefaults();
  });

  it("removes a relay from both roles", () => {
    restoreDefaults();
    const url = DEFAULT_RELAYS[0];
    removeRelay(url);
    const relays = useRelays();
    expect(relays.relayUrls()).not.toContain(url);
    expect(relays.readRelays()).not.toContain(url);
    expect(relays.writeRelays()).not.toContain(url);
    removeRelay(url);
    expect(relays.relayUrls().length).toBe(DEFAULT_RELAYS.length - 1);
    restoreDefaults();
  });

  it("never queries a write-only relay when checking statuses", async () => {
    restoreDefaults();
    addRelay("wss://write-only.example", "write");
    const before = useRelays().relayStatuses()["wss://write-only.example"];
    expect(before).toBe("unknown");
    await refreshStatuses();
    // The probe cannot reach a relay the reader marked write-only.
    expect(useRelays().relayStatuses()["wss://write-only.example"]).toBe(
      "unknown",
    );
    restoreDefaults();
  });

  it("restores modes from storage and still reads the old plain list", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    });
    try {
      store.set(
        "dacci.relays",
        JSON.stringify([
          { url: "wss://r.example", mode: "read" },
          { url: "wss://w.example", mode: "write" },
        ]),
      );
      initRelays();
      expect(useRelays().readRelays()).toEqual(["wss://r.example"]);
      expect(useRelays().writeRelays()).toEqual(["wss://w.example"]);

      // A set stored before modes existed is read/write.
      store.set(
        "dacci.relays",
        JSON.stringify(["wss://legacy.example"]),
      );
      initRelays();
      expect(useRelays().readRelays()).toEqual(["wss://legacy.example"]);
      expect(useRelays().writeRelays()).toEqual(["wss://legacy.example"]);
    } finally {
      vi.unstubAllGlobals();
      restoreDefaults();
    }
  });
});

import { hasValidId, hasValidSignature } from "dacci-nostr-nips";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixturePubkey, forgedAs, replayedAs, signAs } from "./fixture-event.js";

/**
 * A relay is not asked to vouch for anything. The only check every inbound
 * event passes through proves the id is the hash of the author's own fields —
 * and `pubkey` is one of those fields, so a relay that rewrites the author and
 * recomputes the id still passes. These are the events that turn "a relay sent
 * something" into "the app will now do this", and they are what the check is for.
 */
const READER = fixturePubkey("reader");
const LIST = {
  created_at: 1700000000,
  kind: 10002,
  content: "",
  tags: [["r", "wss://attacker.example"]],
};

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function withRelays(): Promise<typeof import("./relays.js")> {
  vi.resetModules();
  vi.doMock("./auth.js", () => ({ useAuth: () => ({ pubkey: () => READER }) }));
  return import("./relays.js");
}

/** Just enough storage for the stores that persist what they adopt. */
function useMemoryStorage(): void {
  const items = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
    removeItem: (k: string) => void items.delete(k),
    clear: () => items.clear(),
  });
}

beforeEach(() => {
  useMemoryStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("./auth.js");
});

describe("a relay list the reader did not sign", () => {
  it("is refused, and the reader's own relay set is left alone", async () => {
    // This is the whole of it. A kind 10002 replaces the read *and* write
    // relay set and persists it, so a relay that can serve one of these has
    // every publish the reader makes from then on — signed, and to the attacker.
    const store = await withRelays();
    store.restoreDefaults();
    const before = store.useRelays().writeRelays();

    await store.applyLoginRelaySet(READER, async () => [forgedAs("reader", LIST)]);

    expect(store.useRelays().writeRelays()).toEqual(before);
    expect(store.useRelays().readRelays()).not.toContain("wss://attacker.example");
    // And nothing was written down for next time, so the attack does not even
    // need the reader to be online: a forged list is not persisted either.
    expect(localStorage.getItem("dacci.relays")).toBe(
      JSON.stringify(
        store
          .useRelays()
          .relayEntries()
          .map((e: { url: string; mode: string }) => ({ url: e.url, mode: e.mode })),
      ),
    );
  });

  it("is refused even though the event's own id checks out", async () => {
    // Without this the test above would pass for the wrong reason: a store that
    // rejected everything, rather than one that rejected exactly the forgeries.
    const forged = forgedAs("reader", LIST);
    expect(hasValidId(forged)).toBe(true);
    expect(hasValidSignature(forged)).toBe(false);
  });

  it("is refused when it carries somebody else's signature", async () => {
    // A different failure inside the curve code, and a different attack: a relay
    // replaying an event it saw signed elsewhere, not one it invented.
    const store = await withRelays();
    store.restoreDefaults();
    const before = store.useRelays().writeRelays();

    await store.applyLoginRelaySet(READER, async () => [
      replayedAs("reader", LIST),
    ]);

    expect(store.useRelays().writeRelays()).toEqual(before);
  });

  it("does not stop a list the reader really did publish", async () => {
    // The other half, and the one a check written as "reject kind 10002" would
    // pass while breaking every reader. The signed fixture is the reader's own
    // work, so the list is adopted exactly as before.
    const store = await withRelays();
    store.restoreDefaults();

    await store.applyLoginRelaySet(READER, async () => [
      signAs("reader", { ...LIST, tags: [["r", "wss://mine.example"]] }),
    ]);

    expect(store.useRelays().writeRelays()).toEqual(["wss://mine.example"]);
  });

  it("falls back to the reader's own timeline when a forged follow list arrives", async () => {
    // A forged kind 3 decides whose posts the home feed shows, so it is dropped
    // the same way a missing one is: self-only, which is where no list lands.
    const store = await withRelays();
    store.restoreDefaults();
    store.clearFeed();

    await store.applyLoginFeed(READER, async () => [
      forgedAs("reader", {
        created_at: 1700000000,
        kind: 3,
        content: "",
        tags: [["p", fixturePubkey("attacker")]],
      }),
    ]);

    expect(store.useFeed().feedAuthors()).toEqual([READER]);
  });
});

describe("a follow count off somebody else's forged list", () => {
  it("reads as unanswered, not as zero", async () => {
    // The subtle half. A relay that answers with nothing has said the subject
    // follows nobody, and that is shown as "0". A relay that answers with a
    // forgery has said nothing at all, and must leave the row unresolved — or one
    // hostile relay could assert that everyone the reader looks at follows
    // nobody, or follows the attacker.
    vi.resetModules();
    vi.doMock("./relays.js", () => ({
      useRelays: () => ({ readRelays: () => ["wss://a"] }),
    }));
    vi.doMock("./nostr.js", () => ({
      getConnection: () => ({
        url: "wss://a",
        query: async () => ({
          failed: false,
          events: [
            forgedAs("subject", {
              created_at: 1700000000,
              kind: 3,
              content: "",
              tags: [["p", fixturePubkey("someone")]],
            }),
          ],
        }),
      }),
    }));
    const store = await import("./follows.js");
    const subject = fixturePubkey("subject");

    // Asked about, and left unresolved: a forged answer is not an answer, and
    // the read has to be given time to finish before that can be said.
    const count = store.useFollowCount(subject);
    await tick();
    expect(count()).toBe(null);
  });

  it("still reports a subject whose real list is empty", async () => {
    // The other half again: a working relay saying "nobody" is a fact about the
    // subject, and treating every empty answer as unanswerable would leave that
    // row blank forever.
    vi.resetModules();
    vi.doMock("./relays.js", () => ({
      useRelays: () => ({ readRelays: () => ["wss://a"] }),
    }));
    vi.doMock("./nostr.js", () => ({
      getConnection: () => ({
        url: "wss://a",
        query: async () => ({ failed: false, events: [] }),
      }),
    }));
    const store = await import("./follows.js");
    const subject = fixturePubkey("subject");

    const count = store.useFollowCount(subject);
    await tick();
    expect(count()).toBe(0);
  });
});

describe("an upload server list the reader did not sign", () => {
  it("is refused, so signed uploads are not redirected", async () => {
    // A kind 10063/10096 names where the app sends uploads, and those uploads
    // carry the reader's NIP-98 signature. A forged one is a redirect, and the
    // device's own list is what the reader configured.
    vi.resetModules();
    vi.doMock("./relays.js", () => ({
      useRelays: () => ({ readRelays: () => ["wss://a"] }),
    }));
    vi.doMock("./nostr.js", () => ({
      getConnection: () => ({
        url: "wss://a",
        query: async () => ({
          failed: false,
          events: [
            forgedAs("reader", {
              created_at: 1700000000,
              kind: 10063,
              content: "",
              tags: [["server", "https://attacker.example"]],
            }),
          ],
        }),
      }),
    }));
    vi.doMock("./auth.js", () => ({ useAuth: () => ({ pubkey: () => READER }) }));
    const store = await import("./servers.js");
    await store.loadServers();

    expect(
      store.useUploadServers().all().map((s: { url: string }) => s.url),
    ).not.toContain("https://attacker.example");
  });
});

describe("a deletion request the reader did not sign", () => {
  it("is refused, so nothing can be hidden from the reader", async () => {
    // A kind 5 makes posts disappear. A relay able to serve one the reader never
    // signed could take any post away from any reader, on any relay, silently.
    vi.resetModules();
    vi.doMock("./relays.js", () => ({
      useRelays: () => ({ readRelays: () => ["wss://a"] }),
    }));
    vi.doMock("./nostr.js", () => ({
      getConnection: () => ({
        url: "wss://a",
        query: async () => ({
          failed: false,
          events: [
            forgedAs("reader", {
              created_at: 1700000000,
              kind: 5,
              content: "",
              tags: [["e", "a".repeat(64)]],
            }),
          ],
        }),
      }),
    }));
    const store = await import("./deleted.js");
    await store.syncDeleted(READER);

    expect(store.isDeleted("a".repeat(64))).toBe(false);
  });
});

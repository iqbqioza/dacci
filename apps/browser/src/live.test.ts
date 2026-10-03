import { afterEach, describe, expect, it, vi } from "vitest";

const tick = (ms = 0): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Relays the mocked layer answers with, changed per test. */
let relays: string[] = [];
/** Every subscription opened, so a test can deliver into it. */
const opened: Array<{
  url: string;
  filter: Record<string, unknown>;
  deliver: (event: Record<string, unknown>) => void;
  closed: boolean;
}> = [];

async function freshLive() {
  vi.resetModules();
  relays = [];
  opened.length = 0;
  vi.doMock("./nostr.js", () => ({
    getConnection: (url: string) => ({
      subscribe: (
        filter: Record<string, unknown>,
        cb: (event: Record<string, unknown>) => void,
      ) => {
        const sub = {
          url,
          filter,
          deliver: cb,
          closed: false,
        };
        opened.push(sub);
        return {
          unsubscribe: () => {
            sub.closed = true;
          },
        };
      },
    }),
    HOME_KINDS: [1],
    NOTIFICATION_KINDS: [1],
    PROFILE_KINDS: [1],
  }));
  vi.doMock("./relays.js", () => ({
    useRelays: () => ({ readRelays: () => relays }),
  }));
  return import("./live.js");
}

afterEach(() => {
  vi.doUnmock("./nostr.js");
  vi.doUnmock("./relays.js");
});

function post(id: string): Record<string, unknown> {
  return {
    id,
    pubkey: "p".repeat(64),
    created_at: 100,
    kind: 1,
    tags: [],
    content: "x",
    sig: "s".repeat(128),
  };
}

describe("rebuilds", () => {
  function depsFor(identity: { relays: string[]; self?: string }) {
    return {
      readRelays: () => identity.relays,
      feedAuthors: () => null,
      selfPubkey: () => identity.self,
    };
  }

  it("keeps arrivals across a relay-only rebuild, and drops them on identity change", async () => {
    // Adding a relay re-opens every stream with `since: now`, so whatever
    // arrived before the rebuild is neither re-delivered nor — if dropped
    // here — ever reaching the list. The bar that promised it vanished with
    // no insertion and no notice.
    const live = await freshLive();
    relays = ["wss://a"];
    const stop = live.startLiveFeeds(depsFor({ relays }));
    const feedSub = opened.find((sub) => sub.filter["#p"] === undefined);
    expect(feedSub).toBeDefined();
    feedSub?.deliver(post("a".repeat(64)));
    await tick();
    expect(live.useFeedLive().buffered()).toHaveLength(1);

    // Same reader, new relay: the arrival survives, on a fresh stream.
    relays = ["wss://a", "wss://b"];
    stop();
    live.startLiveFeeds(depsFor({ relays }));
    expect(live.useFeedLive().buffered()).toHaveLength(1);
    expect(
      opened
        .filter((sub) => sub.filter["#p"] === undefined)
        .slice(-2)
        .map((sub) => sub.url)
        .sort(),
    ).toEqual(["wss://a", "wss://b"]);

    // A different reader: nothing carries over.
    stop();
    const other = live.startLiveFeeds(
      depsFor({ relays, self: "other" }),
    );
    expect(live.useFeedLive().buffered()).toHaveLength(0);
    other();
  });
});

describe("profile live stream", () => {
  it("follows the subject on every read relay, not just the first", async () => {
    const live = await freshLive();
    relays = ["wss://a", "wss://b"];
    live.watchProfileSubject("u".repeat(64));
    // One subscription per relay: a first-relay outage used to kill profile
    // live arrivals silently while the paginator went on paging every relay.
    expect(opened.map((sub) => sub.url).sort()).toEqual([
      "wss://a",
      "wss://b",
    ]);
    for (const sub of opened) {
      expect((sub.filter.authors as string[])).toEqual(["u".repeat(64)]);
    }
  });

  it("re-points the stream when the relay set changes, keeping arrivals", async () => {
    const live = await freshLive();
    relays = ["wss://a"];
    const subject = "u".repeat(64);
    live.watchProfileSubject(subject);
    expect(opened).toHaveLength(1);
    // Something arrives before the change.
    opened[0].deliver(post("a".repeat(64)));
    await tick();
    expect(live.useProfileLive().buffered()).toHaveLength(1);

    // The relay set changes: the old stream is dead, so a new one opens on
    // the new relays — and what arrived stays arrived, because the bar has
    // already promised it.
    relays = ["wss://c", "wss://d"];
    live.refreshProfileStream();
    await tick();
    expect(opened.map((sub) => sub.url).slice(-2).sort()).toEqual([
      "wss://c",
      "wss://d",
    ]);
    expect(opened[0].closed).toBe(true);
    expect(live.useProfileLive().buffered()).toHaveLength(1);
  });

  it("rebuilds the profile stream with the feeds, not only on subject change", async () => {
    // The app rebuilds every stream on login, logout and relay change. The
    // profile stream was not part of the rebuild: it was torn down with the
    // rest and never opened again, so the bar stayed silent until the reader
    // looked at someone else.
    const live = await freshLive();
    relays = ["wss://a"];
    const subject = "u".repeat(64);
    live.watchProfileSubject(subject);
    expect(opened.map((sub) => sub.url)).toEqual(["wss://a"]);

    const deps = {
      readRelays: () => relays,
      feedAuthors: () => null,
      selfPubkey: () => undefined,
    };
    const stop = live.startLiveFeeds(deps);
    relays = ["wss://c"];
    stop();
    live.startLiveFeeds(deps);
    // A stream on the new relay, for the same subject, with no subject change.
    const profile = opened.filter(
      (sub) =>
        (sub.filter.authors as string[] | undefined)?.[0] === subject,
    );
    expect(profile.map((sub) => sub.url)).toContain("wss://c");
  });

  it("drops the stream when there is no subject, and stays quiet", async () => {
    const live = await freshLive();
    relays = ["wss://a"];
    live.watchProfileSubject("u".repeat(64));
    expect(opened).toHaveLength(1);
    live.watchProfileSubject(null);
    expect(opened[0].closed).toBe(true);
    // Nothing to point at, so a refresh opens nothing.
    live.refreshProfileStream();
    expect(opened).toHaveLength(1);
  });
});

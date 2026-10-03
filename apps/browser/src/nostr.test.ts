import { describe, expect, it } from "vitest";
import { isValidEventStructure } from "dacci-nostr-nips";
import {
  formatDate,
  formatTime,
  HOME_KINDS,
  NOTIFICATION_KINDS,
  PROFILE_KINDS,
  shortId,
  UNKNOWN_TIME,
} from "./nostr.js";

describe("shortId", () => {
  it("abbreviates long ids", () => {
    expect(shortId("a".repeat(64))).toBe("aaaaaaaa…aaaa");
  });
});

describe("formatTime", () => {
  it("returns a non-empty locale string", () => {
    expect(formatTime(1000).length).toBeGreaterThan(0);
  });

  it("never prints the words Invalid Date", () => {
    // NIP-01 sets no upper bound on created_at, and a relay will serve whatever
    // it was sent. Past roughly the year 275,760 the value is beyond what a
    // Date can hold, and `toLocaleString` answers with the literal string
    // "Invalid Date" — which is neither a time nor an explanation. Such an
    // event also sorts above everything else, so this is the first thing a
    // reader would see.
    for (const absurd of [
      9_999_999_999_999,
      Number.MAX_SAFE_INTEGER,
      8_640_000_000_001,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(formatTime(absurd)).not.toContain("Invalid");
      expect(formatTime(absurd)).toBe(UNKNOWN_TIME);
    }
  });

  it("still accepts every timestamp that can be a time", () => {
    // The guard must not throw away real posts: zero, the epoch, and a
    // timestamp far in the future but still inside the range.
    for (const real of [0, 1, 1_700_000_000, 4_102_444_800, 8_640_000_000_000]) {
      expect(formatTime(real)).not.toBe(UNKNOWN_TIME);
    }
  });

  it("documents that the shape check lets an absurd timestamp through", () => {
    // Not a defence here — the point is that nothing upstream rejects it, so
    // the formatter is the place the reader is protected.
    expect(
      isValidEventStructure({
        id: "a".repeat(64),
        pubkey: "b".repeat(64),
        created_at: 9_999_999_999_999,
        kind: 1,
        tags: [],
        content: "",
        sig: "c".repeat(128),
      }),
    ).toBe(true);
  });
});

describe("formatDate", () => {
  it("uses the same guard", () => {
    expect(formatDate(9_999_999_999_999)).toBe(UNKNOWN_TIME);
    expect(formatDate(1_700_000_000).length).toBeGreaterThan(0);
  });
});

describe("the kinds a feed asks for", () => {
  it("asks for both repost kinds on every feed that shows a timeline", () => {
    // NIP-18 has two: kind 6 for a note and kind 16 for anything else. A
    // timeline asking only for kind 6 shows what an account reposts and drops
    // what it passed on that was not a note — which is most of what a Nostr
    // account actually reposts. These are the lists the three timelines are
    // built from, so this is the filter the relays are asked.
    for (const kinds of [HOME_KINDS, PROFILE_KINDS, NOTIFICATION_KINDS]) {
      expect(kinds, JSON.stringify(kinds)).toContain(6);
      expect(kinds, JSON.stringify(kinds)).toContain(16);
    }
    // And the posts a feed splits by tab are still asked for.
    for (const kinds of [HOME_KINDS, PROFILE_KINDS]) {
      expect(kinds).toContain(1);
      expect(kinds).toContain(1111);
    }
    // Reactions stay a notification and not a timeline entry.
    expect(NOTIFICATION_KINDS).toContain(7);
    expect(HOME_KINDS).not.toContain(7);
    expect(PROFILE_KINDS).not.toContain(7);
  });
});

describe("pruneConnections", () => {
  it("drops pooled connections the set no longer names, and keeps the rest", async () => {
    // Removing a relay left its socket open: nothing ever closed it. The pool
    // itself never dials — connections are made on first use — so this is
    // network-safe: no socket exists until a query or subscription opens one.
    const { getConnection, pruneConnections } = await import("./nostr.js");
    const kept = getConnection("wss://kept.example");
    const dropped = getConnection("wss://dropped.example");
    expect(getConnection("wss://kept.example")).toBe(kept);

    pruneConnections(["wss://kept.example"]);

    // Kept relays keep their connection; the dropped one dials fresh next.
    expect(getConnection("wss://kept.example")).toBe(kept);
    expect(getConnection("wss://dropped.example")).not.toBe(dropped);
    // And the dropped one was closed rather than orphaned: a closed pool entry
    // reports it, so a lingering socket cannot be mistaken for a live one.
    expect(dropped.status).toBe("closed");
    pruneConnections(["wss://kept.example", "wss://dropped.example"]);
  });
});

import { describe, expect, it } from "vitest";
import { isValidEventStructure } from "dacci-nostr-nips";
import { formatDate, formatTime, shortId, UNKNOWN_TIME } from "./nostr.js";

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

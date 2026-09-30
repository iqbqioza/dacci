import { describe, expect, it } from "vitest";
import { formatTime, shortId } from "./nostr.js";

describe("shortId", () => {
  it("abbreviates long ids", () => {
    expect(shortId("a".repeat(64))).toBe("aaaaaaaa…aaaa");
  });
});

describe("formatTime", () => {
  it("returns a non-empty locale string", () => {
    expect(formatTime(1000).length).toBeGreaterThan(0);
  });
});

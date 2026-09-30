import { describe, expect, it } from "vitest";
import { computeEventId } from "./event.js";
import {
  normalizeRelayUrl,
  parseRelayList,
  RELAY_LIST_KIND,
} from "./relay-list.js";

function makeListEvent(tags: string[][]) {
  const base = {
    pubkey: "a".repeat(64),
    created_at: 1000,
    kind: RELAY_LIST_KIND,
    tags,
    content: "",
  };
  return { ...base, id: computeEventId(base), sig: "b".repeat(128) };
}

describe("normalizeRelayUrl", () => {
  it("accepts ws(s) urls and trims slashes", () => {
    expect(normalizeRelayUrl("wss://relay.example/")).toBe(
      "wss://relay.example",
    );
    expect(normalizeRelayUrl("  wss://relay.example/path  ")).toBe(
      "wss://relay.example/path",
    );
  });

  it("rejects non-relay urls", () => {
    expect(normalizeRelayUrl("https://relay.example")).toBeNull();
    expect(normalizeRelayUrl("not a url")).toBeNull();
    expect(normalizeRelayUrl(42)).toBeNull();
  });
});

describe("parseRelayList", () => {
  it("splits read/write markers and dedupes", () => {
    const event = makeListEvent([
      ["r", "wss://read.example"],
      ["r", "wss://both.example", "read"],
      ["r", "wss://write.example", "write"],
      ["r", "wss://read.example"],
      ["p", "b".repeat(64)],
    ]);
    expect(parseRelayList(event)).toEqual([
      { url: "wss://read.example", read: true, write: true },
      { url: "wss://both.example", read: true, write: false },
      { url: "wss://write.example", read: false, write: true },
    ]);
  });

  it("returns empty for other kinds", () => {
    const event = { ...makeListEvent([]), kind: 1 };
    expect(parseRelayList(event)).toEqual([]);
  });
});

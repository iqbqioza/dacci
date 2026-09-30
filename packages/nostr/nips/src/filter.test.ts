import { describe, expect, it } from "vitest";
import { computeEventId } from "../src/event.js";
import { matchesFilter } from "../src/filter.js";
import type { NostrEvent } from "../src/event.js";

function makeEvent(overrides: Partial<NostrEvent> = {}): NostrEvent {
  const base = {
    pubkey: "a".repeat(64),
    created_at: 1000,
    kind: 1,
    tags: [["p", "b".repeat(64)]],
    content: "hello",
  };
  const id = computeEventId({ ...base, ...overrides });
  return { ...base, ...overrides, id, sig: "c".repeat(128) };
}

describe("matchesFilter", () => {
  it("treats since/until as inclusive (NIP-01)", () => {
    const event = makeEvent({ created_at: 1000 });
    expect(matchesFilter(event, { since: 1000 })).toBe(true);
    expect(matchesFilter(event, { until: 1000 })).toBe(true);
    expect(matchesFilter(event, { since: 1001 })).toBe(false);
    expect(matchesFilter(event, { until: 999 })).toBe(false);
  });

  it("matches kinds, authors, ids and tags with AND semantics", () => {
    const event = makeEvent();
    expect(matchesFilter(event, { kinds: [1], authors: [event.pubkey] })).toBe(
      true,
    );
    expect(matchesFilter(event, { kinds: [2] })).toBe(false);
    expect(
      matchesFilter(event, { "#p": ["b".repeat(64)], kinds: [1] }),
    ).toBe(true);
    expect(matchesFilter(event, { "#p": ["c".repeat(64)] })).toBe(false);
  });
});

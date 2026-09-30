import type { NostrEvent } from "dacci-nostr-nips";
import { describe, expect, it } from "vitest";
import {
  clearEventCache,
  fetchEventById,
  lookupEvent,
  rememberEvents,
} from "./event-cache.js";

function makeEvent(id: string): NostrEvent {
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

describe("event cache", () => {
  it("hits memory before relays", async () => {
    clearEventCache();
    const event = makeEvent("a".repeat(64));
    rememberEvents([event]);
    expect(lookupEvent(event.id)).toBe(event);
    let queried = false;
    const found = await fetchEventById(event.id, ["wss://x.example"], async () => {
      queried = true;
      return [];
    });
    expect(found).toBe(event);
    expect(queried).toBe(false);
    clearEventCache();
  });

  it("fetches misses from relays and remembers them", async () => {
    clearEventCache();
    const event = makeEvent("b".repeat(64));
    const found = await fetchEventById(
      event.id,
      ["wss://x.example"],
      async () => [event],
    );
    expect(found).toBe(event);
    expect(lookupEvent(event.id)).toBe(event);
    clearEventCache();
  });

  it("returns null when relays have nothing", async () => {
    clearEventCache();
    const found = await fetchEventById(
      "c".repeat(64),
      ["wss://x.example"],
      async () => [],
    );
    expect(found).toBeNull();
  });
});

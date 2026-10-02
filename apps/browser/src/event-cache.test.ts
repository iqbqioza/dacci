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

  it("keeps what the reader is looking at, and forgets what they are not", () => {
    // The queue was insertion order and never moved, so the post a reader had
    // just opened — asked for again on every re-render — sat at the front and was
    // the first thing evicted when the cache filled. Events nobody had looked at
    // since went on taking up room.
    clearEventCache();
    const id = (n: number): string => n.toString(16).padStart(64, "0");
    const cold = makeEvent(id(1));
    const hot = makeEvent(id(2));
    const filler = Array.from({ length: 1998 }, (_, i) => makeEvent(id(100 + i)));

    // The hot one goes in *first*, so it is the oldest entry — which is exactly
    // the position the old queue never moved it off.
    rememberEvents([hot, cold, ...filler]);
    // Read the hot one over and over, which is what a reader looking at it does.
    for (let i = 0; i < 10; i += 1) rememberEvents([hot]);

    // One more event puts the cache over its ceiling by one, so exactly one entry
    // has to go — and which one is the whole question.
    rememberEvents([makeEvent(id(9999))]);

    expect(lookupEvent(hot.id)).not.toBeNull();
    expect(lookupEvent(cold.id)).toBeNull();
    clearEventCache();
  });

  it("keeps the first copy when an event arrives again", () => {
    // `id` is a hash of the event's own fields, so two events with one id can
    // differ at most in `sig`, which the id does not cover. Refreshing the
    // position must not also let whichever relay answered last decide which
    // signature the cached post is shown with.
    clearEventCache();
    const first = makeEvent("d".repeat(64));
    const second = { ...first, sig: "t".repeat(128) };
    rememberEvents([first]);
    rememberEvents([second]);
    expect(lookupEvent(first.id)?.sig).toBe(first.sig);
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

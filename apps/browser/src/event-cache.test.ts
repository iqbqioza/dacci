import type { NostrEvent } from "dacci-nostr-nips";
import { describe, expect, it } from "vitest";
import { DEADLINE_MS as DEADLINE } from "./event-cache.js";
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

  it("does not wait out the deadline once every relay has answered", async () => {
    // A deleted post is answered by *every* relay with nothing, so this is the
    // commonest shape there is — and it used to cost the whole five seconds,
    // because only a hit settled the question. One dead relay held a deep link
    // open for the same five seconds even when another had answered in twenty
    // milliseconds, which is not what the function's own comment said it did.
    clearEventCache();
    const never = makeEvent("e".repeat(64));
    const slow = (): Promise<NostrEvent[]> =>
      new Promise((resolve) => setTimeout(() => resolve([never]), 30));
    const started = Date.now();
    const found = await fetchEventById(never.id, ["wss://a", "wss://b"], async (url) =>
      url === "wss://a" ? slow() : new Promise<NostrEvent[]>(() => undefined),
    );
    const waited = Date.now() - started;
    // Found, from the one relay that had it, without waiting for the other.
    expect(found).not.toBeNull();
    expect(waited).toBeLessThan(1000);

    // And nobody holding it is an answer in its own right, so it does not wait
    // either.
    const goneId = "f".repeat(64);
    const asked = Date.now();
    expect(
      await fetchEventById(goneId, ["wss://a"], async () => []),
    ).toBeNull();
    expect(Date.now() - asked).toBeLessThan(1000);
    clearEventCache();
  });

  // Two deadlines' worth of waiting, because the claim is about a relay that
  // answers *after* the deadline — which cannot be shown without letting it.
  it(
    "keeps an answer that arrives after the deadline, rather than losing it",
    { timeout: 20_000 },
    async () => {
    // The reader was told the post does not exist, which this client cannot know:
    // a relay five and a half seconds in is slow, not absent. The answer used to
    // be written into a variable nobody read again — not returned, and not even
    // cached, so the next attempt asked everyone the same question.
    clearEventCache();
    const late = makeEvent("9".repeat(64));
    const started = Date.now();
    const found = await fetchEventById(
      late.id,
      ["wss://slow"],
      async () => {
        await new Promise((r) => setTimeout(r, DEADLINE + 200));
        return [late];
      },
    );
    expect(found).toBeNull();
    // Given up on, on time.
    expect(Date.now() - started).toBeLessThan(DEADLINE + 500);
    // And what arrived afterwards is kept, so the next attempt needs no relay.
    await new Promise((r) => setTimeout(r, DEADLINE + 400));
    expect(lookupEvent(late.id)).not.toBeNull();
    let asked = false;
    expect(
      await fetchEventById(late.id, ["wss://slow"], async () => {
        asked = true;
        return [];
      }),
    ).not.toBeNull();
    expect(asked).toBe(false);
    clearEventCache();
    },
  );

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

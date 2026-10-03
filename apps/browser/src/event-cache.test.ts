import type { NostrEvent } from "dacci-nostr-nips";
import { describe, expect, it } from "vitest";
import { DEADLINE_MS as DEADLINE } from "./event-cache.js";
import {
  answerEvents,
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

  it("takes one relay's 'no' as the answer, whatever the others did", async () => {
    // A deleted post is answered by some relays and simply not by others — one
    // that was closed, one whose query was refused for want of a subscription
    // slot. One honest "I do not have it" settles it; the others never spoke.
    clearEventCache();
    const started = Date.now();
    const found = await fetchEventById(
      "d1".padEnd(64, "0"),
      ["wss://a", "wss://b", "wss://c"],
      async (url) => (url === "wss://a" ? [] : null),
      5000,
    );
    expect(found).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
    clearEventCache();
  });

  it("waits for the deadline when nobody answered at all", async () => {
    // Every read relay was closed or refused the query, which says nothing about
    // the post. This used to resolve the moment they came back — a few hundred
    // milliseconds — and the page said the post does not exist, which is the one
    // thing a client with no answer cannot know.
    clearEventCache();
    const asked = Date.now();
    const looking = fetchEventById(
      "e1".padEnd(64, "0"),
      ["wss://a", "wss://b"],
      async () => null,
      150,
    );
    const settled = await Promise.race([
      looking,
      new Promise<"still looking">((r) => setTimeout(() => r("still looking"), 40)),
    ]);
    expect(settled).toBe("still looking");
    // And then it gives up on the deadline, rather than never giving up at all.
    expect(await looking).toBeNull();
    expect(Date.now() - asked).toBeLessThan(2000);
    clearEventCache();
  });

  it("counts a relay that threw as silence, and one that answered as a verdict", async () => {
    // The two are told apart by the same rule as the `null` answer: a query that
    // rejected is not a relay saying "no". With one throwing and one answering
    // empty the post is still known to be missing; with both throwing it is not.
    clearEventCache();
    expect(
      await fetchEventById(
        "f1".padEnd(64, "0"),
        ["wss://a", "wss://b"],
        async (url) => {
          if (url === "wss://a") throw new Error("socket closed");
          return [];
        },
        400,
      ),
    ).toBeNull();
    const both = fetchEventById(
      "f2".padEnd(64, "0"),
      ["wss://a", "wss://b"],
      async () => {
        throw new Error("socket closed");
      },
      120,
    );
    expect(
      await Promise.race([
        both,
        new Promise<"still looking">((r) => setTimeout(() => r("still looking"), 40)),
      ]),
    ).toBe("still looking");
    expect(await both).toBeNull();
    clearEventCache();
  });

  it("still finds the post when one relay answers and another cannot", async () => {
    // The silence must not hold up a hit, or the fix would have cost the deep
    // link its speed.
    clearEventCache();
    const event = makeEvent("a1".padEnd(64, "0"));
    const started = Date.now();
    const found = await fetchEventById(
      event.id,
      ["wss://a", "wss://dead"],
      async (url) => (url === "wss://a" ? [event] : null),
      5000,
    );
    expect(found).toBe(event);
    expect(Date.now() - started).toBeLessThan(1000);
    clearEventCache();
  });

  it(
    "asks again when nobody answered, and finds the post once they can",
    { timeout: 20_000 },
    async () => {
      // Waiting is not enough on its own: the relays are asked once, nothing comes
      // back, and the post is still not on screen — the only reason being that
      // every dial failed a moment ago. A reader whose network is on its feet is
      // who opens a deep link, so the question is asked again while the deadline
      // has room for it.
      clearEventCache();
      const event = makeEvent("a2".padEnd(64, "0"));
      let round = 0;
      const found = await fetchEventById(event.id, ["wss://a"], async () => {
        round += 1;
        return round >= 2 ? [event] : null;
      }, 5000);
      expect(found).toBe(event);
      expect(round).toBeGreaterThanOrEqual(2);
      clearEventCache();
    },
  );

  it(
    "gives up after a bounded number of retries, not on the first silence",
    { timeout: 20_000 },
    async () => {
      // A relay that is simply gone stays gone. Asking forever would be a loop
      // with a timeout in the middle of it, so the rounds are capped — and the
      // cap is what this pins.
      clearEventCache();
      let round = 0;
      const asked = Date.now();
      const found = await fetchEventById(
        "a3".padEnd(64, "0"),
        ["wss://a"],
        async () => {
          round += 1;
          return null;
        },
        5000,
      );
      expect(found).toBeNull();
      expect(round).toBeGreaterThan(1);
      expect(round).toBeLessThanOrEqual(4);
      expect(Date.now() - asked).toBeLessThan(5000);
      clearEventCache();
    },
  );

  it(
    "does not ask again once a relay has answered",
    { timeout: 20_000 },
    async () => {
      // The deleted post is the commonest shape, and it is answered on the first
      // round. Retrying it would cost three relays × several rounds of requests
      // to learn the same nothing, and hold the page for the whole deadline.
      clearEventCache();
      let asked = 0;
      const started = Date.now();
      const found = await fetchEventById(
        "a4".padEnd(64, "0"),
        ["wss://a", "wss://b", "wss://c"],
        async () => {
          asked += 1;
          return [];
        },
        5000,
      );
      expect(found).toBeNull();
      expect(asked).toBe(3);
      expect(Date.now() - started).toBeLessThan(1000);
      clearEventCache();
    },
  );
});

describe("answerEvents", () => {
  it("treats a failed query as no answer, and an EOSE as a verdict", () => {
    // `failed` is the relay being closed, timing out, or never asked — an empty
    // `events` array under it says nothing about whether the post exists, and
    // reading it as "no" is what turned a network blip into a dead deep link.
    const events = [makeEvent("b1".padEnd(64, "0"))];
    expect(answerEvents({ events, failed: false })).toBe(events);
    expect(answerEvents({ events, failed: true })).toBeNull();
    // An empty answer that really came is kept as one: a deleted post is answered
    // with nothing, and that is worth knowing straight away.
    expect(answerEvents({ events: [], failed: false })).toEqual([]);
    expect(answerEvents({ events: [], failed: true })).toBeNull();
  });
});

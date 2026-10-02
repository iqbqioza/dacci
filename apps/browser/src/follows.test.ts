import type { NostrEvent } from "dacci-nostr-nips";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixturePubkey, signAs } from "./fixture-event.js";

const SUBJECT = fixturePubkey("subject");
/** A followed pubkey. It authors nothing, so it is only ever a tag value. */
const ONE = "b".repeat(64);

/**
 * A NIP-02 contact list by the subject, naming whoever they follow.
 *
 * Signed, because the store reads a follow count off this list and will not
 * read one off an event the subject did not write.
 */
function contacts(follows: string[]): NostrEvent {
  return signAs("subject", {
    created_at: 1000,
    kind: 3,
    tags: follows.map((key) => ["p", key]),
    content: "",
  });
}

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** Long enough for the store's own deadline on one relay round. */
const ROUND = 5000;

/** A promise the test settles by hand, so a round can be held open. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.resetModules();
  asked.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock("./nostr.js");
  vi.doUnmock("./relays.js");
});

/**
 * The count store with one relay whose answer the test controls. `null` models
 * a relay that never answers at all, which is not the same as one that answers
 * with an empty list.
 */
async function withRelay(
  answer: () => Promise<{ failed: boolean; events: NostrEvent[] }>,
): Promise<typeof import("./follows.js")> {
  vi.doMock("./relays.js", () => ({
    useRelays: () => ({ readRelays: () => ["wss://a"] }),
  }));
  vi.doMock("./nostr.js", () => ({
    getConnection: () => ({
      url: "wss://a",
      // The filter is recorded so a test can assert what was actually asked for.
      // Without it, asking a relay about a different kind, or a different
      // author, would still pass every test in this file.
      query: (filter: Record<string, unknown>) => {
        asked.push(filter);
        return answer();
      },
    }),
  }));
  return import("./follows.js");
}

/** Every filter the store has put to a relay, in order. */
const asked: Array<Record<string, unknown>> = [];

describe("follow counts", () => {
  it("asks the relay for that subject's contact list, and nothing else", async () => {
    // The count is read off a kind 3 authored by the subject. Asking for any
    // other kind, or for any other author, returns someone else's follows and
    // the row would show a number about a different person.
    asked.length = 0;
    const store = await withRelay(async () => ({ failed: false, events: [] }));
    store.useFollowCount(SUBJECT);
    await tick();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ kinds: [3], authors: [SUBJECT] });
  });

  it("reports zero for a subject who follows nobody", async () => {
    // An answered round with an empty list is an answer, and it is the only
    // thing that says a subject follows nobody. Reading it as "nothing came
    // back" leaves the row unresolved, so "follows 0" is never shown.
    const store = await withRelay(async () => ({ failed: false, events: [] }));
    const count = store.useFollowCount(SUBJECT);
    await tick();
    expect(count()).toBe(0);
  });

  it("counts the follows and leaves the subject out", async () => {
    const store = await withRelay(async () => ({
      failed: false,
      events: [contacts([ONE, SUBJECT])],
    }));
    const count = store.useFollowCount(SUBJECT);
    await tick();
    expect(count()).toBe(1);
  });

  it("asks again after a relay stays silent", async () => {
    // A subject left queued is never asked about again for the rest of the
    // session, so one silent relay would cost the count permanently.
    let answer: { failed: boolean; events: NostrEvent[] } | null = null;
    const store = await withRelay(async () =>
      answer ?? new Promise(() => {}),
    );
    const count = store.useFollowCount(SUBJECT);
    // The round has to run out its deadline before the subject is unqueued.
    await vi.advanceTimersByTimeAsync(ROUND);
    // Silent, so nothing is known — which is honest.
    expect(count()).toBeNull();

    // The relay comes back, and asking again has to be allowed.
    answer = { failed: false, events: [contacts([ONE])] };
    const again = store.useFollowCount(SUBJECT);
    await vi.advanceTimersByTimeAsync(ROUND);
    expect(again()).toBe(1);
  });

  it("treats a relay that refused as silence, not as an empty list", async () => {
    // A refusal says nothing about the subject. Treating it as an answer would
    // say "follows 0" about someone who may follow a hundred people.
    const store = await withRelay(async () => ({ failed: true, events: [] }));
    const count = store.useFollowCount(SUBJECT);
    await tick();
    expect(count()).toBeNull();
  });

  it("throws away a count that lands after the relay set was dropped", async () => {
    const gate = deferred<{ failed: boolean; events: NostrEvent[] }>();
    const store = await withRelay(() => gate.promise);
    const count = store.useFollowCount(SUBJECT);
    await tick();
    // The reader changes their relays while the round is still out.
    store.resetFollowCounts();
    gate.resolve({ failed: false, events: [contacts([ONE])] });
    await tick();
    expect(count()).toBeNull();
  });
});
import { describe, expect, it } from "vitest";
import { compareEvents, type NostrEvent } from "dacci-nostr-nips";
import { planFlush } from "./flush.js";

function post(id: string, createdAt: number): NostrEvent {
  return {
    id,
    pubkey: "p".repeat(64),
    created_at: createdAt,
    kind: 1,
    tags: [],
    content: "x",
    sig: "s".repeat(128),
  };
}

describe("planFlush", () => {
  it("prepends arrivals the list does not hold, newest first", () => {
    const current = [post("a".repeat(64), 100)];
    const incoming = [post("b".repeat(64), 200)];
    const plan = planFlush(incoming, current);
    expect(plan.added.map((event) => event.id)).toEqual(["b".repeat(64)]);
    expect(plan.events.map((event) => event.id)).toEqual([
      "b".repeat(64),
      "a".repeat(64),
    ]);
  });

  it("drops arrivals the pagination already loaded", () => {
    // A relay replays its stored history after a reconnect, so the stream
    // repeats what the list holds. Concatenating would show the post twice;
    // the bar would also count it, and the press would appear to do nothing.
    const known = post("a".repeat(64), 100);
    const plan = planFlush([known, post("b".repeat(64), 200)], [known]);
    expect(plan.added.map((event) => event.id)).toEqual(["b".repeat(64)]);
    expect(plan.events).toHaveLength(2);
  });

  it("sorts rather than concatenates, so an old arrival cannot jump the queue", () => {
    // Nothing guarantees an arrival is newer than what is on screen: any
    // client with a skewed clock can post with an old timestamp.
    const plan = planFlush(
      [post("a".repeat(64), 50)],
      [post("b".repeat(64), 100)],
    );
    expect(plan.events.map((event) => event.created_at)).toEqual([100, 50]);
    expect(plan.events).toEqual(
      [...plan.events].sort(compareEvents),
    );
  });

  it("adds nothing when nothing is new", () => {
    const current = [post("a".repeat(64), 100)];
    const plan = planFlush([], current);
    expect(plan.added).toEqual([]);
    expect(plan.events).toEqual(current);
  });
});

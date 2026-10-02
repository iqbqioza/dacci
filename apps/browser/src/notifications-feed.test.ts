import type { Filter, NostrEvent } from "dacci-nostr-nips";
import { computeEventId } from "dacci-nostr-nips";
import { RelayConnection } from "dacci-nostr-ws";
import { describe, expect, it, vi } from "vitest";
import {
  createNotificationTimeline,
  isNotification,
  NOTIFICATION_KINDS,
} from "./nostr.js";

const SELF = "1".repeat(64);
const OTHER = "2".repeat(64);

function makeEvent(
  kind: number,
  pubkey: string,
  tags: string[][],
  at: number,
): NostrEvent {
  const base = { pubkey, created_at: at, kind, tags, content: "x" };
  return { ...base, id: computeEventId(base), sig: "s".repeat(128) };
}

/** In-memory relay that answers the addressed-to-SELF queries only. */
function recordingConnection(events: NostrEvent[]) {
  const filters: Filter[] = [];
  const conn = new RelayConnection("wss://a", () => {
    throw new Error("no socket in unit test");
  });
  vi.spyOn(conn, "query").mockImplementation(async (filter) => {
    filters.push(filter);
    const matches = events
      .filter((e) => (filter.kinds ?? []).includes(e.kind))
      .filter((e) =>
        e.tags.some((t) => t[0] === "p" && t[1] === SELF),
      )
      .filter((e) => filter.until === undefined || e.created_at <= filter.until)
      .sort((a, b) =>
        a.created_at !== b.created_at
          ? b.created_at - a.created_at
          : a.id < b.id
            ? -1
            : 1,
      );
    const page = matches.slice(0, filter.limit ?? 100);
    return { events: page, eose: true, failed: false, authRequired: false };
  });
  return { conn, filters };
}

describe("notification timeline", () => {
  it("asks for every kind that can carry a p tag for the reader", async () => {
    const { conn, filters } = recordingConnection([]);
    const paginator = createNotificationTimeline(["wss://a"], SELF, [conn]);
    await paginator.loadNextPage();
    expect(filters[0]?.kinds).toEqual(NOTIFICATION_KINDS);
    expect(filters[0]?.["#p"]).toEqual([SELF]);
    expect(filters[0]?.authors).toBeUndefined();
  });

  it("returns every kind that addresses the user", async () => {
    const events = [
      makeEvent(1, OTHER, [["p", SELF]], 300),
      makeEvent(6, OTHER, [["p", SELF]], 200),
      makeEvent(7, OTHER, [["p", SELF]], 100),
      // An answer under the reader's own reply is addressed to them just as
      // much, and kind 1111 was the one that used to go missing.
      makeEvent(1111, OTHER, [["p", SELF]], 50),
      // Not addressed: must never appear.
      makeEvent(1, OTHER, [], 400),
      makeEvent(1, OTHER, [["p", "9".repeat(64)]], 350),
    ];
    const { conn } = recordingConnection(events);
    const paginator = createNotificationTimeline(["wss://a"], SELF, [conn]);
    const page = await paginator.loadNextPage();
    expect(page.events.map((e) => e.kind).sort((a, b) => a - b)).toEqual([
      1,
      6,
      7,
      1111,
    ]);
    expect(
      page.events.every((e) =>
        e.tags.some((t) => t[0] === "p" && t[1] === SELF),
      ),
    ).toBe(true);
    expect(page.coverage).toBe("complete");
  });

  it("relays may return the user's own event; the client guard drops it", async () => {
    const events = [makeEvent(1, SELF, [["p", SELF]], 300)];
    const { conn } = recordingConnection(events);
    const paginator = createNotificationTimeline(["wss://a"], SELF, [conn]);
    const page = await paginator.loadNextPage();
    // The transport returns it; the store filters it out with
    // isNotification, because a user is never notified about themselves.
    expect(page.events.some((e) => e.pubkey === SELF)).toBe(true);
    expect(isNotification(page.events[0], SELF)).toBe(false);
  });
});

describe("isNotification", () => {
  const mention = makeEvent(1, OTHER, [["p", SELF]], 1);
  const longReply = makeEvent(1111, OTHER, [["p", SELF]], 1);
  const repost = makeEvent(6, OTHER, [["p", SELF]], 1);
  const reaction = makeEvent(7, OTHER, [["p", SELF]], 1);
  const elsewhere = makeEvent(1, OTHER, [["p", "9".repeat(64)]], 1);
  const own = makeEvent(7, SELF, [["p", SELF]], 1);
  const unlistedKind = makeEvent(30, OTHER, [["p", SELF]], 1);

  it("accepts mentions, reposts and reactions addressed to the user", () => {
    expect(isNotification(mention, SELF)).toBe(true);
    expect(isNotification(repost, SELF)).toBe(true);
    expect(isNotification(reaction, SELF)).toBe(true);
    // NIP-22's long-form reply carries the same `p` tag, so it notifies too.
    expect(isNotification(longReply, SELF)).toBe(true);
  });

  it("rejects events addressed elsewhere, own events and other kinds", () => {
    expect(isNotification(elsewhere, SELF)).toBe(false);
    expect(isNotification(own, SELF)).toBe(false);
    expect(isNotification(unlistedKind, SELF)).toBe(false);
  });
});

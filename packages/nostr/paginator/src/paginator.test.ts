import { describe, expect, it, vi } from "vitest";
import { RelayConnection } from "dacci-nostr-ws";
import type { NostrEvent } from "dacci-nostr-nips";
import { TimelinePaginator } from "../src/paginator.js";

function makeEvent(createdAt: number, seed: string): NostrEvent {
  const id = seed.padEnd(64, "0").slice(0, 64);
  return {
    id,
    pubkey: "p".repeat(64),
    created_at: createdAt,
    kind: 1,
    tags: [],
    content: seed,
    sig: "s".repeat(128),
  };
}

/** In-memory NIP-01 relay: newest-first, id-asc tie-break, inclusive until. */
function makeStore(count: number, startAt: number): NostrEvent[] {
  return Array.from({ length: count }, (_, i) =>
    makeEvent(startAt - i, `e${i.toString().padStart(5, "0")}`),
  );
}

function stubConnection(url: string, store: NostrEvent[]) {
  const conn = new RelayConnection(url, () => {
    throw new Error("no socket in unit test");
  });
  vi.spyOn(conn, "query").mockImplementation(async (filter) => {
    const matches = store.filter(
      (e) =>
        (filter.until === undefined || e.created_at <= filter.until) &&
        (filter.kinds === undefined || filter.kinds.includes(e.kind)),
    );
    matches.sort((a, b) =>
      a.created_at !== b.created_at
        ? b.created_at - a.created_at
        : a.id < b.id
          ? -1
          : 1,
    );
    const events = matches.slice(0, filter.limit ?? 100);
    return { events, eose: true, failed: false, authRequired: false };
  });
  return conn;
}

describe("TimelinePaginator", () => {
  it("drains history without loss and reports complete", async () => {
    const store = makeStore(250, 2000);
    const paginator = new TimelinePaginator([stubConnection("wss://a", store)], {
      kinds: [1],
    });
    const seen = new Set<string>();
    let coverage = "";
    while (paginator.hasMore()) {
      const page = await paginator.loadNextPage();
      coverage = page.coverage;
      for (const e of page.events) seen.add(e.id);
      if (page.events.length === 0) break;
    }
    expect(seen.size).toBe(250);
    expect(coverage).toBe("complete");
  });

  it("re-fetches same-second boundaries with limit expansion", async () => {
    const burst = Array.from({ length: 150 }, (_, i) =>
      makeEvent(1000, `b${i.toString().padStart(5, "0")}`),
    );
    const older = Array.from({ length: 50 }, (_, i) =>
      makeEvent(999, `c${i.toString().padStart(5, "0")}`),
    );
    const paginator = new TimelinePaginator(
      [stubConnection("wss://a", [...burst, ...older])],
      { kinds: [1] },
      { baseLimit: 100, maxLimit: 500 },
    );
    const seen = new Set<string>();
    for (let i = 0; i < 10 && paginator.hasMore(); i++) {
      const page = await paginator.loadNextPage();
      for (const e of page.events) seen.add(e.id);
      if (page.events.length === 0 && page.coverage === "complete") break;
    }
    expect(seen.size).toBe(200);
  });

  it("does not wait for a relay that never answers", async () => {
    const good = stubConnection("wss://fast", makeStore(40, 2000));
    // Accepts the connection but never resolves.
    const dead = new RelayConnection("wss://dead", () => {
      throw new Error("no socket in unit test");
    });
    vi.spyOn(dead, "query").mockImplementation(
      () => new Promise(() => {}),
    );
    const started = Date.now();
    const paginator = new TimelinePaginator([good, dead], { kinds: [1] }, {
      pageSize: 30,
      roundTimeoutMs: 300,
      maxRounds: 2,
    });
    const page = await paginator.loadNextPage();
    expect(Date.now() - started).toBeLessThan(2500);
    expect(page.events.length).toBeGreaterThan(0);
    expect(page.coverage).toBe("partial");
    expect(page.pendingRelays).toContain("wss://dead");
  });

  it("retries an auth-gated relay as soon as a signer is attached", async () => {
    const conn = new RelayConnection("wss://auth", () => {
      throw new Error("no socket in unit test");
    });
    const query = vi.spyOn(conn, "query").mockResolvedValue({
      events: [],
      eose: false,
      failed: true,
      authRequired: true,
    });
    const paginator = new TimelinePaginator([conn], { kinds: [1] }, {
      pageSize: 1,
      maxRounds: 3,
    });
    await paginator.loadNextPage();
    const parked = query.mock.calls.length;

    // Session restored: the signer can now answer the challenge.
    conn.setSigner(() => ({
      id: "a".repeat(64),
      pubkey: "b".repeat(64),
      created_at: 1,
      kind: 22242,
      tags: [],
      content: "",
      sig: "c".repeat(128),
    }));
    query.mockResolvedValue({
      events: [makeEvent(1000, "e")],
      eose: true,
      failed: false,
      authRequired: false,
    });
    const page = await paginator.loadNextPage();
    expect(query.mock.calls.length).toBeGreaterThan(parked);
    expect(page.events).toHaveLength(1);
    expect(page.authRequiredRelays).toEqual([]);
  });
});

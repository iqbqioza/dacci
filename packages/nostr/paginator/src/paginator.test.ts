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

  it("reaches history behind a relay that serves fewer events than asked", async () => {
    // NIP-01 lets a relay cap what it will serve, so a relay whose `max_limit`
    // is under the request answers with a short page every single time. Reading
    // that as "run out" ends the relay's history on the first round: the cursor
    // never moves down and `coverage` claims the reader has reached the end.
    const store = makeStore(400, 2000);
    const capped = new RelayConnection("wss://capped", () => {
      throw new Error("no socket in unit test");
    });
    vi.spyOn(capped, "query").mockImplementation(async (filter) => {
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
      // The relay's own cap, well under anything the paginator requests.
      return {
        events: matches.slice(0, 25),
        eose: true,
        failed: false,
        authRequired: false,
      };
    });
    const paginator = new TimelinePaginator([capped], { kinds: [1] }, {
      pageSize: 30,
      maxRounds: 40,
    });
    const seen = new Set<string>();
    for (let i = 0; i < 60 && paginator.hasMore(); i++) {
      const page = await paginator.loadNextPage();
      for (const e of page.events) seen.add(e.id);
      if (page.events.length === 0 && page.coverage === "complete") break;
    }
    expect(seen.size).toBe(400);
  });

  it("keeps the events a relay sent before its deadline ran out", async () => {
    // The transport holds on to whatever arrived so it can survive a timeout,
    // and each of those events passed the same checks as any other. Dropping
    // the batch because it was late means a relay under load contributes
    // nothing at all, however much it did manage to send.
    const store = makeStore(300, 2000);
    const slow = new RelayConnection("wss://slow", () => {
      throw new Error("no socket in unit test");
    });
    vi.spyOn(slow, "query").mockImplementation(async (filter) => {
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
      // A full page, then no EOSE before the deadline: the honest report of a
      // relay that ran out of time mid-round.
      return {
        events: matches.slice(0, filter.limit ?? 100),
        eose: false,
        failed: true,
        authRequired: false,
      };
    });
    const paginator = new TimelinePaginator([slow], { kinds: [1] }, {
      pageSize: 30,
      maxRounds: 3,
    });
    const page = await paginator.loadNextPage();
    expect(page.events.length).toBeGreaterThan(0);
    // More may still be coming, so the reader is not told this is everything.
    expect(page.coverage).toBe("partial");
  });

  it("stops offering more once a burst exceeds what one page can hold", async () => {
    // More events than `maxLimit` sharing one second cannot be paged past: the
    // cursor asks for the same boundary again and gets the same wall back. The
    // relay is stepped below that second rather than parked on it, so this also
    // pins the part that used to go wrong — `hasMore` cannot stay true for the
    // rest of the session, or every press would do a full round of queries,
    // return nothing, and wake the background retry every fifteen seconds.
    //
    // What the step-down reaches *below* the boundary, and the honest "this
    // history has a hole in it" that follows, are the two tests after it.
    const burst = Array.from({ length: 600 }, (_, i) =>
      makeEvent(1000, `d${i.toString().padStart(5, "0")}`),
    );
    const older = Array.from({ length: 50 }, (_, i) =>
      makeEvent(999, `f${i.toString().padStart(5, "0")}`),
    );
    const paginator = new TimelinePaginator(
      [stubConnection("wss://a", [...burst, ...older])],
      { kinds: [1] },
      { baseLimit: 100, maxLimit: 200, pageSize: 100, maxRounds: 4 },
    );
    const seen = new Set<string>();
    let coverage = "";
    // Press until the paginator says there is nothing more, but bounded: the
    // point is that it says so rather than running forever.
    for (let i = 0; i < 30; i++) {
      if (!paginator.hasMore()) break;
      const page = await paginator.loadNextPage();
      coverage = page.coverage;
      for (const e of page.events) seen.add(e.id);
    }
    expect(paginator.hasMore()).toBe(false);
    // Nothing is pending either, so nothing schedules a retry against it.
    expect(paginator.pendingRelays()).toEqual([]);
    // And it does not claim to have reached the end of history.
    expect(coverage).toBe("partial");
    expect(seen.size).toBeGreaterThan(0);
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

describe("telling an empty timeline from an unreachable one", () => {
  it("names the relays that refused, so a view need not guess", async () => {
    // A feed that renders one message for both cases tells a reader their own
    // account has never posted when the truth is that every relay refused, and a
    // reader of someone else's profile that this person has never written a
    // word. The page has to carry which relays actually failed, because nothing
    // else in it can tell an empty answer from a missing one.
    const dead = new RelayConnection("wss://dead", () => {
      throw new Error("no socket in unit test");
    });
    vi.spyOn(dead, "query").mockResolvedValue({
      events: [],
      eose: false,
      failed: true,
      authRequired: false,
    });
    const paginator = new TimelinePaginator([dead], { kinds: [1] });
    const page = await paginator.loadNextPage();
    expect(page.events).toEqual([]);
    expect(page.failedRelays).toEqual(["wss://dead"]);
  });

  it("reports no failures once a relay answers", async () => {
    // The other half: an empty answer from a working relay is not a failure, and
    // the list must be able to tell the reader so.
    const store = makeStore(0, 2000);
    const paginator = new TimelinePaginator([stubConnection("wss://a", store)], {
      kinds: [1],
    });
    const page = await paginator.loadNextPage();
    expect(page.events).toEqual([]);
    expect(page.failedRelays).toEqual([]);
    expect(page.coverage).toBe("complete");
  });

  it("stops naming a relay once it recovers", async () => {
    // A list that only ever grows would leave a recovered relay reported as
    // broken for the rest of the session, and the view would keep saying the
    // feed could not be fetched.
    const store = makeStore(3, 2000);
    const flaky = stubConnection("wss://flaky", []);
    let refuse = true;
    vi.spyOn(flaky, "query").mockImplementation(async (filter) => {
      if (refuse) {
        return { events: [], eose: false, failed: true, authRequired: false };
      }
      return stubConnection("wss://x", store).query(filter);
    });
    // The clock is driven by hand so the backoff is waited out rather than
    // skipped: the relay has to be asked again, not merely believed to be well.
    // Far enough past the store's newest event (2000) to cover it, and moved
    // by hand so the backoff is waited out rather than skipped.
    let clock = 3_000_000;
    const paginator = new TimelinePaginator(
      [flaky],
      { kinds: [1] },
      { baseBackoffMs: 1000, maxBackoffMs: 1000 },
      () => clock,
    );
    expect((await paginator.loadNextPage()).failedRelays).toEqual([
      "wss://flaky",
    ]);
    refuse = false;
    clock += 5000;
    const page = await paginator.loadNextPage();
    expect(page.failedRelays).toEqual([]);
    expect(page.events).toHaveLength(3);
  });
});

describe("a second too crowded to page through", () => {
  /**
   * A relay whose newest second holds more events than the client will ever be
   * asked for, with ordinary history underneath it.
   *
   * The burst cannot be paged: NIP-01 pages by `until`, so there is no way to
   * ask for the rest of one second. Everything below it is a different second
   * and is perfectly reachable.
   */
  function burstRelay(burstAt: number, burstSize: number, older: number) {
    const burst = Array.from({ length: burstSize }, (_, i) =>
      makeEvent(burstAt, `b${i.toString().padStart(6, "0")}`),
    );
    const rest = Array.from({ length: older }, (_, i) =>
      makeEvent(burstAt - 1 - i, `o${i.toString().padStart(6, "0")}`),
    );
    return [...burst, ...rest];
  }

  it("reaches the history below it instead of stopping at the burst", async () => {
    // Parking the relay at the crowded second made everything older unreachable
    // as well: a few hundred posts landing in one second cost a reader every post
    // before them, on that relay, for the rest of the session. The timeline
    // reported "unconfirmed" and there was no way to ask again.
    const store = burstRelay(1000, 600, 50);
    const conn = stubConnection("wss://burst", store);
    const paginator = new TimelinePaginator([conn], { kinds: [1] }, {}, () => 1001_000);

    const seen = new Set<string>();
    let guard = 0;
    while (paginator.hasMore() && guard++ < 60) {
      for (const e of (await paginator.loadNextPage()).events) seen.add(e.id);
    }

    // The 50 posts a second older than the burst are all here. Before the fix
    // the burst was terminal and none of them was.
    const older = store.filter((e) => e.created_at < 1000);
    expect(older.length).toBe(50);
    expect(older.filter((e) => seen.has(e.id))).toHaveLength(50);
  });

  it("does not call the history whole when a slice is out of reach", async () => {
    // The other half, and the reason the step-down is not simply "ignore it".
    // A timeline with a hole in it is partial, whatever else was reached.
    const store = burstRelay(1000, 600, 50);
    const paginator = new TimelinePaginator(
      [stubConnection("wss://burst", store)],
      { kinds: [1] },
      {},
      () => 1001_000,
    );
    let guard = 0;
    let coverage = "partial";
    while (paginator.hasMore() && guard++ < 60) {
      coverage = (await paginator.loadNextPage()).coverage;
    }
    // It finished — no more history to ask for — and it is still not complete.
    expect(paginator.hasMore()).toBe(false);
    expect(coverage).toBe("partial");
  });

  it("still reports a clean timeline as complete", async () => {
    // The step-down must not cost the honest answer in the ordinary case, or
    // every reader would be told their history was unconfirmed.
    const store = makeStore(200, 2000);
    const paginator = new TimelinePaginator([stubConnection("wss://a", store)], {
      kinds: [1],
    });
    let coverage = "";
    while (paginator.hasMore()) {
      coverage = (await paginator.loadNextPage()).coverage;
    }
    expect(coverage).toBe("complete");
  });
});

describe("a second that fits inside the widest request", () => {
  it("is received whole, and the history is not called partial", async () => {
    // The step-down fires when the raised limit reaches the ceiling, which is the
    // *next* request's width rather than the one that just came back. Testing the
    // raised limit marked a boundary the client had never asked the full width of:
    // a second holding exactly `maxLimit / 2` arrived complete, every event was
    // committed, and nothing was lost — and the timeline still told the reader the
    // end of their history was unconfirmed, for the rest of the session.
    const burstAt = 1000;
    const events = [
      ...Array.from({ length: 400 }, (_, i) =>
        makeEvent(burstAt, `h${i.toString().padStart(5, "0")}`),
      ),
      ...Array.from({ length: 20 }, (_, i) =>
        makeEvent(burstAt - 1, `l${i.toString().padStart(5, "0")}`),
      ),
    ];
    const paginator = new TimelinePaginator(
      [stubConnection("wss://a", events)],
      { kinds: [1] },
      { baseLimit: 100, maxLimit: 500, pageSize: 100 },
      () => 1001_000,
    );
    const seen = new Set<string>();
    let coverage = "";
    let guard = 0;
    while (paginator.hasMore() && guard++ < 40) {
      const page = await paginator.loadNextPage();
      coverage = page.coverage;
      for (const e of page.events) seen.add(e.id);
    }
    // Every event arrived, and so the history is whole: the footer must not say
    // otherwise, which is the only thing a reader would act on.
    expect(seen.size).toBe(events.length);
    expect(coverage).toBe("complete");
  });
});

import { computeEventId, type NostrEvent } from "dacci-nostr-nips";
import { describe, expect, it, vi } from "vitest";
import { RelayConnection, type Socket } from "../src/relay.js";

/**
 * A relay's event, with the id the NIP-01 hash actually gives it.
 *
 * The connection drops anything whose id does not match its own fields, so a
 * fixture with a made-up id would be testing a rejection rather than the
 * behaviour it is named after.
 */
function relayEvent(fields: {
  pubkey: string;
  created_at?: number;
  kind?: number;
  tags?: string[][];
  content?: string;
}): NostrEvent {
  const full = {
    pubkey: fields.pubkey,
    created_at: fields.created_at ?? 1000,
    kind: fields.kind ?? 1,
    tags: fields.tags ?? [],
    content: fields.content ?? "x",
  };
  return { ...full, id: computeEventId(full), sig: "c".repeat(128) };
}

function makeSocket(): Socket & { peer: (msg: unknown) => void } {
  const socket: Socket & { peer: (msg: unknown) => void } = {
    send: vi.fn(),
    close: vi.fn(),
    onmessage: null,
    onopen: null,
    onerror: null,
    onclose: null,
    peer: (msg) => socket.onmessage?.(JSON.stringify(msg)),
  };
  queueMicrotask(() => socket.onopen?.());
  return socket;
}

describe("RelayConnection.query", () => {
  it("collects events until EOSE", async () => {
    const socket = makeSocket();
    const conn = new RelayConnection("wss://example", () => socket, {
      authGateProbeMs: 0,
    });
    const event = relayEvent({ pubkey: "b".repeat(64), created_at: 1000, kind: 1, tags: [], content: "hi" });
    const pending = conn.query({ kinds: [1], limit: 10 });
    await new Promise((r) => setTimeout(r, 0));
    const sent = vi.mocked(socket.send).mock.calls[0][0];
    const subId = JSON.parse(sent)[1] as string;
    socket.peer(["EVENT", subId, event]);
    socket.peer(["EOSE", subId]);
    const result = await pending;
    expect(result.failed).toBe(false);
    expect(result.eose).toBe(true);
    expect(result.events).toHaveLength(1);
  });

  it("refuses a query event the filter did not ask for", async () => {
    // A relay may answer a query with anything on the open id, and a query's
    // events are merged into the page and sorted in, so whatever arrives becomes
    // part of the answer. The live branch already checks this; the query branch
    // did not, so a kind 4 delivered to a feed that asked for notes was taken
    // as one of its answers.
    //
    // The `until` half matters just as much. A feed's filter is built with
    // `until` set to now, and NIP-01 puts no upper bound on `created_at`, so a
    // note dated centuries ahead is one every conforming relay will store and
    // serve — and without the check it sorts to the top of the feed, where
    // loading more pages never passes it.
    const socket = makeSocket();
    const conn = new RelayConnection("wss://example", () => socket, {
      authGateProbeMs: 0,
    });
    const now = Math.floor(Date.now() / 1000);
    const pending = conn.query({
      kinds: [1],
      authors: ["a".repeat(64)],
      until: now,
    });
    await new Promise((r) => setTimeout(r, 0));
    const sent = vi.mocked(socket.send).mock.calls[0][0];
    const subId = JSON.parse(sent)[1] as string;
    const author = "a".repeat(64);

    // A direct message, and a note by an author the filter did not name.
    socket.peer([
      "EVENT",
      subId,
      relayEvent({ pubkey: author, created_at: now - 10, kind: 4, tags: [], content: "" }),
    ]);
    socket.peer([
      "EVENT",
      subId,
      relayEvent({ pubkey: "b".repeat(64), created_at: now - 10, kind: 1, tags: [], content: "hi" }),
    ]);
    // And one dated centuries ahead.
    socket.peer([
      "EVENT",
      subId,
      relayEvent({ pubkey: author, created_at: 2 ** 31, kind: 1, tags: [], content: "later" }),
    ]);
    socket.peer(["EOSE", subId]);
    expect((await pending).events).toEqual([]);
  });

  it("still returns what the query filter did ask for", async () => {
    // The check above is only worth having if it keeps the real answer.
    const socket = makeSocket();
    const conn = new RelayConnection("wss://example", () => socket, {
      authGateProbeMs: 0,
    });
    const now = Math.floor(Date.now() / 1000);
    const author = "a".repeat(64);
    const pending = conn.query({ kinds: [1], authors: [author], until: now });
    await new Promise((r) => setTimeout(r, 0));
    const sent = vi.mocked(socket.send).mock.calls[0][0];
    const subId = JSON.parse(sent)[1] as string;
    socket.peer([
      "EVENT",
      subId,
      relayEvent({ pubkey: author, created_at: now - 10, kind: 1, tags: [], content: "hi" }),
    ]);
    socket.peer(["EOSE", subId]);
    const result = await pending;
    expect(result.events).toHaveLength(1);
    expect(result.events[0].content).toBe("hi");
  });

  it("marks CLOSED as failed", async () => {
    const socket = makeSocket();
    const conn = new RelayConnection("wss://example", () => socket, {
      authGateProbeMs: 0,
    });
    const pending = conn.query({ kinds: [1] });
    await new Promise((r) => setTimeout(r, 0));
    const sent = vi.mocked(socket.send).mock.calls[0][0];
    const subId = JSON.parse(sent)[1] as string;
    socket.peer(["CLOSED", subId, "error: nope"]);
    const result = await pending;
    expect(result.failed).toBe(true);
    expect(result.eose).toBe(false);
  });

  it("drops an event whose id is not the hash of its own fields", async () => {
    // An id is the sha256 of the event's fields, so checking it is what makes
    // an id mean anything. Without the check a relay can serve rewritten words
    // under someone else's id, and every list, deep link and dedupe keyed on
    // that id ends up describing a different event than the one that was signed.
    const socket = makeSocket();
    const conn = new RelayConnection("wss://example", () => socket, {
      authGateProbeMs: 0,
    });
    const pending = conn.query({ kinds: [1] });
    await new Promise((r) => setTimeout(r, 0));
    const sent = vi.mocked(socket.send).mock.calls[0][0];
    const subId = JSON.parse(sent)[1] as string;

    const genuine = relayEvent({
      pubkey: "b".repeat(64),
      created_at: 1000,
      content: "what the author wrote",
    });
    // Same id, different words: the shape is fine, the identity is not.
    const tampered = { ...genuine, content: "what the relay chose" };
    socket.peer(["EVENT", subId, tampered]);
    socket.peer(["EVENT", subId, genuine]);
    socket.peer(["EOSE", subId]);

    const result = await pending;
    expect(result.events.map((e) => e.content)).toEqual([
      "what the author wrote",
    ]);
  });

  it("drops an event whose id is not even hex", async () => {
    const socket = makeSocket();
    const conn = new RelayConnection("wss://example", () => socket, {
      authGateProbeMs: 0,
    });
    const pending = conn.query({ kinds: [1] });
    await new Promise((r) => setTimeout(r, 0));
    const sent = vi.mocked(socket.send).mock.calls[0][0];
    const subId = JSON.parse(sent)[1] as string;
    socket.peer(["EVENT", subId, { id: "nope" }]);
    socket.peer(["EOSE", subId]);
    const result = await pending;
    expect(result.events).toEqual([]);
  });

  it("refuses a live event that does not match its id", async () => {
    const socket = makeSocket();
    const conn = new RelayConnection("wss://example", () => socket, {
      authGateProbeMs: 0,
    });
    const seen: string[] = [];
    conn.subscribe({ kinds: [1] }, (e) => seen.push(e.content));
    await new Promise((r) => setTimeout(r, 0));
    const sent = vi.mocked(socket.send).mock.calls[0][0];
    const subId = JSON.parse(sent)[1] as string;
    const genuine = relayEvent({ pubkey: "b".repeat(64), created_at: 1000 });
    socket.peer(["EVENT", subId, { ...genuine, content: "swapped" }]);
    socket.peer(["EVENT", subId, genuine]);
    expect(seen).toEqual(["x"]);
  });

  it("refuses a live event the subscription did not ask for", async () => {
    // A relay may push anything on an open subscription id. The buffers take
    // whatever arrives, so a kind 4 direct message delivered to a feed that
    // asked for notes — or one event dated far in the future, which would sit
    // at the top of the reader's list for the rest of the session — must not
    // get through.
    const socket = makeSocket();
    const conn = new RelayConnection("wss://example", () => socket, {
      authGateProbeMs: 0,
    });
    const seen: number[] = [];
    conn.subscribe({ kinds: [1], "#p": ["9".repeat(64)] }, (e) =>
      seen.push(e.kind),
    );
    await new Promise((r) => setTimeout(r, 0));
    const sent = vi.mocked(socket.send).mock.calls[0][0];
    const subId = JSON.parse(sent)[1] as string;

    // A perfectly well-formed note, but addressed to someone else.
    socket.peer([
      "EVENT",
      subId,
      relayEvent({ pubkey: "b".repeat(64), created_at: 1000 }),
    ]);
    // And a direct message on a subscription that asked for notes.
    socket.peer([
      "EVENT",
      subId,
      relayEvent({ pubkey: "b".repeat(64), created_at: 1001, kind: 4 }),
    ]);
    expect(seen).toEqual([]);

    // What it did ask for still arrives.
    socket.peer([
      "EVENT",
      subId,
      relayEvent({
        pubkey: "b".repeat(64),
        created_at: 1002,
        tags: [["p", "9".repeat(64)]],
      }),
    ]);
    expect(seen).toEqual([1]);
  });

  it("answers a NIP-42 challenge and completes on EOSE", async () => {
    const socket = makeSocket();
    const authEvent = relayEvent({ pubkey: "b".repeat(64), created_at: 1000, kind: 22242, tags: [["relay", "wss://example"]], content: "" });
    const conn = new RelayConnection(
      "wss://example",
      () => socket,
      { signer: () => authEvent, authGateProbeMs: 0 },
    );
    const pending = conn.query({ kinds: [1] });
    await new Promise((r) => setTimeout(r, 0));
    socket.peer(["AUTH", "challenge-1"]);
    await new Promise((r) => setTimeout(r, 0));
    const sent = vi.mocked(socket.send).mock.calls.map((call) => call[0]);
    expect(sent).toHaveLength(2);
    expect(JSON.parse(sent[1])).toEqual(["AUTH", authEvent]);
    const subId = JSON.parse(sent[0])[1] as string;
    socket.peer(["EOSE", subId]);
    const result = await pending;
    expect(result.authRequired).toBe(true);
    expect(result.failed).toBe(false);
    expect(result.eose).toBe(true);
  });

  it("settles both waits when one event is published twice", async () => {
    // A double press on repost or react builds one event and reaches the
    // transport twice, and the map held one waiter per event id. The second
    // publish overwrote the first, so the first was dropped and reported a
    // timeout — and its timeout then deleted the second's entry, reporting a
    // relay that had accepted the event as refusing it.
    const socket = makeSocket();
    const conn = new RelayConnection("wss://example", () => socket, {
      authGateProbeMs: 0,
    });
    const event = relayEvent({ pubkey: "b".repeat(64), created_at: 1000 });

    const first = conn.publish(event, 300);
    await new Promise((r) => setTimeout(r, 0));
    const second = conn.publish(event, 300);
    await new Promise((r) => setTimeout(r, 0));
    socket.peer(["OK", event.id, true, ""]);

    const [a, b] = await Promise.all([first, second]);
    expect(a.accepted).toBe(true);
    expect(b.accepted).toBe(true);
  });

  it("stops answering a relay that keeps asking", async () => {
    // Answering a NIP-42 challenge costs the reader a confirmation when the
    // signer is a NIP-07 extension. The dedupe only catches a repeated string,
    // so a relay sending distinct challenges could pop a dialog for as many as
    // it liked — from a relay the reader merely reads from.
    const socket = makeSocket();
    const authEvent = relayEvent({
      pubkey: "b".repeat(64),
      created_at: 1000,
      kind: 22242,
      tags: [["relay", "wss://example"]],
      content: "",
    });
    const signer = vi.fn(async () => authEvent);
    const conn = new RelayConnection("wss://example", () => socket, {
      signer,
      authGateProbeMs: 0,
    });
    conn.subscribe({ kinds: [1] }, () => {});
    await new Promise((r) => setTimeout(r, 0));

    for (let i = 0; i < 12; i++) {
      socket.peer(["AUTH", `challenge-${i}`]);
      await new Promise((r) => setTimeout(r, 0));
    }
    // Bounded, rather than one prompt per challenge the relay invents.
    expect(signer.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it("flags auth-required CLOSED when no signer is configured", async () => {
    const socket = makeSocket();
    const conn = new RelayConnection("wss://example", () => socket, {
      authGateProbeMs: 0,
    });
    const pending = conn.query({ kinds: [1] });
    await new Promise((r) => setTimeout(r, 0));
    const sent = vi.mocked(socket.send).mock.calls[0][0];
    const subId = JSON.parse(sent)[1] as string;
    socket.peer(["CLOSED", subId, "auth-required: login first"]);
    const result = await pending;
    expect(result.failed).toBe(true);
    expect(result.authRequired).toBe(true);
  });

  it("serves concurrent queries without clobbering", async () => {
    const socket = makeSocket();
    const conn = new RelayConnection("wss://example", () => socket, {
      authGateProbeMs: 0,
    });
    const eventA = relayEvent({ pubkey: "b".repeat(64), created_at: 1000, kind: 1, tags: [], content: "a" });
    const eventB = relayEvent({ pubkey: "b".repeat(64), content: "b" });
    const first = conn.query({ kinds: [1] });
    const second = conn.query({ kinds: [1] });
    await new Promise((r) => setTimeout(r, 0));
    const calls = vi.mocked(socket.send).mock.calls.map((call) => call[0]);
    expect(calls).toHaveLength(2);
    const [subA, subB] = calls.map(
      (raw) => JSON.parse(raw)[1] as string,
    );
    expect(subA).not.toBe(subB);
    socket.peer(["EVENT", subA, eventA]);
    socket.peer(["EVENT", subB, eventB]);
    socket.peer(["EOSE", subB]);
    socket.peer(["EOSE", subA]);
    const [resultA, resultB] = await Promise.all([first, second]);
    expect(resultA.events).toHaveLength(1);
    expect(resultB.events).toHaveLength(1);
    expect(resultA.events[0].id).toBe(eventA.id);
    expect(resultB.events[0].id).toBe(eventB.id);
  });

  it("publishes an event and resolves on OK", async () => {
    const socket = makeSocket();
    const conn = new RelayConnection("wss://example", () => socket, {
      authGateProbeMs: 0,
    });
    const event = relayEvent({ pubkey: "b".repeat(64), created_at: 1000, kind: 1, tags: [], content: "hi" });
    const pending = conn.publish(event);
    await new Promise((r) => setTimeout(r, 0));
    expect(JSON.parse(vi.mocked(socket.send).mock.calls[0][0])).toEqual([
      "EVENT",
      event,
    ]);
    socket.peer(["OK", event.id, true, ""]);
    const result = await pending;
    expect(result).toEqual({ accepted: true, message: "" });
  });

  it("streams live events after EOSE", async () => {
    const socket = makeSocket();
    const conn = new RelayConnection("wss://example", () => socket, {
      authGateProbeMs: 0,
    });
    const received: string[] = [];
    let eosed = false;
    conn.subscribe({ kinds: [1] }, (event) => received.push(event.content), {
      onEose: () => {
        eosed = true;
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    const sent = vi.mocked(socket.send).mock.calls[0][0];
    const subId = JSON.parse(sent)[1] as string;
    socket.peer(["EOSE", subId]);
    expect(eosed).toBe(true);
    socket.peer([
      "EVENT",
      subId,
      relayEvent({ pubkey: "b".repeat(64), created_at: 2000, kind: 1, tags: [], content: "live" }),
    ]);
    expect(received).toEqual(["live"]);
  });

  it("re-opens live subscriptions after a reconnect", async () => {
    const sockets: Array<ReturnType<typeof makeSocket>> = [];
    const factory = () => {
      const socket = makeSocket();
      sockets.push(socket);
      return socket;
    };
    const conn = new RelayConnection("wss://example", factory, {
      baseReconnectMs: 5,
      maxReconnectMs: 10,
      authGateProbeMs: 0,
    });
    conn.subscribe({ kinds: [1] }, () => {});
    await new Promise((r) => setTimeout(r, 0));
    expect(sockets).toHaveLength(1);
    sockets[0].onclose?.();
    await new Promise((r) => setTimeout(r, 60));
    expect(sockets).toHaveLength(2);
    const resent = vi.mocked(sockets[1].send).mock.calls.map((c) => c[0]);
    expect(resent).toHaveLength(1);
    expect(JSON.parse(resent[0])[0]).toBe("REQ");
    conn.close();
  });

  it("unsubscribe stops delivery and sends CLOSE", async () => {
    const socket = makeSocket();
    const conn = new RelayConnection("wss://example", () => socket, {
      authGateProbeMs: 0,
    });
    const received: string[] = [];
    const sub = conn.subscribe({ kinds: [1] }, (e) => received.push(e.content));
    await new Promise((r) => setTimeout(r, 5));
    const subId = JSON.parse(
      vi.mocked(socket.send).mock.calls[0][0],
    )[1] as string;
    sub.unsubscribe();
    expect(JSON.parse(
      vi.mocked(socket.send).mock.calls[1][0],
    )).toEqual(["CLOSE", subId]);
    socket.peer([
      "EVENT",
      subId,
      relayEvent({ pubkey: "b".repeat(64), created_at: 1, kind: 1, tags: [], content: "after" }),
    ]);
    expect(received).toEqual([]);
  });

  it("answers a challenge that arrived before the signer was attached", async () => {
    const socket = makeSocket();
    const conn = new RelayConnection("wss://example", () => socket, {
      authGateProbeMs: 0,
    });
    // No signer yet: the first REQ is challenged.
    const pending = conn.query({ kinds: [1] });
    await new Promise((r) => setTimeout(r, 0));
    const calls = vi.mocked(socket.send).mock.calls.map((c) => c[0]);
    const subId = JSON.parse(calls[0])[1] as string;
    socket.peer(["AUTH", "challenge-late"]);
    await new Promise((r) => setTimeout(r, 0));
    // Nothing answered yet, but the challenge was not lost.
    expect(calls).toHaveLength(1);

    const authEvent = relayEvent({ pubkey: "b".repeat(64), created_at: 1, kind: 22242, tags: [["relay", "wss://example"]], content: "" });
    conn.setSigner(() => authEvent);
    await new Promise((r) => setTimeout(r, 0));
    const after = vi.mocked(socket.send).mock.calls.map((c) => c[0]);
    expect(after).toHaveLength(2);
    expect(JSON.parse(after[1])).toEqual(["AUTH", authEvent]);

    socket.peer(["EOSE", subId]);
    const result = await pending;
    expect(result.eose).toBe(true);
    expect(result.authRequired).toBe(true);
  });

  it("never sends a REQ before answering the challenge", async () => {
    const socket = makeSocket();
    const authEvent = relayEvent({ pubkey: "b".repeat(64), created_at: 1, kind: 22242, tags: [], content: "" });
    const conn = new RelayConnection(
      "wss://example",
      () => socket,
      { signer: () => authEvent, authGateProbeMs: 300 },
    );
    const pending = conn.query({ kinds: [1] });
    await new Promise((r) => setTimeout(r, 0));
    // Relay challenges as soon as the socket opens.
    socket.peer(["AUTH", "challenge-gate"]);
    await new Promise((r) => setTimeout(r, 20));
    const frames = vi.mocked(socket.send).mock.calls.map(
      (c) => JSON.parse(c[0])[0] as string,
    );
    // The invariant: AUTH is on the wire before any REQ, never after.
    expect(frames[0]).toBe("AUTH");
    expect(frames.filter((f) => f === "AUTH")).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 20));
    const after = vi.mocked(socket.send).mock.calls.map((c) => c[0]);
    const kinds = after.map((raw) => JSON.parse(raw)[0] as string);
    expect(kinds.indexOf("AUTH")).toBeLessThan(kinds.indexOf("REQ"));
    const subId = JSON.parse(
      after[kinds.indexOf("REQ")] as string,
    )[1] as string;
    socket.peer(["EOSE", subId]);
    expect((await pending).eose).toBe(true);
  });

  it("reconnects after an unexpected close", async () => {
    const sockets: Array<ReturnType<typeof makeSocket>> = [];
    const factory = () => {
      const socket = makeSocket();
      sockets.push(socket);
      return socket;
    };
    const conn = new RelayConnection("wss://example", factory, {
      baseReconnectMs: 5,
      maxReconnectMs: 10,
      authGateProbeMs: 0,
    });
    expect(conn.status).toBe("closed");
    const pending = conn.query({ kinds: [1] });
    await new Promise((r) => setTimeout(r, 0));
    expect(conn.status).toBe("open");
    const subId = JSON.parse(
      vi.mocked(sockets[0].send).mock.calls[0][0],
    )[1] as string;
    sockets[0].peer(["EOSE", subId]);
    const first = await pending;
    expect(first.eose).toBe(true);
    // Unexpected drop: a new socket must be dialed automatically.
    sockets[0].onclose?.();
    await new Promise((r) => setTimeout(r, 50));
    expect(sockets.length).toBe(2);
    expect(conn.status).toBe("open");
    conn.close();
  });

  it("stops retrying after close()", async () => {
    const sockets: Array<ReturnType<typeof makeSocket>> = [];
    const factory = () => {
      const socket = makeSocket();
      sockets.push(socket);
      return socket;
    };
    const conn = new RelayConnection("wss://example", factory, {
      baseReconnectMs: 5,
      maxReconnectMs: 10,
      authGateProbeMs: 0,
    });
    const pending = conn.query({ kinds: [1] });
    await new Promise((r) => setTimeout(r, 0));
    const subId = JSON.parse(
      vi.mocked(sockets[0].send).mock.calls[0][0],
    )[1] as string;
    sockets[0].peer(["EOSE", subId]);
    await pending;
    conn.close();
    const count = sockets.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(sockets.length).toBe(count);
    expect(conn.status).toBe("closed");
  });
});

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

function makeSocket(opts: { open?: boolean } = {}): Socket & {
  peer: (msg: unknown) => void;
} {
  const socket: Socket & { peer: (msg: unknown) => void } = {
    send: vi.fn(),
    close: vi.fn(),
    onmessage: null,
    onopen: null,
    onerror: null,
    onclose: null,
    peer: (msg) => socket.onmessage?.(JSON.stringify(msg)),
  };
  // `open: false` is a relay that takes the socket and never finishes the
  // handshake, which is what a query parks on.
  if (opts.open !== false) queueMicrotask(() => socket.onopen?.());
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

  it("fails a query at once when CLOSED carries no reason", async () => {
    // NIP-01 leaves the reason optional, and `isRelayMessage` checks only that
    // the value is an array whose first entry is the type — so a bare
    // ["CLOSED", <id>] reached the dispatcher. Reading the "auth-required:"
    // prefix off a missing reason threw there, and everything after the throw was
    // skipped: the query hung for its whole timeout, no CLOSE went back for the
    // subscription the client had abandoned, and a live stream on that id was
    // neither dropped nor reported.
    const socket = makeSocket();
    const conn = new RelayConnection("wss://example", () => socket, {
      authGateProbeMs: 0,
    });
    const pending = conn.query({ kinds: [1] }, 3000);
    await new Promise((r) => setTimeout(r, 0));
    const sent = vi.mocked(socket.send).mock.calls.map((call) => call[0]);
    const subId = JSON.parse(sent[0])[1] as string;

    socket.peer(["CLOSED", subId]);

    // Settled now, rather than waiting out its budget.
    const result = await pending;
    expect(result.failed).toBe(true);
    // And the subscription it gave up on was closed, so the relay stops sending.
    const closed = vi
      .mocked(socket.send)
      .mock.calls.map((call) => call[0])
      .map((raw) => JSON.parse(raw))
      .filter((frame) => frame[0] === "CLOSE");
    expect(closed.map((frame) => frame[1])).toContain(subId);
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

  it("gives a reconnecting relay its prompt budget back", async () => {
    // The cap exists to stop a relay asking for a signature once per challenge
    // it invents. Held across sockets it counted reconnects instead, and those
    // are unbounded — so five drops (a relay restart, a network flap, a laptop
    // waking) left the sixth connection unable to authenticate at all, and its
    // history permanently empty for the rest of the page's life.
    const socket = makeSocket();
    const authEvent = relayEvent({
      pubkey: "b".repeat(64),
      created_at: 1000,
      kind: 22242,
      tags: [["relay", "wss://example"]],
      content: "",
    });
    const signer = vi.fn(async () => authEvent);
    // One socket per round, so each challenge really belongs to a new one.
    const sockets: Array<ReturnType<typeof makeSocket>> = [];
    const conn = new RelayConnection(
      "wss://example",
      () => {
        const s = makeSocket();
        sockets.push(s);
        return s;
      },
      { signer, authGateProbeMs: 0, baseReconnectMs: 1 },
    );

    const round = async (n: number) => {
      conn.subscribe({ kinds: [1] }, () => {});
      await new Promise((r) => setTimeout(r, 5));
      const live = sockets[sockets.length - 1];
      live.peer(["AUTH", `challenge-${n}`]);
      await new Promise((r) => setTimeout(r, 5));
      // The relay drops us; the client redials on the backoff above.
      live.onclose?.();
      await new Promise((r) => setTimeout(r, 5));
    };

    for (let n = 0; n < 8; n++) {
      await round(n);
    }
    // Eight reconnects, each asked exactly once: the budget was refilled rather
    // than spent down to silence. The count is exact because every round in the
    // loop issues one challenge and the loop is the whole of the test.
    expect(signer.mock.calls).toHaveLength(8);
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
    expect(result).toEqual({ accepted: true, message: "", fromRelay: true });
  });

  it("reports a refusal as an answer, and a silence as no answer", async () => {
    // The difference the Network page rests on. NIP-01's `OK <id> false <prefix>`
    // is a relay saying it will not store *this event* — `duplicate`, `pow`,
    // `rate-limited`, `blocked`, `invalid`, `restricted` — and every one of those
    // is the relay working. Only a socket that never spoke is a relay that is
    // down, so the two have to be distinguishable in the result itself rather
    // than guessed at from the message.
    const refused = new RelayConnection("wss://example", () => makeSocket(), {
      authGateProbeMs: 0,
    });
    const first = relayEvent({
      pubkey: "b".repeat(64),
      created_at: 1000,
      kind: 1,
      tags: [],
      content: "hi",
    });
    const pending = refused.publish(first);
    await new Promise((r) => setTimeout(r, 0));
    (refused as unknown as { socket: ReturnType<typeof makeSocket> }).socket.peer([
      "OK",
      first.id,
      false,
      "duplicate: already have it",
    ]);
    await expect(pending).resolves.toEqual({
      accepted: false,
      message: "duplicate: already have it",
      fromRelay: true,
    });

    const silent = new RelayConnection("wss://example", () => makeSocket(), {
      authGateProbeMs: 0,
    });
    const second = relayEvent({
      pubkey: "b".repeat(64),
      created_at: 1001,
      kind: 1,
      tags: [],
      content: "no answer for this one",
    });
    await expect(silent.publish(second, 20)).resolves.toEqual({
      accepted: false,
      message: "timeout",
      fromRelay: false,
    });
  });

  it("answers what was waiting when it is closed", async () => {
    // Closing is how a caller abandons work, and abandoning work means every
    // waiter is told. It was left to the socket's own `close` event — which
    // `close()` makes stale by nulling `socket`, so the handler that would have
    // answered everything declined it as somebody else's connection. Every
    // in-flight query and publish then sat until the timeout it had already given
    // up on.
    //
    // The timeouts here are long enough that a hang is unmistakable, and the
    // wait is a race against a short one so a failure says which it was.
    const socket = makeSocket();
    const conn = new RelayConnection("wss://example", () => socket, {
      authGateProbeMs: 0,
      // No reconnect: a drop here is not what is under test.
      autoReconnect: false,
    });
    const event = relayEvent({
      pubkey: "b".repeat(64),
      created_at: 1000,
      kind: 1,
      tags: [],
      content: "in flight",
    });

    const publish = conn.publish(event, 60000);
    const query = conn.query({ kinds: [1] }, 60000);
    await new Promise((r) => setTimeout(r, 0));
    // And one that is only waiting for the socket to open at all: it is on
    // neither the sub list nor the publish list, so draining those misses it.
    const opening = conn.publish(
      relayEvent({
        pubkey: "b".repeat(64),
        created_at: 1001,
        kind: 1,
        tags: [],
        content: "never dialled",
      }),
      60000,
    );

    conn.close();

    const stillWaiting = "still waiting" as const;
    const settled = await Promise.race([
      Promise.all([publish, query, opening]),
      new Promise<typeof stillWaiting>((r) => setTimeout(() => r(stillWaiting), 1500)),
    ]);
    // Raced against a wait far shorter than any of the three deadlines, so a
    // failure says plainly that something never settled rather than which.
    expect(settled).not.toBe(stillWaiting);
    if (settled === stillWaiting) return;
    const [published, read, dialedAfterwards] = settled;
    // A publish refused by a shutdown says so, and does not claim a relay spoke.
    expect(published).toEqual({
      accepted: false,
      message: "connection closed",
      fromRelay: false,
    });
    expect(read.failed).toBe(true);
    // And the third one — which started after the socket was already up and so
    // was never waiting for anything — is refused too, rather than dialling a
    // fresh connection that `close()` had promised would not happen.
    expect(dialedAfterwards.accepted).toBe(false);
    expect(dialedAfterwards.fromRelay).toBe(false);
  });

  it("answers a caller that was still waiting for the socket to open", async () => {
    // The other half of closing: a query started against a relay that has taken
    // the socket and never finished the handshake is parked in `waitOpen`, which
    // is on neither the sub list nor the publish list. Draining those two misses
    // it, so it waited out the timeout it had already given up on.
    const socket = makeSocket({ open: false });
    const conn = new RelayConnection("wss://example", () => socket, {
      authGateProbeMs: 0,
      autoReconnect: false,
    });
    const query = conn.query({ kinds: [1] }, 60000);
    const publish = conn.publish(
      relayEvent({
        pubkey: "b".repeat(64),
        created_at: 1000,
        kind: 1,
        tags: [],
        content: "never sent",
      }),
      60000,
    );
    await new Promise((r) => setTimeout(r, 0));

    conn.close();

    const stillWaiting = "still waiting" as const;
    const settled = await Promise.race([
      Promise.all([query, publish]),
      new Promise<typeof stillWaiting>((r) => setTimeout(() => r(stillWaiting), 1500)),
    ]);
    expect(settled).not.toBe(stillWaiting);
    if (settled === stillWaiting) return;
    const [read, sent] = settled;
    expect(read.failed).toBe(true);
    expect(sent.accepted).toBe(false);
    expect(sent.fromRelay).toBe(false);
  });

  it("does not dial again once it has been closed", async () => {
    // Closing means closed. Draining the waiters answers the work that was already
    // running, but a caller who closes a connection and then queries it again
    // would otherwise be handed a *new* socket — a connection `close()` had
    // promised would not exist, opened behind the caller's back.
    const socket = makeSocket();
    const conn = new RelayConnection("wss://example", () => socket, {
      authGateProbeMs: 0,
      autoReconnect: false,
    });
    await new Promise((r) => setTimeout(r, 0));
    conn.close();
    const dialledAfterClose = vi.mocked(socket.send).mock.calls.length;

    const read = await conn.query({ kinds: [1] }, 5000);
    expect(read.failed).toBe(true);
    // No REQ went out, and nothing was sent on the closed socket.
    expect(vi.mocked(socket.send).mock.calls.length).toBe(dialledAfterClose);

    const stillWaiting = "still waiting" as const;
    const sent = await Promise.race([
      conn.publish(
        relayEvent({
          pubkey: "b".repeat(64),
          created_at: 1001,
          kind: 1,
          tags: [],
          content: "after close",
        }),
        5000,
      ),
      new Promise<typeof stillWaiting>((r) => setTimeout(() => r(stillWaiting), 1500)),
    ]);
    // Refused, and quickly: a publish on a closed connection is not something to
    // wait a round trip to find out.
    expect(sent).not.toBe(stillWaiting);
    expect(vi.mocked(socket.send).mock.calls.length).toBe(dialledAfterClose);
  });

  it("does not believe an OK that is not one", async () => {
    // NIP-01's `OK` is `[id, boolean, prefix]`. The result's `accepted` is
    // declared a boolean, so passing the field through unchanged meant a relay
    // sending `["OK", id, "false", ""]` put the *string* `"false"` there — a
    // truthy value in a field the type promises is a boolean, and a publish that
    // reads as delivered to anything comparing loosely.
    //
    // The app's own checks are strict, so nothing shipped wrong. What was wrong
    // is that the field contradicted its type, which is exactly the kind of
    // thing the next caller inherits.
    // What the relay sends for the third and fourth fields, and what the result
    // must read as. Kept apart on purpose: a test that reused one value for
    // both proved nothing about the field it was checking, because it handed
    // the code the answer it was asked to give.
    const shapes: Array<{
      sent: unknown[];
      accepted: boolean;
      message: string;
    }> = [
      // NIP-01 says a boolean and a prefix. Everything else is read as a refusal
      // with a reason we can show, rather than passed through.
      { sent: ["false"], accepted: false, message: "malformed: no reason given" },
      { sent: [0], accepted: false, message: "malformed: no reason given" },
      { sent: [null], accepted: false, message: "malformed: no reason given" },
      { sent: [1], accepted: false, message: "malformed: no reason given" },
      {
        sent: [{ accepted: true }, ""],
        accepted: false,
        message: "malformed: no reason given",
      },
      {
        sent: [false, "blocked: not-authorized"],
        accepted: false,
        message: "blocked: not-authorized",
      },
      // A well-formed refusal keeps its reason: that is what tells the reader,
      // and the Network page, that the relay is up and refusing.
      {
        sent: [false, "duplicate: already have it"],
        accepted: false,
        message: "duplicate: already have it",
      },
      // A well-formed acceptance with no prefix is not malformed — NIP-01 makes
      // the prefix optional — so it is not reported as one.
      { sent: [true], accepted: true, message: "" },
      {
        sent: [true, "duplicate: already have it"],
        accepted: true,
        message: "duplicate: already have it",
      },
    ];
    for (const { sent, accepted, message } of shapes) {
      const conn = new RelayConnection("wss://example", () => makeSocket(), {
        authGateProbeMs: 0,
      });
      const event = relayEvent({
        pubkey: "b".repeat(64),
        created_at: 1000,
        kind: 1,
        tags: [],
        content: `shape ${JSON.stringify(sent)}`,
      });
      const pending = conn.publish(event);
      await new Promise((r) => setTimeout(r, 0));
      const socket = (
        conn as unknown as { socket: ReturnType<typeof makeSocket> }
      ).socket;
      socket.peer(["OK", event.id, ...sent]);
      await expect(pending).resolves.toEqual({
        accepted,
        message,
        fromRelay: true,
      });
    }
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

  it("does not let a stale socket's close tear down its replacement", async () => {
    // A browser fires `error` and then `close` for the same socket. The first
    // one puts a reconnect on the timer, so by the time the second arrives the
    // redial has usually installed a healthy socket — and the stale `close` used
    // to run as if it were that socket's. It failed every query and publish in
    // flight on the healthy connection, reported the relay closed, orphaned it
    // without closing it and dialled a third. One flaky frame, and the relay
    // settled nothing until the reader reloaded the tab.
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
    // Get a first connection up, then let it fail the way a browser reports one
    // broken socket: error, then close.
    const first = conn.query({ kinds: [1] });
    await new Promise((r) => setTimeout(r, 0));
    sockets[0].onerror?.();
    await new Promise((r) => setTimeout(r, 50));
    expect(sockets.length).toBe(2);
    sockets[0].onclose?.();
    await new Promise((r) => setTimeout(r, 50));

    // The replacement is untouched: still open, and still answering.
    expect(conn.status).toBe("open");
    expect(sockets.length).toBe(2);
    const second = conn.query({ kinds: [1] });
    await new Promise((r) => setTimeout(r, 0));
    const subId = JSON.parse(
      vi.mocked(sockets[1].send).mock.calls.at(-1)?.[0] ?? "null",
    )[1] as string;
    sockets[1].peer(["EOSE", subId]);
    expect((await second).eose).toBe(true);

    conn.close();
    void first;
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

describe("a CLOSED message whose reason is not a reason", () => {
  it("fails the query at once whatever the third field holds", async () => {
    // NIP-01 leaves the reason optional, and nothing checks the type of what is
    // there, so `["CLOSED", id, 42]` and `["CLOSED", id, {}]` are both reachable.
    // Reading the "auth-required:" prefix off either threw inside the message
    // handler, and every step after the throw was skipped: the query hung for
    // its whole timeout instead of failing at once, no CLOSE went back for the
    // subscription the client had abandoned, and a live stream on that id was
    // neither dropped nor reported. A missing reason and a reason of the wrong
    // type are the same accident.
    for (const reason of [undefined, 42, {}, [], true, null]) {
      const socket = makeSocket();
      const conn = new RelayConnection("wss://example", () => socket, {
        authGateProbeMs: 0,
      });
      const started = Date.now();
      const pending = conn.query({ kinds: [1] }, 3000);
      await new Promise((r) => setTimeout(r, 0));
      const subId = JSON.parse(
        vi.mocked(socket.send).mock.calls[0][0],
      )[1] as string;

      // A three-field frame, with the third field not a string.
      socket.onmessage?.(JSON.stringify(["CLOSED", subId, reason ?? null]).replace(
        '"CLOSED",null]',
        '"CLOSED"]',
      ));
      const result = await pending;
      expect(result.failed, JSON.stringify(reason)).toBe(true);
      // Settled now, rather than waiting out a three-second budget.
      expect(Date.now() - started, JSON.stringify(reason)).toBeLessThan(1000);
      conn.close();
    }
  });
});

import { describe, expect, it, vi } from "vitest";
import { RelayConnection, type Socket } from "../src/relay.js";

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
    const conn = new RelayConnection("wss://example", () => socket);
    const event = {
      id: "a".repeat(64),
      pubkey: "b".repeat(64),
      created_at: 1000,
      kind: 1,
      tags: [],
      content: "hi",
      sig: "c".repeat(128),
    };
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

  it("marks CLOSED as failed", async () => {
    const socket = makeSocket();
    const conn = new RelayConnection("wss://example", () => socket);
    const pending = conn.query({ kinds: [1] });
    await new Promise((r) => setTimeout(r, 0));
    const sent = vi.mocked(socket.send).mock.calls[0][0];
    const subId = JSON.parse(sent)[1] as string;
    socket.peer(["CLOSED", subId, "error: nope"]);
    const result = await pending;
    expect(result.failed).toBe(true);
    expect(result.eose).toBe(false);
  });

  it("answers a NIP-42 challenge and completes on EOSE", async () => {
    const socket = makeSocket();
    const authEvent = {
      id: "d".repeat(64),
      pubkey: "e".repeat(64),
      created_at: 1000,
      kind: 22242,
      tags: [["relay", "wss://example"]],
      content: "",
      sig: "f".repeat(128),
    };
    const conn = new RelayConnection(
      "wss://example",
      () => socket,
      { signer: () => authEvent },
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

  it("flags auth-required CLOSED when no signer is configured", async () => {
    const socket = makeSocket();
    const conn = new RelayConnection("wss://example", () => socket);
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
    const conn = new RelayConnection("wss://example", () => socket);
    const eventA = {
      id: "a".repeat(64),
      pubkey: "b".repeat(64),
      created_at: 1000,
      kind: 1,
      tags: [],
      content: "a",
      sig: "c".repeat(128),
    };
    const eventB = { ...eventA, id: "d".repeat(64), content: "b" };
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
    const conn = new RelayConnection("wss://example", () => socket);
    const event = {
      id: "a".repeat(64),
      pubkey: "b".repeat(64),
      created_at: 1000,
      kind: 1,
      tags: [],
      content: "hi",
      sig: "c".repeat(128),
    };
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
    const conn = new RelayConnection("wss://example", () => socket);
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
      {
        id: "e".repeat(64),
        pubkey: "b".repeat(64),
        created_at: 2000,
        kind: 1,
        tags: [],
        content: "live",
        sig: "f".repeat(128),
      },
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
    const conn = new RelayConnection("wss://example", () => socket);
    const received: string[] = [];
    const sub = conn.subscribe({ kinds: [1] }, (e) => received.push(e.content));
    await new Promise((r) => setTimeout(r, 0));
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
      {
        id: "d".repeat(64),
        pubkey: "b".repeat(64),
        created_at: 1,
        kind: 1,
        tags: [],
        content: "after",
        sig: "f".repeat(128),
      },
    ]);
    expect(received).toEqual([]);
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

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
});

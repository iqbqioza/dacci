import { afterEach, expect } from "vitest";

/**
 * No test in this package may open a socket.
 *
 * `relays.ts` probes every relay in the set when the set changes, and the sign-in
 * and sign-out paths both change it — so a test that never mentions a WebSocket
 * was still dialling four public relays, and its result depended on whether those
 * relays were up that day. One of them answered `CLOSED auth-required:` on a
 * different run than the last, which is how a slow round turned into a flake
 * nobody could reproduce.
 *
 * A recorder rather than a throw: a test that legitimately needs a socket, such
 * as the ones covering the transport itself, can install its own. This one only
 * insists that the *default* is nothing.
 */
class UnreachableSocket extends EventTarget {
  static readonly dialled: string[] = [];
  readonly url: string;

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    UnreachableSocket.dialled.push(this.url);
    queueMicrotask(() => {
      // Opened, then closed and never answers. A test that reaches this without
      // caring still completes, and the list above says it happened.
      this.readyState = 1;
      this.dispatchEvent(new Event("open"));
      queueMicrotask(() => {
        this.readyState = 3;
        this.dispatchEvent(new Event("close"));
      });
    });
  }

  send(): void {}
  close(): void {}
  set onopen(handler: (() => void) | null) {
    this.addEventListener("open", handler as EventListener);
  }
  set onclose(handler: (() => void) | null) {
    this.addEventListener("close", handler as EventListener);
  }
  set onerror(handler: (() => void) | null) {
    this.addEventListener("error", handler as EventListener);
  }
  set onmessage(handler: ((data: unknown) => void) | null) {
    this.addEventListener("message", handler as EventListener);
  }
}

globalThis.WebSocket = UnreachableSocket as unknown as typeof WebSocket;

/**
 * The other half: a test that let one dial has not asserted anything about the
 * app, it has asserted something about a relay on the public internet that day.
 *
 * This lives here rather than in a test file because a hook only reaches the
 * tests in its own file, and the point is to reach all of them.
 */
afterEach(() => {
  const dialled = UnreachableSocket.dialled.splice(0);
  expect(
    dialled,
    dialled.length === 0
      ? ""
      : `a test opened ${dialled.length} socket(s), so its result depended on ` +
        `the network: ${[...new Set(dialled)].join(", ")}. Mock the relay ` +
        `layer, or install a socket of your own.`,
  ).toEqual([]);
});

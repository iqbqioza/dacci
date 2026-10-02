import { afterAll, afterEach, expect } from "vitest";

/**
 * No test in this package may reach the network.
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
 *
 * `fetch` is replaced as well as the socket. The headline is "no test reaches the
 * network", and a socket alone does not deliver that: NIP-11 relay information and
 * every Blossom upload go through `fetch`, and a test that reached either without
 * stubbing it would have made a real request with the suite still green.
 */
class UnreachableSocket extends EventTarget {
  static readonly dialled: string[] = [];
  readonly url: string;
  /** Mirrors the shape the app reads, so a test that inspects it still works. */
  readyState = 0;

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

/** A `fetch` that reaches nothing, and says so the same way a socket does. */
class UnreachableFetch {
  static readonly requested: string[] = [];

  constructor(readonly input: RequestInfo | URL) {
    UnreachableFetch.requested.push(String(input));
  }

  get url(): string {
    return String(this.input);
  }

  async text(): Promise<string> {
    throw new Error(`a test requested ${String(this.input)}`);
  }

  async json(): Promise<unknown> {
    throw new Error(`a test requested ${String(this.input)}`);
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    throw new Error(`a test requested ${String(this.input)}`);
  }
}

globalThis.fetch = ((input: RequestInfo | URL) =>
  Promise.reject(
    new Error(`a test requested ${String(input)}`),
  )) as unknown as typeof fetch;

/**
 * The other half: a test that let one dial has not asserted anything about the
 * app, it has asserted something about a relay on the public internet that day.
 *
 * This lives here rather than in a test file because a hook only reaches the
 * tests in its own file, and the point is to reach all of them.
 */
/** What a test reached for, as a sentence, or the empty string if it reached for nothing. */
function reached(where: string): string {
  const sockets = UnreachableSocket.dialled.splice(0);
  const requests = UnreachableFetch.requested.splice(0);
  const parts: string[] = [];
  if (sockets.length > 0) {
    parts.push(
      `opened ${sockets.length} socket(s): ${[...new Set(sockets)].join(", ")}`,
    );
  }
  if (requests.length > 0) {
    parts.push(
      `made ${requests.length} request(s): ${[...new Set(requests)].join(", ")}`,
    );
  }
  if (parts.length === 0) return "";
  return (
    `a test ${parts.join(" and ")}, so its result depended on the network. ` +
    `${where}Mock the layer it reaches for, or install your own.`
  );
}

afterEach(() => {
  expect(UnreachableSocket.dialled.length, reached("")).toBe(0);
  expect(UnreachableFetch.requested.length, reached("")).toBe(0);
});

/**
 * The same check once more after the file is over.
 *
 * A dial or request that fires in the gap between the last `afterEach` and the
 * teardown is caught here and nowhere else. One that fires *after* the teardown
 * needs no guard: the environment is gone, so the timer is discarded and never
 * reaches anything. A dial landing between two tests of the same file is already
 * caught by the `afterEach` of the later one, which reads a list nothing has
 * drained since.
 */
afterAll(() => {
  const late = reached(
    "Nothing below this point can run, so this was left over from a timer that " +
      "outlived its test. ",
  );
  expect(UnreachableSocket.dialled.length, late).toBe(0);
  expect(UnreachableFetch.requested.length, late).toBe(0);
});

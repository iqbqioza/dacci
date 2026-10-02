import { vi } from "vitest";

/**
 * Stubs the transport so a test never reaches a relay.
 *
 * Several modules here open sockets as a side effect of ordinary work rather
 * than where a test would look for it: `relays.ts` fires a status refresh from
 * every set change, and both signing in and signing out change the set. A test
 * that never mentions a WebSocket was still dialling four public relays, and its
 * result depended on whether they were up — one of which answers
 * `CLOSED auth-required:` on some days and not others.
 *
 * Keyed by resolved path rather than by the specifier, so this works from here
 * while the modules under test import their neighbour as `"./nostr.js"`.
 */
export function stubRelayLayer(
  overrides: Record<string, unknown> = {},
): void {
  vi.doMock(new URL("../src/nostr.ts", import.meta.url).pathname, () => ({
    /**
     * A relay that answers nothing, which is what an unreachable one looks like
     * to every caller: the status refresh marks it offline and moves on.
     */
    getConnection: (url: string) => ({
      url,
      query: async () => ({
        events: [],
        eose: true,
        failed: true,
        authRequired: false,
      }),
      publish: async () => ({ accepted: false }),
    }),
    ...overrides,
  }));
}

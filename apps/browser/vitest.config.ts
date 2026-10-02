import { defineConfig } from "vitest/config";

function src(pkg: string): string {
  return new URL(`../../packages/nostr/${pkg}/src/index.ts`, import.meta.url)
    .pathname;
}

export default defineConfig({
  test: {
    environment: "node",
    // A unit test that opens a socket is a test whose result depends on a relay
    // being up. Nothing in this package needs one: the transport has its own
    // tests, with their own sockets, in the package that owns it.
    setupFiles: [new URL("./test/no-network.ts", import.meta.url).pathname],
  },
  resolve: {
    alias: {
      "dacci-nostr-nips": src("nips"),
      "dacci-nostr-ws": src("ws"),
      "dacci-nostr-paginator": src("paginator"),
      "dacci-nostr-signer": src("signer"),
    },
  },
});

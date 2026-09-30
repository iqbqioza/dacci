import { defineConfig } from "vitest/config";

function src(pkg: string): string {
  return new URL(`../../packages/nostr/${pkg}/src/index.ts`, import.meta.url)
    .pathname;
}

export default defineConfig({
  test: {
    environment: "node",
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

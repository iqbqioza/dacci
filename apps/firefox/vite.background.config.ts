import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: false,
    target: "esnext",
    rollupOptions: {
      input: {
        background: resolve(import.meta.dirname, "src/background/index.ts"),
      },
      output: {
        format: "iife",
        entryFileNames: "assets/[name].iife.js",
      },
    },
  },
});
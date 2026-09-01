import { resolve } from "node:path";
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [svelte(), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "esnext",
    rollupOptions: {
      input: {
        panel: resolve(import.meta.dirname, "panel.html"),
      },
      output: {
        entryFileNames: "assets/[name].js",
        assetFileNames: "assets/[name].[ext]",
        chunkFileNames: "assets/[name].js",
      },
    },
  },
});
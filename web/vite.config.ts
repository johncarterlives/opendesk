import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { appIndex } from "./indexer/plugin.ts";

// The app is served from "/" both by Cloudflare Pages and by the self-hosted Go
// binary, so every asset path is absolute from the root.
export default defineConfig({
  base: "/",
  plugins: [react(), tailwindcss(), appIndex()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
  },
  server: { port: 5173 },
  // Every page is a lazy chunk, so the dev server would only discover a page's
  // dependencies (the editor, charts) when it is first opened, re-bundle them and
  // break the page already loaded. Scanning all of src up front bundles them once.
  optimizeDeps: { entries: ["index.html", "src/**/*.{ts,tsx}", "!src/**/*.test.{ts,tsx}"] },
});

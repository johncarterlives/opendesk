import { defineConfig } from "vitest/config";
import path from "node:path";
import { appIndex } from "./indexer/plugin.ts";

export default defineConfig({
  // The settings and docs indexes (indexer/), which the search tests read.
  plugins: [appIndex()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
  // The keyboard shortcuts guide is read by a test that keeps it in step with the app.
  server: { fs: { allow: [import.meta.dirname, path.resolve(import.meta.dirname, "../docs/src/content/docs/guides")] } },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "widget/**/*.test.ts"],
  },
});

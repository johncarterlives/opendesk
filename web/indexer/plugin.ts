// The app's search indexes as virtual modules, built from the code and the docs when the
// app is built (and again in dev when a file they come from changes):
//   virtual:settings-index  every settings page's sections and fields (indexer/settings.ts)
//   virtual:docs-index      the docs site's pages and sections (indexer/docs.ts)
// Each is its own lazy chunk: the app imports them with import() when a search needs them.

import fs from "node:fs";
import path from "node:path";
import type { Plugin, ViteDevServer } from "vite";
import { buildDocsIndex } from "./docs.ts";
import { buildSettingsIndex } from "./settings.ts";

const SETTINGS = "virtual:settings-index";
const DOCS = "virtual:docs-index";

export function appIndex(): Plugin {
  const web = path.resolve(import.meta.dirname, "..");
  const docs = path.resolve(web, "../docs/src/content/docs");
  const src = path.join(web, "src");
  let server: ViteDevServer | undefined;
  const invalidate = (id: string) => {
    const mod = server?.moduleGraph.getModuleById(`\0${id}`);
    if (mod) server!.moduleGraph.invalidateModule(mod);
  };
  return {
    name: "opendesk-app-index",
    resolveId(id) {
      return id === SETTINGS || id === DOCS ? `\0${id}` : undefined;
    },
    load(id) {
      if (id === `\0${SETTINGS}`) return `export default JSON.parse(${JSON.stringify(JSON.stringify(buildSettingsIndex(web)))});`;
      if (id === `\0${DOCS}`) {
        // The image and Pages builds copy the docs in; a build without them would ship no answers.
        if (!fs.existsSync(docs)) throw new Error(`the docs index needs the docs site's pages at ${docs}`);
        return `export default JSON.parse(${JSON.stringify(JSON.stringify(buildDocsIndex(docs)))});`;
      }
      return undefined;
    },
    configureServer(s) {
      server = s;
      s.watcher.add(docs);
      s.watcher.on("change", (file) => {
        if (file.startsWith(docs)) invalidate(DOCS);
        else if (file.startsWith(src) && /\.(tsx?|json)$/.test(file)) invalidate(SETTINGS);
      });
    },
  };
}

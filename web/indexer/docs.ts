// The docs index, read from the docs site's pages (docs/src/content/docs) at build time:
// each page's title and description, and each of its sections (## headings) with the
// first words under it. The app searches it to answer "how do I…" and links to
// docs.opendesk.sh; nothing is fetched from the docs site at runtime.

import fs from "node:fs";
import path from "node:path";
import type { DocEntry } from "../src/lib/appSearch/types.ts";

export type { DocEntry };

// Pages for contributors to opendesk itself, and the API's per-resource reference (field
// tables an agent never asks about; the API overview pages stay).
const SKIP = [/^contributing\//, /^api\/resources\//];
const PAGE_TEXT = 260;
const SECTION_TEXT = 300;

function frontmatter(src: string): { data: Record<string, string>; body: string } {
  const m = src.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { data: {}, body: src };
  const data: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) data[kv[1]] = kv[2].replace(/^(['"])(.*)\1$/, "$2").trim();
  }
  return { data, body: src.slice(m[0].length) };
}

/** Markdown and MDX to plain words: no imports, components, code blocks, links or emphasis. */
export function plain(md: string): string {
  return md
    .replace(/^import .*$/gm, "")
    .replace(/^export .*$/gm, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[A-Za-z][^>]*\/>/g, " ")
    .replace(/<\/?[A-Za-z][^>]*>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(\*\*|__|\*|_)(\S[^*_]*?)\1/g, "$2")
    .replace(/^\s*:::.*$/gm, " ")
    .replace(/^\s*[-*+]\s+|^\s*\d+\.\s+|^\s*>\s?/gm, "")
    .replace(/\|/g, " ")
    .replace(/^[\s:|-]+$/gm, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(s: string, n: number): string {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), n - 20)) + "…";
}

/** The anchor Starlight gives a heading (github-slugger). */
export function slug(heading: string, taken: Map<string, number>): string {
  const base = heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/ /g, "-");
  const n = taken.get(base) ?? 0;
  taken.set(base, n + 1);
  return n ? `${base}-${n}` : base;
}

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return files(p);
    return /\.mdx?$/.test(e.name) ? [p] : [];
  });
}

/** Builds the docs index from the docs site's content folder. */
export function buildDocsIndex(dir: string): DocEntry[] {
  const out: DocEntry[] = [];
  for (const file of files(dir).sort()) {
    const rel = path.relative(dir, file).split(path.sep).join("/").replace(/\.mdx?$/, "");
    if (SKIP.some((re) => re.test(`${rel}/`))) continue;
    const u = rel === "index" ? "" : `${rel.replace(/\/index$/, "")}/`;
    const { data, body } = frontmatter(fs.readFileSync(file, "utf8"));
    const t = data.title;
    if (!t) continue;
    // Code blocks first, so a "## " inside one is not a heading.
    const parts = body.replace(/```[\s\S]*?```/g, " ").split(/^## +(.+)$/m);
    const taken = new Map<string, number>();
    out.push({ u, t, ...(data.description ? { d: data.description } : {}), x: clip(plain(parts[0]), PAGE_TEXT) });
    for (let i = 1; i < parts.length; i += 2) {
      const s = plain(parts[i]);
      const text = parts[i + 1] ?? "";
      const subs = [...text.matchAll(/^###+ +(.+)$/gm)].map((m) => plain(m[1]));
      const words = plain(text.replace(/^###+ +.+$/gm, ""));
      out.push({ u, h: slug(s, taken), t, s, x: clip([subs.join(". "), words].filter(Boolean).join(". "), SECTION_TEXT) });
      // Sub-headings take anchors too, so later duplicates number the way Starlight does.
      for (const sub of subs) slug(sub, taken);
    }
  }
  return out;
}

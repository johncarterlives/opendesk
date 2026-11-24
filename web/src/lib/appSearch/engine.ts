// The matching side of the app's search, loaded with the first index a search needs (so the
// main bundle carries only the hooks): each entry resolved in the reader's language, filtered
// by what they can use, and prepared for match.ts.

import { gatesMet, settingsUsable, type SettingsAccess } from "@/lib/settingsAccess";
import { FEATURES } from "./features";
import { findHash } from "./find";
import { DOCS_ORIGIN, type AppHit } from "./index";
import { prepare, rank, type Mode, type Prepared } from "./match";
import type { DocEntry, Ref, SettingsIndex } from "./types";

/** i18next's t, read with keys built at runtime. */
export type Translate = (key: string, opts: Record<string, unknown>) => unknown;

/** A ref in the reader's language; placeholders read as the assistant's name or drop out. */
export function resolveRef(t: Translate, ref: Ref | undefined, assistant = "Ollie"): string {
  if (!ref) return "";
  const i = ref.indexOf(":");
  const out = t(ref.slice(i + 1), { ns: ref.slice(0, i), name: assistant, defaultValue: "" });
  return typeof out === "string" ? out.replace(/\{\{[^}]*\}\}/g, "…").trim() : "";
}

export type Item = { hit: AppHit; prepared: Prepared };

/** Settings and app places the reader can use, in their language, ready to match. */
export function settingsItems(index: SettingsIndex, access: SettingsAccess, t: Translate, assistant?: string): Item[] {
  const r = (ref?: Ref) => resolveRef(t, ref, assistant);
  const settings = r("navigation:titles.settings");
  const out: Item[] = [];
  for (const e of index.entries) {
    if (!settingsUsable(e.r, access) || (e.n && !settingsUsable(e.n, access)) || !gatesMet(e.g, access)) continue;
    const title = r(e.t);
    if (!title) continue;
    const page = r(index.pages[e.r]) || (e.k === "p" ? "" : title);
    const section = e.k === "r" ? r(e.s) : "";
    const description = r(e.d);
    const extra = (e.x ?? []).map(r).filter(Boolean).join(". ");
    const where = [settings, ...(e.k === "p" ? [] : [page]), ...(section && section !== title ? [section] : [])];
    const hit: AppHit = {
      kind: "setting",
      id: `s:${e.r}|${e.k}|${e.t}`,
      title,
      where,
      description: description || undefined,
      route: e.r,
      hash: e.k === "p" || e.n ? undefined : findHash(e.t),
      entry: e,
      text: [description, extra].filter(Boolean).join(" "),
    };
    out.push({
      hit,
      prepared: prepare([
        { text: title, weight: 3 },
        { text: page, weight: 1.4 },
        { text: section, weight: 1.2 },
        { text: description, weight: 1 },
        { text: extra, weight: 0.8 },
      ]),
    });
  }
  const sidebar = r("navigation:command.sidebarPlace");
  for (const f of FEATURES) {
    const title = r(f.t);
    const description = r(f.d);
    const extra = (f.x ?? []).map(r).filter(Boolean).join(". ");
    out.push({
      hit: { kind: "feature", id: `f:${f.id}`, title, where: [sidebar], description: description || undefined, action: f.action, docs: f.docs, text: [description, extra].filter(Boolean).join(" ") },
      prepared: prepare([
        { text: title, weight: 3 },
        { text: sidebar, weight: 1.4 },
        { text: description, weight: 1 },
        { text: extra, weight: 1 },
      ]),
    });
  }
  return out;
}

/** The docs' pages and sections, ready to match. */
export function docItems(docs: readonly DocEntry[], docsLabel: string): Item[] {
  return docs.map((d) => {
    const title = d.s ?? d.t;
    return {
      hit: {
        kind: "doc",
        id: `d:${d.u}#${d.h ?? ""}`,
        title,
        where: [docsLabel, ...(d.s ? [d.t] : [])],
        description: d.d,
        href: `${DOCS_ORIGIN}/${d.u}${d.h ? `#${d.h}` : ""}`,
        text: [d.d, d.x].filter(Boolean).join(" "),
      },
      prepared: prepare([
        { text: title, weight: 2.5 },
        { text: d.s ? d.t : "", weight: 1.4 },
        { text: d.d ?? "", weight: 1 },
        { text: d.x, weight: 0.6 },
      ]),
    };
  });
}

/** The best items for a query. `titled`: only those whose title has one of its words (docs, whose text is long). */
export function search(items: readonly Item[], query: string, opts: { mode?: Mode; limit?: number; titled?: boolean } = {}): AppHit[] {
  return rank(items, (i) => i.prepared, query, opts).map((i) => i.hit);
}

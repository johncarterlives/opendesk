// Views grouped by their section (contracts/api.md, /v1/views): views that name the same
// section, in any case, read together under one header. Sections and views without one
// keep `position` order, a section at its first view's place, and its views by position.

import type { View } from "@/lib/api/types";

/** The longest section name the API takes. */
export const MAX_VIEW_SECTION = 60;

/** One entry of the views list: a view on its own, or a section and its views. */
export type ViewEntry =
  | { kind: "view"; view: View }
  /** `key` matches every spelling of the name; `name` is its first view's. */
  | { kind: "section"; key: string; name: string; views: View[] };

/** A section's name as typed: spaces collapsed, blank for none. */
export const cleanSection = (s: string | null | undefined) => (s ?? "").split(/\s+/).filter(Boolean).join(" ");

/** A typed section cut to what the API keeps: at most 60 characters, counted as the API counts them. */
export const clipSection = (s: string) => cleanSection([...cleanSection(s)].slice(0, MAX_VIEW_SECTION).join(""));

/** Characters the API refuses in a name (displayname rules): control characters and angle brackets. */
// eslint-disable-next-line no-control-regex
const REFUSED = /[\u0000-\u001f\u007f-\u009f<>]/;

/** True when the API would refuse the section's characters (spaces aside, which collapse). */
export const sectionProblem = (s: string) => REFUSED.test(cleanSection(s));

/** What views of one section share: the name in any case. */
export const sectionKey = (s: string) => cleanSection(s).toLocaleLowerCase();

/** The views in position order; ties keep the order they came in (the API's: by name). */
const byPosition = (views: readonly View[]) => [...views].sort((a, b) => a.position - b.position);

/** The views list as the sidebar reads it. */
export function groupViews(views: readonly View[]): ViewEntry[] {
  const out: ViewEntry[] = [];
  const sections = new Map<string, Extract<ViewEntry, { kind: "section" }>>();
  for (const v of byPosition(views)) {
    const name = cleanSection(v.section);
    if (!name) {
      out.push({ kind: "view", view: v });
      continue;
    }
    const key = sectionKey(name);
    const sec = sections.get(key);
    if (sec) sec.views.push(v);
    else {
      const entry = { kind: "section" as const, key, name, views: [v] };
      sections.set(key, entry);
      out.push(entry);
    }
  }
  return out;
}

/** The views in the order the sidebar shows them, sections unfolded. */
export const orderViews = (views: readonly View[]): View[] => groupViews(views).flatMap((e) => (e.kind === "view" ? [e.view] : e.views));

/** The sections in use, in sidebar order, each spelled as its first view spells it. */
export const viewSections = (views: readonly View[]): string[] => groupViews(views).flatMap((e) => (e.kind === "section" ? [e.name] : []));

/** The spelling a typed section takes: an existing section's when it names one, so case never splits a section. */
export function matchSection(typed: string, existing: readonly string[]): string {
  const name = cleanSection(typed);
  return existing.find((s) => sectionKey(s) === sectionKey(name)) ?? name;
}

const FOLDED_KEY = "od-nav-view-sections";

/** Where a member's folded sections are kept in this browser: per workspace and member. */
const foldedKey = (workspaceId: string, userId: string) => `${FOLDED_KEY}:${workspaceId}:${userId}`;

/** The sections a member folded in the sidebar (by `sectionKey`). */
export function readFolded(workspaceId: string, userId: string): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(foldedKey(workspaceId, userId)) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

/** Keeps the folded sections; storage that is unavailable only forgets them. */
export function writeFolded(workspaceId: string, userId: string, folded: ReadonlySet<string>) {
  try {
    if (folded.size) localStorage.setItem(foldedKey(workspaceId, userId), JSON.stringify([...folded]));
    else localStorage.removeItem(foldedKey(workspaceId, userId));
  } catch {
    /* storage unavailable */
  }
}

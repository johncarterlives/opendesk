// The app's own search: its settings, places like the sidebar, and its docs, matched in the
// browser in the reader's language. The indexes are built from the code and the docs when the
// app is built (web/indexer); they and the matching (engine.ts, match.ts) load on first use,
// each as its own chunk. What the reader can't use is left out (lib/settingsAccess.ts).

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { SettingsAccess } from "@/lib/settingsAccess";
import type { Translate } from "./engine";
import type { FeatureAction } from "./features";
import type { Mode } from "./match";
import type { SettingsEntry } from "./types";

export const DOCS_ORIGIN = "https://docs.opendesk.sh";

export type AppHit =
  | (HitBase & { kind: "setting"; route: string; hash?: string; entry: SettingsEntry })
  | (HitBase & { kind: "feature"; action: FeatureAction; docs?: string })
  | (HitBase & { kind: "doc"; href: string });

interface HitBase {
  id: string;
  title: string;
  /** Where it is: its page and section, "Sidebar", or the docs page. */
  where: string[];
  description?: string;
  /** Everything it says, for an answer grounded in it. */
  text: string;
}

const loadSettings = () => import("virtual:settings-index").then((m) => m.default);
const loadDocs = () => import("virtual:docs-index").then((m) => m.default);
const loadEngine = () => import("./engine");

/** The settings index, loaded on first use. */
export function useSettingsIndex(enabled: boolean) {
  return useQuery({ queryKey: ["appSearch", "settings"], queryFn: loadSettings, enabled, staleTime: Infinity, gcTime: Infinity });
}

/** The docs index, loaded on first use. */
export function useDocsIndex(enabled: boolean) {
  return useQuery({ queryKey: ["appSearch", "docs"], queryFn: loadDocs, enabled, staleTime: Infinity, gcTime: Infinity });
}

/**
 * The reader's matches for a query among settings and app places, and the docs when asked.
 * Each index loads the first time it is enabled.
 */
export function useAppSearch(query: string, opts: { access: SettingsAccess; settings: boolean; docs: boolean; mode?: Mode; limit?: number; docsLimit?: number; assistant?: string }) {
  // t is new for each language, so the items follow a change of language.
  const { t: typed } = useTranslation();
  const t = typed as unknown as Translate;
  const settings = useSettingsIndex(opts.settings);
  const docs = useDocsIndex(opts.docs);
  const { data: engine } = useQuery({ queryKey: ["appSearch", "engine"], queryFn: loadEngine, enabled: opts.settings || opts.docs, staleTime: Infinity, gcTime: Infinity });
  const { role, tickets, collab, ai, cloud, severalWorkspaces } = opts.access;
  const sItems = useMemo(
    () => (engine && settings.data ? engine.settingsItems(settings.data, { role, tickets, collab, ai, cloud, severalWorkspaces }, t, opts.assistant) : []),
    [engine, settings.data, role, tickets, collab, ai, cloud, severalWorkspaces, t, opts.assistant],
  );
  const docsLabel = String(t("command.docs", { ns: "navigation" }));
  const dItems = useMemo(() => (engine && docs.data ? engine.docItems(docs.data, docsLabel) : []), [engine, docs.data, docsLabel]);
  const q = query.trim();
  const search = engine?.search;
  const settingsHits = useMemo(() => (search && opts.settings && q ? search(sItems, q, { mode: opts.mode, limit: opts.limit }) : []), [search, sItems, q, opts.settings, opts.mode, opts.limit]);
  const docHits = useMemo(() => (search && opts.docs && q ? search(dItems, q, { mode: opts.mode, limit: opts.docsLimit ?? 4, titled: true }) : []), [search, dItems, q, opts.docs, opts.mode, opts.docsLimit]);
  return { settings: settingsHits, docs: docHits, loading: !engine || (opts.settings && settings.isPending) || (opts.docs && docs.isPending) };
}

/** A hit as an excerpt for an answer about the app (POST /v1/ai/app-help). */
export function asSource(h: AppHit): { title: string; url: string; text: string } {
  const url = h.kind === "doc" ? h.href : h.kind === "setting" ? h.route : h.docs ? `${DOCS_ORIGIN}/${h.docs}` : "";
  return { title: [...h.where, h.title].join(" / ").slice(0, 300), url: url.slice(0, 500), text: h.text.slice(0, 2000) };
}

// Deep links to one setting: /settings/<page>#find=<ns:key>. The page scrolls the section
// or row with that label into view and highlights it briefly (flash, lib/motion.ts). The
// label is looked up by its text in the reader's language, among the headings and row
// labels the settings layout marks (data-find-label in components/layout.tsx), so a link
// keeps working whatever the page's markup around it.

import { useRouterState } from "@tanstack/react-router";
import { useReducedMotion } from "motion/react";
import { useEffect, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { flash } from "@/lib/motion";
import { normalize } from "./match";
import type { Ref } from "./types";

const PREFIX = "find=";

/** The hash that points at a setting's label. */
export function findHash(ref: Ref): string {
  return PREFIX + encodeURIComponent(ref);
}

export function parseFindHash(hash: string): Ref | null {
  const h = hash.replace(/^#/, "");
  if (!h.startsWith(PREFIX)) return null;
  try {
    const ref = decodeURIComponent(h.slice(PREFIX.length));
    return /^[\w-]+:[\w.-]+$/.test(ref) ? ref : null;
  } catch {
    return null;
  }
}

/** The marked label whose text is `text` ("…" stands for a name filled in on the page), and what to highlight. */
export function findTarget(root: ParentNode, text: string): { label: HTMLElement; target: HTMLElement } | null {
  const parts = text.split("…").map(normalize).filter(Boolean);
  if (!parts.length) return null;
  const whole = normalize(text);
  let loose: HTMLElement | null = null;
  for (const label of root.querySelectorAll<HTMLElement>("[data-find-label]")) {
    const got = normalize(label.textContent ?? "");
    if (got === whole) return { label, target: label.closest<HTMLElement>("[data-find]") ?? label };
    if (!loose && parts.every((p) => got.includes(p))) loose = label;
  }
  return loose ? { label: loose, target: loose.closest<HTMLElement>("[data-find]") ?? loose } : null;
}

const WAIT_MS = 5000;

/**
 * Reveals the setting the URL's #find= names inside `root`, once it renders (a page that
 * loads its data shows it a moment later), each time the reader is sent there.
 */
export function useFindOnPage(root: RefObject<HTMLElement | null>) {
  const hash = useRouterState({ select: (s) => s.location.hash });
  // A new navigation to the same link reveals it again.
  const visit = useRouterState({ select: (s) => (s.location.state as { __TSR_key?: string }).__TSR_key ?? s.location.href });
  const reduced = !!useReducedMotion();
  const { t } = useTranslation();
  useEffect(() => {
    const ref = parseFindHash(hash);
    const el = root.current;
    if (!ref || !el) return;
    const i = ref.indexOf(":");
    const text = String(t(ref.slice(i + 1) as never, { ns: ref.slice(0, i), defaultValue: "" } as never)).replace(/\{\{[^}]*\}\}/g, "…");
    if (!text) return;
    const reveal = () => {
      const found = findTarget(el, text);
      if (!found) return false;
      // A section from its heading down; a row in the middle, with what is around it.
      found.target.scrollIntoView({ block: found.target.tagName === "SECTION" ? "start" : "center", behavior: reduced ? "auto" : "smooth" });
      flash(found.target, reduced);
      return true;
    };
    if (reveal()) return;
    const obs = new MutationObserver(() => {
      if (reveal()) obs.disconnect();
    });
    obs.observe(el, { childList: true, subtree: true });
    const stop = window.setTimeout(() => obs.disconnect(), WAIT_MS);
    return () => {
      obs.disconnect();
      window.clearTimeout(stop);
    };
  }, [hash, visit, root, reduced, t]);
}

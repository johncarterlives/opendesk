import { useNavigate, type NavigateOptions } from "@tanstack/react-router";
import { useCallback } from "react";
import { sidebarEdit } from "@/lib/collab/sidebarEdit";
import { openInNewTab, useHref } from "@/lib/links";
import { spaceUi } from "@/lib/spaces/store";
import type { FeatureAction } from "./features";
import type { AppHit } from "./index";

const actions: Record<FeatureAction, () => void> = {
  customizeSidebar: () => sidebarEdit.start(),
  newSpace: () => spaceUi.edit({ kind: "new" }),
};

/**
 * Where a hit goes: a settings page (with #find= to its setting), a docs page in a new tab,
 * or an action in place. `href` is set for the first two, so they render as real links.
 */
export function useOpenHit(): (hit: AppHit, before?: () => void) => { href?: string; onSelect: () => void } {
  const navigate = useNavigate();
  const toHref = useHref();
  return useCallback(
    (hit, before) => {
      switch (hit.kind) {
        case "setting": {
          const to = { to: hit.route, hash: hit.hash } as NavigateOptions;
          return {
            href: toHref(to),
            onSelect: () => {
              before?.();
              void navigate(to);
            },
          };
        }
        case "doc":
          return {
            href: hit.href,
            onSelect: () => {
              before?.();
              openInNewTab(hit.href);
            },
          };
        case "feature":
          return {
            onSelect: () => {
              before?.();
              actions[hit.action]();
            },
          };
      }
    },
    [navigate, toHref],
  );
}

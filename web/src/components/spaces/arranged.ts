// A whole built-in section inside a Space shows by the Space's arrangement of it (its order and
// hidden rows, Favorites' added rows; lib/spaces/arrange.ts). SpaceView provides the section
// item around the open workspace's own section; the section reads the prefs it shows by here,
// and keeps the person's own prefs for what its menus change.

import { createContext, useContext, useMemo } from "react";
import type { SidebarPrefs, SidebarSectionId, SpaceItem } from "@/lib/api/types";
import { arrangedPrefs } from "@/lib/spaces/arrange";

export const ArrangedCtx = createContext<Pick<SpaceItem, "rows" | "hidden"> | null>(null);

/** The prefs a built-in section shows by: the person's own, arranged by the Space showing it. */
export function useShownPrefs(prefs: SidebarPrefs, id: SidebarSectionId): SidebarPrefs {
  const item = useContext(ArrangedCtx);
  return useMemo(() => arrangedPrefs(prefs, id, item), [prefs, id, item]);
}

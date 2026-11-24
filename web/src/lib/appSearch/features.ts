// Places in the app that are not a settings page but that people look for as one: what
// settings search and the command menu also find. Strings are the app's own (i18n refs),
// so they read in the reader's language; `docs` is the guide that explains it.

import type { Ref } from "./types";

export type FeatureAction = "customizeSidebar" | "newSpace";

export interface Feature {
  id: string;
  t: Ref;
  d?: Ref;
  /** More of the app's own words that find it. */
  x?: Ref[];
  action: FeatureAction;
  /** A docs page, with its anchor (indexer/docs.ts paths). */
  docs?: string;
}

export const FEATURES: Feature[] = [
  {
    id: "customize-sidebar",
    t: "collab:nav.customize",
    d: "collab:edit.customizeHint",
    x: ["collab:edit.title", "collab:edit.layouts", "collab:customize.description", "collab:customize.favoritesTitle"],
    action: "customizeSidebar",
    docs: "guides/sidebar/#edit-your-sidebar",
  },
  {
    id: "new-space",
    t: "spaces:editor.newTitle",
    d: "spaces:editor.description",
    x: ["spaces:switcher.spaces", "spaces:newMenu.workspaces"],
    action: "newSpace",
    docs: "guides/workspaces/#build-a-space",
  },
];

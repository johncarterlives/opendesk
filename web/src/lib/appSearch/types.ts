// The shapes of the app's search indexes, built from the code and the docs at build time
// (web/indexer) and loaded on demand as virtual:settings-index and virtual:docs-index.

/** An i18n key with its namespace: "ns:key". */
export type Ref = string;

/** What a settings entry needs besides its page's own rules (lib/settingsAccess.ts). */
export type Gate = "admin" | "owner" | "collab" | "tickets" | "ai" | "cloud" | "selfHosted";

export interface SettingsEntry {
  /** The settings route the entry opens, such as "/settings/security". */
  r: string;
  /** page, section or row */
  k: "p" | "s" | "r";
  t: Ref;
  d?: Ref;
  /** Field labels and hints inside it: more words that find it. */
  x?: Ref[];
  /** The section a row is in. */
  s?: Ref;
  g?: Gate[];
  /** On a page opened from the route's list (a mailbox, a brand), that page's route pattern: the entry opens the list. */
  n?: string;
}

export interface SettingsIndex {
  /** Each route's title (navigation:titles.*). */
  pages: Record<string, Ref>;
  entries: SettingsEntry[];
}

export interface DocEntry {
  /** Path on docs.opendesk.sh, such as "guides/sidebar/". */
  u: string;
  /** The section's anchor; none for the page itself. */
  h?: string;
  /** The page's title. */
  t: string;
  /** The section's heading. */
  s?: string;
  /** The page's description (on the page entry). */
  d?: string;
  /** The first words of the page or the section, and the headings under it. */
  x: string;
}

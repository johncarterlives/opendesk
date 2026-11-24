// How a Space arranges a whole built-in section (contracts/spaces.md "Arranging a whole
// section"): a `section` item keeps its own order of the section's rows (`rows`) and the rows it
// does not show (`hidden`), spelled as SidebarPrefs spells them for the workspace's sidebar
// ("Row order", `hidden`). The section stays up to date: rows the order does not name follow
// in the section's usual order, and new ones show. Favorites take rows from elsewhere: each key
// of its `rows` is a row the Space adds, before the person's own favorites.
//
// In the editor a whole section opens into its rows, a group inside its Space section. As in the
// workspace's sidebar, a row reorders within its group, and adding it elsewhere leaves it there:
// into Favorites (one of its rows) or into a Space section (a row of its own). Hiding is its eye.
// Pure, so the editor, the sidebar and the tests read and change it the same way.

import type { SidebarPin, SidebarPrefs, SidebarSectionId, Space, SpaceItem, SpaceItemKind, SpaceSection } from "../api/types";
import { isOrdered } from "../collab/rowOrder";
import { placed } from "../collab/sidebarEditModel";
import { hid } from "../collab/sidebarPrefs";
import { itemKey, removeItem } from "./model";

/** At most this many keys in a section item's `rows`, and in its `hidden`. */
export const ARRANGE_LIMIT = 300;

/** The kinds of row a key can name that are also rows of their own (a Space row, contracts/spaces.md). */
const ROW_KINDS = ["ticket_folder", "team", "view", "box", "account", "folder", "page", "wiki_page", "wiki_space"] as const satisfies readonly SpaceItemKind[];
/** The kinds Favorites take: the kinds of favorite that are one row (SidebarPrefs.pinned, without view sections). */
export const FAVORITE_KINDS = ["box", "folder", "account", "view", "team", "ticket_folder"] as const satisfies readonly SidebarPin["kind"][];

type RowKind = (typeof ROW_KINDS)[number];

/** A row's key in a built-in section: `<kind>:<id>` (`team:<id>`, `box:assigned`), as `hidden` spells it. */
export const rowKeyOf = (i: { kind: string; id: string }) => `${i.kind}:${i.id}`;

function split(key: string): { kind: string; id: string } | null {
  const at = key.indexOf(":");
  return at > 0 && at < key.length - 1 ? { kind: key.slice(0, at), id: key.slice(at + 1) } : null;
}

/** The Space row a key stands for in a workspace, or null for a row that can't be one of its own (waiting chats, a part of Pages). */
export function itemOfKey(workspaceId: string, key: string): SpaceItem | null {
  const k = split(key);
  if (!k || !(ROW_KINDS as readonly string[]).includes(k.kind)) return null;
  return { workspace_id: workspaceId, kind: k.kind as RowKind, id: k.id };
}

/** The favorite a key stands for, when Favorites take it. */
export function pinOfKey(key: string): SidebarPin | null {
  const k = split(key);
  if (!k || !(FAVORITE_KINDS as readonly string[]).includes(k.kind)) return null;
  return { kind: k.kind as SidebarPin["kind"], id: k.id };
}

/** The built-in section a row belongs to (its home), from its key. */
export function homeOf(key: string): SidebarSectionId | null {
  if (key === hid.waitingChats) return "inbox";
  switch (split(key)?.kind) {
    case "ticket_folder":
      return "inbox";
    case "box":
    case "account":
    case "folder":
      return "mail";
    case "team":
      return "teams";
    case "view":
      return "views";
    case "wiki_page":
    case "wiki_space":
    case "pages":
      return "pages";
    case "page":
      return "workspace";
    default:
      return null;
  }
}

/** Whether a row takes a place of its own inside its section: the sections a member orders, and in Mail its accounts (its boxes keep theirs). */
export function isOrderedRow(section: SidebarSectionId, key: string): boolean {
  if (section === "favorites") return true;
  if (!isOrdered(section)) return false;
  return section !== "mail" || key.startsWith("account:");
}

/** Whether a whole section item is arranged in its Space. */
export const isArranged = (i: Pick<SpaceItem, "rows" | "hidden">) => !!(i.rows?.length || i.hidden?.length);

const unique = (keys: readonly string[]) => [...new Set(keys)];

/**
 * The prefs a whole section of a Space shows by: the person's own for that workspace, with the
 * Space's hidden rows added, its order first, and in Favorites its rows before their own
 * favorites. Only for showing: what a row's menu changes is saved to the person's own prefs.
 */
export function arrangedPrefs(p: SidebarPrefs, id: SidebarSectionId, item: Pick<SpaceItem, "rows" | "hidden"> | null | undefined): SidebarPrefs {
  if (!item || !isArranged(item)) return p;
  const hidden = item.hidden ?? [];
  const rows = item.rows ?? [];
  const out: SidebarPrefs = { ...p, hidden: unique([...p.hidden, ...hidden]) };
  if (hidden.includes(hid.waitingChats)) out.show_waiting_chats = false;
  if (id === "favorites") {
    const added = rows.map(pinOfKey).filter((x): x is SidebarPin => !!x);
    const keys = new Set(added.map(rowKeyOf));
    out.pinned = [...added, ...p.pinned.filter((x) => !keys.has(rowKeyOf(x)) && !hidden.includes(rowKeyOf(x)))];
  } else if (isOrdered(id) && rows.length) {
    out.row_order = { ...p.row_order, [id]: unique([...rows, ...(p.row_order[id] ?? [])]) };
  }
  return out;
}

/** The rows a whole section shows in the Space, from the rows it has (`live`, in its usual order). Favorites: the Space's own rows first. */
export function arrangeRows(id: SidebarSectionId, live: readonly string[], item: Pick<SpaceItem, "rows" | "hidden">): string[] {
  const hidden = new Set(item.hidden ?? []);
  const rows = item.rows ?? [];
  if (id === "favorites") return unique([...rows.filter((k) => pinOfKey(k)), ...live]).filter((k) => !hidden.has(k));
  const shown = live.filter((k) => !hidden.has(k));
  if (!isOrdered(id) || !rows.length) return shown;
  const at = new Map(unique(rows).map((k, i) => [k, i]));
  const moving = shown.filter((k) => isOrderedRow(id, k));
  const ordered = [...moving.filter((k) => at.has(k)).sort((a, b) => at.get(a)! - at.get(b)!), ...moving.filter((k) => !at.has(k))];
  // Rows that keep their own place (Mail's boxes) stay where they are; the others fill the order.
  let i = 0;
  return shown.map((k) => (isOrderedRow(id, k) ? ordered[i++] : k));
}

// ─── Moving rows in the editor ──────────────────────────────────────────────

/** A whole section in the editor: its item's key (`<workspace>:section:<id>`); a Space section's id never holds ":". */
export const isGroupKey = (key: string) => key.includes(":");

/** The section items of a Space by key, with the Space section each sits in. */
function groupAt(s: Space, key: string): { item: SpaceItem; section: SpaceSection } | null {
  for (const section of s.sections) for (const item of section.items) if (item.kind === "section" && itemKey(item) === key) return { item, section };
  return null;
}

/** The rows each container shows in the editor, in order: a Space section's item keys, a group's row keys. */
export type Shown = (container: string) => readonly string[];

/** What a row being moved is: its workspace, its key, and the Space row it was (its name, number, emoji). */
type Moving = { workspaceId: string; key: string; item?: SpaceItem; group?: true };

function moving(s: Space, from: string, key: string): Moving | null {
  if (isGroupKey(from)) {
    const g = groupAt(s, from);
    return g ? { workspaceId: g.item.workspace_id, key } : null;
  }
  const item = s.sections.find((x) => x.id === from)?.items.find((x) => itemKey(x) === key);
  if (!item) return null;
  if (item.kind === "section" || item.kind === "everywhere") return { workspaceId: item.workspace_id, key, item, group: true };
  return { workspaceId: item.workspace_id, key: rowKeyOf(item), item };
}

/**
 * Whether a row can land in a container: within its group where it takes a place, in Favorites
 * or a Space section where it isn't yet, and a Space row back into its home section.
 */
export function canMoveRow(s: Space, from: string, key: string, to: string): boolean {
  const m = moving(s, from, key);
  if (!m) return false;
  if (!isGroupKey(to)) {
    const sec = s.sections.find((x) => x.id === to);
    if (!sec) return false;
    if (m.group) return true;
    const item = m.item ?? itemOfKey(m.workspaceId, m.key);
    if (!item) return false;
    // A Space row moves among Space sections; a row of a group is added where it isn't yet.
    return !isGroupKey(from) || !sec.items.some((x) => itemKey(x) === itemKey(item));
  }
  if (m.group) return false;
  const g = groupAt(s, to);
  if (!g || g.item.workspace_id !== m.workspaceId) return false;
  const id = g.item.id as SidebarSectionId;
  if (from === to) return isOrderedRow(id, m.key);
  if (id === "favorites") return !!pinOfKey(m.key) && !(g.item.rows ?? []).includes(m.key);
  return !isGroupKey(from) && homeOf(m.key) === id;
}

const setGroup = (s: Space, key: string, f: (i: SpaceItem) => SpaceItem): Space => ({
  ...s,
  sections: s.sections.map((sec) => ({ ...sec, items: sec.items.map((i) => (i.kind === "section" && itemKey(i) === key ? tidy(f(i)) : i)) })),
});

/** A section item without empty lists. */
function tidy(i: SpaceItem): SpaceItem {
  const out = { ...i };
  if (!out.rows?.length) delete out.rows;
  if (!out.hidden?.length) delete out.hidden;
  return out;
}

/** Shows or hides one row of a whole section in the Space; in Favorites, hiding one of the Space's rows takes it out. */
export function setRowHidden(s: Space, group: string, key: string, hidden: boolean): Space {
  return setGroup(s, group, (i) => {
    if (i.id === "favorites" && hidden && i.rows?.includes(key)) return { ...i, rows: i.rows.filter((k) => k !== key) };
    const list = (i.hidden ?? []).filter((k) => k !== key);
    return { ...i, hidden: hidden ? [...list, key] : list };
  });
}

/** A whole section back to its usual order, every row of it shown. */
export function resetArranged(s: Space, group: string): Space {
  return setGroup(s, group, (i) => ({ ...i, rows: [], hidden: [] }));
}

/** Saves `keys` (a group's rows as they show) as its order; keys the order had for rows not showing keep their place after them. */
function withOrder(i: SpaceItem, keys: readonly string[]): SpaceItem {
  const rest = (i.rows ?? []).filter((k) => !keys.includes(k));
  return { ...i, rows: [...keys, ...rest] };
}

/**
 * Moves a row, or a whole section, to sit before `before` (or last) in a container, or returns
 * null where it can't go (canMoveRow). Within a group it reorders. Into a Space section it is a
 * row of its own and into Favorites one of its rows, as the sidebar pins it: where it was, it
 * stays. A Space row back home stops being a row of its own and shows in its section again.
 */
export function moveRow(s: Space, from: string, key: string, to: string, before: string | null, shown: Shown): Space | null {
  if (!canMoveRow(s, from, key, to)) return null;
  if (from === to && before === key) return s;
  const m = moving(s, from, key)!;

  // Within its own group: a new order (Favorites: the Space's rows).
  if (from === to && isGroupKey(to)) {
    return setGroup(s, to, (i) => {
      if (i.id === "favorites") return { ...i, rows: placed(i.rows ?? [], key, before) };
      const keys = shown(to).filter((k) => isOrderedRow(i.id as SidebarSectionId, k));
      return withOrder(i, placed(keys, key, before !== null && keys.includes(before) ? before : null));
    });
  }

  // Into a Space section.
  if (!isGroupKey(to)) {
    const item: SpaceItem = m.item ?? itemOfKey(m.workspaceId, m.key)!;
    const k = itemKey(item);
    // A row sits in a Space once: one already elsewhere (the Space row moving) moves here.
    const next = removeItem(s, k);
    return {
      ...next,
      sections: next.sections.map((sec) => {
        if (sec.id !== to) return sec;
        const keys = placed(sec.items.map(itemKey), k, before);
        const byKey = new Map([...sec.items, item].map((x) => [itemKey(x), x]));
        return { ...sec, items: keys.map((x) => byKey.get(x)!).filter(Boolean) };
      }),
    };
  }
  // Into Favorites, one of its rows.
  if (groupAt(s, to)!.item.id === "favorites")
    return setGroup(s, to, (i) => {
      const rows = i.rows ?? [];
      return { ...i, rows: placed(rows, m.key, before !== null && rows.includes(before) ? before : null), hidden: (i.hidden ?? []).filter((k) => k !== m.key) };
    });
  // A Space row back home: shown there again, at the place it lands.
  return setGroup(removeItem(s, key), to, (i) => {
    const back = { ...i, hidden: (i.hidden ?? []).filter((k) => k !== m.key) };
    if (!isOrderedRow(i.id as SidebarSectionId, m.key)) return back;
    const keys = shown(to).filter((k) => k !== m.key && isOrderedRow(i.id as SidebarSectionId, k));
    return withOrder(back, placed([...keys, m.key], m.key, before !== null && keys.includes(before) ? before : null));
  });
}

/** One container as the editor lays it out: its key and the keys it shows, in order. */
export type Layout = { key: string; keys: readonly string[] }[];

/**
 * Where an arrow key takes a row: the next place up or down, in the order the editor shows (a
 * group's rows sit at the group's place in its Space section), that the row can land on and that
 * moves it. A step never adds a row somewhere new: a row of a group moves within it, and a Space
 * row or a whole section walks the Space's sections, past the groups. Null at either end.
 */
export function stepRow(s: Space, from: string, key: string, dir: -1 | 1, layout: Layout): { to: string; before: string | null } | null {
  const byKey = new Map(layout.map((c) => [c.key, c.keys]));
  const slots: { to: string; before: string | null }[] = [];
  const walk = (c: string) => {
    for (const k of byKey.get(c) ?? []) {
      slots.push({ to: c, before: k });
      // A group's own rows, unless it is the one moving.
      if (byKey.has(k) && isGroupKey(k) && !(c === from && k === key)) walk(k);
    }
    slots.push({ to: c, before: null });
  };
  for (const c of layout) if (!isGroupKey(c.key)) walk(c.key);
  const here = slots.findIndex((x) => x.to === from && x.before === key);
  if (here < 0) return null;
  const keys = byKey.get(from) ?? [];
  const after = keys[keys.indexOf(key) + 1] ?? null;
  // Before itself, or before the row after it, is where it already is.
  const same = (x: { to: string; before: string | null }) => x.to === from && (x.before === key || x.before === after);
  for (let j = here + dir; j >= 0 && j < slots.length; j += dir) {
    const x = slots[j];
    if (same(x)) continue;
    if (x.to !== from && (isGroupKey(from) || isGroupKey(x.to))) continue;
    if (canMoveRow(s, from, key, x.to)) return x;
  }
  return null;
}

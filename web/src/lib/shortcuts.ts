// Keyboard shortcuts: one registry of every key the app answers, where and for what
// (SHORTCUTS), the person's own keys for any of them (Settings › Shortcuts, kept per user
// through /v1/me/shortcuts and in this browser), and useShortcuts to bind handlers by id.
// The ? sheet, Settings › Shortcuts, menu and tooltip hints and the command menu all read
// the same list, so a rebound key shows everywhere at once.
//
// A binding is one or two steps split by a space ("g p" is g, then p); a step is its keys
// joined by "+", modifiers first in the order mod, alt, shift ("mod+shift+p"). mod is Cmd
// on a Mac and Ctrl elsewhere. Steps are what keyName (lib/hotkeys.ts) calls a key press.

import { useMemo } from "react";
import { create } from "zustand";
import { useHotkeys, type HotkeyMap } from "./hotkeys";

export type ShortcutScope = "global" | "sidebar" | "page" | "editor" | "database" | "canvas" | "tickets" | "ticket" | "mail" | "bots";

/** The order scopes are listed in; the current page's scope goes first in the ? sheet. */
export const SCOPES: readonly ShortcutScope[] = ["global", "sidebar", "tickets", "ticket", "mail", "page", "editor", "database", "canvas", "bots"];

/** What a shortcut needs to be offered: a product the workspace has on. */
export type ShortcutNeeds = "tickets" | "mail" | "pages";

export interface ShortcutDef {
  id: string;
  /** The default binding. */
  keys: string;
  scope: ShortcutScope;
  needs?: ShortcutNeeds;
  /** Handled by the editor, the canvas or a composer itself: listed and shown, never rebound. */
  fixed?: boolean;
  /** Never on at the same time as this scope (the list's keys while a ticket is open are the ticket's). */
  apart?: ShortcutScope;
}

const def = <const T extends readonly ShortcutDef[]>(list: T) => list;

export const SHORTCUTS = def([
  // Anywhere in the app.
  { id: "global.palette", keys: "mod+k", scope: "global" },
  { id: "global.help", keys: "?", scope: "global" },
  { id: "global.ollie", keys: "mod+j", scope: "global" },
  { id: "global.new", keys: "c", scope: "global" },
  { id: "global.back", keys: "mod+[", scope: "global" },
  { id: "global.forward", keys: "mod+]", scope: "global" },
  { id: "go.inbox", keys: "g i", scope: "global" },
  { id: "go.mine", keys: "g m", scope: "global", needs: "tickets" },
  { id: "go.mail", keys: "g a", scope: "global", needs: "mail" },
  { id: "go.pages", keys: "g p", scope: "global", needs: "pages" },
  { id: "go.today", keys: "g d", scope: "global", needs: "pages" },
  { id: "go.graph", keys: "g g", scope: "global", needs: "pages" },
  { id: "go.wiki", keys: "g w", scope: "global" },
  { id: "go.contacts", keys: "g c", scope: "global" },
  { id: "go.kb", keys: "g k", scope: "global" },
  { id: "go.reports", keys: "g r", scope: "global" },
  { id: "go.settings", keys: "g s", scope: "global" },
  { id: "go.shortcuts", keys: "g ?", scope: "global" },
  { id: "go.team", keys: "g t", scope: "global", needs: "tickets" },
  // The sidebar: toggling and editing anywhere, the rest while a row has the focus.
  { id: "sidebar.toggle", keys: "b", scope: "global" },
  { id: "sidebar.edit", keys: "g e", scope: "global" },
  { id: "sidebar.focus", keys: "g b", scope: "global" },
  { id: "sidebar.done", keys: "escape", scope: "sidebar" },
  { id: "sidebar.next", keys: "arrowdown", scope: "sidebar" },
  { id: "sidebar.previous", keys: "arrowup", scope: "sidebar" },
  { id: "sidebar.rename", keys: "f2", scope: "sidebar" },
  { id: "sidebar.moveUp", keys: "mod+shift+arrowup", scope: "sidebar" },
  { id: "sidebar.moveDown", keys: "mod+shift+arrowdown", scope: "sidebar" },
  { id: "sidebar.pin", keys: "p", scope: "sidebar" },
  { id: "sidebar.hide", keys: "h", scope: "sidebar" },
  { id: "sidebar.remove", keys: "delete", scope: "sidebar" },
  // The ticket list (the inbox, a team, a view).
  { id: "tickets.next", keys: "j", scope: "tickets", needs: "tickets" },
  { id: "tickets.previous", keys: "k", scope: "tickets", needs: "tickets" },
  { id: "tickets.down", keys: "arrowdown", scope: "tickets", needs: "tickets", apart: "ticket" },
  { id: "tickets.up", keys: "arrowup", scope: "tickets", needs: "tickets", apart: "ticket" },
  { id: "tickets.open", keys: "o", scope: "tickets", needs: "tickets" },
  { id: "tickets.enter", keys: "enter", scope: "tickets", needs: "tickets", apart: "ticket" },
  { id: "tickets.select", keys: "x", scope: "tickets", needs: "tickets" },
  { id: "tickets.selectAll", keys: "mod+a", scope: "tickets", needs: "tickets" },
  { id: "tickets.solve", keys: "e", scope: "tickets", needs: "tickets", apart: "ticket" },
  { id: "tickets.reply", keys: "r", scope: "tickets", needs: "tickets", apart: "ticket" },
  { id: "tickets.assign", keys: "i", scope: "tickets", needs: "tickets", apart: "ticket" },
  { id: "tickets.snooze", keys: "h", scope: "tickets", needs: "tickets", apart: "ticket" },
  { id: "tickets.spam", keys: "shift+s", scope: "tickets", needs: "tickets", apart: "ticket" },
  { id: "tickets.search", keys: "/", scope: "tickets", needs: "tickets" },
  { id: "tickets.escape", keys: "escape", scope: "tickets", needs: "tickets" },
  // An open ticket.
  { id: "ticket.reply", keys: "r", scope: "ticket", needs: "tickets" },
  { id: "ticket.note", keys: "n", scope: "ticket", needs: "tickets" },
  { id: "ticket.assign", keys: "a", scope: "ticket", needs: "tickets" },
  { id: "ticket.assignMe", keys: "i", scope: "ticket", needs: "tickets" },
  { id: "ticket.status", keys: "s", scope: "ticket", needs: "tickets" },
  { id: "ticket.priority", keys: "p", scope: "ticket", needs: "tickets" },
  { id: "ticket.team", keys: "t", scope: "ticket", needs: "tickets" },
  { id: "ticket.snooze", keys: "h", scope: "ticket", needs: "tickets" },
  { id: "ticket.solve", keys: "e", scope: "ticket", needs: "tickets" },
  { id: "ticket.spam", keys: "shift+s", scope: "ticket", needs: "tickets" },
  { id: "ticket.panel", keys: "]", scope: "ticket", needs: "tickets" },
  { id: "ticket.send", keys: "mod+enter", scope: "ticket", needs: "tickets", fixed: true },
  { id: "ticket.sendAndFinish", keys: "mod+shift+enter", scope: "ticket", needs: "tickets", fixed: true },
  { id: "ticket.draft", keys: "mod+j", scope: "ticket", needs: "tickets", fixed: true },
  // Mail (Collab), the list and an open conversation.
  { id: "mail.next", keys: "j", scope: "mail", needs: "mail" },
  { id: "mail.previous", keys: "k", scope: "mail", needs: "mail" },
  { id: "mail.down", keys: "arrowdown", scope: "mail", needs: "mail" },
  { id: "mail.up", keys: "arrowup", scope: "mail", needs: "mail" },
  { id: "mail.open", keys: "o", scope: "mail", needs: "mail" },
  { id: "mail.enter", keys: "enter", scope: "mail", needs: "mail" },
  { id: "mail.select", keys: "x", scope: "mail", needs: "mail" },
  { id: "mail.selectAll", keys: "mod+a", scope: "mail", needs: "mail" },
  { id: "mail.archive", keys: "e", scope: "mail", needs: "mail" },
  { id: "mail.trash", keys: "#", scope: "mail", needs: "mail" },
  { id: "mail.spam", keys: "!", scope: "mail", needs: "mail" },
  { id: "mail.star", keys: "s", scope: "mail", needs: "mail" },
  { id: "mail.unread", keys: "shift+u", scope: "mail", needs: "mail" },
  { id: "mail.read", keys: "shift+i", scope: "mail", needs: "mail" },
  { id: "mail.move", keys: "m", scope: "mail", needs: "mail" },
  { id: "mail.label", keys: "l", scope: "mail", needs: "mail" },
  { id: "mail.reply", keys: "r", scope: "mail", needs: "mail" },
  { id: "mail.replyAll", keys: "a", scope: "mail", needs: "mail" },
  { id: "mail.forward", keys: "f", scope: "mail", needs: "mail" },
  { id: "mail.comment", keys: "shift+c", scope: "mail", needs: "mail" },
  { id: "mail.people", keys: "]", scope: "mail", needs: "mail" },
  { id: "mail.search", keys: "/", scope: "mail", needs: "mail" },
  { id: "mail.escape", keys: "escape", scope: "mail", needs: "mail" },
  // While an inbox category tab has the focus, for whoever may reorder the tabs (components/collab/CategoryTabs.tsx).
  { id: "mail.tabLeft", keys: "mod+shift+arrowleft", scope: "mail", needs: "mail" },
  { id: "mail.tabRight", keys: "mod+shift+arrowright", scope: "mail", needs: "mail" },
  // A page of Pages or the wiki.
  { id: "page.new", keys: "n", scope: "page" },
  { id: "page.newSubpage", keys: "shift+n", scope: "page" },
  { id: "page.parent", keys: "u", scope: "page" },
  { id: "page.favorite", keys: "s", scope: "page" },
  { id: "page.duplicate", keys: "shift+d", scope: "page" },
  { id: "page.move", keys: "m", scope: "page" },
  { id: "page.copyLink", keys: "l", scope: "page" },
  { id: "page.beside", keys: "mod+\\", scope: "page" },
  { id: "page.panel", keys: "mod+shift+;", scope: "page", fixed: true },
  { id: "page.search", keys: "/", scope: "page" },
  { id: "page.history", keys: "shift+h", scope: "page" },
  { id: "page.publish", keys: "shift+p", scope: "page" },
  { id: "page.export", keys: "shift+e", scope: "page" },
  { id: "page.lock", keys: "shift+l", scope: "page" },
  { id: "page.print", keys: "mod+p", scope: "page", fixed: true },
  { id: "page.save", keys: "mod+s", scope: "page", fixed: true },
  // The page's text, handled by the editor.
  { id: "editor.slash", keys: "/", scope: "editor", fixed: true },
  { id: "editor.pageLink", keys: "[ [", scope: "editor", fixed: true },
  { id: "editor.mention", keys: "@", scope: "editor", fixed: true },
  { id: "editor.ticket", keys: "#", scope: "editor", fixed: true },
  { id: "editor.emoji", keys: ":", scope: "editor", fixed: true },
  { id: "editor.write", keys: "space", scope: "editor", fixed: true },
  { id: "editor.text", keys: "mod+alt+0", scope: "editor", fixed: true },
  { id: "editor.heading1", keys: "mod+alt+1", scope: "editor", fixed: true },
  { id: "editor.heading2", keys: "mod+alt+2", scope: "editor", fixed: true },
  { id: "editor.heading3", keys: "mod+alt+3", scope: "editor", fixed: true },
  { id: "editor.todo", keys: "mod+alt+4", scope: "editor", fixed: true },
  { id: "editor.bullets", keys: "mod+alt+5", scope: "editor", fixed: true },
  { id: "editor.numbers", keys: "mod+alt+6", scope: "editor", fixed: true },
  { id: "editor.toggle", keys: "mod+alt+7", scope: "editor", fixed: true },
  { id: "editor.code", keys: "mod+alt+8", scope: "editor", fixed: true },
  { id: "editor.quote", keys: "mod+shift+b", scope: "editor", fixed: true },
  { id: "editor.moveUp", keys: "mod+shift+arrowup", scope: "editor", fixed: true },
  { id: "editor.moveDown", keys: "mod+shift+arrowdown", scope: "editor", fixed: true },
  { id: "editor.duplicate", keys: "mod+d", scope: "editor", fixed: true },
  { id: "editor.check", keys: "mod+enter", scope: "editor", fixed: true },
  { id: "editor.bold", keys: "mod+b", scope: "editor", fixed: true },
  { id: "editor.italic", keys: "mod+i", scope: "editor", fixed: true },
  { id: "editor.underline", keys: "mod+u", scope: "editor", fixed: true },
  { id: "editor.strike", keys: "mod+shift+s", scope: "editor", fixed: true },
  { id: "editor.inlineCode", keys: "mod+e", scope: "editor", fixed: true },
  { id: "editor.highlight", keys: "mod+shift+h", scope: "editor", fixed: true },
  { id: "editor.link", keys: "mod+k", scope: "editor", fixed: true },
  { id: "editor.comment", keys: "mod+alt+m", scope: "editor", fixed: true },
  { id: "editor.ollie", keys: "mod+j", scope: "editor", fixed: true },
  // A database page.
  { id: "database.newRow", keys: "r", scope: "database" },
  { id: "database.nextView", keys: "v", scope: "database" },
  { id: "database.previousView", keys: "shift+v", scope: "database" },
  { id: "database.filter", keys: "f", scope: "database" },
  { id: "database.sort", keys: "o", scope: "database" },
  { id: "database.search", keys: "shift+f", scope: "database" },
  // A canvas, handled by the canvas.
  { id: "canvas.pan", keys: "space", scope: "canvas", fixed: true },
  { id: "canvas.zoomIn", keys: "+", scope: "canvas", fixed: true },
  { id: "canvas.zoomOut", keys: "-", scope: "canvas", fixed: true },
  { id: "canvas.zoomReset", keys: "mod+0", scope: "canvas", fixed: true },
  { id: "canvas.fit", keys: "shift+1", scope: "canvas", fixed: true },
  { id: "canvas.fitSelection", keys: "shift+2", scope: "canvas", fixed: true },
  { id: "canvas.selectAll", keys: "mod+a", scope: "canvas", fixed: true },
  { id: "canvas.duplicate", keys: "mod+d", scope: "canvas", fixed: true },
  { id: "canvas.group", keys: "mod+g", scope: "canvas", fixed: true },
  { id: "canvas.delete", keys: "delete", scope: "canvas", fixed: true },
  { id: "canvas.nudge", keys: "arrowup", scope: "canvas", fixed: true },
  { id: "canvas.open", keys: "enter", scope: "canvas", fixed: true },
  { id: "canvas.undo", keys: "mod+z", scope: "canvas", fixed: true },
  { id: "canvas.redo", keys: "mod+shift+z", scope: "canvas", fixed: true },
  // AI bots' look editor.
  { id: "bots.new", keys: "n", scope: "bots" },
  { id: "bots.shuffle", keys: "r", scope: "bots" },
  { id: "bots.undo", keys: "z", scope: "bots" },
]);

export type ShortcutId = (typeof SHORTCUTS)[number]["id"];

/** The registry, each entry as a plain ShortcutDef. */
export const SHORTCUT_LIST: readonly ShortcutDef[] = SHORTCUTS;

const byId = new Map<string, ShortcutDef>(SHORTCUT_LIST.map((s) => [s.id, s]));

export function shortcutDef(id: string): ShortcutDef | undefined {
  return byId.get(id);
}

export function isShortcutId(id: string): id is ShortcutId {
  return byId.has(id);
}

// ─── Grammar ─────────────────────────────────────────────────────────────────

const NAMED = new Set([
  "enter", "escape", "space", "tab", "backspace", "delete", "arrowup", "arrowdown", "arrowleft", "arrowright",
  "home", "end", "pageup", "pagedown", ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);
const MODS = ["mod", "alt", "shift"] as const;

/** A step's modifiers and key, or null when it is not one. */
export function parseStep(step: string): { mods: Set<string>; key: string } | null {
  if (!step) return null;
  // Modifiers come first, each once, in MODS order; "mod++" is mod and the + key.
  const parts: string[] = [];
  let rest = step;
  let last = -1;
  for (;;) {
    const i = MODS.findIndex((x) => rest.startsWith(`${x}+`) && rest.length > x.length + 1);
    if (i < 0) break;
    if (i <= last) return null;
    last = i;
    parts.push(MODS[i]!);
    rest = rest.slice(MODS[i]!.length + 1);
  }
  const key = rest;
  if (!(key.length === 1 ? !/\s/.test(key) : NAMED.has(key))) return null;
  // Shift names a letter's capital; a symbol already carries its shift ("?", "#").
  if (parts.includes("shift") && key.length === 1 && !/[a-z0-9;]/.test(key)) return null;
  return { mods: new Set(parts), key };
}

/** Whether s is a binding: one or two steps, the second only after a step without mod. */
export function isBinding(s: string): boolean {
  const steps = s.split(" ");
  if (steps.length < 1 || steps.length > 2 || steps.some((x) => !parseStep(x))) return false;
  return steps.length === 1 || !parseStep(steps[0]!)!.mods.has("mod");
}

/** A binding as the Kbd component shows it: "mod+shift+p" → "mod shift p". */
export function displayKeys(binding: string): string {
  return binding
    .split(" ")
    .map((step) => {
      const p = parseStep(step);
      if (!p) return step;
      const key = KEY_SHOWN[p.key] ?? p.key;
      return [...MODS.filter((m) => p.mods.has(m)), key].join(" ");
    })
    .join(" ");
}

const KEY_SHOWN: Record<string, string> = {
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  escape: "esc",
  delete: "del",
  backspace: "⌫",
  enter: "enter",
  space: "space",
};

// ─── The person's keys ───────────────────────────────────────────────────────

/** Ids the person rebound: their keys, or null for a shortcut they turned off. */
export type ShortcutBindings = Partial<Record<string, string | null>>;

export const useShortcutKeys = create<{ bindings: ShortcutBindings }>(() => ({ bindings: readLocal() }));

const LOCAL = "od-shortcuts";

function readLocal(): ShortcutBindings {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(LOCAL) : null;
    return raw ? (cleanBindings(JSON.parse(raw)) ?? {}) : {};
  } catch {
    return {};
  }
}

/** Keeps known, rebindable ids with a valid binding or null; drops the rest. */
export function cleanBindings(raw: unknown): ShortcutBindings | null {
  if (!raw || typeof raw !== "object") return null;
  const out: ShortcutBindings = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    const d = byId.get(id);
    if (!d || d.fixed) continue;
    if (v === null || (typeof v === "string" && isBinding(v))) out[id] = v;
  }
  return out;
}

/** Applies bindings saved elsewhere (the server, another tab) and keeps them for the next visit. */
export function setShortcutBindings(bindings: ShortcutBindings) {
  const clean = cleanBindings(bindings) ?? {};
  useShortcutKeys.setState({ bindings: clean });
  try {
    localStorage.setItem(LOCAL, JSON.stringify(clean));
  } catch {
    // Private mode: the server keeps them.
  }
}

/** A shortcut's binding: the person's, its default, or null when turned off. */
export function bindingOf(id: string, bindings: ShortcutBindings = useShortcutKeys.getState().bindings): string | null {
  const d = byId.get(id);
  if (!d) return null;
  if (!d.fixed && id in bindings) return bindings[id] ?? null;
  return d.keys;
}

/** A shortcut's keys as Kbd shows them, kept live, or undefined when it has none. */
export function useShortcutLabel(idOrKeys: string | undefined): string | undefined {
  const bindings = useShortcutKeys((s) => s.bindings);
  if (!idOrKeys) return undefined;
  if (!byId.has(idOrKeys)) return idOrKeys;
  const b = bindingOf(idOrKeys, bindings);
  return b ? displayKeys(b) : undefined;
}

// ─── Binding handlers ────────────────────────────────────────────────────────

export type ShortcutHandlers = Partial<Record<ShortcutId, ((e: KeyboardEvent) => void) | false | null | undefined>>;

/**
 * Binds handlers by shortcut id, with the person's keys: the same rules as useHotkeys
 * (ignored while typing or with a dialog open, except mod keys; Enter and Space left to
 * a focused control; "g p"-style steps). A falsy handler leaves its keys alone.
 */
export function useShortcuts(handlers: ShortcutHandlers, enabled = true) {
  const bindings = useShortcutKeys((s) => s.bindings);
  const map = useMemo(() => {
    const out: HotkeyMap = {};
    for (const [id, fn] of Object.entries(handlers)) {
      if (!fn) continue;
      const b = bindingOf(id, bindings);
      if (b && !(b in out)) out[b] = fn;
    }
    return out;
    // The handlers are new each render; useHotkeys reads the latest map from a ref.
  }, [handlers, bindings]);
  useHotkeys(map, enabled);
}

// ─── Conflicts ───────────────────────────────────────────────────────────────

/** Scopes whose shortcuts can be on at the same time. The editor and canvas win while they have the focus. */
const TOGETHER: Record<ShortcutScope, readonly ShortcutScope[]> = {
  global: ["global", "sidebar", "tickets", "ticket", "mail", "page", "database", "bots"],
  sidebar: ["sidebar", "global"],
  tickets: ["tickets", "ticket", "global"],
  ticket: ["ticket", "tickets", "global"],
  mail: ["mail", "global"],
  page: ["page", "database", "global"],
  database: ["database", "page", "global"],
  editor: ["editor"],
  canvas: ["canvas"],
  bots: ["bots", "global"],
};

export function together(a: ShortcutDef, b: ShortcutDef): boolean {
  if (a.apart === b.scope || b.apart === a.scope) return false;
  return TOGETHER[a.scope].includes(b.scope);
}

/** Whether two bindings would catch the same press: equal, or one is the other's first step. */
export function clash(a: string, b: string): boolean {
  if (a === b) return true;
  const [a1, a2] = a.split(" ");
  const [b1, b2] = b.split(" ");
  return (!!a2 && !b2 && a1 === b) || (!!b2 && !a2 && b1 === a);
}

/** The shortcuts binding keys would clash with if id took them. */
export function conflictsFor(id: string, keys: string, bindings: ShortcutBindings = useShortcutKeys.getState().bindings): ShortcutDef[] {
  const me = byId.get(id);
  if (!me) return [];
  return SHORTCUT_LIST.filter((o) => {
    if (o.id === id || o.fixed) return false;
    const ob = bindingOf(o.id, bindings);
    return !!ob && together(me, o) && clash(keys, ob);
  });
}

/** Every pair of rebindable shortcuts that would catch the same press. */
export function allConflicts(bindings: ShortcutBindings = {}): [string, string][] {
  const out: [string, string][] = [];
  const live = SHORTCUT_LIST.filter((s) => !s.fixed);
  for (let i = 0; i < live.length; i++)
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i]!;
      const b = live[j]!;
      const ka = bindingOf(a.id, bindings);
      const kb = bindingOf(b.id, bindings);
      if (ka && kb && together(a, b) && clash(ka, kb)) out.push([a.id, b.id]);
    }
  return out;
}

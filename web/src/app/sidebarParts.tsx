// The sidebar's row primitives: the row shapes, the gliding active pill, rail
// tooltips, counts and foldable sections. Shared by the ticket sections and the
// Collab mail sections, so every row lines up.

import { useTranslation } from "react-i18next";
import { motion, useReducedMotion } from "motion/react";
import { ChevronDown } from "lucide-react";
import { createContext, useContext, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { AnimatedNumber } from "@/components/motion";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { tone, toneFor } from "@/lib/tones";
import { useSidebarPrefs } from "@/lib/collab/hooks";
import { iconOf, nameOf, SECTION_IDS } from "@/lib/collab/sidebarPrefs";
import { sidebarEdit, useSidebarEdit, type RowAction } from "@/lib/collab/sidebarEdit";
import type { SidebarSectionId } from "@/lib/api/types";
import type { EditSource } from "@/lib/collab/sidebarEditModel";

// The two row shapes share one element so the icon never moves while the label
// fades and the column narrows.
export const rowBase =
  "group relative isolate flex items-center rounded-md text-left text-[12.5px] outline-none transition-[width,background-color,color] duration-200 ease-out focus-visible:shadow-[0_0_0_2px_var(--focus)] motion-reduce:transition-none [&>svg]:size-[15px] [&>svg]:shrink-0 [&>svg]:transition-colors";
export const rowShape = (rail: boolean) => (rail ? "mx-3 h-8 w-8 justify-center" : "mx-2.5 h-7 w-[calc(100%-1.25rem)] gap-2.5 px-2");
export const rowIdle = "text-fg-2 hover:bg-chrome-hover hover:text-fg [&>svg]:text-fg-3 hover:[&>svg]:text-fg-2";
// The current row: its grey pill glides between rows (ActivePill), so the row
// itself only changes its text.
export const rowActive = "text-fg font-medium [&>svg]:text-fg hover:bg-transparent";

export const PillCtx = createContext("nav-pill");

/** The badge a section's header carries in a Space when the section is another workspace's. */
export const SectionMarkCtx = createContext<ReactNode>(null);

/** The active row's background, shared across rows so it glides between them. */
export function ActivePill() {
  const id = useContext(PillCtx);
  const reduce = useReducedMotion();
  return (
    <motion.span
      aria-hidden
      layoutId={reduce ? undefined : id}
      transition={{ type: "spring", stiffness: 550, damping: 42, mass: 0.7 }}
      className="absolute inset-0 -z-10 rounded-md bg-chrome-active"
    />
  );
}

/** Link children that draw the gliding pill when the row is current. */
export const withPill = (content: ReactNode) =>
  function NavRowContent({ isActive }: { isActive: boolean }) {
    return (
      <>
        {isActive && <ActivePill />}
        {content}
      </>
    );
  };

// ─── The row that opened the page ───────────────────────────────────────────
//
// The same thing can be a row in several places of the sidebar: a view under Views and in
// Favorites, a page in the Pages tree and in a section of the member's own. The row clicked
// lights up alone, like a tab; opened from anywhere else, every row of it lights up. A row
// names what it opens (`target`: "view:<id>", "wiki_page:<id>") and where it sits (`place`:
// "views", "favorites", "section:<id>", "tree").

export type Opener = { target: string; place: string };

let opener: Opener | null = null;
const openerListeners = new Set<() => void>();

/** Records the row clicked: the next render lights it, and only it, for that target. */
export function markOpener(target: string, place: string) {
  opener = { target, place };
  openerListeners.forEach((l) => l());
}

export function useOpener(): Opener | null {
  return useSyncExternalStore(
    (l) => {
      openerListeners.add(l);
      return () => openerListeners.delete(l);
    },
    () => opener,
  );
}

/** Whether a row gives way: another row of the same target was the one clicked. */
export function givesWay(who: Opener | null, target: string, place: string): boolean {
  return !!who && who.target === target && who.place !== place;
}

/**
 * The parts of a sidebar Link that lights up by its route like a tab: marks itself on click,
 * and while it gives way to the row clicked it neither bolds nor draws the pill.
 */
export function litLink(who: Opener | null, target: string, place: string, content: ReactNode) {
  const away = givesWay(who, target, place);
  return {
    onClick: () => markOpener(target, place),
    activeProps: (away ? {} : { className: rowActive, "data-status": "active" }) as Record<string, string>,
    children: away ? content : withPill(content),
  };
}

export function NavTip({ rail, label, children }: { rail: boolean; label: string; children: React.ReactElement }) {
  if (!rail) return children;
  return (
    <Tooltip content={label} side="right">
      {children}
    </Tooltip>
  );
}

export function Count({ n, rail }: { n: number | null | undefined; rail: boolean }) {
  if (n === null || n === undefined || rail) return null;
  // data-count: a row with a menu fades it for its ⋯ button (app.css .nav-row-menu).
  return (
    <span data-count="" className="ml-auto flex shrink-0">
      <AnimatedNumber
        value={Math.min(n, 1000)}
        format={(v) => (v >= 1000 ? "999+" : String(Math.round(v)))}
        flash
        className="mono text-[11px] text-fg-4 group-data-[status=active]:text-fg-2"
      />
    </span>
  );
}

export function Label({ children, rail }: { children: ReactNode; rail: boolean }) {
  return <span className={cn("min-w-0 flex-1 truncate", rail ? "sr-only" : "animate-label-in motion-reduce:animate-none")}>{children}</span>;
}

export function Section({
  id,
  label,
  rail,
  action,
  first,
  folded: foldedProp,
  onFold,
  icon,
  edit: editProp,
  menuTop,
  dragKey: dragKeyProp,
  children,
}: {
  id: string;
  label: string;
  /** The emoji the person gave the section, before its title. */
  icon?: string;
  rail: boolean;
  action?: ReactNode;
  first?: boolean;
  /** Folded, when the caller keeps it (a Space's own sections save it in the Space). */
  folded?: boolean;
  onFold?: (folded: boolean) => void;
  /** Renaming it where it is and its ⋯ menu; a built-in section gets its own from SectionEditCtx. */
  edit?: SectionEdit;
  /** A built-in section's own actions, first in its one ⋯ menu (Pages: new page, import). */
  menuTop?: ReactNode;
  /** Its key among the sections it drags with; a built-in section's is its id. */
  dragKey?: string;
  children: ReactNode;
}) {
  const mark = useContext(SectionMarkCtx);
  // A built-in section shows the member's own name and emoji for it (contracts/collab.md "Names and icons").
  const prefs = useSidebarPrefs();
  const builtin = (SECTION_IDS as readonly string[]).includes(id);
  const title = builtin ? nameOf(prefs, `section:${id}`, label) : label;
  const emoji = icon ?? (builtin ? iconOf(prefs, `section:${id}`) : undefined);
  const editFor = useContext(SectionEditCtx);
  const edit = editProp ?? (builtin ? editFor?.(id as SidebarSectionId, label, menuTop) : undefined);
  const drag = useContext(SidebarDragCtx);
  const dragKey = dragKeyProp ?? (builtin && drag?.scope === "sidebar" ? id : undefined);
  const dragProps = drag && dragKey && !rail ? drag.section(dragKey, title) : undefined;
  const renaming = useSidebarEdit((s) => !!edit && s.renaming === edit.key);
  const key = `od-nav-fold-${id}`;
  const [foldedHere, setFolded] = useState(() => {
    try {
      return localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  });
  const folded = foldedProp ?? foldedHere;
  const toggle = () => {
    if (onFold) return onFold(!folded);
    setFolded(!folded);
    try {
      localStorage.setItem(key, folded ? "0" : "1");
    } catch {
      /* storage unavailable */
    }
  };
  return (
    <div className={cn(!first && "mt-5")} data-edit-section={dragProps ? dragKey : undefined}>
      {!rail && (
        <div data-edit-head="" className="group/section mx-2.5 mb-0.5 flex h-6 items-center px-2">
          {renaming && edit ? (
            <InlineRename initial={title} placeholder={edit.placeholder} label={edit.renameLabel} caps onDone={(v) => {
              sidebarEdit.done();
              if (v !== null) edit.onName(v);
            }} />
          ) : (
            <button
              type="button"
              aria-expanded={!folded}
              onClick={toggle}
              data-sidebar-row={edit?.key}
              data-renamable={edit ? "true" : undefined}
              {...dragProps}
              className="label-caps flex min-w-0 flex-1 items-center gap-1 text-left outline-none transition-colors hover:text-fg-2 focus-visible:text-fg"
            >
              {emoji && <span aria-hidden className="text-[11px] normal-case leading-none tracking-normal">{emoji}</span>}
              <span className="truncate">{title}</span>
              {mark && <span className="ml-0.5 flex shrink-0 normal-case tracking-normal">{mark}</span>}
              <ChevronDown
                aria-hidden
                className={cn(
                  "size-3 shrink-0 transition-[transform,opacity] duration-200",
                  folded ? "-rotate-90 opacity-100" : "opacity-0 group-hover/section:opacity-100",
                )}
              />
            </button>
          )}
          {!renaming && (action || edit?.menu) && (
            <span className="flex shrink-0 items-center gap-0.5">
              {action}
              {edit?.menu}
            </span>
          )}
        </div>
      )}
      {(!folded || rail) && <div className="flex flex-col gap-px">{children}</div>}
    </div>
  );
}

// ─── Arranging the sidebar where it is ──────────────────────────────────────

/** A section's name of the member's own and its ⋯ menu (components/collab/SectionMenu.tsx). */
export type SectionEdit = {
  /** Its id while renamed or picking an icon (`data-sidebar-row`), "section:<key>". */
  key: string;
  placeholder: string;
  renameLabel: string;
  /** Saves the new name; an empty one brings back its own. */
  onName: (name: string) => void;
  menu: ReactNode;
};

/** The ⋯ menu and renaming of the built-in sections, given by the sidebar that draws them. */
export const SectionEditCtx = createContext<((id: SidebarSectionId, label: string, top?: ReactNode) => SectionEdit | undefined) | null>(null);

type DragProps = Record<string, unknown>;

/**
 * Dragging rows and sections outside edit mode (components/collab/SidebarDrag.tsx): the props
 * that make a row or a section's title drag, in the sidebar's own sections or a Space's.
 */
export const SidebarDragCtx = createContext<{
  scope: "sidebar" | "space";
  row: (source: EditSource, label: string) => DragProps;
  section: (key: string, label: string) => DragProps;
  /** Moves a row or section one place up (-1) or down (1); `dry` only says whether it can. */
  step: (source: EditSource, dir: -1 | 1, dry?: boolean) => boolean;
  /** A key's action on a row (moving, pinning, hiding, removing); true when it acted. */
  act: (source: EditSource, action: RowAction, label: string) => boolean;
} | null>(null);

/**
 * How long a menu takes to close and give the focus back to what opened it: a field or picker
 * opened from the menu on a row keeps the focus through it.
 */
export const MENU_SETTLE_MS = 1000;

/** A name typed where it was: Enter or leaving it saves, Escape keeps the old one. */
export function InlineRename({ initial, placeholder, label, caps, onDone }: { initial: string; placeholder: string; label: string; caps?: boolean; onDone: (name: string | null) => void }) {
  const done = useRef(false);
  // Opened from a menu, the menu's closing takes the focus back for a moment: the field keeps it.
  const [born] = useState(() => Date.now());
  const finish = (v: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(v === null ? null : v.trim());
  };
  return (
    <input
      autoFocus
      defaultValue={initial}
      placeholder={placeholder}
      aria-label={label}
      maxLength={64}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finish(e.currentTarget.value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          finish(null);
        }
      }}
      onBlur={(e) => {
        const el = e.currentTarget;
        if (Date.now() - born < MENU_SETTLE_MS) return void setTimeout(() => el.focus(), 0);
        finish(el.value);
      }}
      className={cn(
        "h-6 min-w-0 flex-1 rounded border border-line bg-surface px-1 text-[12.5px] text-fg outline-none placeholder:text-fg-4 focus:shadow-[0_0_0_2px_var(--focus)]",
        caps && "label-caps text-fg",
      )}
    />
  );
}


/** The pulsing red dot of a waiting visitor. */
export function WaitDot({ size = "size-1.5" }: { size?: string }) {
  return (
    <span className={cn("relative flex shrink-0", size)}>
      <span className="absolute inset-0 rounded-full bg-tone-red-solid animate-urgent-ping motion-reduce:hidden" />
      <span className={cn("relative rounded-full bg-tone-red-solid", size)} />
    </span>
  );
}

/**
 * On a row that lists tickets: how many visitors wait in chat there with nobody on it. A
 * soft tinted chip with a small live dot, so several rows can carry it without shouting;
 * the "waiting in chat" row on top of the inbox stays the loud one.
 */
export function WaitingBadge({ n, rail }: { n: number; rail: boolean }) {
  const { t } = useTranslation("shell");
  if (!n) return null;
  if (rail) return <span className="absolute left-1 top-1"><WaitDot /></span>;
  return (
    <span
      title={t("nav.waitingCount", { count: n })}
      aria-label={t("nav.waitingCount", { count: n })}
      className="ml-auto inline-flex h-[18px] shrink-0 items-center gap-1 rounded-[5px] bg-tone-red-soft pl-1.5 pr-[5px] text-[10.5px] font-semibold tabular-nums text-tone-red"
    >
      <WaitDot size="size-[5px]" />
      {n > 99 ? "99+" : n}
    </span>
  );
}

/** A workspace's mark: its first letter on a tile in its tone. `tiny` is the mark beside a Space row. */
export function WorkspaceGlyph({ name, small, tiny }: { name: string; small?: boolean; tiny?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center font-semibold tracking-tight text-white",
        tone[toneFor(name)].solid,
        tiny ? "size-3.5 rounded-[3px] text-[8px] !text-white" : small ? "size-4 rounded-sm text-[9px] !text-white" : "size-6 rounded-md text-[10.5px]",
      )}
    >
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

// The Space editor's sections and rows (contracts/spaces.md "The editor"), arranged as finely as
// the sidebar's edit mode arranges a workspace's sidebar. A whole built-in section opens into its
// rows, a group inside its Space section: a row reorders inside it where the section keeps an
// order, is added to Favorites or to any Space section (a row of its own there) and stays in its
// section, as pinning does in the sidebar, and hides with its eye. Sections, rows and groups drag
// by their grip with the sidebar's own drag (useEditDrag: pointer events, so touch drags too), and a
// focused grip moves one place with an arrow key, Alt or not: a group's row within its group, a
// Space row or a section across sections. The rules and the changes are lib/spaces/arrange.ts.

import { motion, useReducedMotion } from "motion/react";
import { Building2, ChevronRight, ChevronsDownUp, CornerUpLeft, Ellipsis, Eye, EyeOff, FileText, FolderInput, GripVertical, Inbox, Layers, Mail, Plus, RotateCcw, Star, Trash2, Users, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { DragGhost } from "@/components/collab/DragGhost";
import { useEditDrag } from "@/components/collab/useEditDrag";
import { Menu, MenuChoice, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuSub, MenuTrigger } from "@/components/ui/menu";
import { Tooltip } from "@/components/ui/tooltip";
import type { SidebarBadge, SidebarSectionId, Space, SpaceItem, SpaceSection } from "@/lib/api/types";
import { badgeChoices, badgeWord, type PagesPart } from "@/lib/collab/sidebarPrefs";
import { dropInSpace, type EditSource, type EditTarget } from "@/lib/collab/sidebarEditModel";
import { cn } from "@/lib/cn";
import { springs } from "@/lib/motion";
import type { WorkspaceData } from "@/lib/spaces/hooks";
import { arrangeRows, canMoveRow, homeOf, isArranged, isGroupKey, itemOfKey, moveRow, resetArranged, rowKeyOf, setRowHidden, stepRow, type Layout } from "@/lib/spaces/arrange";
import { isCollabItem, isEverywhere, isEverywhereList, isSectionId, itemKey, removeItem, removeSection, updateItem, updateSection, type SpaceProblem } from "@/lib/spaces/model";
import { buildRow, everywhereIcons, InWorkspace, type RowLabels } from "./rows";
import { favoriteRow, sectionRows, type SectionRow } from "./sectionRows";

export const sectionIcons: Record<SidebarSectionId, ReactNode> = { favorites: <Star />, inbox: <Inbox />, mail: <Mail />, teams: <Users />, views: <Layers />, pages: <FileText />, workspace: <Building2 /> };

type Look = { label: string; icon: ReactNode; badgeKind?: "mail" | "ticket" | "team"; nums?: Record<string, number | null | undefined> };

/** What a single row in the editor reads as: its name and icon, "loading" while its workspace's data comes, or null when it is gone. */
function lookOf(item: SpaceItem, d: WorkspaceData | undefined, labels: RowLabels): Look | "loading" | null {
  if (isEverywhere(item))
    return isEverywhereList(item.id) ? { label: labels.everywhere(item.id), icon: everywhereIcons[item.id], badgeKind: item.id === "mine" ? "ticket" : "mail" } : null;
  if (!d) return "loading";
  if (item.kind === "section") return isSectionId(item.id) ? { label: labels.section(item.id, d.collab), icon: sectionIcons[item.id] } : null;
  const loading =
    (item.kind === "team" && !d.teams) ||
    (item.kind === "view" && !d.views) ||
    (item.kind === "mailbox" && !d.mailboxes) ||
    ((item.kind === "wiki_space" || item.kind === "wiki_page") && (!d.wiki || !d.teams)) ||
    (isCollabItem(item) && (d.collab === undefined || (d.collab && !d.accounts))) ||
    (item.kind === "folder" && !!d.accounts?.some((a) => !d.folders[a.id]));
  const m = buildRow(item, d, { labels });
  if (!m) return loading ? "loading" : null;
  return { label: m.label, icon: m.icon, badgeKind: m.badge?.kind, nums: m.badge?.nums };
}

export function Problem({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="mt-1 animate-rise-in text-[11.5px] text-danger-fg motion-reduce:animate-none">
      {children}
    </p>
  );
}

const iconBtn =
  "flex size-6 shrink-0 items-center justify-center rounded-md text-fg-4 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:shadow-[0_0_0_2px_var(--focus)] data-[state=open]:bg-hover data-[state=open]:text-fg [&_svg]:size-3.5";

/** A row's number in the Space: Default, or one of the numbers its kind has. */
function NumberMenu({ item, kind, nums, onPick }: { item: SpaceItem; kind: "mail" | "ticket" | "team"; nums?: Record<string, number | null | undefined>; onPick: (v: SidebarBadge | null) => void }) {
  const { t } = useTranslation("spaces");
  const { t: tc } = useTranslation("collab");
  const word = (v: SidebarBadge) => (v === "none" ? tc("rowMenu.hideNumber") : tc(`customize.badge.${badgeWord(v, kind)}`));
  return (
    <Menu>
      <Tooltip content={t("row.number")}>
        <MenuTrigger asChild>
          <button
            type="button"
            aria-label={`${t("row.number")}: ${item.badge ? word(item.badge) : t("row.default")}`}
            className={cn(iconBtn, item.badge ? "w-auto px-1.5 text-[11px] font-medium text-fg-2" : "")}
          >
            {item.badge ? word(item.badge) : <span className="mono text-[11px]">#</span>}
          </button>
        </MenuTrigger>
      </Tooltip>
      <MenuContent align="end" className="w-[200px]">
        <MenuLabel>{t("row.number")}</MenuLabel>
        <MenuChoice checked={!item.badge} onSelect={() => onPick(null)}>
          {t("row.default")}
        </MenuChoice>
        {badgeChoices(kind).map((v) => (
          <MenuChoice key={v} checked={item.badge === v} onSelect={() => onPick(v)} hint={v === "none" ? undefined : (nums?.[v] ?? undefined)}>
            {word(v)}
          </MenuChoice>
        ))}
      </MenuContent>
    </Menu>
  );
}

/** The line where a drag would land. */
const Line = ({ inset }: { inset?: boolean }) => <div aria-hidden className={cn("pointer-events-none h-0.5 rounded-full bg-tone-blue-solid", inset ? "ml-9 mr-3" : "mx-3")} />;

/** The grip a section, row or group is dragged by; an arrow key, Alt or not, moves it one place. */
function Grip({ label, id, props, onStep }: { label: string; id: string; props: ReturnType<ReturnType<typeof useEditDrag<EditSource>>["handle"]>; onStep: (dir: -1 | 1) => void }) {
  const { t } = useTranslation("settings");
  return (
    <button
      type="button"
      aria-label={label}
      title={t("sortable.hint")}
      data-grip={id}
      {...props}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
        e.preventDefault();
        e.stopPropagation();
        onStep(e.key === "ArrowUp" ? -1 : 1);
      }}
      className="flex h-7 w-4 shrink-0 cursor-grab touch-none items-center justify-center rounded-sm text-fg-4 opacity-60 outline-none transition-opacity hover:text-fg-2 hover:opacity-100 focus-visible:opacity-100 focus-visible:shadow-[0_0_0_2px_var(--focus)] active:cursor-grabbing group-hover/row:opacity-100 [@media(hover:none)]:opacity-100"
    >
      <GripVertical className="size-3.5" />
    </button>
  );
}

/** A whole section's rows as the editor shows them: in the Space's order, rows hidden here dimmed. */
type GroupView = { item: SpaceItem; id: SidebarSectionId; rows: (SectionRow & { hidden: boolean })[] | "loading"; open: boolean };

/** The grip's id, kept when a row changes section, so the focus follows it. */
const gripOf = (i: SpaceItem) => (i.kind === "section" || i.kind === "everywhere" ? itemKey(i) : `${i.workspace_id}|${rowKeyOf(i)}`);

/** Groups with more rows than this start folded. */
const FOLD_OVER = 12;

export function SpaceArrange({
  space,
  onChange,
  data,
  labels,
  marks,
  target,
  onTarget,
  problems,
  starter,
}: {
  space: Space;
  onChange: (s: Space) => void;
  data: Map<string, WorkspaceData>;
  labels: RowLabels;
  /** Whether rows carry their workspace's badge. */
  marks: boolean;
  /** The section rows picked under Add from go to. */
  target: string | null;
  onTarget: (id: string) => void;
  problems: SpaceProblem[];
  starter: boolean;
}) {
  const { t } = useTranslation("spaces");
  const { t: tc } = useTranslation("collab");
  const reduce = useReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);
  const [folds, setFolds] = useState<Record<string, boolean>>({});
  const [focus, setFocus] = useState<string | null>(null);
  const words = useMemo(() => ({ waitingChats: tc("customize.waitingChats"), part: (p: PagesPart) => tc(`customize.pages.${p}`) }), [tc]);
  const sectionName = (sec: SpaceSection, i: number) => sec.title.trim() || t("view.untitledN", { n: i + 1 });

  // Each whole section's rows, as they show here.
  const groups = new Map<string, GroupView>();
  for (const sec of space.sections)
    for (const item of sec.items) {
      if (item.kind !== "section" || !isSectionId(item.id)) continue;
      const key = itemKey(item);
      const d = data.get(item.workspace_id);
      let rows: GroupView["rows"] = "loading";
      if (d) {
        const id = item.id;
        const live = id === "favorites" ? (item.rows ?? []).flatMap((k) => favoriteRow(k, d, labels) ?? []) : sectionRows(id, d, labels, words);
        const byKey = new Map(live.map((r) => [r.key, r]));
        const hidden = new Set(item.hidden ?? []);
        rows = arrangeRows(id, live.map((r) => r.key), { rows: item.rows }).flatMap((k) => {
          const r = byKey.get(k);
          return r ? [{ ...r, hidden: id !== "favorites" && hidden.has(k) }] : [];
        });
      }
      const open = folds[key] ?? (rows === "loading" || rows.length <= FOLD_OVER);
      groups.set(key, { item, id: item.id, rows, open });
    }

  // What each container shows, in order: what drops place rows among, and what arrow keys walk.
  const layout: Layout = [
    ...space.sections.map((sec) => ({ key: sec.id, keys: sec.items.map(itemKey) })),
    ...[...groups].map(([key, g]) => ({ key, keys: g.open && g.rows !== "loading" ? g.rows.map((r) => r.key) : [] })),
  ];
  const shown = (c: string) => layout.find((x) => x.key === c)?.keys ?? [];

  const move = (from: string, key: string, to: string, before: string | null) => {
    const next = moveRow(space, from, key, to, before, shown);
    if (next && next !== space) onChange(next);
    return next;
  };
  const accepts = (s: EditSource, tg: EditTarget) => (s.kind === "section" ? tg.kind === "section" : tg.kind === "row" && canMoveRow(space, s.from, s.key, tg.section));
  const onDrop = (s: EditSource, tg: EditTarget) => {
    if (s.kind === "section") {
      const next = dropInSpace(space, s, tg);
      if (next) onChange(next);
    } else if (tg.kind === "row") move(s.from, s.key, tg.section, tg.before);
  };
  const { drag, target: dropAt, handle } = useEditDrag<EditSource>({ root: rootRef, accepts, onDrop });

  // The grip that moved keeps the focus, wherever its row went.
  useEffect(() => {
    if (!focus) return;
    rootRef.current?.querySelector<HTMLElement>(`[data-grip="${CSS.escape(focus)}"]`)?.focus();
    setFocus(null);
  }, [focus, space]);

  const stepSection = (id: string, dir: -1 | 1) => {
    const ids = space.sections.map((x) => x.id);
    const i = ids.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    const next = dropInSpace(space, { kind: "section", key: id }, { kind: "section", before: dir < 0 ? ids[j] : (ids[j + 1] ?? null) });
    if (next) {
      onChange(next);
      setFocus(`section|${id}`);
    }
  };
  const stepRowFrom = (from: string, key: string, grip: string, dir: -1 | 1) => {
    const to = stepRow(space, from, key, dir, layout);
    if (!to) return;
    // A row that opens out of a folded group, or into one, stays in sight.
    if (isGroupKey(to.to)) setFolds((f) => ({ ...f, [to.to]: true }));
    if (move(from, key, to.to, to.before)) setFocus(grip);
  };

  const lineAt = (container: string, before: string | null) => dropAt?.kind === "row" && dropAt.section === container && dropAt.before === before;
  const dragging = drag?.source;
  const isDragged = (from: string, key: string) => dragging?.kind === "row" && dragging.from === from && dragging.key === key;
  /** The whole section `id` of a workspace in this Space, by key. */
  const homeGroup = (id: SidebarSectionId, wid: string) => [...groups].find(([, g]) => g.id === id && g.item.workspace_id === wid)?.[0];
  const motionProps = { layout: reduce ? false : ("position" as const), transition: reduce ? { duration: 0 } : springs.row };

  // A whole section's rows: dimmed while hidden here, each with its grip, eye and menu.
  const groupRows = (gk: string, g: GroupView) => {
    if (g.rows === "loading")
      return (
        <div className="py-1.5 pl-9">
          <span className="skeleton block h-2.5 w-32" />
        </div>
      );
    const fav = g.id === "favorites";
    const favorites = [...groups].find(([, x]) => x.id === "favorites" && x.item.workspace_id === g.item.workspace_id)?.[0];
    return (
      <>
        {g.rows.map((r) => {
          // Unique per group: a row shown in two groups (Mail and Favorites) has a grip in each.
          const grip = `${gk}|${r.key}`;
          const toFavorites = !fav && favorites && canMoveRow(space, gk, r.key, favorites) ? favorites : undefined;
          const addTo = itemOfKey(g.item.workspace_id, r.key) ? space.sections.filter((x) => canMoveRow(space, gk, r.key, x.id)) : [];
          return (
            <motion.div key={r.key} {...motionProps}>
              {lineAt(gk, r.key) && <Line inset />}
              <div
                data-edit-row={r.key}
                className={cn("group/row flex h-8 items-center gap-1.5 pr-1.5 transition-opacity duration-150 motion-reduce:transition-none", r.hidden && "opacity-50", isDragged(gk, r.key) && "opacity-40")}
                style={{ paddingLeft: 32 + (r.depth ?? 0) * 14 }}
              >
                <Grip label={t("editor.move", { name: r.label })} id={grip} props={handle({ kind: "row", from: gk, key: r.key }, r.label)} onStep={(dir) => stepRowFrom(gk, r.key, grip, dir)} />
                <span className="flex size-4 shrink-0 items-center justify-center text-fg-3 [&_svg]:size-3.5">{r.icon}</span>
                <span className="min-w-0 flex-1 truncate px-1 text-[12.5px] text-fg-2">{r.label}</span>
                {fav ? (
                  <Tooltip content={t("editor.removeFavorite", { name: r.label })}>
                    <button type="button" aria-label={t("editor.removeFavorite", { name: r.label })} onClick={() => onChange(setRowHidden(space, gk, r.key, true))} className={iconBtn}>
                      <X />
                    </button>
                  </Tooltip>
                ) : (
                  <Tooltip content={r.hidden ? t("editor.showRow", { name: r.label }) : t("editor.hideRow", { name: r.label })}>
                    <button
                      type="button"
                      aria-pressed={!r.hidden}
                      aria-label={r.hidden ? t("editor.showRow", { name: r.label }) : t("editor.hideRow", { name: r.label })}
                      onClick={() => onChange(setRowHidden(space, gk, r.key, !r.hidden))}
                      className={cn(iconBtn, !r.hidden && "text-fg-3")}
                    >
                      {r.hidden ? <EyeOff /> : <Eye />}
                    </button>
                  </Tooltip>
                )}
                {!addTo.length && !toFavorites && <span aria-hidden className="size-6 shrink-0" />}
                {(!!addTo.length || toFavorites) && (
                  <Menu>
                    <MenuTrigger asChild>
                      <button type="button" aria-label={t("row.more", { name: r.label })} className={iconBtn}>
                        <Ellipsis />
                      </button>
                    </MenuTrigger>
                    <MenuContent align="end" className="w-[210px]">
                      {toFavorites && (
                        <MenuItem icon={<Star />} onSelect={() => move(gk, r.key, toFavorites, null)}>
                          {t("editor.toFavorites")}
                        </MenuItem>
                      )}
                      {!!addTo.length && (
                        <MenuSub label={t("editor.addTo")} icon={<FolderInput />}>
                          {addTo.map((x) => (
                            <MenuItem key={x.id} onSelect={() => move(gk, r.key, x.id, null)}>
                              {sectionName(x, space.sections.indexOf(x))}
                            </MenuItem>
                          ))}
                        </MenuSub>
                      )}
                    </MenuContent>
                  </Menu>
                )}
              </div>
            </motion.div>
          );
        })}
        {lineAt(gk, null) && <Line inset />}
        {!g.rows.length && <p className="flex h-8 items-center pl-9 text-[12px] text-fg-4">{fav ? t("editor.favoritesEmpty") : t("editor.groupEmpty")}</p>}
        {fav && <p className="flex h-7 items-center pl-9 text-[11.5px] text-fg-4">{starter ? t("editor.favoritesTheirs") : t("editor.favoritesYours")}</p>}
      </>
    );
  };

  const mine = (sec: SpaceSection) => [...new Set(problems.filter((p) => "section" in p && p.section === sec.id).map((p) => p.code))];

  return (
    <div ref={rootRef} className="flex flex-col gap-2">
      {space.sections.map((sec, si) => {
        const title = sec.title;
        const isTarget = space.sections.length > 1 && target === sec.id;
        const sectionDragged = dragging?.kind === "section" && dragging.key === sec.id;
        return (
          <motion.div key={sec.id} {...motionProps}>
            {dropAt?.kind === "section" && dropAt.before === sec.id && <Line />}
            <div
              data-edit-section={sec.id}
              onFocusCapture={() => onTarget(sec.id)}
              className={cn(
                "group relative rounded-lg border bg-surface transition-[border-color,box-shadow,opacity] duration-150 motion-reduce:transition-none",
                isTarget ? "border-line-strong shadow-[0_1px_3px_rgb(0_0_0/0.06)]" : "border-line",
                sectionDragged && "opacity-40",
                dropAt?.kind === "row" && dropAt.section === sec.id && "border-line-strong",
              )}
            >
              <div data-edit-head="" className="group/row flex h-10 items-center gap-1.5 pl-1.5 pr-1.5">
                <Grip label={t("editor.move", { name: sectionName(sec, si) })} id={`section|${sec.id}`} props={handle({ kind: "section", key: sec.id }, sectionName(sec, si))} onStep={(dir) => stepSection(sec.id, dir)} />
                <input
                  value={title}
                  onChange={(e) => onChange(updateSection(space, sec.id, { title: e.target.value }))}
                  placeholder={t("editor.noHeader")}
                  aria-label={t("editor.sectionTitle")}
                  maxLength={60}
                  className="h-7 min-w-0 flex-1 rounded-md bg-transparent px-1.5 text-[13px] font-semibold text-fg outline-none transition-colors placeholder:font-normal placeholder:text-fg-4 hover:bg-hover/60 focus:bg-hover/60"
                />
                <span className="mono shrink-0 text-[10.5px] text-fg-4">{t("editor.rows", { count: sec.items.length })}</span>
                {space.sections.length > 1 && (
                  <Tooltip content={isTarget ? t("editor.addingHere") : t("editor.addHere")}>
                    <button type="button" aria-pressed={isTarget} aria-label={isTarget ? t("editor.addingHere") : t("editor.addHere")} onClick={() => onTarget(sec.id)} className={cn(iconBtn, isTarget && "bg-hover text-fg")}>
                      <Plus />
                    </button>
                  </Tooltip>
                )}
                {title.trim() && (
                  <Tooltip content={t("editor.foldInSidebar")}>
                    <button
                      type="button"
                      aria-pressed={sec.collapsed}
                      aria-label={t("editor.foldInSidebar")}
                      onClick={() => onChange(updateSection(space, sec.id, { collapsed: !sec.collapsed }))}
                      className={cn(iconBtn, sec.collapsed && "bg-hover text-fg")}
                    >
                      <ChevronsDownUp />
                    </button>
                  </Tooltip>
                )}
                <Menu>
                  <MenuTrigger asChild>
                    <button type="button" aria-label={t("editor.sectionMenu", { name: sectionName(sec, si) })} className={iconBtn}>
                      <Ellipsis />
                    </button>
                  </MenuTrigger>
                  <MenuContent align="end" className="w-[200px]">
                    <MenuItem danger icon={<Trash2 />} onSelect={() => onChange(removeSection(space, sec.id))}>
                      {t("editor.removeSection")}
                    </MenuItem>
                  </MenuContent>
                </Menu>
              </div>
              {mine(sec).map((code) => (
                <div key={code} className="px-3 pb-1">
                  <Problem>{t(`editor.problems.${code}`)}</Problem>
                </div>
              ))}
              <div className="border-t border-line-soft py-0.5">
                {sec.items.map((item) => {
                  const key = itemKey(item);
                  const d = isEverywhere(item) ? undefined : data.get(item.workspace_id);
                  const look = lookOf(item, d, labels);
                  const gone = look === null;
                  const label = look && look !== "loading" ? look.label : "";
                  const group = groups.get(key);
                  const grip = gripOf(item);
                  const home = !group && !isEverywhere(item) && homeOf(rowKeyOf(item));
                  const back = home ? homeGroup(home, item.workspace_id) : undefined;
                  const fg = !group && !isEverywhere(item) ? homeGroup("favorites", item.workspace_id) : undefined;
                  const favorites = fg && canMoveRow(space, sec.id, key, fg) ? fg : undefined;
                  const markHere = marks && !isEverywhere(item) && d;
                  const header = (
                    <div className={cn("group/row flex h-9 items-center gap-1.5 pl-1.5 pr-1.5", gone && "opacity-60")}>
                      <Grip label={t("editor.move", { name: label || t("editor.unavailable") })} id={grip} props={handle({ kind: "row", from: sec.id, key }, label || key)} onStep={(dir) => stepRowFrom(sec.id, key, grip, dir)} />
                      {group && (
                        <button
                          type="button"
                          aria-expanded={group.open}
                          aria-label={t("editor.groupRows", { name: label })}
                          onClick={() => setFolds((f) => ({ ...f, [key]: !group.open }))}
                          className={cn(iconBtn, "size-5")}
                        >
                          <ChevronRight className={cn("transition-transform duration-150 motion-reduce:transition-none", group.open && "rotate-90")} />
                        </button>
                      )}
                      <span className={cn("flex size-4 shrink-0 items-center justify-center text-fg-3 [&_svg]:size-3.5", gone && "opacity-40")}>{look && look !== "loading" ? look.icon : null}</span>
                      {gone ? (
                        <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg-4">{t("editor.unavailable")}</span>
                      ) : look === "loading" ? (
                        <span className="skeleton h-2.5 w-28" />
                      ) : group ? (
                        <span className="flex min-w-0 flex-1 items-center gap-2 px-1.5">
                          <span className="truncate text-[12.5px] font-medium text-fg">{label}</span>
                          <span className="shrink-0 text-[11px] text-fg-4">{isArranged(item) ? t("editor.arrangedHint") : t("editor.wholeHint")}</span>
                        </span>
                      ) : (
                        <input
                          value={item.name ?? ""}
                          onChange={(e) => onChange(updateItem(space, key, { name: e.target.value }))}
                          placeholder={label}
                          aria-label={t("row.renameLabel", { name: label })}
                          maxLength={80}
                          className="h-7 min-w-0 flex-1 rounded-md bg-transparent px-1.5 text-[12.5px] text-fg outline-none transition-colors placeholder:text-fg placeholder:opacity-100 hover:bg-hover/60 focus:bg-hover/60 focus:placeholder:text-fg-4"
                        />
                      )}
                      {markHere && <InWorkspace name={d.name} logo={d.logo} />}
                      {!group && look && look !== "loading" && look.badgeKind && (
                        <NumberMenu item={item} kind={look.badgeKind} nums={look.nums} onPick={(v) => onChange(updateItem(space, key, { badge: v }))} />
                      )}
                      <Menu>
                        <MenuTrigger asChild>
                          <button type="button" aria-label={t("row.more", { name: label || t("editor.unavailable") })} className={iconBtn}>
                            <Ellipsis />
                          </button>
                        </MenuTrigger>
                        <MenuContent align="end" className="w-[210px]">
                          {space.sections.length > 1 && (
                            <MenuSub label={t("editor.moveTo")} icon={<FolderInput />}>
                              {space.sections.map((x, i) => (
                                <MenuChoice key={x.id} checked={x.id === sec.id} onSelect={() => move(sec.id, key, x.id, null)}>
                                  {sectionName(x, i)}
                                </MenuChoice>
                              ))}
                            </MenuSub>
                          )}
                          {favorites && (
                            <MenuItem icon={<Star />} onSelect={() => move(sec.id, key, favorites, null)}>
                              {t("editor.toFavorites")}
                            </MenuItem>
                          )}
                          {back && home && (
                            <MenuItem icon={<CornerUpLeft />} onSelect={() => move(sec.id, key, back, null)}>
                              {t("editor.backInto", { name: labels.section(home, d?.collab) })}
                            </MenuItem>
                          )}
                          {group && isArranged(item) && (
                            <MenuItem icon={<RotateCcw />} onSelect={() => onChange(resetArranged(space, key))}>
                              {t("editor.resetArrangement")}
                            </MenuItem>
                          )}
                          {!group && item.name && (
                            <MenuItem icon={<X />} onSelect={() => onChange(updateItem(space, key, { name: null }))}>
                              {t("row.resetName", { name: label })}
                            </MenuItem>
                          )}
                          {(space.sections.length > 1 || favorites || back || (group && isArranged(item)) || (!group && item.name)) && <MenuSeparator />}
                          <MenuItem danger icon={<Trash2 />} onSelect={() => onChange(removeItem(space, key))}>
                            {t("editor.remove")}
                          </MenuItem>
                        </MenuContent>
                      </Menu>
                    </div>
                  );
                  return (
                    <motion.div key={key} {...motionProps}>
                      {lineAt(sec.id, key) && <Line />}
                      <div data-edit-row={key} className={cn("transition-opacity duration-150 motion-reduce:transition-none", isDragged(sec.id, key) && "opacity-40")}>
                        {group ? (
                          <div data-edit-section={key} className={cn("rounded-md transition-colors duration-150 motion-reduce:transition-none", dropAt?.kind === "row" && dropAt.section === key && "bg-hover/50")}>
                            {header}
                            {group.open && <div className="relative pb-1 before:absolute before:bottom-1.5 before:left-[23px] before:top-0 before:w-px before:bg-line-soft">{groupRows(key, group)}</div>}
                          </div>
                        ) : (
                          header
                        )}
                      </div>
                    </motion.div>
                  );
                })}
                {lineAt(sec.id, null) && <Line />}
                {!sec.items.length && <p className="px-4 py-3 text-[12px] text-fg-4">{t("editor.emptySection")}</p>}
              </div>
            </div>
          </motion.div>
        );
      })}
      {dropAt?.kind === "section" && dropAt.before === null && <Line />}
      <DragGhost drag={drag} />
    </div>
  );
}

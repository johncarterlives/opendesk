// The Pages section of the main sidebar (contracts/wiki.md "In the main sidebar"): Pages'
// (contracts/pages.md) pages, databases and canvases as a live tree, shown while the workspace
// has Pages on, each teamspace and the member's
// private pages under a row that folds, then today's note, templates and the trash. Rows nest,
// fold, drag and have the wiki's own menu (PageTree); "+" opens the new page popup and files
// dropped on the section open the import with them. What shows is the member's: the whole
// section, each part, a teamspace or a top-level page can be hidden (SidebarPrefs `hidden`).
// Wiki favorites are also rows of the main Favorites (FavoritePageRows).

import { Link, useNavigate } from "@tanstack/react-router";
import { CalendarDays, ChevronRight, EyeOff, FileText, FileUp, LayoutGrid, LayoutTemplate, Lock, MoreHorizontal, PencilRuler, Plus, StarOff, Trash2 } from "lucide-react";
import { useMemo, useState, type DragEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ActivePill, Label, NavTip, rowActive, rowBase, rowIdle, rowShape, Section, withPill } from "@/app/sidebarParts";
import { openImport, quickAdd } from "@/app/quickAdd";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { sidebarEdit } from "@/lib/collab/sidebarEdit";
import { toast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { TeamDot, useTeamsCtx } from "@/components/tickets/teams";
import type { SidebarPrefs, Team } from "@/lib/api/types";
import { useSaveSidebarPrefs, useSidebarPrefs } from "@/lib/collab/hooks";
import { RowEmoji } from "@/components/spaces/rows";
import { SidebarRow, useRowEdit } from "@/components/collab/SidebarRow";
import { FAVORITES, starKey } from "@/lib/collab/sidebarEditModel";
import { hid, iconOf, nameOf, setHidden, type PagesPart } from "@/lib/collab/sidebarPrefs";
import { cn } from "@/lib/cn";
import { atLeast, useRole, useSession } from "@/lib/session";
import { buildTree, childrenOf, spaceBody, type SpaceKey } from "@/lib/wiki/tree";
import { useProducts } from "@/lib/products";
import { AreaProvider, pageTo } from "@/lib/wiki/area";
import { markOpener, openHere, useAreaTree, useCreatePage, useFavorites, useOpenPageId, useOpener, useTitle, useWikiTree } from "./hooks";
import { useOpenToday } from "./journal";
import { DragProvider, EmptyRow, PageIcon, TreeView, useSpaceView } from "./PageTree";

/** The small buttons on a row or header, shown on hover like the other sections' "+". */
const tool =
  "flex size-5 items-center justify-center rounded text-fg-4 opacity-0 transition-opacity hover:bg-chrome-active hover:text-fg group-hover/section:opacity-100 group-hover/row:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100";

/** Which groups are folded, per member in this browser; open by default. */
function useFolds() {
  const key = `od-nav-pages-folded:${useSession((s) => s.workspaceId)}`;
  const [folded, setFolded] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(key) ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const toggle = (id: string) =>
    setFolded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(key, JSON.stringify([...next]));
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  return { folded, toggle };
}

/** Hides a part, a teamspace or a page from the section, saved with the member's sidebar. */
function useHide(prefs: SidebarPrefs) {
  const save = useSaveSidebarPrefs();
  const { t } = useTranslation("collab");
  return (id: string) => save.mutate(setHidden(prefs, id, true), { onError: (e) => toast.error(e, t("customize.saveFailed")) });
}

/** `shown`: the prefs it shows by, when a Space arranges it (components/spaces/arranged.ts); hiding changes `prefs`. */
export function PagesSection(props: { prefs: SidebarPrefs; shown?: SidebarPrefs; rail: boolean; first: boolean }) {
  if (!useProducts().pages) return null;
  return (
    <AreaProvider area="pages">
      <PagesTree {...props} />
    </AreaProvider>
  );
}

function PagesTree({ prefs, shown: view = prefs, rail, first }: { prefs: SidebarPrefs; shown?: SidebarPrefs; rail: boolean; first: boolean }) {
  const { t } = useTranslation("shell");
  const { t: tw } = useTranslation("wiki");
  const navigate = useNavigate();
  const canEdit = atLeast(useRole(), "agent");
  const { data = [], isLoading } = useAreaTree();
  const teams = useTeamsCtx();
  const hide = useHide(prefs);
  const { folded, toggle } = useFolds();
  const openToday = useOpenToday();
  const create = useCreatePage();
  const [dropping, setDropping] = useState(false);
  const full = useMemo(() => buildTree(data), [data]);
  const workspace = useSpaceView("workspace");
  const priv = useSpaceView("private");
  const hidden = useMemo(() => new Set(view.hidden), [view.hidden]);
  const shown = (part: PagesPart) => !hidden.has(hid.pages(part));
  const hiddenPages = useMemo(() => new Set(view.hidden.filter((x) => x.startsWith("wiki_page:")).map((x) => x.slice(10))), [view.hidden]);
  // A teamspace shows when it has pages the member sees, by name, as in the wiki.
  const spaces = useMemo(
    () => teams.teams.filter((x) => teams.canSeeTeam(x) && !hidden.has(hid.wikiSpace(x.id)) && data.some((n) => n.team_id === x.id)).sort((a, b) => a.name.localeCompare(b.name)),
    [teams, hidden, data],
  );

  if (rail)
    return (
      <Section id="pages" label={t("nav.pages")} rail first={first}>
        <NavTip rail label={t("nav.pages")}>
          <Link to="/pages" className={cn(rowBase, rowShape(true), rowIdle)} activeProps={{ className: rowActive }} aria-label={t("nav.pages")}>
            {withPill(<FileText />)}
          </Link>
        </NavTip>
      </Section>
    );

  const files = (e: DragEvent) => canEdit && e.dataTransfer.types.includes("Files");
  const tops = childrenOf(workspace, null).filter((n) => !hiddenPages.has(n.id));
  const placeRow = "text-fg-3";

  return (
    <Section
      id="pages"
      label={t("nav.pages")}
      rail={false}
      first={first}
      // One ⋯ for the section: what Pages does first, then arranging it (components/collab/SectionMenu.tsx).
      menuTop={
        <>
          {canEdit && (
            <>
              <MenuItem icon={<Plus />} onSelect={() => quickAdd.page(undefined, "pages")}>
                {tw("tree.newPage")}
              </MenuItem>
              <MenuItem icon={<FileUp />} onSelect={() => openImport(null, { area: "pages" })}>
                {tw("import.action")}
              </MenuItem>
            </>
          )}
          <MenuItem icon={<LayoutGrid />} onSelect={() => void navigate({ to: "/pages" })}>
            {tw("pages.openHome")}
          </MenuItem>
        </>
      }
      action={
        canEdit ? (
          <Tooltip content={tw("tree.newPage")}>
            <button type="button" aria-label={tw("tree.newPage")} onClick={() => quickAdd.page(undefined, "pages")} className={tool}>
              <Plus className="size-3.5" />
            </button>
          </Tooltip>
        ) : undefined
      }
    >
      <div
        data-wiki-sidebar
        className={cn("flex flex-col gap-px rounded-md transition-shadow", dropping && "shadow-[inset_0_0_0_1px_var(--tone-blue-solid)]")}
        onDragOver={(e) => {
          if (!files(e)) return;
          e.preventDefault();
          setDropping(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
        }}
        onDrop={(e) => {
          if (!files(e)) return;
          e.preventDefault();
          setDropping(false);
          openImport(null, { files: [...e.dataTransfer.files], area: "pages" });
        }}
      >
        <DragProvider>
          {shown("workspace") &&
            !isLoading &&
            (tops.length ? (
              <TreeView view={workspace} full={full} space="workspace" canEdit={canEdit} variant="nav" hidden={hiddenPages} onHide={(id) => hide(hid.wikiPage(id))} />
            ) : (
              canEdit && (
                <button type="button" onClick={() => create.mutate(spaceBody("workspace"))} className={cn(rowBase, rowShape(false), rowIdle, placeRow)}>
                  <Plus />
                  <Label rail={false}>{tw("tree.newPage")}</Label>
                </button>
              )
            ))}
          {shown("teamspaces") &&
            spaces.map((team) => (
              <TeamspaceGroup key={team.id} team={team} canEdit={canEdit} full={full} folded={folded.has(team.id)} onToggle={() => toggle(team.id)} onHide={() => hide(hid.wikiSpace(team.id))} />
            ))}
          {shown("private") && (
            <Group
              icon={<Lock className="size-[13px]" />}
              label={nameOf(prefs, hid.pages("private"), tw("sidebar.private"))}
              folded={folded.has("private")}
              onToggle={() => toggle("private")}
              onAdd={canEdit ? () => create.mutate(spaceBody("private")) : undefined}
              onHide={() => hide(hid.pages("private"))}
            >
              {childrenOf(priv, null).length ? (
                <TreeView view={priv} full={full} space="private" canEdit={canEdit} variant="nav" depth={1} />
              ) : (
                <EmptyRow space="private" canEdit={canEdit} variant="nav" onAdd={() => create.mutate(spaceBody("private"))} />
              )}
            </Group>
          )}
        </DragProvider>
        {canEdit && shown("today") && (
          <button type="button" onClick={() => void openToday()} className={cn(rowBase, rowShape(false), rowIdle, placeRow)}>
            <CalendarDays />
            <Label rail={false}>{nameOf(prefs, hid.pages("today"), tw("journal.today"))}</Label>
          </button>
        )}
        {shown("templates") && (
          <Link to="/pages/templates" className={cn(rowBase, rowShape(false), rowIdle, placeRow)} activeProps={{ className: rowActive }}>
            {withPill(
              <>
                <LayoutTemplate />
                <Label rail={false}>{nameOf(prefs, hid.pages("templates"), tw("templatesPage.title"))}</Label>
              </>,
            )}
          </Link>
        )}
        {shown("trash") && (
          <Link to="/pages/trash" className={cn(rowBase, rowShape(false), rowIdle, placeRow)} activeProps={{ className: rowActive }}>
            {withPill(
              <>
                <Trash2 />
                <Label rail={false}>{nameOf(prefs, hid.pages("trash"), tw("trash.title"))}</Label>
              </>,
            )}
          </Link>
        )}
      </div>
    </Section>
  );
}

/** A teamspace: its row, which folds, and its pages under it. Also a Space's teamspace row. */
export function TeamspaceGroup({
  team,
  canEdit,
  full,
  folded,
  onToggle,
  onHide,
}: {
  team: Team;
  canEdit: boolean;
  full: ReturnType<typeof buildTree>;
  folded: boolean;
  onToggle: () => void;
  onHide?: () => void;
}) {
  const create = useCreatePage();
  const space: SpaceKey = `team:${team.id}`;
  const view = useSpaceView(space);
  const prefs = useSidebarPrefs();
  const glyph = iconOf(prefs, hid.wikiSpace(team.id));
  return (
    <Group
      icon={glyph ? <RowEmoji emoji={glyph} /> : <TeamDot team={team} />}
      label={nameOf(prefs, hid.wikiSpace(team.id), team.name)}
      locked={team.private}
      folded={folded}
      onToggle={onToggle}
      onAdd={canEdit ? () => create.mutate(spaceBody(space)) : undefined}
      onHide={onHide}
    >
      <TreeView view={view} full={full} space={space} canEdit={canEdit} variant="nav" depth={1} />
    </Group>
  );
}

/** A Space's teamspace row of the open workspace: the teamspace and its pages, as in Pages. */
export function SpaceTeamspace({ team }: { team: Team }) {
  return (
    <AreaProvider area="pages">
      <SpaceTeamspaceTree team={team} />
    </AreaProvider>
  );
}

function SpaceTeamspaceTree({ team }: { team: Team }) {
  const canEdit = atLeast(useRole(), "agent");
  const { data = [] } = useAreaTree();
  const full = useMemo(() => buildTree(data), [data]);
  const { folded, toggle } = useFolds();
  return (
    <DragProvider>
      <div data-wiki-sidebar className="flex flex-col gap-px">
        <TeamspaceGroup team={team} canEdit={canEdit} full={full} folded={folded.has(team.id)} onToggle={() => toggle(team.id)} />
      </div>
    </DragProvider>
  );
}

/** A row that folds what is under it: a teamspace, or the member's private pages. */
function Group({
  icon,
  label,
  locked,
  folded,
  onToggle,
  onAdd,
  onHide,
  children,
}: {
  icon: ReactNode;
  label: string;
  locked?: boolean;
  folded: boolean;
  onToggle: () => void;
  onAdd?: () => void;
  onHide?: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation("wiki");
  const { t: tc } = useTranslation("collab");
  return (
    <>
      <div className="group/row relative">
        <button type="button" aria-expanded={!folded} onClick={onToggle} className={cn(rowBase, rowShape(false), rowIdle, "group-hover/row:pr-14 group-focus-within/row:pr-14")}>
          <span className="flex size-[15px] shrink-0 items-center justify-center">{icon}</span>
          <Label rail={false}>
            <span className="flex min-w-0 items-center gap-1">
              <span className="truncate">{label}</span>
              {locked && <Lock className="size-[11px] shrink-0 text-fg-4" />}
              <ChevronRight className={cn("size-3 shrink-0 text-fg-4 transition-transform duration-150 motion-reduce:transition-none", !folded && "rotate-90")} />
            </span>
          </Label>
        </button>
        <span className="absolute right-3.5 top-1 flex items-center gap-px">
          {onHide && (
            <Menu>
              <MenuTrigger asChild>
                <button type="button" aria-label={t("tree.actions", { title: label })} className={tool}>
                  <MoreHorizontal className="size-3.5" />
                </button>
              </MenuTrigger>
              <MenuContent align="start">
                {onAdd && (
                  <MenuItem icon={<Plus />} onSelect={onAdd}>
                    {t("sidebar.addIn", { section: label })}
                  </MenuItem>
                )}
                <MenuItem icon={<EyeOff />} onSelect={onHide}>
                  {t("sidebar.hidePage")}
                </MenuItem>
                <MenuItem icon={<PencilRuler />} onSelect={() => sidebarEdit.start()}>
                  {tc("edit.title")}
                </MenuItem>
              </MenuContent>
            </Menu>
          )}
          {onAdd && (
            <Tooltip content={t("sidebar.addIn", { section: label })}>
              <button type="button" aria-label={t("sidebar.addIn", { section: label })} onClick={onAdd} className={tool}>
                <Plus className="size-3.5" />
              </button>
            </Tooltip>
          )}
        </span>
      </div>
      {!folded && children}
    </>
  );
}

/**
 * The member's favorite pages as rows of the main Favorites, after its pins: one list with the
 * wiki's own Favorites, with the live title and icon from the tree; a page in the trash or out
 * of sight is skipped.
 */
export function FavoritePageRows({ rail }: { rail: boolean }) {
  const sidebarPrefs = useSidebarPrefs();
  const { t } = useTranslation("wiki");
  const title = useTitle();
  const fav = useFavorites();
  const { tree } = useWikiTree();
  const openId = useOpenPageId();
  const who = useOpener();
  const rowEdit = useRowEdit();
  return (
    <>
      {fav.list.map((saved) => {
        const n = tree.byId.get(saved.id);
        if (!n) return null;
        const label = nameOf(sidebarPrefs, hid.wikiPage(n.id), title(n.title));
        const glyph = iconOf(sidebarPrefs, hid.wikiPage(n.id));
        const active = openHere(who, openId, n.id, "favorites");
        // Drags among Favorites (the wiki's order) or into a section of the member's own, and
        // renames with a double-click, like every other row.
        return (
          <SidebarRow
            key={n.id}
            id={`favorites|${starKey(n.id)}`}
            source={{ kind: "row", from: FAVORITES, key: starKey(n.id), page: n.id, row: { kind: "wiki_page", id: n.id } }}
            label={label}
            edit={rowEdit(hid.wikiPage(n.id), title(n.title))}
            rail={rail}
          >
            <div className="group/row relative">
              <NavTip rail={rail} label={label}>
                <Link
                  {...pageTo(n)}
                  onClick={() => markOpener(n.id, "favorites")}
                  className={cn(rowBase, rowShape(rail), rowIdle, !rail && "group-hover/row:pr-8", active && rowActive)}
                  aria-label={rail ? label : undefined}
                >
                  {/* Drawn by hand, not from the route: the same page's row in the tree may be the one lit. */}
                  {active && <ActivePill />}
                  <span className="flex size-[15px] shrink-0 items-center justify-center">
                    {glyph ? <RowEmoji emoji={glyph} /> : <PageIcon icon={n.icon} kind={n.kind} />}
                  </span>
                  <Label rail={rail}>{label}</Label>
                </Link>
              </NavTip>
              {!rail && (
                <span className="absolute right-3.5 top-1">
                  <Tooltip content={t("favorites.remove")}>
                    <button type="button" aria-label={t("favorites.remove")} onClick={() => fav.toggle(n)} className={tool}>
                      <StarOff className="size-3.5" />
                    </button>
                  </Tooltip>
                </span>
              )}
            </div>
          </SidebarRow>
        );
      })}
    </>
  );
}

/** Whether the member has favorite pages to show in Favorites. */
export function useHasFavoritePages(): boolean {
  const fav = useFavorites();
  const { tree } = useWikiTree();
  return fav.list.some((n) => tree.byId.has(n.id));
}

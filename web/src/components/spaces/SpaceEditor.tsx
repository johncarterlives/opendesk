// The Space editor (contracts/spaces.md "The editor"): name, icon and colour; the Space's
// sections and rows, dragged into order, each row with its own name and number; Add section;
// "Add from", a tab per workspace listing what it offers; the marks switch. The
// same editor publishes a workspace's starter Space from Settings › General (admins), where
// every row is of that workspace. Nothing is saved until Save.

import { Check, Inbox, Layers, Plus, Users } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { WorkspaceBadge } from "@/components/workspaces/WorkspaceBadge";
import { useWorkspacePrefs, orderWorkspaces } from "@/lib/workspaces";
import { AccountDot, boxIcon, FolderGlyph } from "@/components/collab/bits";
import { TeamDot } from "@/components/tickets/teams";
import { ViewIcon, viewName } from "@/components/tickets/ViewIcon";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useConfirm } from "@/components/ui/confirm";
import { Dialog } from "@/components/ui/dialog";
import { SearchInput, TextInput } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import type { Space, SpaceItem } from "@/lib/api/types";
import { ACCOUNT_BOXES, accountName, buildFolderTree, flattenTree, folderWithRole } from "@/lib/collab/boxes";
import { SECTION_IDS } from "@/lib/collab/sidebarPrefs";
import { cn } from "@/lib/cn";
import { folders as ticketFolders } from "@/lib/folders";
import { useCollab, useSidebarPrefs } from "@/lib/collab/hooks";
import { atLeast, useRole, useSession } from "@/lib/session";
import { canSeeTeam, useWorkspacesData, useRemoveStarter, useSaveSpaces, useSaveStarter, useSpaces, useStarterSpace, type WorkspaceData } from "@/lib/spaces/hooks";
import {
  addItems,
  addSection,
  blankSpace,
  cleanName,
  defaultSections,
  MAIN_SECTION_ID,
  nextColor,
  hasItem,
  EVERYWHERE_LISTS,
  itemKey,
  LIMITS,
  removeItem,
  replaceSpace,
  SPACE_COLORS,
  SPACE_ICONS,
  SPACE_PAGES,
  spaceProblems,
  spacesProblems,
  needsWiki,
} from "@/lib/spaces/model";
import { spaceUi, useSpaceUi, type EditorTarget } from "@/lib/spaces/store";
import { tone } from "@/lib/tones";
import { buildRow, everywhereIcons, useRowLabels, type RowLabels } from "./rows";
import { Problem, sectionIcons, SpaceArrange } from "./SpaceArrange";
import { PageIcon } from "@/components/wiki/PageTree";
import { buildTree, childrenOf } from "@/lib/wiki/tree";
import { SpaceGlyph, spaceIcons, spaceTone } from "./icons";
import { sameJSON } from "@/lib/sameJSON";

type Offer = { item: SpaceItem; label: string; icon: ReactNode; hint?: string; depth?: number };

/** The "Every workspace" tab of Add from: the Everywhere lists, which span every workspace. */
const EVERY = "*";

function everywhereOffers(labels: RowLabels): Offer[] {
  return EVERYWHERE_LISTS.map((id) => ({ item: { workspace_id: "", kind: "everywhere", id }, label: labels.everywhere(id), icon: everywhereIcons[id] }));
}

/** What a workspace offers a Space, in groups: whole sections, inbox folders, teams, views, mail (with Collab), pages. */
function offersOf(d: WorkspaceData, labels: RowLabels, wholeHint: string): { id: "sections" | "inbox" | "teams" | "views" | "mail" | "pages" | "teamspaces" | "wiki"; offers: Offer[] }[] {
  const it = (kind: SpaceItem["kind"], id: string): SpaceItem => ({ workspace_id: d.id, kind, id });
  const sections = SECTION_IDS
    .filter((id) => d.collab || id !== "mail")
    .map((id) => ({ item: it("section", id), label: labels.section(id, d.collab), icon: sectionIcons[id], hint: wholeHint }));
  const inbox: Offer[] = ticketFolders.map((f) => ({ item: it("ticket_folder", f.id), label: labels.folder(f.id), icon: buildRow(it("ticket_folder", f.id), d, { labels })?.icon }));
  // Each ticket inbox (a reply address), opening its own Unassigned.
  for (const m of d.mailboxes ?? []) inbox.push({ item: it("mailbox", m.id), label: m.name || m.email, icon: <Inbox />, hint: m.name ? m.email : undefined });
  const visible = (d.teams ?? []).filter((x) => canSeeTeam(d, x)).sort((a, b) => Number(d.myTeams.has(b.id)) - Number(d.myTeams.has(a.id)) || a.name.localeCompare(b.name));
  const teams: Offer[] = [
    ...(d.myTeams.size > 1 ? [{ item: it("team", "mine"), label: labels.myTeams, icon: <Users /> }] : []),
    ...visible.map((x) => ({ item: it("team", x.id), label: x.name, icon: <TeamDot team={x} /> })),
  ];
  const views = [...(d.views ?? [])].sort((a, b) => a.position - b.position).map((v) => ({ item: it("view", v.id), label: viewName(v), icon: <ViewIcon icon={v.icon} size={14} /> }));
  const mail: Offer[] = [];
  if (d.collab) {
    mail.push({ item: it("box", "inbox"), label: labels.allInboxes, icon: <Layers /> });
    mail.push({ item: it("box", "shared"), label: labels.box("shared"), icon: boxIcon.shared });
    mail.push({ item: it("box", "assigned"), label: labels.box("assigned"), icon: boxIcon.assigned });
    mail.push({ item: it("box", "mentions"), label: labels.box("mentions"), icon: boxIcon.mentions });
    for (const a of d.accounts ?? []) {
      mail.push({ item: it("account", a.id), label: accountName(a), icon: <AccountDot color={a.color} className="size-2.5" />, hint: a.email });
      const fs = d.folders[a.id];
      for (const b of ACCOUNT_BOXES) {
        const f = folderWithRole(fs, b);
        if (f && b !== "inbox") mail.push({ item: it("folder", f.id), label: labels.box(b), icon: boxIcon[b], depth: 1 });
      }
      for (const { node, depth } of flattenTree(buildFolderTree(fs ?? []))) {
        if (node.folder) mail.push({ item: it("folder", node.folder.id), label: node.name, icon: <FolderGlyph folder={node.folder} />, depth: 1 + depth, hint: node.path !== node.name ? node.path : undefined });
      }
    }
  }
  const pages = SPACE_PAGES.map((p) => ({ item: it("page", p), label: labels.page(p), icon: buildRow(it("page", p), d, { labels })?.icon }));
  // Teamspaces, each kept up to date with its pages.
  const teamspaces = visible.filter((x) => d.wiki?.some((n) => n.team_id === x.id)).map((x) => ({ item: it("wiki_space", x.id), label: x.name, icon: <TeamDot team={x} /> }));
  // Pages, databases and canvases, in the tree's order: any of them can be a row of its own (a
  // runbook, a journal). A database's rows are its own, shown in its views.
  const wiki: Offer[] = [];
  const wtree = buildTree(d.wiki ?? []);
  const walk = (parent: string | null, depth: number) => {
    for (const n of childrenOf(wtree, parent)) {
      wiki.push({ item: it("wiki_page", n.id), label: n.title.trim() || labels.untitled, icon: <PageIcon icon={n.icon} kind={n.kind} />, depth });
      if (depth < 2 && n.kind !== "database") walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  return [
    { id: "sections" as const, offers: sections },
    { id: "inbox" as const, offers: inbox },
    { id: "teams" as const, offers: teams },
    { id: "views" as const, offers: views },
    { id: "mail" as const, offers: mail },
    { id: "pages" as const, offers: pages },
    { id: "teamspaces" as const, offers: teamspaces },
    { id: "wiki" as const, offers: wiki },
  ].filter((g) => g.offers.length);
}

/** "Add from": a tab per workspace, each listing what it offers with a checkbox. */
/** What a workspace offers, by group, with a search; `omit` leaves groups out (the whole sections, for a member's own section). */
export function AddFrom({ space, workspaces, data, active, onActive, labels, onToggle, omit }: { space: Space; workspaces: { id: string; name: string; logo: string | null }[]; data: Map<string, WorkspaceData>; active: string; onActive: (w: string) => void; labels: RowLabels; onToggle: (item: SpaceItem, on: boolean) => void; omit?: readonly string[] }) {
  const { t } = useTranslation("spaces");
  const [query, setQuery] = useState("");
  const every = active === EVERY;
  const d = every ? undefined : data.get(active);
  const ws = workspaces.find((w) => w.id === active);
  const needle = query.trim().toLowerCase();
  const all = every ? [{ id: "everywhere" as const, offers: everywhereOffers(labels) }] : d ? offersOf(d, labels, t("editor.wholeHint")) : [];
  const groups = all.filter((g) => !omit?.includes(g.id)).map((g) => ({ ...g, offers: needle ? g.offers.filter((o) => o.label.toLowerCase().includes(needle) || o.hint?.toLowerCase().includes(needle)) : g.offers })).filter((g) => g.offers.length);
  return (
    <div className="flex min-h-0 flex-col rounded-lg border border-line bg-surface">
      {workspaces.length > 1 && (
        <div role="tablist" aria-label={t("editor.addFrom")} className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-2 [scrollbar-width:none]">
          {workspaces.map((w) => (
            <button
              key={w.id}
              type="button"
              role="tab"
              aria-selected={w.id === active}
              onClick={() => onActive(w.id)}
              className={cn(
                "relative inline-flex h-9 shrink-0 items-center gap-1.5 px-1.5 text-[12.5px] outline-none transition-colors focus-visible:shadow-[inset_0_0_0_2px_var(--focus)]",
                w.id === active ? "font-medium text-fg after:absolute after:inset-x-1 after:-bottom-px after:h-[1.5px] after:rounded-full after:bg-fg" : "text-fg-3 hover:text-fg",
              )}
            >
              {w.id === EVERY ? <Layers className="size-3.5 text-fg-3" /> : <WorkspaceBadge name={w.name} logo={w.logo} size="sm" decorative />}
              <span className="max-w-[120px] truncate">{w.name}</span>
            </button>
          ))}
        </div>
      )}
      <div className="shrink-0 p-2">
        <SearchInput value={query} onChange={setQuery} placeholder={t("editor.search")} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {!d && !every ? (
          <p className="px-3 py-2 text-[12px] text-fg-4">{t("editor.loading", { workspace: ws?.name ?? "" })}</p>
        ) : (
          <>
            {d?.collab === false && !needle && <p className="mx-2 mb-2 rounded-md bg-sunken px-2.5 py-2 text-[11.5px] text-fg-3">{t("editor.noCollab", { workspace: d.name })}</p>}
            {groups.map((g) => (
              <section key={g.id} className="mb-2">
                <h4 className="label-caps px-2 pb-1 pt-1.5">{t(g.id === "inbox" && d?.collab ? "editor.groups.tickets" : `editor.groups.${g.id}`)}</h4>
                <ul className="flex flex-col">
                  {g.offers.map((o) => {
                    const on = hasItem(space, o.item);
                    return (
                      <li key={itemKey(o.item)}>
                        <label className="flex h-8 cursor-default items-center gap-2 rounded-md pr-2 transition-colors hover:bg-hover/60" style={{ paddingLeft: 8 + (o.depth ?? 0) * 16 }}>
                          <Checkbox checked={on} onCheckedChange={(v) => onToggle(o.item, v)} aria-label={o.label} />
                          <span className="flex size-4 shrink-0 items-center justify-center text-fg-3 [&_svg]:size-3.5">{o.icon}</span>
                          <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg">{o.label}</span>
                          {o.hint && <span className="max-w-[45%] shrink-0 truncate text-[11px] text-fg-4">{o.hint}</span>}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
            {!groups.length && needle && <p className="px-3 py-2 text-[12px] text-fg-4">{t("editor.noMatches")}</p>}
          </>
        )}
      </div>
    </div>
  );
}

function SpaceEditor({ target, make }: { target: EditorTarget; make: () => Space }) {
  const [initial] = useState(make);
  const { t } = useTranslation("spaces");
  const { t: ui } = useTranslation("ui");
  const confirm = useConfirm();
  const uid = useSession((s) => s.user?.id ?? "");
  const wid = useSession((s) => s.workspaceId);
  const memberships = useSession((s) => s.memberships);
  const wsPrefs = useWorkspacePrefs();
  const { spaces } = useSpaces();
  const save = useSaveSpaces();
  const saveStarter = useSaveStarter();
  const removeStarter = useRemoveStarter();
  const starter = target.kind === "starter";
  const { data: published } = useStarterSpace(starter ? wid : null);
  const labels = useRowLabels();
  const [draft, setDraft] = useState<Space>(initial);
  const [targetSection, setTargetSection] = useState<string | null>(initial.sections[initial.sections.length - 1]?.id ?? null);
  const [tab, setTab] = useState<string>(wid ?? memberships[0]?.workspace.id ?? "");
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);

  // A starter Space is of its workspace alone; a person's Space of any of theirs.
  const own = (starter ? memberships.filter((m) => m.workspace.id === wid) : orderWorkspaces(memberships, wsPrefs.order)).map((m) => ({ id: m.workspace.id, name: m.workspace.name, logo: m.workspace.avatar_url }));
  // The Everywhere lists span every workspace: a person's own Space can hold them, a starter can't.
  const workspaces = starter ? own : [...own, { id: EVERY, name: t("editor.everyWorkspace"), logo: null }];
  const members = useMemo(() => new Set(own.map((w) => w.id)), [own]);
  const wids = useMemo(() => {
    const out = [tab];
    for (const sec of draft.sections) for (const i of sec.items) if (!out.includes(i.workspace_id) && members.has(i.workspace_id)) out.push(i.workspace_id);
    return out.filter((w) => w && w !== EVERY);
  }, [draft.sections, tab, members]);
  const names = (w: string, kind: string) => draft.sections.some((sec) => sec.items.some((i) => i.workspace_id === w && i.kind === kind));
  const data = useWorkspacesData(wids, { folders: (w) => w === tab || names(w, "folder"), wiki: (w) => w === tab || needsWiki(draft, w) });

  const problems = spaceProblems(draft, members);
  const listProblems = starter ? [] : spacesProblems(replaceSpace(spaces ?? [], draft), members).filter((p) => p.code !== "space");
  const blocked = problems.length > 0 || listProblems.length > 0;
  const dirty = !sameJSON(draft, initial);
  const distinct = new Set(draft.sections.flatMap((s) => s.items.map((i) => i.workspace_id)));
  const nameProblem = problems.find((p) => p.code === "name_required" || p.code === "name_too_long");
  const general = [...problems.filter((p) => !("section" in p) && p !== nameProblem).map((p) => p.code), ...listProblems.map((p) => p.code)];

  const close = () => spaceUi.closeEditor();
  const ask = () => {
    if (!dirty) return close();
    confirm.show(t("editor.discardBody"), close, { title: t("editor.discardTitle"), confirmLabel: t("editor.discard"), danger: true });
  };
  const toggle = (item: SpaceItem, on: boolean) => {
    if (!on) return setDraft(removeItem(draft, itemKey(item)));
    const next = addItems(draft, targetSection, [item]);
    if (!targetSection || !draft.sections.some((s) => s.id === targetSection)) setTargetSection(next.sections[next.sections.length - 1]?.id ?? null);
    setDraft(next);
  };
  const submit = async () => {
    setTried(true);
    if (blocked) return;
    const clean = { ...draft, name: cleanName(draft.name) };
    setSaving(true);
    try {
      if (starter) {
        await saveStarter.mutateAsync(clean);
        toast.success(t("editor.published"));
      } else {
        await save.mutateAsync(replaceSpace(spaces ?? [], clean));
        if (target.kind === "new") spaceUi.pick(uid, clean.id);
      }
      close();
    } catch (e) {
      toast.error(e, t("editor.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const wsName = memberships.find((m) => m.workspace.id === wid)?.workspace.name ?? "";
  const title = starter ? t("editor.starterTitle", { workspace: wsName }) : target.kind === "new" ? t("editor.newTitle") : t("editor.editTitle", { name: initial.name });

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && ask()}
      size="xl"
      title={title}
      description={starter ? t("editor.starterDescription", { workspace: wsName }) : t("editor.description")}
      footer={
        <>
          {starter && published && (
            <Button
              variant="danger"
              className="mr-auto"
              onClick={() =>
                confirm.show(
                  t("editor.removeStarterBody"),
                  async () => {
                    await removeStarter.mutateAsync();
                    toast.success(t("editor.removed"));
                    close();
                  },
                  { title: t("editor.removeStarterTitle"), confirmLabel: t("editor.removeStarter"), danger: true },
                )
              }
            >
              {t("editor.removeStarter")}
            </Button>
          )}
          {tried && general.length > 0 && <span className="mr-auto text-[12px] text-danger-fg">{t(`editor.problems.${general[0]}`)}</span>}
          <Button variant="ghost" onClick={ask}>
            {ui("cancel")}
          </Button>
          <Button variant="primary" loading={saving} disabled={tried && blocked} onClick={() => void submit()}>
            {starter ? t("editor.publish") : target.kind === "new" ? t("editor.create") : t("editor.save")}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-5 pb-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {/* Name, icon and colour. */}
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-3">
            <SpaceGlyph icon={draft.icon} name={draft.name || "?"} color={draft.color} size="lg" className="mt-[18px] size-8" />
            <div className="min-w-0 flex-1">
              <label htmlFor="space-name" className="text-[12.5px] font-medium text-fg">
                {t("editor.name")}
              </label>
              <TextInput
                id="space-name"
                autoFocus
                value={draft.name}
                invalid={tried && !!nameProblem}
                maxLength={60}
                placeholder={t("editor.namePlaceholder")}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                className="mt-1.5"
              />
              {(tried || draft.name.length > LIMITS.name) && nameProblem && <Problem>{t(`editor.problems.${nameProblem.code}`)}</Problem>}
            </div>
          </div>
          <div className="flex flex-wrap items-start gap-x-8 gap-y-3 sm:pl-11">
            <div>
              <div className="mb-1.5 text-[12px] font-medium text-fg-2">{t("editor.icon")}</div>
              <div role="radiogroup" aria-label={t("editor.icon")} className="grid grid-cols-[repeat(13,1.75rem)] gap-0.5 max-sm:grid-cols-[repeat(9,1.75rem)]">
                {(["", ...SPACE_ICONS] as string[]).map((ic) => {
                  const Icon = ic ? spaceIcons[ic as (typeof SPACE_ICONS)[number]] : null;
                  const on = draft.icon === ic;
                  const name = ic ? t(`editor.icons.${ic as (typeof SPACE_ICONS)[number]}`) : t("editor.letter");
                  return (
                    <Tooltip key={ic || "letter"} content={name}>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={on}
                        aria-label={name}
                        onClick={() => setDraft({ ...draft, icon: ic })}
                        className={cn(
                          "flex size-7 items-center justify-center rounded-md text-fg-3 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:shadow-[0_0_0_2px_var(--focus)]",
                          on && cn(tone[spaceTone(draft.color)].soft, tone[spaceTone(draft.color)].text, "hover:text-current"),
                        )}
                      >
                        {Icon ? <Icon className="size-3.5" /> : <span className="text-[11.5px] font-semibold">{cleanName(draft.name).charAt(0).toUpperCase() || "A"}</span>}
                      </button>
                    </Tooltip>
                  );
                })}
              </div>
            </div>
            <div>
              <div className="mb-1.5 text-[12px] font-medium text-fg-2">{t("editor.color")}</div>
              <div role="radiogroup" aria-label={t("editor.color")} className="flex items-center gap-1">
                {SPACE_COLORS.map((c) => (
                  <Tooltip key={c} content={t(`editor.colors.${c}`)}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={draft.color === c}
                      aria-label={t(`editor.colors.${c}`)}
                      onClick={() => setDraft({ ...draft, color: c })}
                      className={cn(
                        "flex size-6 items-center justify-center rounded-full outline-none transition-transform hover:scale-110 focus-visible:shadow-[0_0_0_2px_var(--surface),0_0_0_4px_var(--focus)] active:scale-95 motion-reduce:transition-none",
                        tone[spaceTone(c)].solid,
                        draft.color === c && "shadow-[0_0_0_2px_var(--surface),0_0_0_3.5px_var(--line-strong)]",
                      )}
                    >
                      {draft.color === c && <Check className="size-3 text-white" strokeWidth={3} />}
                    </button>
                  </Tooltip>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="grid min-h-0 gap-4 md:grid-cols-[minmax(0,1fr)_300px]">
          {/* The Space's sections and rows. */}
          <section className="min-w-0">
            <div className="mb-1.5 flex items-end justify-between gap-3">
              <div>
                <h3 className="label-caps">{t("editor.structure")}</h3>
                <p className="mt-0.5 text-[11.5px] text-fg-4">{t("editor.structureHint")}</p>
              </div>
            </div>
            {draft.sections.length ? (
              <SpaceArrange
                space={draft}
                onChange={setDraft}
                data={data}
                labels={labels}
                marks={distinct.size > 1 || (distinct.size === 1 && !distinct.has(wid ?? ""))}
                target={draft.sections.length > 1 ? targetSection : null}
                onTarget={setTargetSection}
                problems={tried ? problems : problems.filter((p) => p.code === "section_too_many_items" || p.code === "title_too_long" || p.code === "row_name_too_long" || p.code === "too_many_arranged")}
                starter={starter}
              />
            ) : (
              <p className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-[12px] text-fg-4">{t("editor.noSections")}</p>
            )}
            <Button
              variant="ghost"
              icon={<Plus />}
              className="mt-2"
              disabled={draft.sections.length >= LIMITS.sections}
              onClick={() => {
                const made = addSection(draft, "");
                setDraft(made.space);
                setTargetSection(made.id);
              }}
            >
              {t("editor.addSection")}
            </Button>
          </section>

          {/* What each workspace offers. */}
          <section className="flex min-h-[320px] min-w-0 flex-col md:max-h-[520px]">
            <h3 className="label-caps mb-1.5">{t("editor.addFrom")}</h3>
            <AddFrom space={draft} workspaces={workspaces} data={data} active={tab} onActive={setTab} labels={labels} onToggle={toggle} />
          </section>
        </div>

        <section>
          <h3 className="label-caps mb-1.5">{t("editor.options")}</h3>
          <div className="rounded-lg border border-line">
            <label className="flex items-start justify-between gap-4 px-3.5 py-3">
              <span>
                <span className="block text-[12.5px] font-medium">{t("editor.marks")}</span>
                <span className="mt-0.5 block text-[12px] text-fg-3">{t("editor.marksHint")}</span>
              </span>
              <Switch checked={draft.marks} onCheckedChange={(v) => setDraft({ ...draft, marks: v })} aria-label={t("editor.marks")} />
            </label>
          </div>
        </section>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

/** The editor that is open, once what it edits has loaded. Mounted by the app layout. */
export default function SpaceEditorRoot() {
  const target = useSpaceUi((s) => s.editor);
  const { spaces } = useSpaces();
  const wid = useSession((s) => s.workspaceId);
  const role = useRole();
  const collab = useCollab();
  const prefs = useSidebarPrefs();
  const starter = useStarterSpace(target?.kind === "starter" ? wid : null);
  if (!target || !spaces) return null;
  let make: (() => Space) | null = null;
  if (target.kind === "space") {
    const found = spaces.find((s) => s.id === target.id);
    if (found) make = () => structuredClone(found);
  } else if (target.kind === "new") {
    const from = target.from;
    make = () => (from ? structuredClone(from) : blankSpace("", nextColor(spaces)));
  } else if (wid && atLeast(role, "admin") && !starter.isLoading && collab.isFetched) {
    // A first starter holds the workspace's own sections, ready to rearrange.
    const name = useSession.getState().memberships.find((m) => m.workspace.id === wid)?.workspace.name ?? "";
    const own = defaultSections(prefs, collab.enabled);
    const published = starter.data;
    make = () =>
      published
        ? structuredClone(published)
        : {
            ...blankSpace(name.slice(0, LIMITS.name), "blue"),
            sections: [{ id: MAIN_SECTION_ID, title: "", collapsed: false, items: own.map((id) => ({ workspace_id: wid, kind: "section" as const, id })) }],
          };
  }
  if (!make) return null;
  return <SpaceEditor key={`${target.kind}:${"id" in target ? target.id : ""}`} target={target} make={make} />;
}

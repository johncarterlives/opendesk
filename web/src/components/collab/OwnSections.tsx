// A member's own sidebar section (contracts/collab.md SidebarPrefs `sections`): their title,
// folded like the built-in ones, and rows of anything the workspace offers, drawn as the
// sidebar draws its own (components/spaces/rows.tsx) with their live numbers. Rows and the
// section drag as themselves (components/collab/SidebarDrag.tsx), a page's or a list's title
// dragged in from the page lands where it is dropped, and a double-click renames a row or the
// title where it is. The header's ⋯ (components/collab/SectionMenu.tsx) renames, gives it an
// emoji, adds rows, moves, folds and deletes; rows keep the Space row menu in the sidebar's
// words. "Add section" sits under the sections, shown on hover.

import { readSidebarDrag, carriesSidebarRow } from "@/lib/collab/sidebarDrag";
import { dropOnSidebar } from "@/lib/collab/sidebarEditModel";
import { ChevronsDownUp, ChevronsUpDown, Plus } from "lucide-react";
import { lazy, Suspense, useState, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import { Section } from "@/app/sidebarParts";
import { SpaceRowMenu } from "@/components/spaces/SpaceRowMenu";
import { buildRow, NavItemRow, useMailLocation, useRowLabels } from "@/components/spaces/rows";
import { useWaitingFor } from "@/components/tickets/useUrgentChats";
import { toast } from "@/components/ui/toast";
import { MenuItem } from "@/components/ui/menu";
import { Tooltip } from "@/components/ui/tooltip";
import type { SidebarSection, Space } from "@/lib/api/types";
import { asSpace, ownKey, withSpace } from "@/lib/collab/ownSections";
import { ownSectionsUi, type OwnRow } from "@/lib/collab/ownSectionsUi";
import { cn } from "@/lib/cn";
import { useWorkspacesData } from "@/lib/spaces/hooks";
import { itemKey, removeSection, updateItem, updateSection } from "@/lib/spaces/model";
import { useOwnSidebar } from "./AddToSidebar";
import { SectionMenu } from "./SectionMenu";
import { SidebarRow } from "./SidebarRow";

const LazyTeamspace = lazy(() => import("@/components/wiki/PagesSection").then((m) => ({ default: m.SpaceTeamspace })));

const headerBtn =
  "flex size-5 items-center justify-center rounded text-fg-4 opacity-0 transition-opacity hover:bg-chrome-hover hover:text-fg group-hover/section:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100";

export function OwnSection({ section, first, rail }: { section: SidebarSection; first: boolean; rail: boolean }) {
  const { t } = useTranslation("collab");
  const { prefs, wid, change } = useOwnSidebar();
  const folders = section.items.some((i) => i.kind === "folder");
  const wiki = section.items.some((i) => i.kind === "wiki_page" || i.kind === "wiki_space");
  const d = useWorkspacesData(wid ? [wid] : [], { folders: () => folders, wiki: () => wiki }).get(wid);
  const labels = useRowLabels();
  const here = useMailLocation();
  const waiting = useWaitingFor();
  // A page's or a list's title dragged in from the page, over the section.
  const [over, setOver] = useState(false);

  const space = asSpace(prefs, wid);
  const sec = space.sections.find((s) => s.id === section.id);
  if (!sec || !d) return null;
  const save = (next: Space) => change(withSpace(prefs, next));
  const put = (list: Space[]) => list[0] && save(list[0]);
  const title = section.title || t("ownSections.untitled");
  const key = ownKey(section.id);

  // Something dragged in from the page (a page's or a list's title) is added at the end.
  const dropZone = rail
    ? {}
    : {
        onDragOver: (e: DragEvent) => {
          if (!carriesSidebarRow(e)) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = "copy";
          if (!over) setOver(true);
        },
        onDragLeave: (e: DragEvent) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
        },
        onDrop: (e: DragEvent) => {
          setOver(false);
          const outside = readSidebarDrag(e);
          if (!outside) return;
          e.preventDefault();
          e.stopPropagation();
          const row = { kind: outside.kind, id: outside.id };
          const r = dropOnSidebar(prefs, wid, { kind: "row", from: "page", key: itemKey({ workspace_id: wid, ...row }), row }, { kind: "row", section: key, before: null }, () => []);
          if (r && "prefs" in r) change(r.prefs);
          else if (!sec.items.some((i) => i.kind === row.kind && i.id === row.id)) toast.error(t("ownSections.full"));
        },
      };

  // Deleted at once, with the way back in the toast.
  const remove = () => {
    const before = prefs;
    change(withSpace(prefs, removeSection(space, section.id)));
    toast.undo(t("edit.sectionDeleted", { name: title }), () => change(before), t("edit.undo"));
  };

  const rid = `section:${key}`;
  const edit = {
    key: rid,
    placeholder: t("ownSections.untitled"),
    renameLabel: t("edit.rename", { name: title }),
    onName: (v: string) => v && save(updateSection(space, section.id, { title: v })),
    menu: (
      <SectionMenu
        id={rid}
        name={title}
        dragKey={key}
        emoji={section.icon}
        onIcon={(v) => save(updateSection(space, section.id, { icon: v || null }))}
        onAdd={() => ownSectionsUi.add(section.id)}
        onDelete={remove}
        extra={
          <MenuItem
            icon={section.collapsed ? <ChevronsUpDown /> : <ChevronsDownUp />}
            onSelect={() => save(updateSection(space, section.id, { collapsed: !section.collapsed }))}
          >
            {section.collapsed ? t("ownSections.expand") : t("ownSections.collapse")}
          </MenuItem>
        }
      />
    ),
  };

  const rows = sec.items.map((item) => {
    const k = itemKey(item);
    // Rows of the member's own sections are of the kinds a section takes (contracts/collab.md SidebarItem).
    const source = { kind: "row" as const, from: key, key: k, row: { kind: item.kind as OwnRow["kind"], id: item.id } };
    if (item.kind === "wiki_space") {
      // A teamspace is its tree of pages, kept up to date.
      const team = d.teams?.find((x) => x.id === item.id);
      if (!team || !buildRow(item, d, { labels })) return null;
      return (
        <SidebarRow key={k} id={`${key}|${k}`} source={source} label={team.name} rail={rail} className="flex flex-col gap-px">
          <Suspense fallback={null}>
            <LazyTeamspace team={team} />
          </Suspense>
        </SidebarRow>
      );
    }
    const model = buildRow(item, d, { labels, here, waiting });
    if (!model) return null;
    const name = item.name || model.label;
    return (
      <SidebarRow
        key={k}
        id={`${key}|${k}`}
        source={source}
        label={name}
        rail={rail}
        edit={{
          name,
          placeholder: model.label,
          label: t("edit.rename", { name }),
          emoji: item.icon,
          onName: (v) => save(updateItem(space, k, { name: !v || v === model.label ? null : v })),
          onIcon: (v) => save(updateItem(space, k, { icon: v || null })),
        }}
      >
        <NavItemRow
          model={model}
          rail={rail}
          prefs={prefs}
          own={item.badge}
          label={item.name}
          emoji={item.icon}
          place={`section:${section.id}`}
          menu={(row) => (
            <SpaceRowMenu spaces={[space]} space={space} item={item} model={model} put={put} onRename={() => undefined} rail={rail} label={name} sidebar>
              {row}
            </SpaceRowMenu>
          )}
        />
      </SidebarRow>
    );
  });
  const shown = rows.filter(Boolean);

  return (
    <div {...dropZone} className={cn("rounded-md transition-colors", over && "bg-chrome-hover/60")}>
      <Section
        id={`own-${section.id}`}
        label={title}
        rail={rail}
        first={first}
        folded={section.collapsed}
        onFold={(collapsed) => save(updateSection(space, section.id, { collapsed }))}
        icon={section.icon}
        edit={edit}
        dragKey={key}
        action={
          <Tooltip content={t("ownSections.addRows")}>
            <button type="button" aria-label={t("ownSections.addRows")} onClick={() => ownSectionsUi.add(section.id)} className={headerBtn}>
              <Plus className="size-3.5" />
            </button>
          </Tooltip>
        }
      >
        {shown}
        {!rail && !shown.length && (
          <div className="mx-2.5 flex h-7 items-center gap-2 px-2 text-[12px] text-fg-4">
            <span className="min-w-0 flex-1 truncate">{t("ownSections.dragHere")}</span>
            <button
              type="button"
              onClick={() => ownSectionsUi.add(section.id)}
              className="flex h-5 shrink-0 items-center gap-1 rounded px-1.5 text-fg-3 outline-none transition-colors hover:bg-chrome-hover hover:text-fg focus-visible:shadow-[0_0_0_2px_var(--focus)] [&>svg]:size-3"
            >
              <Plus />
              {t("edit.add")}
            </button>
          </div>
        )}
      </Section>
    </div>
  );
}

/** "Add section" under the sidebar's sections: always there, in the quietest grey, so it is found without hovering. */
export function AddSectionButton({ label, onClick }: { label?: string; onClick?: () => void }) {
  const { t } = useTranslation("collab");
  return (
    <button
      type="button"
      onClick={onClick ?? (() => ownSectionsUi.name({ mode: "new" }))}
      className="mx-2.5 mt-4 flex h-7 w-[calc(100%-1.25rem)] items-center gap-2.5 rounded-md px-2 text-[12.5px] text-fg-4 outline-none transition-[color,background-color] duration-150 hover:bg-chrome-hover hover:text-fg-2 focus-visible:shadow-[0_0_0_2px_var(--focus)] motion-reduce:transition-none [&>svg]:size-3.5"
    >
      <Plus />
      <span>{label ?? t("ownSections.addSection")}</span>
    </button>
  );
}

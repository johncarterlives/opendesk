// The rows a whole built-in section has, for arranging it in the Space editor: every row the
// section can show for this person in that workspace, in its usual order, keyed as SidebarPrefs
// keys them (lib/spaces/arrange.ts). The person's own hidden rows there are not applied: a
// starter Space is arranged for everyone, and a Space's own hiding is shown by the editor.

import type { ReactNode } from "react";
import { FileText, CalendarDays, LayoutTemplate, Lock, Trash2, Users } from "lucide-react";
import type { SidebarSectionId } from "@/lib/api/types";
import { hid, PAGES_PARTS, type PagesPart } from "@/lib/collab/sidebarPrefs";
import { folders as ticketFolders } from "@/lib/folders";
import { canSeeTeam, type WorkspaceData } from "@/lib/spaces/hooks";
import { pinOfKey } from "@/lib/spaces/arrange";
import { SPACE_PAGES } from "@/lib/spaces/model";
import { orderViews } from "@/lib/viewSections";
import { inArea } from "@/lib/wiki/area";
import { buildRow, type RowLabels } from "./rows";

export type SectionRow = { key: string; label: string; icon: ReactNode; depth?: number };

/** The words rows without a row model are named with: the waiting chats row, the parts of Pages. */
export type SectionWords = { waitingChats: string; part: (p: PagesPart) => string };

const partIcons: Record<PagesPart, ReactNode> = {
  workspace: <FileText />,
  teamspaces: <Users />,
  private: <Lock />,
  today: <CalendarDays />,
  templates: <LayoutTemplate />,
  trash: <Trash2 />,
};

/** One row by its key, as the sidebar draws it, or null when what it names is gone or out of sight. */
export function rowOfKey(key: string, d: WorkspaceData, labels: RowLabels): SectionRow | null {
  const at = key.indexOf(":");
  const m = buildRow({ kind: key.slice(0, at), id: key.slice(at + 1) }, d, { labels });
  return m ? { key, label: m.label, icon: m.icon } : null;
}

/** Every row a built-in section has, in its usual order. Favorites have none of their own here: the person's favorites are theirs. */
export function sectionRows(id: SidebarSectionId, d: WorkspaceData, labels: RowLabels, words: SectionWords): SectionRow[] {
  const rows = (keys: string[], depth?: number) => keys.flatMap((k) => {
    const r = rowOfKey(k, d, labels);
    return r ? [depth ? { ...r, depth } : r] : [];
  });
  switch (id) {
    case "favorites":
      return [];
    case "inbox":
      if (!d.tickets) return [];
      return [{ key: hid.waitingChats, label: words.waitingChats, icon: <span className="size-2 rounded-full bg-tone-red-solid" /> }, ...rows(ticketFolders.map((f) => hid.ticketFolder(f.id)))];
    case "mail":
      if (!d.collab) return [];
      return rows([hid.box("inbox"), hid.box("shared"), hid.box("assigned"), ...(d.accounts ?? []).map((a) => hid.account(a.id))]);
    case "teams": {
      if (!d.tickets) return [];
      const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
      const visible = (d.teams ?? []).filter((x) => canSeeTeam(d, x));
      const mine = visible.filter((x) => d.myTeams.has(x.id)).sort(byName);
      const others = visible.filter((x) => !d.myTeams.has(x.id)).sort(byName);
      return rows([...(mine.length > 1 ? [hid.team("mine")] : []), ...[...mine, ...others].map((x) => hid.team(x.id))]);
    }
    case "views":
      return rows(orderViews(d.views ?? []).map((v) => hid.view(v.id)));
    case "pages": {
      const own = (d.wiki ?? []).filter(inArea("pages"));
      const tops = own.filter((n) => !n.parent_id && !n.private && !n.team_id && !n.journal).sort((a, b) => a.position - b.position);
      const spaces = (d.teams ?? []).filter((x) => canSeeTeam(d, x) && own.some((n) => n.team_id === x.id)).sort((a, b) => a.name.localeCompare(b.name));
      return PAGES_PARTS.flatMap((part) => [
        { key: hid.pages(part), label: words.part(part), icon: partIcons[part] },
        ...(part === "workspace" ? rows(tops.map((n) => hid.wikiPage(n.id)), 1) : part === "teamspaces" ? rows(spaces.map((x) => hid.wikiSpace(x.id)), 1) : []),
      ]);
    }
    case "workspace":
      return rows(SPACE_PAGES.map((p) => hid.page(p)));
  }
}

/** A row Favorites take in a Space, by its key; null for a key they don't take. */
export function favoriteRow(key: string, d: WorkspaceData, labels: RowLabels): SectionRow | null {
  return pinOfKey(key) ? rowOfKey(key, d, labels) : null;
}

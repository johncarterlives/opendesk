// What each built-in sidebar section holds, for arranging it: its rows with their names,
// icons, hidden-ids, favorites and numbers, and what each favorite points at. The customize
// dialog and the sidebar's edit mode (SidebarEditor) list the same rows.

import { useQuery } from "@tanstack/react-query";
import { BarChart3, BookOpen, CalendarDays, FileText, LayoutTemplate, Layers, ListTree, Lock, NotebookText, Trash2, Users } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { SidebarPin, SidebarSectionId, View } from "@/lib/api/types";
import { ACCOUNT_BOXES, accountName, buildFolderTree, flattenTree, folderWithRole, isMailBox } from "@/lib/collab/boxes";
import { useAllFolders, useCollab, useMailAccounts, useSidebarPrefs } from "@/lib/collab/hooks";
import type { OwnRow } from "@/lib/collab/ownSectionsUi";
import { hid, PAGES_PARTS, type BadgeKind, type MailBadge, type PagesPart, type TicketBadge } from "@/lib/collab/sidebarPrefs";
import { folderById, folders as ticketFolders } from "@/lib/folders";
import { q } from "@/lib/queries";
import { groupViews, findSection } from "@/lib/viewSections";
import { TeamDot, useTeamsCtx } from "@/components/tickets/teams";
import { ViewIcon, viewName } from "@/components/tickets/ViewIcon";
import { PageIcon } from "@/components/wiki/PageTree";
import { inArea } from "@/lib/wiki/area";
import { AccountDot, boxIcon, FolderGlyph } from "./bits";

export type ItemBadge = { key: string; kind: BadgeKind; sections: SidebarSectionId[]; fallback?: MailBadge | TicketBadge };

/**
 * A row of a built-in section. `hideId` hides it, `pin` makes it a favorite, `row` is what
 * goes into a section of the member's own (a favorite's kind, or a page, teamspace or
 * Workspace row); `depth` nests it under the row before.
 */
export type Item = { key: string; label: string; icon: ReactNode; hideId?: string; pin?: SidebarPin; row?: OwnRow; badge?: ItemBadge; depth?: number; note?: string };

/** The kinds of favorite that are also rows of the member's own sections (a view section is not). */
export function ownRowOf(item: Pick<Item, "pin" | "row">): OwnRow | null {
  if (item.row) return item.row;
  if (!item.pin || item.pin.kind === "view_section") return null;
  return { kind: item.pin.kind, id: item.pin.id };
}

export function useSidebarItems() {
  const { t: tNav } = useTranslation("navigation");
  const { t } = useTranslation("collab");
  const { t: tShell } = useTranslation("shell");
  const collab = useCollab().enabled;
  const prefs = useSidebarPrefs();
  const { data: accounts } = useMailAccounts();
  const folderMap = useAllFolders(accounts);
  const { data: views } = useQuery(q.views());
  const { data: pages } = useQuery(q.wikiTree());
  const teams = useTeamsCtx();

  const mailBadge = (key: string, fallback?: MailBadge): ItemBadge => ({ key, kind: "mail", sections: ["mail"], fallback });
  const ticketBadge = (key: string, section: SidebarSectionId): ItemBadge => ({ key, kind: section === "teams" ? "team" : "ticket", sections: [section] });

  const itemsOf = (id: SidebarSectionId): Item[] => {
    switch (id) {
      case "favorites":
        return [];
      case "mail": {
        const out: Item[] = [
          { key: "box:inbox", label: t("nav.allInboxes"), icon: <Layers />, hideId: hid.box("inbox"), pin: { kind: "box", id: "inbox" }, badge: mailBadge("box:inbox") },
          { key: "box:shared", label: t("box.shared"), icon: boxIcon.shared, hideId: hid.box("shared"), pin: { kind: "box", id: "shared" }, badge: mailBadge("box:shared") },
          { key: "box:assigned", label: t("box.assigned"), icon: boxIcon.assigned, hideId: hid.box("assigned"), pin: { kind: "box", id: "assigned" }, badge: mailBadge("box:assigned") },
          { key: "box:mentions", label: t("box.mentions"), icon: boxIcon.mentions, hideId: hid.box("mentions"), pin: { kind: "box", id: "mentions" }, badge: mailBadge("box:mentions") },
          ...ACCOUNT_BOXES.map((b) => ({ key: `every:${b}`, label: t(`box.${b}`), icon: boxIcon[b], hideId: hid.folder(b), note: t("customize.everyAccount") })),
        ];
        for (const a of accounts ?? []) {
          const fs = folderMap[a.id];
          out.push({ key: `account:${a.id}`, label: accountName(a), icon: <AccountDot color={a.color} className="size-2.5" />, hideId: hid.account(a.id), pin: { kind: "account", id: a.id }, badge: mailBadge(`account:${a.id}`) });
          for (const b of ACCOUNT_BOXES) {
            const f = folderWithRole(fs, b);
            // Only Starred of the special folders showed a number before anyone chose.
            if (f) out.push({ key: `f:${f.id}`, label: t(`box.${b}`), icon: boxIcon[b], hideId: hid.folder(f.id), pin: { kind: "folder", id: f.id }, badge: mailBadge(`folder:${f.id}`, b === "starred" ? undefined : "none"), depth: 1 });
          }
          for (const { node, depth } of flattenTree(buildFolderTree(fs ?? []))) {
            if (!node.folder) continue;
            out.push({ key: `f:${node.folder.id}`, label: node.name, icon: <FolderGlyph folder={node.folder} />, hideId: hid.folder(node.folder.id), pin: { kind: "folder", id: node.folder.id }, badge: mailBadge(`folder:${node.folder.id}`), depth: 1 + depth });
          }
        }
        return out;
      }
      case "inbox":
        return [
          // Shown only while someone waits, so a member who does not take chats can leave it out.
          { key: "waiting_chats", label: t("customize.waitingChats"), icon: <span className="size-2 rounded-full bg-tone-red-solid" />, hideId: hid.waitingChats, note: t("customize.waitingChatsNote") },
          ...ticketFolders.map((f): Item => ({
            key: f.id,
            label: tNav(f.labelKey),
            icon: <Layers />,
            hideId: hid.ticketFolder(f.id),
            pin: { kind: "ticket_folder", id: f.id },
            badge: f.id === "solved" || f.id === "spam" ? undefined : ticketBadge(hid.ticketFolder(f.id), "inbox"),
          })),
        ];
      case "teams": {
        const list = teams.teams.filter(teams.canSeeTeam);
        // My teams shows while the member is on two teams or more.
        const mine = list.filter((x) => teams.myTeams.has(x.id)).length > 1;
        return [
          ...(mine ? [{ key: "mine", label: tShell("nav.myTeams"), icon: <Users />, hideId: hid.team("mine"), pin: { kind: "team", id: "mine" } as SidebarPin, badge: ticketBadge(hid.team("mine"), "teams") }] : []),
          ...list.map((x) => ({ key: x.id, label: x.name, icon: <TeamDot team={x} />, hideId: hid.team(x.id), pin: { kind: "team", id: x.id } as SidebarPin, badge: ticketBadge(hid.team(x.id), "teams") })),
        ];
      }
      case "views": {
        const view = (v: View, depth: number): Item => ({
          key: v.id,
          label: viewName(v),
          icon: <ViewIcon icon={v.icon} size={14} />,
          hideId: hid.view(v.id),
          pin: { kind: "view", id: v.id },
          badge: ticketBadge(hid.view(v.id), "views"),
          depth,
        });
        // A section heads its views, and pins to Favorites with them.
        return groupViews(views ?? []).flatMap((e) =>
          e.kind === "view"
            ? [view(e.view, 0)]
            : [{ key: `section:${e.key}`, label: viewName(e), icon: e.icon ? <ViewIcon icon={e.icon} size={14} /> : <ListTree />, pin: { kind: "view_section", id: e.key }, note: t("customize.viewSection") }, ...e.views.map((v) => view(v, 1))],
        );
      }
      case "pages": {
        // Its parts, the workspace's top-level pages under Workspace pages, and the teamspaces under Teamspaces.
        const icons: Record<PagesPart, ReactNode> = {
          workspace: <FileText />,
          teamspaces: <Users />,
          private: <Lock />,
          today: <CalendarDays />,
          templates: <LayoutTemplate />,
          trash: <Trash2 />,
        };
        // The Pages section shows Pages' own pages (contracts/pages.md), not the wiki's.
        const own = (pages ?? []).filter(inArea("pages"));
        const tops = own.filter((n) => !n.parent_id && !n.private && !n.team_id && !n.journal).sort((a, b) => a.position - b.position);
        const spaces = teams.teams.filter((x) => teams.canSeeTeam(x) && own.some((n) => n.team_id === x.id)).sort((a, b) => a.name.localeCompare(b.name));
        return PAGES_PARTS.flatMap((part): Item[] => [
          { key: `pages:${part}`, label: t(`customize.pages.${part}`), icon: icons[part], hideId: hid.pages(part) },
          ...(part === "workspace"
            ? tops.map((n) => ({ key: n.id, label: n.title.trim() || t("customize.pages.untitled"), icon: <PageIcon icon={n.icon} kind={n.kind} />, hideId: hid.wikiPage(n.id), row: { kind: "wiki_page", id: n.id } as OwnRow, depth: 1 }))
            : part === "teamspaces"
              ? spaces.map((x) => ({ key: x.id, label: x.name, icon: <TeamDot team={x} />, hideId: hid.wikiSpace(x.id), row: { kind: "wiki_space", id: x.id } as OwnRow, depth: 1 }))
              : []),
        ]);
      }
      case "workspace":
        return [
          { key: "contacts", label: tShell("nav.contacts"), icon: <Users />, hideId: hid.page("contacts"), row: { kind: "page", id: "contacts" } },
          { key: "knowledge", label: tShell("nav.kb"), icon: <BookOpen />, hideId: hid.page("knowledge"), row: { kind: "page", id: "knowledge" } },
          { key: "wiki", label: tShell("nav.wiki"), icon: <NotebookText />, hideId: hid.page("wiki"), row: { kind: "page", id: "wiki" } },
          { key: "reports", label: tShell("nav.reports"), icon: <BarChart3 />, hideId: hid.page("reports"), row: { kind: "page", id: "reports" } },
        ];
    }
  };

  // Favorites list: what each pin points at, by name.
  const pinLabel = (p: SidebarPin): string | null => {
    switch (p.kind) {
      case "box":
        // Mail favorites are Collab's: without it they stay saved but are not listed.
        return collab && isMailBox(p.id) ? (p.id === "inbox" ? t("nav.allInboxes") : t(`box.${p.id}`)) : null;
      case "account": {
        const a = accounts?.find((x) => x.id === p.id);
        return a ? accountName(a) : null;
      }
      case "folder": {
        const f = Object.values(folderMap).flatMap((x) => x ?? []).find((x) => x.id === p.id);
        return f ? f.name : null;
      }
      case "view":
        return views?.find((v) => v.id === p.id)?.name ?? null;
      case "view_section":
        return findSection(views ?? [], p.id)?.name ?? null;
      case "team":
        return teams.team(p.id)?.name ?? null;
      case "ticket_folder": {
        const folder = folderById(p.id);
        return folder ? tNav(folder.labelKey) : null;
      }
      default:
        return null;
    }
  };
  const livePinned = prefs.pinned.filter((p) => pinLabel(p));

  return { itemsOf, pinLabel, livePinned };
}

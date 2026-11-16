// One sidebar row from what it names: a favorite, a single Space row of the open workspace,
// or a row of another workspace. buildRow turns a {kind, id} and that workspace's data into
// a row model (label, icon, numbers, link); NavItemRow draws it the way the sidebar's own
// rows look. A row of another workspace opens its page there: the focus moves first, and
// what the cache holds of it shows at once (lib/workspaces.ts useOpenInWorkspace). An
// everywhere row (assigned to me, all mail) spans every workspace and opens its list.

import { Link, useRouterState, type NavigateOptions } from "@tanstack/react-router";
import { BarChart3, BookOpen, CircleCheck, CircleDashed, Clock, FileText, Inbox, Layers, Lock, Mails, NotebookText, ShieldAlert, User, UserCheck, Users } from "lucide-react";
import { forwardRef, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ActivePill, Count, givesWay, Label, markOpener, NavTip, rowActive, rowBase, rowIdle, rowShape, useOpener, WaitingBadge } from "@/app/sidebarParts";
import { AccountTags } from "@/components/collab/AccountTags";
import { AccountDot, boxIcon, FolderGlyph } from "@/components/collab/bits";
import { TeamDot } from "@/components/tickets/teams";
import { ViewIcon, viewName } from "@/components/tickets/ViewIcon";
import { Tooltip } from "@/components/ui/tooltip";
import { WorkspaceBadge } from "@/components/workspaces/WorkspaceBadge";
import type { WaitingScope } from "@/components/tickets/useUrgentChats";
import type { MailBox, SidebarBadge, SidebarPrefs, SidebarSectionId, WikiArea, WorkspaceOverview } from "@/lib/api/types";
import { pageTo } from "@/lib/wiki/area";
import { accountNumbers, allInboxNumbers, boxTabNumbers, folderNumbers, listBoxNumbers, ticketRowNumbers } from "@/lib/collab/badges";
import { accountView, useAccountViews } from "@/lib/collab/accountView";
import { accountName, isMailBox, isTabBox, type MailSearch } from "@/lib/collab/boxes";
import { badgeFor, hid, pickCount, type BadgeKind, type BadgeNumbers, type MailBadge, type TicketBadge } from "@/lib/collab/sidebarPrefs";
import { cn } from "@/lib/cn";
import { folderById, type FolderId, type TeamTab } from "@/lib/folders";
import { canSeeTeam, type WorkspaceData } from "@/lib/spaces/hooks";
import { isEverywhereList, isSpacePage, type EverywhereList, type SpacePage } from "@/lib/spaces/model";
import { useOpenInWorkspace } from "@/lib/workspaces";
import { useCollab } from "@/lib/collab/hooks";

export type RowLink =
  | { kind: "inbox"; folder: FolderId; mailbox?: string }
  /** With `tab` (undefined for Unassigned), one of the team inbox's tabs, lit apart from the others. */
  | { kind: "team"; teamId: string; tab?: TeamTab }
  | { kind: "view"; viewId: string }
  | { kind: "mail"; box: MailBox | "folder"; account?: string; folder?: string }
  | { kind: "page"; page: SpacePage }
  | { kind: "wiki"; pageId: string; area?: WikiArea }
  | { kind: "everywhere"; list: EverywhereList };

const pagePaths: Record<SpacePage, string> = { contacts: "/contacts", knowledge: "/kb", wiki: "/wiki", reports: "/reports" };
const pageLabels = { contacts: "nav.contacts", knowledge: "nav.kb", wiki: "nav.wiki", reports: "nav.reports" } as const satisfies Record<SpacePage, string>;

/** The app URL a row opens; with `ws`, in that workspace (web/src/lib/workspaceParam.ts). */
export function rowHref(l: RowLink, ws?: string): string {
  const p = new URLSearchParams();
  let path: string;
  switch (l.kind) {
    case "inbox":
      path = `/inbox/${l.folder}`;
      if (l.mailbox) p.set("mailbox", l.mailbox);
      break;
    case "team":
      path = `/teams/${encodeURIComponent(l.teamId)}`;
      if (l.tab) p.set("tab", l.tab);
      break;
    case "view":
      path = `/views/${encodeURIComponent(l.viewId)}`;
      break;
    case "mail":
      path = `/mail/${l.box}`;
      if (l.account) p.set("account", l.account);
      if (l.folder) p.set("folder", l.folder);
      break;
    case "page":
      path = pagePaths[l.page];
      break;
    case "wiki":
      path = `/wiki/${encodeURIComponent(l.pageId)}`;
      break;
    case "everywhere":
      path = `/everywhere/${l.list}`;
      break;
  }
  if (ws) p.set("ws", ws);
  const qs = p.toString();
  return qs ? `${path}?${qs}` : path;
}

/** Where a row goes, as router navigation (a row of another workspace moves the focus first). */
export function rowNavigate(l: RowLink): NavigateOptions {
  switch (l.kind) {
    case "inbox":
      return { to: "/inbox/$folder/{-$ticketId}", params: { folder: l.folder, ticketId: undefined }, search: { mailbox: l.mailbox } } as NavigateOptions;
    case "team":
      return { to: "/teams/$teamId/{-$ticketId}", params: { teamId: l.teamId, ticketId: undefined }, search: { tab: l.tab } } as NavigateOptions;
    case "view":
      return { to: "/views/$viewId/{-$ticketId}", params: { viewId: l.viewId, ticketId: undefined } } as NavigateOptions;
    case "mail":
      return { to: "/mail/$box/{-$threadId}", params: { box: l.box, threadId: undefined }, search: { account: l.account, folder: l.folder } } as NavigateOptions;
    case "page":
      return (l.page === "contacts" ? { to: "/contacts/{-$contactId}", params: { contactId: undefined } } : { to: pagePaths[l.page] }) as NavigateOptions;
    case "wiki":
      return pageTo({ id: l.pageId, area: l.area }) as NavigateOptions;
    case "everywhere":
      return { to: "/everywhere/$list", params: { list: l.list } } as NavigateOptions;
  }
}

export type RowModel = {
  /** Its badge and hidden key: ticket_folder:<id>, team:<id>, view:<id>, box:<box>, account:<id>, folder:<id>, page:<id>. */
  key: string;
  label: string;
  icon: ReactNode;
  title?: string;
  /** The number it can show: its kind, the sections it follows, what it showed before anyone chose, and every number. */
  badge?: { kind: BadgeKind; sections: SidebarSectionId[]; fallback?: MailBadge | TicketBadge; nums: BadgeNumbers };
  link: RowLink;
  /** Mail rows know from the URL whether they are open; the other rows ask the router. */
  active?: boolean;
  /** Visitors waiting in chat on its tickets with nobody on them. */
  waiting?: number;
  /** The rail's dot: unread mail, or a count above zero. */
  railDot?: "unread" | "count";
  locked?: boolean;
  /** Beside the label, before the numbers (an account's Away and addresses pills). */
  tag?: ReactNode;
};

export const ticketFolderIcons: Record<FolderId, ReactNode> = {
  unassigned: <CircleDashed />,
  mine: <User />,
  open: <Inbox />,
  pending: <Clock />,
  solved: <CircleCheck />,
  spam: <ShieldAlert />,
};

export const pageIcons: Record<SpacePage, ReactNode> = { contacts: <Users />, knowledge: <BookOpen />, wiki: <NotebookText />, reports: <BarChart3 /> };
export const everywhereIcons: Record<EverywhereList, ReactNode> = { mine: <UserCheck />, mail: <Mails /> };

const dotIcon = (n: ReactNode) => <span className="flex size-[15px] shrink-0 items-center justify-center">{n}</span>;

/** The words rows are named with. */
export type RowLabels = {
  folder: (id: FolderId) => string;
  box: (box: MailBox) => string;
  allInboxes: string;
  myTeams: string;
  page: (p: SpacePage) => string;
  /** A wiki page without a title. */
  untitled: string;
  section: (id: SidebarSectionId, collabEnabled?: boolean) => string;
  everywhere: (list: EverywhereList) => string;
};

export function useRowLabels(): RowLabels {
  const { t: tNav } = useTranslation("navigation");
  const { t: tShell } = useTranslation("shell");
  const { t: tc } = useTranslation("collab");
  const { t: tw } = useTranslation("workspaces");
  const { t: tWiki } = useTranslation("wiki");
  const collab = useCollab();
  return {
    everywhere: (l) => (l === "mine" ? tw("everywhere.mineTitle") : tw("everywhere.mailTitle")),
    folder: (id) => {
      const f = folderById(id);
      return f ? tNav(f.labelKey) : id;
    },
    box: (b) => tc(`box.${b}`),
    allInboxes: tc("nav.allInboxes"),
    myTeams: tShell("nav.myTeams"),
    page: (p) => tShell(pageLabels[p]),
    untitled: tWiki("untitled"),
    section: (id, collabEnabled = collab.enabled) =>
      id === "favorites"
        ? tc("nav.favorites")
        : id === "mail"
          ? tc("nav.mail")
          : id === "inbox"
            ? tShell(collabEnabled ? "nav.tickets" : "nav.inbox")
            : id === "teams"
              ? tShell("nav.teams")
              : id === "views"
                ? tShell("nav.views")
                : id === "pages"
                  ? tShell("nav.pages")
                  : tShell("nav.workspace"),
  };
}

export type MailHere = { box: string | null; account?: string; folder?: string };

/** Where the mail page is: its box, account and folder, from the URL. */
export function useMailLocation(): MailHere {
  // Account rows read the view each account opens on: they follow a change to it.
  useAccountViews();
  const href = useRouterState({ select: (s) => (s.location.pathname.startsWith("/mail/") ? `${s.location.pathname}|${(s.location.search as MailSearch).account ?? ""}|${(s.location.search as MailSearch).folder ?? ""}` : "") });
  if (!href) return { box: null };
  const [path, account, folder] = href.split("|");
  return { box: path.split("/")[2] ?? null, account: account || undefined, folder: folder || undefined };
}

export type RowContext = {
  labels: RowLabels;
  /** Sections a row's number follows before its own (Favorites: ["favorites"]). */
  via?: SidebarSectionId[];
  /** The open mail page (open workspace only). */
  here?: MailHere;
  waiting?: (scope: WaitingScope) => number;
};

/**
 * An everywhere row: its list's number added up over the workspaces it gathers (the
 * overview's), tickets assigned to the person or unread mail in their inboxes.
 */
export function buildEverywhereRow(list: string, labels: RowLabels, overview: WorkspaceOverview[]): RowModel | null {
  if (!isEverywhereList(list)) return null;
  const live = overview.filter((o) => !o.suspended);
  const sum = (f: (o: WorkspaceOverview) => number | undefined) => (overview.length ? live.reduce((n, o) => n + (f(o) ?? 0), 0) : undefined);
  return {
    key: `everywhere:${list}`,
    label: labels.everywhere(list),
    icon: everywhereIcons[list],
    badge:
      list === "mine"
        ? { kind: "ticket", sections: [], nums: { count: sum((o) => o.ticket_counts?.mine) } }
        : { kind: "mail", sections: [], nums: { unread: sum((o) => o.mail_counts?.boxes.inbox) } },
    link: { kind: "everywhere", list },
    railDot: list === "mail" ? "unread" : undefined,
  };
}

/**
 * A row's model, or null when what it names is gone, not visible, or needs Collab the
 * workspace lacks (it is skipped, never removed).
 */
export function buildRow(item: { kind: string; id: string }, d: WorkspaceData, ctx: RowContext): RowModel | null {
  const via = ctx.via ?? [];
  const here = d.open ? ctx.here : undefined;
  const hidden = new Set(d.prefs.hidden);
  // Tickets off: its folders, teams, views and the reports are not there to pin or open.
  if (!d.tickets && (item.kind === "ticket_folder" || item.kind === "team" || item.kind === "view" || (item.kind === "page" && item.id === "reports"))) return null;
  switch (item.kind) {
    case "ticket_folder": {
      const f = folderById(item.id);
      if (!f) return null;
      const key = hid.ticketFolder(f.id);
      const counted = f.id !== "solved" && f.id !== "spam";
      return {
        key,
        label: ctx.labels.folder(f.id),
        icon: ticketFolderIcons[f.id],
        badge: counted ? { kind: "ticket", sections: [...via, "inbox"], nums: ticketRowNumbers(d.counts, key) } : undefined,
        link: { kind: "inbox", folder: f.id },
        waiting: ctx.waiting?.({ kind: "ticket_folder", id: f.id }),
        railDot: f.id === "unassigned" ? "count" : undefined,
      };
    }
    case "team": {
      const key = hid.team(item.id);
      if (item.id === "mine") {
        if (!d.myTeams.size) return null;
        return {
          key,
          label: ctx.labels.myTeams,
          icon: <Users />,
          badge: { kind: "team", sections: [...via, "teams"], nums: ticketRowNumbers(d.counts, key) },
          link: { kind: "team", teamId: "mine" },
          waiting: ctx.waiting?.({ kind: "team", id: "mine" }),
          railDot: "count",
        };
      }
      const team = d.teams?.find((x) => x.id === item.id);
      if (!team || !canSeeTeam(d, team)) return null;
      return {
        key,
        label: team.name,
        icon: dotIcon(<TeamDot team={team} />),
        badge: { kind: "team", sections: [...via, "teams"], nums: ticketRowNumbers(d.counts, key) },
        link: { kind: "team", teamId: team.id },
        waiting: ctx.waiting?.({ kind: "team", id: team.id }),
        railDot: "count",
        locked: team.private,
      };
    }
    case "mailbox": {
      // A ticket inbox opens its Unassigned folder; one removed is skipped.
      const m = d.mailboxes?.find((x) => x.id === item.id);
      if (!m) return null;
      const key = `mailbox:${m.id}`;
      return {
        key,
        label: m.name || m.email,
        title: m.email,
        icon: <Inbox />,
        badge: { kind: "ticket", sections: [...via, "inbox"], nums: ticketRowNumbers(d.counts, key) },
        link: { kind: "inbox", folder: "unassigned", mailbox: m.id },
        railDot: "count",
      };
    }
    case "view": {
      const v = d.views?.find((x) => x.id === item.id);
      if (!v) return null;
      const key = hid.view(v.id);
      return {
        key,
        label: viewName(v),
        icon: <ViewIcon icon={v.icon} />,
        badge: { kind: "ticket", sections: [...via, "views"], nums: ticketRowNumbers(d.counts, key) },
        link: { kind: "view", viewId: v.id },
        waiting: ctx.waiting?.({ kind: "view", id: v.id }),
      };
    }
    case "page": {
      if (!isSpacePage(item.id)) return null;
      return { key: `page:${item.id}`, label: ctx.labels.page(item.id), icon: pageIcons[item.id], link: { kind: "page", page: item.id } };
    }
    case "wiki_page": {
      // A page in the trash, deleted or out of the person's sight is skipped.
      const n = d.wiki?.find((x) => x.id === item.id);
      if (!n) return null;
      return { key: `wiki_page:${n.id}`, label: n.title.trim() || ctx.labels.untitled, icon: <WikiPageGlyph icon={n.icon} />, link: { kind: "wiki", pageId: n.id, area: n.area } };
    }
    case "wiki_space": {
      // A teamspace shows while its team is in sight and has pages the person sees.
      const team = d.teams?.find((x) => x.id === item.id);
      if (!team || !canSeeTeam(d, team) || !d.wiki?.some((n) => n.team_id === team.id)) return null;
      return { key: hid.wikiSpace(team.id), label: team.name, icon: dotIcon(<TeamDot team={team} />), link: { kind: "page", page: "wiki" }, locked: team.private };
    }
    case "box": {
      if (!d.collab || !isMailBox(item.id)) return null;
      const box = item.id;
      const key = hid.box(box);
      const accounts = d.accounts ?? [];
      const shownAccounts = accounts.filter((a) => !hidden.has(hid.account(a.id)));
      const nums =
        box === "inbox"
          ? allInboxNumbers(shownAccounts, d.folders, d.mailCounts)
          : box === "shared" || box === "assigned"
            ? listBoxNumbers(box, d.mailCounts)
            : isTabBox(box)
              ? boxTabNumbers(box, accounts, d.folders, d.mailCounts, true)
              : {};
      // Inbox, Unread, Shared and Assigned showed their count before anyone chose; the other boxes nothing.
      const fallback = box === "inbox" || box === "shared" || box === "assigned" || box === "unread" ? undefined : "none";
      return {
        key,
        label: box === "inbox" ? ctx.labels.allInboxes : ctx.labels.box(box),
        icon: box === "inbox" ? <Layers /> : boxIcon[box],
        badge: { kind: "mail", sections: [...via, "mail"], fallback, nums },
        link: { kind: "mail", box },
        active: !!here && here.box === box && !here.account && !here.folder,
        railDot: "unread",
      };
    }
    case "account": {
      if (!d.collab) return null;
      const a = d.accounts?.find((x) => x.id === item.id);
      if (!a) return null;
      return {
        key: hid.account(a.id),
        label: accountName(a),
        title: a.email,
        icon: dotIcon(<AccountDot color={a.color} className="size-2.5" />),
        tag: <AccountTags account={a} />,
        badge: { kind: "mail", sections: [...via, "mail"], nums: accountNumbers(a, d.folders[a.id], d.mailCounts) },
        // Inbox or Unread, whichever was used last for the account (GH#523).
        link: { kind: "mail", box: accountView(a.id, here), account: a.id },
        active: !!here && here.box === accountView(a.id, here) && here.account === a.id && !here.folder,
        railDot: "unread",
      };
    }
    case "folder": {
      if (!d.collab) return null;
      const f = Object.values(d.folders)
        .flatMap((x) => x ?? [])
        .find((x) => x.id === item.id);
      if (!f) return null;
      return {
        key: hid.folder(f.id),
        label: f.name,
        title: f.path,
        icon: <FolderGlyph folder={f} />,
        badge: { kind: "mail", sections: [...via, "mail"], nums: folderNumbers(f, d.mailCounts) },
        link: { kind: "mail", box: "folder", folder: f.id, account: f.account_id },
        active: !!here && here.folder === f.id,
        railDot: "unread",
      };
    }
    default:
      return null;
  }
}

/** The number a row shows: its own choice in the Space (`own`), else the workspace's choice for it or its sections, else its default. */
export function rowNumber(model: RowModel, prefs: SidebarPrefs, own?: SidebarBadge): { n: number | undefined; choice: MailBadge | TicketBadge | undefined } {
  const b = model.badge;
  if (!b) return { n: undefined, choice: undefined };
  const p = own ? { ...prefs, badges: { ...prefs.badges, [model.key]: own } } : prefs;
  const choice = badgeFor(p, model.key, b.sections, b.kind, b.fallback);
  return { n: pickCount(choice, b.nums), choice };
}

const activeLink = { className: rowActive, "data-status": "active" } as Record<string, string>;

/** The row's link: the router's own in the open workspace, a plain one that opens another workspace otherwise. */
type AnchorProps = {
  link: RowLink;
  ws?: string;
  className: string;
  label?: string;
  title?: string;
  active?: boolean;
  /** Another row of the same target was the one clicked: this one does not light up (app/sidebarParts.tsx). */
  away?: boolean;
  children: (active: boolean) => ReactNode;
} & Omit<React.HTMLAttributes<HTMLAnchorElement>, "children" | "title">;

/** What a row opens, as the sidebar's opener names it ("view:<id>", "wiki_page:<id>"). */
export function rowTarget(l: RowLink): string {
  switch (l.kind) {
    case "inbox":
      return l.mailbox ? `mailbox:${l.mailbox}:${l.folder}` : `ticket_folder:${l.folder}`;
    case "team":
      return l.tab ? `team:${l.teamId}:${l.tab}` : `team:${l.teamId}`;
    case "view":
      return `view:${l.viewId}`;
    case "mail":
      return `mail:${l.box}:${l.account ?? ""}:${l.folder ?? ""}`;
    case "page":
      return `page:${l.page}`;
    case "wiki":
      return `wiki_page:${l.pageId}`;
    case "everywhere":
      return `everywhere:${l.list}`;
  }
}

const RowAnchor = forwardRef<HTMLAnchorElement, AnchorProps>(function RowAnchor({ link, ws, className, label, title, active, away, children, ...rest }, ref) {
  const openIn = useOpenInWorkspace();
  const common = { ref, className, "aria-label": label, title, ...rest };
  if (ws) {
    const href = rowHref(link, ws);
    return (
      <a
        href={href}
        {...common}
        onClick={(e) => {
          rest.onClick?.(e);
          if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
          e.preventDefault();
          openIn(ws, rowNavigate(link));
        }}
      >
        {children(false)}
      </a>
    );
  }
  const lit = away ? undefined : activeLink;
  const fn = ({ isActive }: { isActive: boolean }) => children(isActive && !away);
  switch (link.kind) {
    case "inbox":
      // A folder of one ticket inbox (?mailbox=) and the folder of every inbox light up apart.
      return (
        <Link
          to="/inbox/$folder/{-$ticketId}"
          params={{ folder: link.folder, ticketId: undefined }}
          search={{ mailbox: link.mailbox }}
          activeOptions={{ explicitUndefined: true }}
          activeProps={lit}
          {...common}
        >
          {fn}
        </Link>
      );
    case "team":
      return (
        <Link
          to="/teams/$teamId/{-$ticketId}"
          params={{ teamId: link.teamId, ticketId: undefined }}
          search={"tab" in link ? { tab: link.tab } : undefined}
          activeOptions={"tab" in link ? { explicitUndefined: true } : undefined}
          activeProps={lit}
          {...common}
        >
          {fn}
        </Link>
      );
    case "view":
      return (
        <Link to="/views/$viewId/{-$ticketId}" params={{ viewId: link.viewId, ticketId: undefined }} activeProps={lit} {...common}>
          {fn}
        </Link>
      );
    case "page":
      return link.page === "contacts" ? (
        <Link to="/contacts/{-$contactId}" params={{ contactId: undefined }} activeProps={lit} {...common}>
          {fn}
        </Link>
      ) : (
        <Link to={pagePaths[link.page] as "/kb" | "/wiki" | "/reports"} activeProps={lit} {...common}>
          {fn}
        </Link>
      );
    case "wiki":
      return (
        <Link {...pageTo({ id: link.pageId, area: link.area })} activeProps={lit} {...common}>
          {fn}
        </Link>
      );
    case "everywhere":
      return (
        <Link to="/everywhere/$list" params={{ list: link.list }} activeProps={lit} {...common}>
          {fn}
        </Link>
      );
    case "mail":
      return (
        <Link
          to="/mail/$box/{-$threadId}"
          params={{ box: link.box, threadId: undefined }}
          search={{ account: link.account, folder: link.folder }}
          data-status={active && !away ? "active" : undefined}
          aria-current={active ? "page" : undefined}
          {...common}
          className={cn(className, active && !away && rowActive)}
        >
          {children(!!active && !away)}
        </Link>
      );
  }
});

/** The small badge of another workspace beside a row or section title, "In Lumen Labs" on hover. */
export function InWorkspace({ name, logo }: { name: string; logo: string | null }) {
  const { t } = useTranslation("workspaces");
  const label = t("badge.in", { name });
  return (
    <Tooltip content={label}>
      <span className="flex shrink-0">
        <WorkspaceBadge name={name} logo={logo} size="xs" decorative />
        <span className="sr-only">{label}</span>
      </span>
    </Tooltip>
  );
}

/**
 * One row as the sidebar draws its own: icon, name, waiting chats, its number, the rail's
 * dot. `menu` wraps the link (a RowMenu or a Space row menu); `mark` is its workspace's mark.
 */
export function NavItemRow({
  model,
  rail,
  prefs,
  own,
  label,
  ws,
  mark,
  menu,
  nested,
  emoji,
  place,
}: {
  model: RowModel;
  rail: boolean;
  /** The row's workspace's prefs, for the number it follows. */
  prefs: SidebarPrefs;
  /** The number chosen for it in the Space. */
  own?: SidebarBadge;
  /** The name given to it in the Space. */
  label?: string;
  /** Another workspace: the row opens there. */
  ws?: string;
  mark?: ReactNode;
  menu?: (row: ReactElement) => ReactElement;
  /** Indented under a view section's header (app/ViewSectionGroup.tsx). */
  nested?: boolean;
  /** The emoji the person gave the row, in place of its icon. */
  emoji?: string;
  /** Where the row sits ("favorites", "section:<id>"): clicked, it lights up alone among rows of the same target. */
  place?: string;
}) {
  const { t } = useTranslation("shell");
  const who = useOpener();
  const target = rowTarget(model.link);
  // The person's own name and emoji: the row's in its section first, then the sidebar's for that row.
  const name = label || prefs.names[model.key] || model.label;
  const glyph = emoji ?? prefs.icons[model.key];
  const { n, choice } = rowNumber(model, prefs, own);
  // Mail and team rows show a number above zero; inbox folders and views show their count, zero too.
  const count = n !== undefined && (model.badge?.kind === "ticket" || n > 0) ? n : undefined;
  const dot = rail && (model.railDot === "unread" ? choice !== "none" && !!model.badge?.nums.unread : model.railDot === "count" ? (n ?? 0) > 0 : false);
  const link = (
    <RowAnchor
      link={model.link}
      ws={ws}
      active={model.active}
      away={place ? givesWay(who, target, place) : false}
      onClick={place ? () => markOpener(target, place) : undefined}
      className={cn(rowBase, rowShape(rail), rowIdle, nested && "pl-[22px]")}
      label={rail ? name : undefined}
      title={rail ? undefined : (model.title ?? (label ? model.label : undefined))}
    >
      {(active) => (
        <>
          {active && <ActivePill />}
          {glyph ? <RowEmoji emoji={glyph} /> : model.icon}
          <Label rail={rail}>
            <span className="flex min-w-0 items-center gap-1">
              <span className="truncate">{name}</span>
              {model.locked && <Lock aria-label={t("nav.privateTeam")} className="size-[11px] shrink-0 text-fg-4" />}
            </span>
          </Label>
          {!rail && model.tag}
          {mark && !rail && <span className="flex shrink-0">{mark}</span>}
          <WaitingBadge n={model.waiting ?? 0} rail={rail} />
          <Count n={count} rail={rail} />
          {dot && <span className="absolute right-1 top-1 size-1.5 rounded-full bg-fg ring-2 ring-chrome" />}
        </>
      )}
    </RowAnchor>
  );
  return (
    <NavTip rail={rail} label={name}>
      {menu ? menu(link) : link}
    </NavTip>
  );
}

/** An emoji where a row has its icon, the icon's size. */
export function RowEmoji({ emoji }: { emoji: string }) {
  return (
    <span aria-hidden className="flex size-[15px] shrink-0 items-center justify-center text-[13px] leading-none">
      {emoji}
    </span>
  );
}

/** A wiki page's emoji where the other rows have an icon, or the page glyph. */
function WikiPageGlyph({ icon }: { icon: string }) {
  return icon ? (
    <span className="flex size-[15px] items-center justify-center text-[13px] leading-none" aria-hidden>
      {icon}
    </span>
  ) : (
    <FileText />
  );
}

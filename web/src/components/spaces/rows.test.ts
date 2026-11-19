import { describe, expect, it } from "vitest";
import type { MailAccount, Mailbox, Team, TicketCounts, View, WorkspaceOverview } from "@/lib/api/types";
import { defaultSidebarPrefs } from "@/lib/collab/sidebarPrefs";
import type { WorkspaceData } from "@/lib/spaces/hooks";
import { buildEverywhereRow, buildRow, rowHref, rowNavigate, rowNumber, type RowContext, type RowLabels } from "./rows";

const labels: RowLabels = {
  folder: (id) => `folder ${id}`,
  box: (b) => `box ${b}`,
  allInboxes: "All inboxes",
  myTeams: "My teams",
  page: (p) => `page ${p}`,
  section: (id) => `section ${id}`,
  untitled: "Untitled",
  everywhere: (l) => `everywhere ${l}`,
};

const team = (id: string, p: Partial<Team> = {}) => ({ id, name: `Team ${id}`, color: "blue", private: false, member_ids: [], members: [], ...p }) as unknown as Team;
const counts = { unassigned: 4, mine: 2, open: 9, pending: 1, on_hold: 1, solved: 0, spam: 3, views: { v1: 7 }, teams: { t1: { open: 5, unassigned: 2 } }, stats: { "view:v1": { awaiting: 3, urgent: 1, overdue: 0 } } } as TicketCounts;

function data(p: Partial<WorkspaceData> = {}): WorkspaceData {
  return {
    id: "w1",
    name: "Lumen",
    logo: null,
    open: false,
    role: "agent",
    collab: true,
    tickets: true,
    prefs: defaultSidebarPrefs(),
    counts,
    teams: [team("t1"), team("secret", { private: true })],
    myTeams: new Set(["t1"]),
    views: [{ id: "v1", name: "Hot", shared: true, filters: {}, position: 0 } as View],
    mailboxes: [{ id: "m1", name: "Support", email: "support@lumen.test" } as Mailbox],
    accounts: [{ id: "a1", name: "Work", email: "[EMAIL]", color: "blue", unread: 2 } as MailAccount],
    mailCounts: { boxes: { inbox: 6, unread: 6, shared: 1, assigned: 0, drafts: 0, needs_action: 0 }, assigned: {}, accounts: { a1: 5 }, folders: {} },
    folders: {},
    wiki: [{ id: "w1", parent_id: null, title: "Runbook", icon: "📘", position: 0, version: 1, updated_at: "", created_by_id: null, tags: [] }],
    ...p,
  };
}

describe("Space rows", () => {
  it("builds no ticket row while the workspace has Tickets off", () => {
    const ctx = { labels } as RowContext;
    const off = data({ tickets: false });
    for (const item of [{ kind: "ticket_folder", id: "mine" }, { kind: "team", id: "t1" }, { kind: "view", id: "v1" }, { kind: "page", id: "reports" }])
      expect(buildRow(item, off, ctx)).toBeNull();
    expect(buildRow({ kind: "page", id: "wiki" }, off, ctx)).not.toBeNull();
    expect(buildRow({ kind: "ticket_folder", id: "mine" }, data(), ctx)).not.toBeNull();
  });

  it("opens another workspace's page with ?ws=", () => {
    expect(rowHref({ kind: "inbox", folder: "mine" }, "w1")).toBe("/inbox/mine?ws=w1");
    expect(rowHref({ kind: "team", teamId: "t1" })).toBe("/teams/t1");
    expect(rowHref({ kind: "view", viewId: "v1" }, "w1")).toBe("/views/v1?ws=w1");
    expect(rowHref({ kind: "mail", box: "folder", account: "a1", folder: "f1" }, "w1")).toBe("/mail/folder?account=a1&folder=f1&ws=w1");
    expect(rowHref({ kind: "page", page: "knowledge" }, "w1")).toBe("/kb?ws=w1");
    expect(rowHref({ kind: "page", page: "contacts" })).toBe("/contacts");
    expect(rowHref({ kind: "page", page: "wiki" }, "w1")).toBe("/wiki?ws=w1");
    expect(rowHref({ kind: "wiki", pageId: "p1" }, "w1")).toBe("/wiki/p1?ws=w1");
  });

  it("names a wiki page by its live title and skips one out of sight", () => {
    const d = data();
    expect(buildRow({ kind: "wiki_page", id: "w1" }, d, { labels })).toMatchObject({ key: "wiki_page:w1", label: "Runbook", link: { kind: "wiki", pageId: "w1" } });
    expect(buildRow({ kind: "wiki_page", id: "gone" }, d, { labels })).toBeNull();
    expect(buildRow({ kind: "wiki_page", id: "w1" }, data({ wiki: undefined }), { labels })).toBeNull();
  });

  it("opens a ticket inbox at its Unassigned folder, numbered from its own counts", () => {
    const withCounts = { ...counts, mailboxes: { m1: { unassigned: 3, mine: 1, open: 2, pending: 0 } } } as TicketCounts;
    const model = buildRow({ kind: "mailbox", id: "m1" }, data({ counts: withCounts }), { labels });
    expect(model).toMatchObject({ key: "mailbox:m1", label: "Support", link: { kind: "inbox", folder: "unassigned", mailbox: "m1" } });
    expect(rowNumber(model!, defaultSidebarPrefs()).n).toBe(3);
    // An inbox without open tickets is left out of the counts: zero, not unknown.
    expect(rowNumber(buildRow({ kind: "mailbox", id: "m1" }, data({ counts: { ...counts, mailboxes: {} } }), { labels })!, defaultSidebarPrefs()).n).toBe(0);
    expect(buildRow({ kind: "mailbox", id: "gone" }, data(), { labels })).toBeNull();
    expect(rowHref({ kind: "inbox", folder: "open", mailbox: "m1" }, "w1")).toBe("/inbox/open?mailbox=m1&ws=w1");
    expect(rowHref({ kind: "team", teamId: "t1", tab: "pending" })).toBe("/teams/t1?tab=pending");
  });

  it("shows a teamspace while its team is in sight and has pages", () => {
    const page = { id: "p2", parent_id: null, title: "Billing runbook", icon: "", position: 0, version: 1, updated_at: "", created_by_id: null, tags: [], team_id: "t1" };
    const d = data({ wiki: [page] });
    expect(buildRow({ kind: "wiki_space", id: "t1" }, d, { labels })).toMatchObject({ key: "wiki_space:t1", label: "Team t1" });
    // A teamspace without pages, a team out of sight, and a team that is gone show nothing.
    expect(buildRow({ kind: "wiki_space", id: "t1" }, data(), { labels })).toBeNull();
    expect(buildRow({ kind: "wiki_space", id: "secret" }, data({ wiki: [{ ...page, team_id: "secret" }], myTeams: new Set() }), { labels })).toBeNull();
    expect(buildRow({ kind: "wiki_space", id: "gone" }, d, { labels })).toBeNull();
  });

  it("names and numbers each kind from the workspace's data", () => {
    const d = data();
    expect(buildRow({ kind: "ticket_folder", id: "unassigned" }, d, { labels })).toMatchObject({ key: "ticket_folder:unassigned", label: "folder unassigned", badge: { kind: "ticket", nums: { count: 4 } } });
    expect(buildRow({ kind: "ticket_folder", id: "solved" }, d, { labels })?.badge).toBeUndefined();
    expect(buildRow({ kind: "team", id: "t1" }, d, { labels })).toMatchObject({ label: "Team t1", badge: { kind: "team", nums: { count: 2, open: 5 } } });
    expect(buildRow({ kind: "view", id: "v1" }, d, { labels })).toMatchObject({ label: "Hot", badge: { nums: { count: 7, awaiting: 3, urgent: 1 } } });
    expect(buildRow({ kind: "box", id: "shared" }, d, { labels })).toMatchObject({ label: "box shared", badge: { kind: "mail", nums: { unread: 1 } } });
    // Mentions counts every conversation it lists, shown before anyone chooses.
    const mentions = buildRow({ kind: "box", id: "mentions" }, data({ mailCounts: { ...d.mailCounts!, boxes: { ...d.mailCounts!.boxes, mentions: 3 } } }), { labels });
    expect(mentions).toMatchObject({ key: "box:mentions", label: "box mentions", link: { kind: "mail", box: "mentions" } });
    expect(rowNumber(mentions!, d.prefs).n).toBe(3);
    expect(rowHref({ kind: "mail", box: "mentions" }, "w1")).toBe("/mail/mentions?ws=w1");
    expect(buildRow({ kind: "account", id: "a1" }, d, { labels })).toMatchObject({ label: "Work", badge: { nums: { unread: 5 } } });
    expect(buildRow({ kind: "page", id: "reports" }, d, { labels })).toMatchObject({ label: "page reports", link: { kind: "page", page: "reports" } });
  });

  it("skips what is gone, a private team the person is not on, and mail without Collab", () => {
    const d = data();
    expect(buildRow({ kind: "team", id: "nope" }, d, { labels })).toBeNull();
    expect(buildRow({ kind: "team", id: "secret" }, d, { labels })).toBeNull();
    expect(buildRow({ kind: "view", id: "gone" }, d, { labels })).toBeNull();
    expect(buildRow({ kind: "page", id: "billing" }, d, { labels })).toBeNull();
    expect(buildRow({ kind: "account", id: "a1" }, data({ collab: false }), { labels })).toBeNull();
    expect(buildRow({ kind: "box", id: "inbox" }, data({ collab: undefined }), { labels })).toBeNull();
    expect(buildRow({ kind: "section", id: "inbox" }, d, { labels })).toBeNull();
  });

  it("shows the Space's own number first, then the workspace's choice, then the default", () => {
    const d = data();
    const view = buildRow({ kind: "view", id: "v1" }, d, { labels })!;
    expect(rowNumber(view, d.prefs).n).toBe(7);
    expect(rowNumber(view, { ...d.prefs, badges: { "section:views": "awaiting" } }).n).toBe(3);
    expect(rowNumber(view, { ...d.prefs, badges: { "section:views": "awaiting" } }, "urgent").n).toBe(1);
    expect(rowNumber(view, d.prefs, "none").n).toBeUndefined();
    // A favorite reads Favorites' number first.
    const fav = buildRow({ kind: "view", id: "v1" }, d, { labels, via: ["favorites"] })!;
    expect(rowNumber(fav, { ...d.prefs, badges: { "section:favorites": "urgent", "section:views": "awaiting" } }).n).toBe(1);
  });

  it("adds up an everywhere row's number over the workspaces it gathers, a suspended one left out", () => {
    const o = (id: string, mine: number, inbox: number | null, suspended = false) =>
      ({ id, suspended, ticket_counts: { ...counts, mine }, mail_counts: inbox === null ? null : { boxes: { inbox, unread: inbox, shared: 0, assigned: 0, drafts: 0 }, assigned: {}, accounts: {}, folders: {} } }) as unknown as WorkspaceOverview;
    const list = [o("a", 2, 5), o("b", 3, null), o("c", 9, 9, true)];
    expect(buildEverywhereRow("mine", labels, list)).toMatchObject({ label: "everywhere mine", badge: { kind: "ticket", nums: { count: 5 } }, link: { kind: "everywhere", list: "mine" } });
    expect(buildEverywhereRow("mail", labels, list)?.badge?.nums).toEqual({ unread: 5 });
    expect(buildEverywhereRow("views", labels, list)).toBeNull();
    expect(rowHref({ kind: "everywhere", list: "mail" })).toBe("/everywhere/mail");
    expect(rowNavigate({ kind: "view", viewId: "v1" })).toMatchObject({ to: "/views/$viewId/{-$ticketId}", params: { viewId: "v1" } });
  });
});

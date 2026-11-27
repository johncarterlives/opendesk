import type { TicketListQuery } from "./api/endpoints";
import type { FieldFilter, TicketCounts } from "./api/types";

export type FolderId = "unassigned" | "mine" | "open" | "pending" | "solved" | "spam" | "all";

export type Folder = { id: FolderId; labelKey: `folders.${FolderId}`; query: TicketListQuery; count: (c: TicketCounts) => number | null };

const active = ["open", "pending", "on_hold"] as TicketListQuery["status"];

export const folders: Folder[] = [
  { id: "unassigned", labelKey: "folders.unassigned", query: { status: active, assignee: "none" }, count: (c) => c.unassigned },
  { id: "mine", labelKey: "folders.mine", query: { status: active, assignee: "me" }, count: (c) => c.mine },
  { id: "open", labelKey: "folders.open", query: { status: ["open"] }, count: (c) => c.open },
  { id: "pending", labelKey: "folders.pending", query: { status: ["pending", "on_hold"] }, count: (c) => c.pending + c.on_hold },
  { id: "solved", labelKey: "folders.solved", query: { status: ["solved", "closed"] }, count: () => null },
  { id: "spam", labelKey: "folders.spam", query: { spam: true }, count: (c) => c.spam },
];

/**
 * Every ticket but spam, whatever its status: where search's "See all" lists what it found
 * (?q=). Not a sidebar folder.
 */
export const allFolder: Folder = { id: "all", labelKey: "folders.all", query: {}, count: () => null };

export function folderById(id: string): Folder | undefined {
  return id === allFolder.id ? allFolder : folders.find((f) => f.id === id);
}

/** A team inbox's tabs (/teams/$teamId, where teamId may be "mine" for every team of the caller's). */
export type TeamTab = "unassigned" | "open" | "pending" | "all";
export const teamTabs: TeamTab[] = ["unassigned", "open", "pending", "all"];

export function teamQuery(teamId: string, tab: TeamTab | undefined): TicketListQuery {
  const team_id = teamId;
  switch (tab ?? "unassigned") {
    case "open":
      return { team_id, status: ["open"] };
    case "pending":
      return { team_id, status: ["pending", "on_hold"] };
    case "all":
      return { team_id };
    default:
      return { team_id, status: ["open", "pending"], assignee: "none" };
  }
}

export type InboxSearch = {
  sort?: TicketListQuery["sort"];
  order?: TicketListQuery["order"];
  priority?: string;
  severity?: string;
  channel?: string;
  tag?: string;
  mailbox?: string;
  /** The address a ticket was written to (a mailbox's address or an alias). */
  to?: string;
  /** Team filter: ids, "mine" and "none", joined by ",". */
  team?: string;
  brand?: string;
  /** The tab of a team inbox. */
  tab?: TeamTab;
  q?: string;
  /** Custom field filters, "key:op:value" joined by "|" (contracts/api.md field.<key>[op]=v). */
  fields?: string;
};

export type { FieldFilter } from "./api/types";
export function parseFieldFilters(s: string | undefined): FieldFilter[] {
  if (!s) return [];
  return s.split("|").flatMap((part) => {
    const [key, op, ...rest] = part.split(":");
    return key && op ? [{ key, op: op as FieldFilter["op"], value: rest.join(":") }] : [];
  });
}
export function encodeFieldFilters(f: FieldFilter[]): string | undefined {
  return f.length ? f.map((x) => `${x.key}:${x.op}:${x.value}`).join("|") : undefined;
}

/** The list query for a folder or view plus the user's filters and sort. */
export function listQuery(base: TicketListQuery, s: InboxSearch): TicketListQuery {
  const q: TicketListQuery = { ...base };
  if (s.sort) q.sort = s.sort;
  if (s.order) q.order = s.order;
  if (s.priority) q.priority = s.priority.split(",") as TicketListQuery["priority"];
  if (s.severity) q.severity = s.severity.split(",") as TicketListQuery["severity"];
  if (s.channel) q.channel = s.channel as TicketListQuery["channel"];
  if (s.tag) q.tag = s.tag;
  if (s.mailbox) q.mailbox_id = s.mailbox;
  if (s.to) q.received_at = s.to;
  // A team inbox is already one team (or the caller's teams).
  if (s.team && !base.team_id) q.team_id = s.team;
  if (s.brand) q.brand_id = s.brand;
  if (s.q) q.q = s.q;
  const ff = parseFieldFilters(s.fields);
  if (ff.length) q.fields = ff;
  return q;
}

export function parseInboxSearch(raw: Record<string, unknown>): InboxSearch {
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const sort = str(raw.sort);
  const order = str(raw.order);
  return {
    sort: sort === "created_at" || sort === "priority" || sort === "severity" || sort === "due" || sort === "last_message_at" ? sort : sort && /^field\.[a-z][a-z0-9_]{0,39}$/.test(sort) ? (sort as `field.${string}`) : undefined,
    order: order === "asc" || order === "desc" ? order : undefined,
    priority: str(raw.priority),
    severity: str(raw.severity),
    channel: str(raw.channel),
    tag: str(raw.tag),
    mailbox: str(raw.mailbox),
    to: str(raw.to),
    team: str(raw.team),
    brand: str(raw.brand),
    tab: teamTabs.includes(raw.tab as TeamTab) ? (raw.tab as TeamTab) : undefined,
    q: str(raw.q),
    fields: str(raw.fields),
  };
}

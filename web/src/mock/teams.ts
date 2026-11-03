// Teams, brands, widgets and routing in mock mode (contracts/teams.md): the
// rules every handler shares. Who may see a private team's tickets, the REST
// shapes with their computed fields, and the routing evaluator behind
// POST /v1/routing/test (also usable when a ticket is created).

import type {
  ApiKey,
  AssignMode,
  Brand,
  Channel,
  KbArticle,
  Role,
  RoutingCondition,
  RoutingRule,
  RoutingTest,
  Skill,
  Team,
  TeamRole,
  Ticket,
  TicketRouted,
  Webhook,
  Widget,
} from "@/lib/api/types";
import { defaultHelpUrl } from "@/lib/helpCenter";
import { db, userRef, type WsData } from "./db";

export const APP_ORIGIN = "https://app.opendesk.sh";

export function roleIn(ws: WsData, userId: string): Role {
  return ws.members.find((m) => m.user_id === userId)?.role ?? "viewer";
}
export const isAdmin = (ws: WsData, userId: string) => {
  const r = roleIn(ws, userId);
  return r === "owner" || r === "admin";
};

export function teamRole(team: Team, userId: string): TeamRole | null {
  return team.members.find((m) => m.user_id === userId)?.role ?? null;
}

/** Private teams the user may see: the ones they belong to, in any role. */
export function visiblePrivateTeamIds(ws: WsData, userId: string): string[] {
  return ws.teams.filter((t) => t.private && teamRole(t, userId)).map((t) => t.id);
}

/** contracts/teams.md "Visibility": a private team's tickets are for its members and the assignee. Admins are not exempt. */
export function canSeeTicket(ws: WsData, t: Pick<Ticket, "team_id" | "assignee">, userId = db.meId): boolean {
  if (!t.team_id) return true;
  const team = ws.teams.find((x) => x.id === t.team_id);
  if (!team?.private) return true;
  return !!teamRole(team, userId) || t.assignee?.id === userId;
}

/**
 * A key's or webhook's private teams become `ids` (already checked): the caller grants every
 * listed team they are on, and the others keep their granter (contracts/teams.md "Visibility").
 */
export function setGrants(ws: WsData, owner: ApiKey | Webhook, ids: string[], by = db.meId) {
  const prev = owner.private_teams ?? [];
  owner.private_team_ids = [...ids];
  owner.private_teams = ids
    .map((id) => {
      const team = ws.teams.find((x) => x.id === id)!;
      const granter = teamRole(team, by) ? userRef(by) : (prev.find((g) => g.id === id)?.granted_by ?? null);
      return { id, name: team.name, granted_by: granter };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A grant lasts while its granter is on the team, and the team is private: drop the rest
 * from every key and webhook. Returns the keys and webhooks that changed.
 */
export function dropLapsedGrants(ws: WsData): (ApiKey | Webhook)[] {
  const changed: (ApiKey | Webhook)[] = [];
  for (const o of [...ws.apiKeys, ...ws.webhooks]) {
    const keep = (o.private_team_ids ?? []).filter((id) => {
      const team = ws.teams.find((x) => x.id === id);
      const by = o.private_teams?.find((g) => g.id === id)?.granted_by;
      return !!team?.private && !!by && !!teamRole(team, by.id);
    });
    if (keep.length === (o.private_team_ids ?? []).length) continue;
    o.private_team_ids = keep;
    o.private_teams = (o.private_teams ?? []).filter((g) => keep.includes(g.id));
    changed.push(o);
  }
  return changed;
}

/** The private team an event about this ticket belongs to, if any (gateway routing). */
export function privateTeamOf(ws: WsData, ticketId: string | null | undefined): string | null {
  if (!ticketId) return null;
  const t = ws.tickets.find((x) => x.id === ticketId);
  const team = t?.team_id ? ws.teams.find((x) => x.id === t.team_id) : null;
  return team?.private ? team.id : null;
}

/** The team's rule in /v1/assignment, else null (the workspace default). */
export function teamAssignMode(ws: WsData, teamId: string): AssignMode | null {
  return ws.routing.rules.find((r) => r.target_type === "team" && r.target_id === teamId)?.mode ?? null;
}

export function setTeamAssignMode(ws: WsData, teamId: string, mode: AssignMode | null) {
  const rest = ws.routing.rules.filter((r) => !(r.target_type === "team" && r.target_id === teamId));
  ws.routing.rules = mode ? [...rest, { target_type: "team", target_id: teamId, mode }] : rest;
}

/** The full Team for the caller: counts and addresses computed; a private team's members only to its members and admins. */
export function teamOut(ws: WsData, team: Team, userId = db.meId): Team {
  const live = ws.tickets.filter((t) => t.team_id === team.id && !t.spam && !ws.deletedTickets.has(t.id));
  const hideMembers = team.private && !teamRole(team, userId) && !isAdmin(ws, userId);
  const members = hideMembers ? [] : team.members.map((m) => ({ ...m }));
  return {
    ...team,
    members,
    member_ids: members.map((m) => m.user_id),
    assign_mode: teamAssignMode(ws, team.id),
    mailbox_ids: ws.mailboxes.filter((m) => m.team_id === team.id).map((m) => m.id),
    open_count: live.filter((t) => t.status === "open").length,
    unassigned_count: live.filter((t) => (t.status === "open" || t.status === "pending") && !t.assignee).length,
  };
}

export function defaultBrand(ws: WsData): Brand | undefined {
  return ws.brands.find((b) => b.is_default) ?? ws.brands[0];
}

/** url is the active custom domain, else the default address (contracts/teams.md "Help center addresses"). */
export function helpCenterOut(b: Brand): Brand["help_center"] {
  const default_url = defaultHelpUrl(b.slug);
  const domain = b.help_center.domain ? structuredClone(b.help_center.domain) : null;
  return { ...b.help_center, url: domain?.status === "active" ? `https://${domain.hostname}` : default_url, default_url, domain };
}

/** A page of the brand's help center, as links in answers and the widget carry it. */
export const helpPageUrl = (b: Brand, path = "") => helpCenterOut(b).url + path;

/** An article on its brand's help center (its collection's brand, else its own), else the default brand's. */
export function articleUrl(ws: WsData, a: Pick<KbArticle, "slug" | "brand_id" | "collection_id">): string {
  const col = a.collection_id ? ws.collections.find((c) => c.id === a.collection_id) : undefined;
  const id = col?.brand_id ?? a.brand_id ?? null;
  const b = (id && ws.brands.find((x) => x.id === id)) || defaultBrand(ws);
  return b ? helpPageUrl(b, `/a/${a.slug}`) : `${defaultHelpUrl(ws.workspace.slug)}/a/${a.slug}`;
}

export function brandOut(ws: WsData, b: Brand): Brand {
  const boxes = ws.mailboxes
    .filter((m) => m.brand_id === b.id)
    .sort((x, y) => Date.parse(x.created_at) - Date.parse(y.created_at));
  return {
    ...b,
    help_center: helpCenterOut(b),
    images: { ...b.images },
    default_mailbox_id: (boxes.find((m) => m.status === "active") ?? boxes[0])?.id ?? null,
    mailbox_count: boxes.length,
    widget_count: ws.widgets.filter((w) => w.brand_id === b.id).length,
  };
}

/** The default brand's first widget: what /v1/widget/settings and workspace.widget_key still mean. */
export function legacyWidget(ws: WsData): Widget | undefined {
  const b = defaultBrand(ws);
  return ws.widgets.filter((w) => w.brand_id === b?.id).sort((x, y) => x.position - y.position)[0];
}

/** Keep `ws.widget` and `workspace.widget_key` pointing at the legacy widget. */
export function syncLegacyWidget(ws: WsData) {
  const w = legacyWidget(ws);
  if (!w) return;
  ws.widget = w.settings;
  ws.workspace.widget_key = w.key;
}

export function widgetSnippet(key: string): string {
  return `<script src="${APP_ORIGIN}/widget/v1.js" data-key="${key}" async></script>`;
}

export function widgetOut(_ws: WsData, w: Widget): Widget {
  return { ...w, settings: { ...w.settings, topics: w.settings.topics.map((x) => ({ ...x })) }, install: { snippet: widgetSnippet(w.key) } };
}

// ─── Routing ───────────────────────────────────────────────────────────────

export type RoutingInput = {
  channel: Extract<Channel, "email" | "chat"> | "api";
  to?: string;
  from?: string;
  subject?: string;
  body?: string;
  widget_id?: string;
  topic?: string;
  page_url?: string;
  contact_fields?: Record<string, unknown>;
};

const lc = (s: string | undefined) => (s ?? "").toLowerCase().trim();

/** The mailbox an address delivers into: its own address or one of its aliases. */
export function mailboxForAddress(ws: WsData, address: string | undefined) {
  const a = lc(address);
  if (!a) return undefined;
  return ws.mailboxes.find((m) => lc(m.email) === a || m.aliases.some((x) => lc(x) === a));
}

function compare(op: RoutingCondition["op"], actual: string, want: string): boolean {
  const a = lc(actual);
  const w = lc(want);
  switch (op) {
    case "equals":
      return a === w;
    case "not_equals":
      return a !== w;
    case "contains":
      return !!w && a.includes(w);
    case "not_contains":
      return !w || !a.includes(w);
    case "starts_with":
      return !!w && a.startsWith(w);
    case "gt":
      return Number(actual) > Number(want);
    case "lt":
      return Number(actual) < Number(want);
  }
}

type Facts = Record<string, string>;

/** One condition: true, false, or "unknown" for Ollie's decisions (never run by a test). */
function evalCondition(c: RoutingCondition, f: Facts, fields: Record<string, unknown>): boolean | "unknown" {
  if (c.field === "ai_decide") return "unknown";
  if (c.field.startsWith("contact.field.")) {
    const v = fields[c.field.slice("contact.field.".length)];
    return compare(c.op, v === undefined || v === null ? "" : String(v), c.value);
  }
  return compare(c.op, f[c.field] ?? "", c.value);
}

/** all/any over three-valued results: a decided false (all) or true (any) wins over unknown. */
export function ruleMatches(rule: RoutingRule, f: Facts, fields: Record<string, unknown> = {}): boolean | "unknown" {
  const results = rule.conditions.map((c) => evalCondition(c, f, fields));
  if (rule.match === "all") {
    if (results.some((r) => r === false)) return false;
    return results.some((r) => r === "unknown") ? "unknown" : true;
  }
  if (results.some((r) => r === true)) return true;
  return results.some((r) => r === "unknown") ? "unknown" : false;
}

/**
 * Where a new message like this would go (contracts/teams.md "Routing"): the
 * address or widget first, then the first enabled rule that matches. Rules
 * after an "unknown" (Ollie decides) still run, so the test shows what would
 * happen if Ollie said no.
 */
export function evaluateRouting(ws: WsData, input: RoutingInput): RoutingTest & { widget_id: string | null; received_at: string } {
  const mailbox = input.channel === "email" ? mailboxForAddress(ws, input.to) : undefined;
  const widget = input.channel === "chat" ? ws.widgets.find((w) => w.id === input.widget_id) : undefined;
  const topic = widget?.settings.topics.find((t) => t.id === input.topic || lc(t.label) === lc(input.topic));
  const brand = mailbox ? ws.brands.find((b) => b.id === mailbox.brand_id) : widget ? ws.brands.find((b) => b.id === widget.brand_id) : defaultBrand(ws);
  const brandId = brand?.id ?? defaultBrand(ws)?.id ?? "";

  let team: string | null = null;
  let routed: TicketRouted | null = null;
  // An alias with a team of its own, unless the address belongs to a private team.
  const aliasTeam = mailbox && !mailbox.private ? mailbox.alias_teams?.[lc(input.to)] : undefined;
  if (aliasTeam && ws.teams.some((x) => x.id === aliasTeam)) {
    team = aliasTeam;
    routed = { via: "address" };
  } else if (mailbox?.team_id) {
    team = mailbox.team_id;
    routed = { via: "address" };
  } else if (topic?.team_id) {
    team = topic.team_id;
    routed = { via: "topic" };
  } else if (widget?.team_id) {
    team = widget.team_id;
    routed = { via: "widget" };
  }

  const from = lc(input.from);
  const facts: Facts = {
    received_at: lc(input.to),
    mailbox_id: mailbox?.id ?? "",
    brand_id: brandId,
    widget_id: widget?.id ?? "",
    channel: input.channel,
    from_email: from,
    from_domain: from.includes("@") ? from.split("@")[1] : "",
    subject: input.subject ?? "",
    body: input.body ?? "",
    page_url: input.page_url ?? "",
    topic: topic?.id ?? input.topic ?? "",
  };
  const steps: RoutingTest["steps"] = [];
  let decided = false;
  let requiredSkills: Skill[] = [];
  for (const r of ws.routingRules.filter((x) => x.enabled).sort((a, b) => a.position - b.position)) {
    if (decided) {
      steps.push({ rule_id: r.id, name: r.name, matched: false });
      continue;
    }
    const m = ruleMatches(r, facts, input.contact_fields ?? {});
    steps.push({ rule_id: r.id, name: r.name, matched: m });
    if (m === true) {
      decided = true;
      team = r.team_id;
      routed = { via: "rule", rule_id: r.id, rule_name: r.name };
      requiredSkills = r.skill_ids.map((id) => ws.skills.find((skill) => skill.id === id)).filter((skill): skill is Skill => !!skill);
    }
  }

  // The reply address: the one it arrived at, else the brand's address for the team, else the brand's default.
  const brandBoxes = ws.mailboxes.filter((m) => m.brand_id === brandId);
  const replyBox = mailbox ?? brandBoxes.find((m) => team && m.team_id === team) ?? (brand ? ws.mailboxes.find((m) => m.id === brandOut(ws, brand).default_mailbox_id) : undefined);
  const assign = (team && teamAssignMode(ws, team)) || replyBox?.id && ws.routing.rules.find((r) => r.target_type === "mailbox" && r.target_id === replyBox.id)?.mode || ws.workspace.settings.auto_assign || "none";
  return {
    team_id: team,
    brand_id: brandId,
    mailbox_id: replyBox?.id ?? null,
    routed,
    steps,
    required_skills: requiredSkills,
    assign_mode: assign,
    widget_id: widget?.id ?? null,
    received_at: input.channel === "email" ? lc(input.to) : "",
  };
}

/** Count a rule match (run_count), as the server does when a real ticket is routed. */
export function countRuleRun(ws: WsData, routed: TicketRouted | null) {
  if (routed?.via !== "rule") return;
  const r = ws.routingRules.find((x) => x.id === routed.rule_id);
  if (r) r.run_count++;
}

export const isOpenish = (t: Ticket) => t.status === "open" || t.status === "pending" || t.status === "on_hold";

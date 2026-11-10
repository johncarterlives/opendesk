// Pictures and logos, availability, assignment, triage, business hours and the
// setup checklist (contracts/api.md "Profile pictures and logos" onwards).

import type {
  Assignment,
  AssignMode,
  AssignmentRule,
  Availability,
  BusinessHours,
  Company,
  Contact,
  NewTicketNotify,
  Onboarding,
  OnboardingStep,
  Role,
  TriageField,
  TriageSettings,
  Weekday,
  WorkspaceImageSlot,
} from "@/lib/api/types";
import { fileToUrl } from "../avatars";
import { db, me, type WsData } from "../db";
import { publish } from "../gateway";
import { HttpError, del, forbidden, get, invalid, notFound, patch, post, put, respond, strArr, type Ctx } from "../router";
import { isRecord, nowIso, uuid } from "../util";
import { aiOff, decisionEngine } from "./ai";
import { agentSetup } from "./aiClients";
import { collabAccountsOf } from "./collab";
import { memberOut } from "./workspace";

const MAX_BYTES = 5 << 20;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const SLOTS: ("logo" | WorkspaceImageSlot)[] = ["logo", "help_center_logo", "help_center_favicon", "widget_avatar", "widget_launcher"];
const MODES: AssignMode[] = ["none", "round_robin", "load_balanced"];
const NEW_TICKET_NOTIFY: NewTicketNotify[] = ["auto", "everyone", "leads", "off"];
const AVAILABILITY: Availability[] = ["online", "away", "offline"];
const WEEKDAYS: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const SEEDED_LABELS = ["question", "problem", "bug", "feature request", "billing", "vip", "feedback"];
const rank: Record<Role, number> = { viewer: 0, agent: 1, admin: 2, owner: 3 };

function role(ws: WsData): Role {
  return ws.members.find((m) => m.user_id === db.meId)?.role ?? "viewer";
}
function requireRole(ws: WsData, min: Role) {
  if (rank[role(ws)] < rank[min]) throw forbidden(min === "agent" ? "Viewers can't change this" : "Only admins can change this");
}

/** The uploaded `file`, checked as the API checks it. */
export async function readUpload(ctx: Ctx): Promise<string> {
  const f = ctx.form?.get("file");
  if (!(f instanceof File)) throw invalid("Choose an image to upload");
  if (f.size > MAX_BYTES) throw new HttpError(413, "too_large", "Images can be at most 5 MB.");
  if (!IMAGE_TYPES.includes(f.type)) throw new HttpError(422, "unsupported_image", "Use a PNG, JPEG, GIF or WebP image.");
  return fileToUrl(f);
}

function audit(ws: WsData, action: string, entity_type: string, entity_id: string | null) {
  const u = me();
  ws.audit.unshift({
    id: uuid(),
    actor: { type: "user", user: { id: u.id, name: u.name, email: u.email, avatar_url: u.avatar_url }, api_key_id: null },
    action,
    entity_type,
    entity_id,
    data: {},
    ip: "84.152.33.17",
    created_at: nowIso(),
  });
}

/** Every workspace sees the change to its member's picture. */
function publishMe() {
  for (const ws of db.workspaces) {
    if (!ws.members.some((m) => m.user_id === db.meId)) continue;
    publish(ws, "member.updated", { member: memberOut(ws, db.meId) }, { topics: [`user:${db.meId}`] });
  }
}

function syncContactRefs(ws: WsData, c: Contact) {
  for (const t of ws.tickets) if (t.contact?.id === c.id) t.contact = { ...t.contact, avatar_url: c.avatar_url };
}
function syncCompanyRefs(ws: WsData, co: Company) {
  for (const c of ws.contacts) if (c.company?.id === co.id) c.company = { ...c.company, avatar_url: co.avatar_url };
}

function assignment(ws: WsData): Assignment {
  const notify = ws.workspace.settings.new_ticket_notify;
  return {
    mode: ws.workspace.settings.auto_assign ?? "none",
    rules: ws.routing.rules,
    auto_away_minutes: ws.routing.autoAwayMinutes,
    new_ticket_notify: notify && NEW_TICKET_NOTIFY.includes(notify) ? notify : "auto",
    followup_keeps_assignee: ws.workspace.settings.followup_keeps_assignee ?? false,
  };
}

function triage(ws: WsData): TriageSettings {
  return {
    auto_triage: ws.ai.auto_triage,
    fields: ws.routing.triageFields,
    assign_after_triage: ws.routing.assignAfterTriage,
    threshold: ws.routing.triageThreshold ?? 0.7,
    engine: decisionEngine(),
    available: !aiOff() && ws.ai.enabled,
  };
}

function hours(ws: WsData): BusinessHours {
  return { ...ws.routing.hours, timezone: ws.workspace.settings.timezone ?? "UTC" };
}

const HHMM = /^([01]\d|2[0-4]):[0-5]\d$/;
const minutes = (v: string) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3));

export function parseHours(body: Record<string, unknown>): Omit<BusinessHours, "timezone"> {
  const schedule = {} as BusinessHours["schedule"];
  const raw = isRecord(body.schedule) ? body.schedule : {};
  for (const k of Object.keys(raw)) if (!WEEKDAYS.includes(k as Weekday)) throw invalid("schedule keys must be mon, tue, wed, thu, fri, sat or sun.");
  for (const d of WEEKDAYS) {
    const list = Array.isArray(raw[d]) ? (raw[d] as unknown[]) : [];
    if (list.length > 3) throw invalid("At most 3 opening ranges per day.");
    const ranges = list.map((r) => {
      const start = isRecord(r) && typeof r.start === "string" ? r.start : "";
      const end = isRecord(r) && typeof r.end === "string" ? r.end : "";
      if (!HHMM.test(start) || !HHMM.test(end) || minutes(start) % 15 || minutes(end) % 15 || minutes(start) > 1440 || minutes(end) > 1440)
        throw invalid("Opening times are HH:MM on the quarter hour, like 09:00 or 17:30.");
      if (minutes(start) >= minutes(end)) throw invalid(`On ${d}, each range must end after it starts.`);
      return { start, end };
    });
    ranges.sort((a, b) => minutes(a.start) - minutes(b.start));
    for (let i = 1; i < ranges.length; i++) if (minutes(ranges[i].start) < minutes(ranges[i - 1].end)) throw invalid(`On ${d}, opening ranges overlap.`);
    schedule[d] = ranges;
  }
  const holidays = (Array.isArray(body.holidays) ? body.holidays : []).map((h) => {
    const date = isRecord(h) && typeof h.date === "string" ? h.date : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) throw invalid("Holiday dates are YYYY-MM-DD.");
    return { date, name: isRecord(h) && typeof h.name === "string" ? h.name.trim().slice(0, 100) : "" };
  });
  if (holidays.length > 100) throw invalid("At most 100 holidays.");
  holidays.sort((a, b) => a.date.localeCompare(b.date));
  return { enabled: body.enabled === true, schedule, holidays: holidays.filter((h, i) => holidays.findIndex((x) => x.date === h.date) === i) };
}

export function onboarding(ws: WsData): Onboarding {
  const row = ws.members.find((m) => m.user_id === db.meId);
  const mail = ws.workspace.mail_available !== false;
  const accounts = mail ? collabAccountsOf(ws) : [];
  const done: Record<OnboardingStep["id"], boolean> = {
    connect_mail_account: accounts.length > 0,
    share_mail_account: accounts.some((a) => a.shared),
    connect_mailbox: ws.mailboxes.length > 0,
    invite_teammate: ws.members.length > 1 || ws.invitations.length > 0,
    upload_photo: !!me().avatar_url,
    install_widget: ws.routing.widgetSeen,
    publish_article: ws.articles.some((a) => a.status === "published"),
    setup_triage: (ws.workspace.settings.auto_assign ?? "none") !== "none" || ws.routing.rules.some((r) => r.mode !== "none") || ws.ai.auto_triage,
    create_label: ws.tags.some((t) => !SEEDED_LABELS.includes(t.name.toLowerCase())),
    try_ollie: ws.aiUsage.some((u) => u.user_id !== null),
    setup_ai_agent: agentSetup(ws).complete,
  };
  // The steps follow the products (contracts/api.md "Onboarding").
  if (ws.workspace.settings.tickets_enabled === false) {
    const mailSteps: OnboardingStep[] = mail
      ? [
          { id: "connect_mail_account", title: "Connect a mail account", description: "Bring a Gmail, Outlook or IMAP inbox in. Keep it private or share it.", done: done.connect_mail_account, href: "/settings/mail-accounts", requires: "agent" },
          { id: "share_mail_account", title: "Share an inbox with your team", description: "Everyone you add sees its mail and can reply, assign and comment.", done: done.share_mail_account, href: "/settings/mail-accounts", requires: "agent" },
        ]
      : [];
    const steps: OnboardingStep[] = [
      ...mailSteps,
      { id: "invite_teammate", title: "Invite a teammate", description: "Work together and share the load.", done: done.invite_teammate, href: "/settings/members", requires: "admin" },
      { id: "upload_photo", title: "Upload your photo", description: "Teammates see who is replying.", done: done.upload_photo, href: "/settings/profile", requires: "agent" },
    ];
    return { steps, done_count: steps.filter((s) => s.done).length, total: steps.length, dismissed: !!row?.onboarding_dismissed };
  }
  const steps: OnboardingStep[] = [
    { id: "connect_mailbox", title: "Connect a mailbox", description: "Bring your support email in so messages become tickets.", done: done.connect_mailbox, href: "/settings/mailboxes", requires: "admin" },
    { id: "invite_teammate", title: "Invite a teammate", description: "Answer tickets together and share the load.", done: done.invite_teammate, href: "/settings/members", requires: "admin" },
    { id: "upload_photo", title: "Upload your photo", description: "Customers and teammates see who is replying.", done: done.upload_photo, href: "/settings/profile", requires: "agent" },
    { id: "install_widget", title: "Install the chat widget", description: "Add live chat to your site with one script tag.", done: done.install_widget, href: "/settings/widget", requires: "admin" },
    { id: "publish_article", title: "Publish a help article", description: "Answer common questions before they become tickets.", done: done.publish_article, href: "/kb", requires: "agent" },
    { id: "setup_triage", title: "Set up triage and assignment", description: "Let Ollie sort new tickets and route them to whoever is available.", done: done.setup_triage, href: "/settings/triage", requires: "admin" },
    { id: "create_label", title: "Create a label", description: "Group tickets by topic, product or customer type.", done: done.create_label, href: "/settings/tags", requires: "admin" },
    { id: "try_ollie", title: "Try Ollie", description: "Ask Ollie to draft a reply, summarize a ticket or find an answer.", done: done.try_ollie, href: "/inbox/all", requires: "agent" },
    { id: "setup_ai_agent", title: "Set up the AI agent", description: "Teach Ollie your answers, test it, then let it reply to chats.", done: done.setup_ai_agent, href: "/settings/ai/agent", requires: "admin" },
  ];
  return { steps, done_count: steps.filter((s) => s.done).length, total: steps.length, dismissed: !!row?.onboarding_dismissed };
}

function avatarRoutes<T extends Contact | Company>(
  base: "contacts" | "companies",
  what: string,
  list: (ws: WsData) => T[],
  sync: (ws: WsData, row: T) => void,
  publishRow: (ws: WsData, row: T) => void,
) {
  const entity = base === "contacts" ? "contact" : "company";
  const find = (ctx: Ctx) => {
    requireRole(ctx.ws, "agent");
    const row = list(ctx.ws).find((x) => x.id === ctx.params.id);
    if (!row) throw notFound(what);
    return row;
  };
  put(`/v1/${base}/:id/avatar`, async (ctx) => {
    const row = find(ctx);
    row.avatar_url = await readUpload(ctx);
    row.avatar_source = "upload";
    row.updated_at = nowIso();
    sync(ctx.ws, row);
    audit(ctx.ws, `${entity}.avatar_updated`, entity, row.id);
    publishRow(ctx.ws, row);
    return row;
  });
  del(`/v1/${base}/:id/avatar`, (ctx) => {
    const row = find(ctx);
    if (row.avatar_source === "upload") {
      row.avatar_url = null;
      row.avatar_source = null;
      row.updated_at = nowIso();
      sync(ctx.ws, row);
      audit(ctx.ws, `${entity}.avatar_removed`, entity, row.id);
      publishRow(ctx.ws, row);
    }
    return row;
  });
  post(`/v1/${base}/:id/avatar/refresh`, (ctx) => {
    find(ctx);
    return respond(202);
  });
}

export function registerPictures() {
  // Your own picture.
  put("/v1/me/avatar", async (ctx) => {
    const u = me();
    u.avatar_url = await readUpload(ctx);
    u.avatar_source = "upload";
    for (const ws of db.workspaces) if (ws.members.some((m) => m.user_id === u.id)) audit(ws, "user.avatar_updated", "user", u.id);
    publishMe();
    return u;
  });
  del("/v1/me/avatar", () => {
    const u = me();
    u.avatar_url = null;
    u.avatar_source = null;
    for (const ws of db.workspaces) if (ws.members.some((m) => m.user_id === u.id)) audit(ws, "user.avatar_removed", "user", u.id);
    publishMe();
    return u;
  });
  post("/v1/me/heartbeat", () => {
    for (const ws of db.workspaces) {
      const m = ws.members.find((x) => x.user_id === db.meId);
      if (m) m.last_seen_at = nowIso();
    }
    return respond(204);
  });

  // Availability and the assignment cap.
  patch("/v1/members/:user_id/availability", (ctx) => {
    const uid = ctx.params.user_id === "me" ? db.meId : ctx.params.user_id;
    const m = ctx.ws.members.find((x) => x.user_id === uid);
    if (!m) throw notFound("Member");
    const admin = rank[role(ctx.ws)] >= rank.admin;
    if (uid !== db.meId && !admin) throw forbidden("Only admins can change another member's availability");
    if ("availability" in ctx.body) {
      const a = ctx.body.availability as Availability;
      if (!AVAILABILITY.includes(a)) throw invalid("availability must be online, away or offline");
      m.availability = a;
    }
    if ("max_open_tickets" in ctx.body) {
      if (!admin) throw forbidden("Only admins can set an assignment cap");
      const cap = ctx.body.max_open_tickets;
      if (cap !== null && (typeof cap !== "number" || !Number.isInteger(cap) || cap < 1 || cap > 1000)) throw invalid("max_open_tickets is 1 to 1000, or null");
      if (cap !== null && m.role === "viewer") throw invalid("Viewers are never assigned, so they have no cap");
      m.max_open_tickets = cap as number | null;
      audit(ctx.ws, "member.assignment_cap_changed", "member", uid);
    }
    const out = memberOut(ctx.ws, uid);
    publish(ctx.ws, "member.updated", { member: out }, { topics: [`user:${uid}`] });
    return out;
  });

  // Which messages an agent may delete, over the workspace's rule.
  patch("/v1/members/:user_id/permissions", (ctx) => {
    if (rank[role(ctx.ws)] < rank.admin) throw forbidden();
    const m = ctx.ws.members.find((x) => x.user_id === ctx.params.user_id);
    if (!m) throw notFound("Member");
    const v = ctx.body.message_delete;
    if (v !== "default" && v !== "off" && v !== "own" && v !== "all") throw invalid("message_delete must be default, off, own or all");
    if (m.role !== "agent") throw invalid("Only agents have this setting: owners and admins delete any message, viewers none.");
    m.message_delete = v === "default" ? null : v;
    audit(ctx.ws, "member.permissions_changed", "member", m.user_id);
    const out = memberOut(ctx.ws, m.user_id);
    publish(ctx.ws, "member.updated", { member: out }, { topics: [`user:${m.user_id}`] });
    return out;
  });

  // Workspace logo and brand images.
  put("/v1/workspace/images/:slot", async (ctx) => {
    requireRole(ctx.ws, "admin");
    const slot = ctx.params.slot as (typeof SLOTS)[number];
    if (!SLOTS.includes(slot)) throw invalid("slot must be logo, help_center_logo, help_center_favicon, widget_avatar or widget_launcher");
    const url = await readUpload(ctx);
    const w = ctx.ws.workspace;
    if (slot === "logo") {
      w.avatar_url = url;
      w.avatar_source = "upload";
    } else w.images = { ...w.images, [slot]: url };
    audit(ctx.ws, "workspace.image_updated", "workspace", w.id);
    publish(ctx.ws, "workspace.updated", { workspace: w });
    return w;
  });
  del("/v1/workspace/images/:slot", (ctx) => {
    requireRole(ctx.ws, "admin");
    const slot = ctx.params.slot as (typeof SLOTS)[number];
    if (!SLOTS.includes(slot)) throw invalid("Unknown image slot");
    const w = ctx.ws.workspace;
    if (slot === "logo") {
      w.avatar_url = null;
      w.avatar_source = null;
    } else w.images = { ...w.images, [slot]: null };
    audit(ctx.ws, "workspace.image_removed", "workspace", w.id);
    publish(ctx.ws, "workspace.updated", { workspace: w });
    return w;
  });

  avatarRoutes<Contact>("contacts", "Contact", (ws) => ws.contacts, syncContactRefs, (ws, c) => publish(ws, "contact.updated", { contact: c }));
  avatarRoutes<Company>("companies", "Company", (ws) => ws.companies, syncCompanyRefs, (ws, c) => publish(ws, "company.updated", { company: c }));

  // Assignment.
  get("/v1/assignment", (ctx) => assignment(ctx.ws));
  patch("/v1/assignment", (ctx) => {
    requireRole(ctx.ws, "admin");
    const b = ctx.body;
    if ("mode" in b) {
      if (!MODES.includes(b.mode as AssignMode)) throw invalid("mode must be none, round_robin or load_balanced");
      ctx.ws.workspace.settings = { ...ctx.ws.workspace.settings, auto_assign: b.mode as AssignMode };
    }
    if ("new_ticket_notify" in b) {
      if (!NEW_TICKET_NOTIFY.includes(b.new_ticket_notify as NewTicketNotify)) throw invalid("new_ticket_notify must be auto, everyone, leads or off");
      ctx.ws.workspace.settings = { ...ctx.ws.workspace.settings, new_ticket_notify: b.new_ticket_notify as NewTicketNotify };
    }
    if ("followup_keeps_assignee" in b) {
      if (typeof b.followup_keeps_assignee !== "boolean") throw invalid("followup_keeps_assignee must be true or false");
      ctx.ws.workspace.settings = { ...ctx.ws.workspace.settings, followup_keeps_assignee: b.followup_keeps_assignee };
    }
    if ("auto_away_minutes" in b) {
      const n = b.auto_away_minutes;
      if (typeof n !== "number" || !Number.isInteger(n) || (n !== 0 && (n < 10 || n > 1440))) throw invalid("auto_away_minutes is 0, or 10 to 1440");
      ctx.ws.routing.autoAwayMinutes = n;
    }
    if ("rules" in b) {
      if (!Array.isArray(b.rules) || b.rules.length > 200) throw invalid("At most 200 rules");
      const seen = new Set<string>();
      ctx.ws.routing.rules = b.rules.map((r): AssignmentRule => {
        if (!isRecord(r)) throw invalid("Each rule needs target_type, target_id and mode");
        const type = r.target_type;
        const id = typeof r.target_id === "string" ? r.target_id : "";
        if (type !== "mailbox" && type !== "team") throw invalid("target_type must be mailbox or team");
        const known = type === "team" ? ctx.ws.teams.some((t) => t.id === id) : ctx.ws.mailboxes.some((m) => m.id === id);
        if (!known) throw invalid(`Unknown ${type}`);
        if (!MODES.includes(r.mode as AssignMode)) throw invalid("mode must be none, round_robin or load_balanced");
        if (seen.has(`${type}:${id}`)) throw invalid("One rule per mailbox or team");
        seen.add(`${type}:${id}`);
        return { target_type: type, target_id: id, mode: r.mode as AssignMode };
      });
    }
    audit(ctx.ws, "assignment.updated", "workspace", ctx.ws.workspace.id);
    publish(ctx.ws, "workspace.updated", { workspace: ctx.ws.workspace });
    return assignment(ctx.ws);
  });

  // Triage.
  get("/v1/triage", (ctx) => triage(ctx.ws));
  patch("/v1/triage", (ctx) => {
    requireRole(ctx.ws, "admin");
    const b = ctx.body;
    if ("auto_triage" in b) ctx.ws.ai.auto_triage = b.auto_triage === true;
    if ("assign_after_triage" in b) ctx.ws.routing.assignAfterTriage = b.assign_after_triage === true;
    if ("fields" in b) {
      const f = strArr(b.fields);
      if (!f || f.some((x) => !["priority", "severity", "labels", "team"].includes(x))) throw invalid("fields may hold priority, severity, labels and team.");
      ctx.ws.routing.triageFields = [...new Set(f)] as TriageField[];
    }
    if ("threshold" in b) {
      const v = b.threshold;
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0.5 || v > 0.99) throw invalid("threshold must be between 0.5 and 0.99.");
      ctx.ws.routing.triageThreshold = Math.round(v * 100) / 100;
    }
    audit(ctx.ws, "triage.updated", "workspace", ctx.ws.workspace.id);
    return triage(ctx.ws);
  });

  // Business hours.
  get("/v1/business-hours", (ctx) => hours(ctx.ws));
  put("/v1/business-hours", (ctx) => {
    requireRole(ctx.ws, "admin");
    const next = parseHours(ctx.body);
    const tz = typeof ctx.body.timezone === "string" ? ctx.body.timezone : undefined;
    if (tz !== undefined) {
      try {
        new Intl.DateTimeFormat("en", { timeZone: tz });
      } catch {
        throw invalid("Unknown timezone");
      }
      ctx.ws.workspace.settings = { ...ctx.ws.workspace.settings, timezone: tz };
    }
    ctx.ws.routing.hours = next;
    audit(ctx.ws, "business_hours.updated", "workspace", ctx.ws.workspace.id);
    publish(ctx.ws, "workspace.updated", { workspace: ctx.ws.workspace });
    return hours(ctx.ws);
  });

  // Setup checklist.
  get("/v1/onboarding", (ctx) => onboarding(ctx.ws));
  post("/v1/onboarding/dismiss", (ctx) => {
    const m = ctx.ws.members.find((x) => x.user_id === db.meId);
    if (m) m.onboarding_dismissed = true;
    return respond(204);
  });
}

// The wiki in mock mode (contracts/wiki.md), checked as internal/helpdesk/wiki checks it:
// the tree with its spaces (the workspace's, a member's private pages, teamspaces), pages
// with versions, history with coalesced revisions, moves that refuse cycles, the trash,
// templates and copies, favorites, recent pages and readers, the journal, verification,
// links and search, and databases (properties, views and rows with checked values). The
// mock's person is db.meId. The first workspace starts with a small support handbook, two
// templates and two linked databases (known issues and key accounts); the others start
// empty, to show the first-run state.

import DOMPurify from "dompurify";
import type {
  Canvas,
  CanvasEdge,
  CanvasNode,
  Database,
  DbDate,
  DbFile,
  DbOption,
  DbProperty,
  DbPropType,
  DbRow,
  DbRows,
  DbStatusGroup,
  DbValue,
  DbView,
  KbArticle,
  Notification,
  Role,
  WikiArea,
  WikiComments,
  WikiDailyNote,
  WikiNode,
  WikiPage,
  WikiPageSettings,
  WikiPageViews,
  WikiReaction,
  WikiRef,
  WikiRevision,
  WikiSearchHit,
  WikiThread,
  WikiTrashed,
  WikiWriteMode,
} from "@/lib/api/types";
import { mentionIds } from "@/lib/collab/html";
import { MAX_DEPTH, buildTree, childrenOf } from "@/lib/wiki/tree";
import { DEFAULT_LOOK } from "@/lib/wiki/look";
import { linkedIds, pageTags } from "@/lib/wiki/links";
import { db, userRef, type WsData } from "../db";
import { publish } from "../gateway";
import { chunk, del, forbidden, get, HttpError, invalid, notFound, patch, post, put, respond, s, sse, type Ctx } from "../router";
import { reserve, spend } from "../aiBalance";
import { htmlToText, rewriteText, textToParagraphs } from "./aiTicket";
import { kbBrandRef, recountCollections, sameCollection, uniqueSlug } from "./resources";
import { canSeeTicket, roleIn, teamRole } from "../teams";
import { findTicket } from "../tickets";
import { ago, DAY, escapeHtml, HOUR, markdownToHtml, MIN, NOW, nowIso, parseUUID, slugify, stripHtml, uuid } from "../util";
import { htmlToMarkdown } from "@/lib/procedures";
import { exportBaseName } from "@/lib/wiki/port";

type Row = WikiPageSettings & {
  id: string;
  parent_id: string | null;
  title: string;
  icon: string;
  body_html: string;
  position: number;
  version: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  /** The member a private page belongs to. */
  private_to: string | null;
  team_id: string | null;
  template: boolean;
  journal: boolean;
  daily_date: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
  /** The page whose trashing took this one along (itself for the page trashed). */
  trashed_with: string | null;
  verified_by: string | null;
  verified_at: string | null;
  verified_until: string | null;
  /** "database": its subpages are its rows; "canvas": it holds cards. */
  kind: "page" | "database" | "canvas";
  /** A canvas's cards and connections; null for a page. */
  canvas: Canvas | null;
  /** A database's properties and views; null for a page. */
  database: Database | null;
  /** A row's values, by property id. */
  props: Record<string, DbValue>;
  /** Creation order, for rows made in the same millisecond (numberRows: oldest first). */
  seq: number;
  /** Other names the page goes by (contracts/wiki.md "Aliases"). */
  aliases: string[];
  /** Whose tree it is in (contracts/pages.md): the wiki's or Pages'. */
  area: WikiArea;
};
type Rev = { id: string; page_id: string; title: string; icon: string; body_html: string; author: string | null; created_at: string; updated_at: string };
type Visit = { user_id: string; page_id: string; visits: number; last_at: string; seq: number };
/** A person's views of a page on a day (UTC), as wiki_page_views keeps them (contracts/wiki.md "Page analytics"). */
type ViewDay = { user_id: string; page_id: string; day: string; views: number };
/** A comment; a thread is its first comment (thread_id = id), which holds the quote and the resolution. */
type CommentRow = {
  id: string;
  page_id: string;
  thread_id: string;
  quote: string;
  inline: boolean;
  author_id: string | null;
  body_html: string;
  mentions: string[];
  created_at: string;
  edited_at: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  seq: number;
};
type Reaction = { comment_id: string; user_id: string; emoji: string; seq: number };
type State = {
  pages: Row[];
  revisions: Rev[];
  favorites: Map<string, string[]>;
  visits: Visit[];
  views: ViewDay[];
  comments: CommentRow[];
  reactions: Reaction[];
  /** Explicit follows and unfollows, by page then user; without one, a page's creator follows it. */
  follows: Map<string, Map<string, boolean>>;
};

const MAX_PAGES = 5000;
const MAX_BODY = 512 * 1024;
const MAX_REVISIONS = 100;
const MAX_FAVORITES = 100;
const COALESCE_GAP = 10 * MIN;
const COALESCE_SPAN = HOUR;
const TRASH_KEEP = 30 * DAY;

const states = new WeakMap<WsData, State>();
let visitSeq = 0;
let rowSeq = 0;

function stateOf(ws: WsData): State {
  let st = states.get(ws);
  if (!st) {
    st = { pages: [], revisions: [], favorites: new Map(), visits: [], views: [], comments: [], reactions: [], follows: new Map() };
    states.set(ws, st);
    if (ws === db.workspaces[0]) seedHandbook(ws, st);
  }
  purge(st);
  return st;
}

/** Pages 30 days in the trash go for good, with everything under them. */
function purge(st: State) {
  const before = Date.now() - TRASH_KEEP;
  const roots = st.pages.filter((r) => r.trashed_with === r.id && r.deleted_at && Date.parse(r.deleted_at) < before);
  if (roots.length) removeRows(st, roots.flatMap((r) => everythingUnder(st, r.id)));
}

const rank: Record<Role, number> = { viewer: 1, agent: 2, admin: 3, owner: 4 };
const role = (ctx: Ctx) => roleIn(ctx.ws, db.meId);

function requireAgent(ctx: Ctx) {
  if (rank[role(ctx)] < rank.agent) throw new HttpError(403, "forbidden", "You don't have permission to do that");
}

// ─── Who sees what (visibility.go) ─────────────────────────────────────────

type Viewer = { me: string; hidden: Set<string> };

/** The person's view: their own private pages, and no page of a private team they are not on. */
function viewerOf(ws: WsData, me = db.meId): Viewer {
  return { me, hidden: new Set(ws.teams.filter((t) => t.private && !teamRole(t, me)).map((t) => t.id)) };
}

/** seesSQL: in the viewer's space, whether in the trash or a template. */
const sees = (v: Viewer, r: Row) => (r.private_to === null || r.private_to === v.me) && (r.team_id === null || !v.hidden.has(r.team_id));
/** liveSQL: a page of the viewer's tree. */
const live = (v: Viewer, r: Row) => !r.deleted_at && !r.template && sees(v, r);

const verifiedNow = (r: Row) => !!r.verified_at && (!r.verified_until || Date.parse(r.verified_until) > Date.now());

const node = (r: Row): WikiNode => ({
  id: r.id,
  parent_id: r.parent_id,
  title: r.title,
  icon: r.icon,
  position: r.position,
  version: r.version,
  updated_at: r.updated_at,
  created_by_id: r.created_by,
  tags: pageTags(r.body_html + canvasHtml(r), stripHtml),
  private: r.private_to !== null,
  team_id: r.team_id,
  ...(r.journal ? { journal: true } : {}),
  ...(r.daily_date ? { daily_date: r.daily_date } : {}),
  ...(r.template ? { template: true } : {}),
  ...(verifiedNow(r) ? { verified: true } : {}),
  kind: r.kind,
  ...(r.aliases.length ? { aliases: [...r.aliases] } : {}),
  area: r.area,
});
const refOf = (r: Pick<Row, "id" | "title" | "icon">): WikiRef => ({ id: r.id, title: r.title, icon: r.icon });
const settingsOf = (r: Row): WikiPageSettings => ({ cover: r.cover, cover_y: r.cover_y, full_width: r.full_width, small_text: r.small_text, font: r.font, locked: r.locked });
const byPosition = (a: Row, b: Row) => a.position - b.position || a.id.localeCompare(b.id);

/** The pages above id, the top-level one first, whatever their state. */
function ancestorsOf(st: State, id: string): Row[] {
  const out: Row[] = [];
  let cur = st.pages.find((r) => r.id === id)?.parent_id ?? null;
  while (cur && out.length < 64) {
    const up = st.pages.find((r) => r.id === cur);
    if (!up) break;
    out.unshift(up);
    cur = up.parent_id;
  }
  return out;
}

/** id and every page under it in the same state (both in the tree, or trashed together), and how many levels it spans. */
function subtree(st: State, id: string): { ids: string[]; height: number } {
  const root = st.pages.find((r) => r.id === id);
  if (!root) return { ids: [], height: 0 };
  const ids: string[] = [];
  let level = [root];
  let height = 0;
  while (level.length && height < 64) {
    height++;
    ids.push(...level.map((r) => r.id));
    const at = new Set(level.map((r) => r.id));
    level = st.pages.filter((r) => r.parent_id !== null && at.has(r.parent_id) && r.trashed_with === root.trashed_with);
  }
  return { ids, height };
}

/** id and everything under it, in the tree or in the trash. */
function everythingUnder(st: State, id: string): string[] {
  const out = [id];
  for (let i = 0; i < out.length; i++) for (const r of st.pages) if (r.parent_id === out[i]) out.push(r.id);
  return out;
}

function removeRows(st: State, ids: string[]) {
  const gone = new Set(ids);
  st.pages = st.pages.filter((r) => !gone.has(r.id));
  st.revisions = st.revisions.filter((x) => !gone.has(x.page_id));
  st.visits = st.visits.filter((x) => !gone.has(x.page_id));
  st.views = st.views.filter((x) => !gone.has(x.page_id));
  const comments = new Set(st.comments.filter((c) => gone.has(c.page_id)).map((c) => c.id));
  st.comments = st.comments.filter((c) => !comments.has(c.id));
  st.reactions = st.reactions.filter((x) => !comments.has(x.comment_id));
  for (const id of gone) st.follows.delete(id);
  for (const [user, list] of st.favorites) st.favorites.set(user, list.filter((id) => !gone.has(id)));
}

/**
 * Puts id at index among the children of parent in the tree (the end when index is past it,
 * or left out) and numbers them from 0; without id it only renumbers them. Top-level pages
 * are numbered within their area and space (templates, shared by both areas, within their
 * space); trashed pages and templates keep their numbers.
 */
function place(st: State, parent: string | null, owner: string | null, team: string | null, template: boolean, area: WikiArea, id?: string, index?: number) {
  const order = st.pages
    .filter((r) => r.parent_id === parent && !r.deleted_at && r.template === template && (parent !== null || (r.private_to === owner && r.team_id === team && (template || r.area === area))) && r.id !== id)
    .sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  const moving = id ? st.pages.find((r) => r.id === id) : undefined;
  if (moving) order.splice(index !== undefined && index >= 0 && index < order.length ? index : order.length, 0, moving);
  order.forEach((r, i) => (r.position = i));
}

function pageOut(st: State, r: Row): WikiPage {
  return {
    ...node(r),
    ...settingsOf(r),
    body_html: r.body_html,
    aliases: [...r.aliases],
    template: r.template,
    journal: r.journal,
    kind: r.kind,
    database: r.database ? structuredClone(r.database) : null,
    props: structuredClone(r.props),
    canvas: r.canvas ? structuredClone(r.canvas) : null,
    verification: r.verified_at
      ? { by: userRef(r.verified_by), at: r.verified_at, until: r.verified_until, expired: !!r.verified_until && Date.parse(r.verified_until) < Date.now() }
      : null,
    deleted_at: r.deleted_at,
    deleted_by: userRef(r.deleted_by),
    created_at: r.created_at,
    created_by: userRef(r.created_by),
    updated_by: userRef(r.updated_by),
    breadcrumbs: ancestorsOf(st, r.id).map(refOf),
    // A page in the tree shows its subpages in the tree; one in the trash, those trashed with it.
    children: st.pages
      .filter((c) => c.parent_id === r.id && c.trashed_with === r.trashed_with)
      .sort(byPosition)
      .map(refOf),
  };
}

/** The page of the path the viewer may see, in the trash or not; else not found, as if it didn't exist. */
function find(ctx: Ctx, st = stateOf(ctx.ws)): Row {
  const r = st.pages.find((p) => p.id === ctx.params.id);
  if (!r || !sees(viewerOf(ctx.ws), r)) throw notFound("Page");
  requireArea(ctx.ws, r.area);
  return r;
}

/** Pages' pages are out of reach while the workspace has Pages off (contracts/pages.md); kept, not gone. */
const pagesOn = (ws: WsData) => ws.workspace.settings.pages_enabled !== false;

function requireArea(ws: WsData, area: WikiArea) {
  if (area === "pages" && !pagesOn(ws))
    throw new HttpError(403, "feature_disabled", "pages is disabled for this workspace", { product: "pages", reason: "workspace_disabled" });
}

/** The area a list reads: ?area=pages, else the wiki's. */
function areaParam(ctx: Ctx): WikiArea {
  const area: WikiArea = ctx.query.get("area") === "pages" ? "pages" : "wiki";
  requireArea(ctx.ws, area);
  return area;
}

/** A top-level page's area from a body field: Pages' when it says so, else the wiki's. */
function areaField(ctx: Ctx, raw: unknown): WikiArea {
  const area: WikiArea = raw === "pages" ? "pages" : "wiki";
  requireArea(ctx.ws, area);
  return area;
}

const inTrash = () => new HttpError(422, "page_in_trash", "This page is in the trash. Restore it to change it.");
const cycle = () => new HttpError(422, "page_cycle", "A page can't move under itself or one of its subpages.");
const tooDeep = () => new HttpError(422, "page_too_deep", "Pages nest up to 10 levels deep.");

/** Refuses n more pages in a full wiki (the trash and templates count). */
function roomFor(st: State, n: number) {
  if (st.pages.length + n > MAX_PAGES)
    throw new HttpError(422, "wiki_full", "A workspace's wiki holds up to 5,000 pages, the trash included. Delete pages you no longer need first.");
}

type Parent = { row: Row; up: Row[] };

/** A parent page id ("" or null is the top level): a page of the tree the viewer may see. */
function parentRef(ctx: Ctx, st: State, raw: unknown): Parent | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const id = parseUUID(raw.trim());
  if (!id) throw invalid("parent_id is not a valid id");
  const row = st.pages.find((r) => r.id === id);
  if (!row || row.deleted_at || !sees(viewerOf(ctx.ws), row)) throw invalid("parent page not found in this workspace");
  requireArea(ctx.ws, row.area);
  return { row, up: ancestorsOf(st, id) };
}

/** The space a top-level page goes to: "workspace", "private" or "team" (with team_id, a team the viewer may see). */
function spaceRef(ctx: Ctx, space: unknown, rawTeam: unknown): { owner: string | null; team: string | null } {
  switch (space ?? "") {
    case "":
    case "workspace":
      return { owner: null, team: null };
    case "private":
      return { owner: db.meId, team: null };
    case "team": {
      if (typeof rawTeam !== "string") throw invalid("team_id is required for a teamspace page");
      const id = parseUUID(rawTeam.trim());
      if (!id) throw invalid("team_id is not a valid id");
      const hidden = viewerOf(ctx.ws).hidden;
      if (!ctx.ws.teams.some((t) => t.id === id && !hidden.has(t.id))) throw invalid("team not found in this workspace");
      return { owner: null, team: id };
    }
  }
  throw invalid("space must be workspace, private or team");
}

/**
 * Admins and owners delete (or trash) any page; agents a page when they created it (or it is
 * their private page) and every page under it.
 */
function canDelete(ctx: Ctx, st: State, ids: string[]) {
  if (rank[role(ctx)] >= rank.admin) return;
  const me = db.meId;
  const others = new Set(st.pages.filter((r) => ids.includes(r.id) && r.created_by !== me && r.private_to !== me).map((r) => r.id));
  if (others.has(ids[0] ?? "")) throw new HttpError(403, "forbidden", "Someone else created this page, so only an admin can delete it.");
  if (others.size) throw new HttpError(403, "forbidden", "Someone else created pages under this one, so only an admin can delete it.");
}

function cleanTitle(v: unknown): string {
  if (typeof v !== "string") return "";
  if ([...v].length > 200) throw invalid("title must be at most 200 characters");
  return v.replace(/\s+/g, " ").trim();
}

// One emoji as the API reads it (internal/helpdesk/wiki/emoji.go): pictographs with a
// variation selector and skin tone, joined by ZWJ; a flag; a tag flag; or a keycap.
const pict = String.raw`\p{Extended_Pictographic}[\u{FE0E}\u{FE0F}]?[\u{1F3FB}-\u{1F3FF}]?`;
const oneEmoji = new RegExp(
  String.raw`^(?:${pict}(?:\u{200D}${pict})*|[\u{1F1E6}-\u{1F1FF}]{2}|[0-9#*]\u{FE0F}?\u{20E3}|\u{1F3F4}[\u{E0020}-\u{E007E}]+\u{E007F})$`,
  "u",
);

function cleanIcon(v: unknown): string {
  if (typeof v !== "string" || !v.trim()) return "";
  const t = v.trim();
  if (t.length > 64 || !oneEmoji.test(t)) throw invalid("icon must be one emoji");
  return t;
}

function cleanBody(v: unknown): string {
  const html = typeof v === "string" ? v : "";
  if (new TextEncoder().encode(html).length > MAX_BODY) throw new HttpError(422, "page_too_large", "A page can hold up to 512 KB of text and formatting. Split it into subpages.");
  // The server keeps the rich-text allowlist and the wiki's blocks (hd.SanitizeWiki); the
  // mock drops what can run and the to-do checkboxes the app draws itself.
  return DOMPurify.sanitize(html, { FORBID_TAGS: ["input", "label", "iframe", "form", "style", "script"], ADD_ATTR: ["datetime", "colwidth"] });
}

const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);

function record(st: State, r: Row, merge: boolean) {
  const now = Date.now();
  const mine = st.revisions.filter((x) => x.page_id === r.id).sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  const last = mine[0];
  if (merge && last && r.updated_by && last.author === r.updated_by && now - Date.parse(last.updated_at) < COALESCE_GAP && now - Date.parse(last.created_at) < COALESCE_SPAN) {
    Object.assign(last, { title: r.title, icon: r.icon, body_html: r.body_html, updated_at: nowIso() });
    return;
  }
  const fresh: Rev = { id: uuid(), page_id: r.id, title: r.title, icon: r.icon, body_html: r.body_html, author: r.updated_by, created_at: nowIso(), updated_at: nowIso() };
  // The newest 100 stay: this one and the 99 before it.
  const keep = new Set([fresh.id, ...mine.slice(0, MAX_REVISIONS - 1).map((x) => x.id)]);
  st.revisions = [...st.revisions, fresh].filter((x) => x.page_id !== r.id || keep.has(x.id));
}

const GRADIENTS = new Set(["dawn", "ocean", "forest", "dusk", "sand", "slate", "rose", "lagoon", "aurora", "ember"]);

/** The look a PATCH asks for, checked as the API checks it. */
function settingsPatch(body: Record<string, unknown>, cur: WikiPageSettings): WikiPageSettings {
  const next = { ...cur };
  if ("cover" in body) {
    const c = String(body.cover ?? "").trim();
    const ok = c === "" || (c.startsWith("gradient:") && GRADIENTS.has(c.slice(9))) || /^(https:\/\/\S+|\/v1\/attachments\/[0-9a-f-]{36}(\?\S*)?)$/i.test(c);
    if (!ok) throw invalid("cover must be a gradient, an https image or an uploaded image");
    next.cover = c;
  }
  if ("cover_y" in body) next.cover_y = Math.max(0, Math.min(100, Number(body.cover_y) || 0));
  if ("full_width" in body) next.full_width = !!body.full_width;
  if ("small_text" in body) next.small_text = !!body.small_text;
  if ("font" in body) {
    if (!["default", "serif", "mono"].includes(String(body.font))) throw invalid("font must be default, serif or mono");
    next.font = body.font as WikiPageSettings["font"];
  }
  if ("locked" in body) next.locked = !!body.locked;
  return next;
}

/**
 * The verification a PATCH asks for, checked before anything changes: undefined leaves it,
 * null takes it away, else verifies the page as the person for some days (or until changed).
 */
function verificationPatch(body: Record<string, unknown>): { days: number | null } | null | undefined {
  const days = body.verified_days ?? null;
  if (typeof body.verified !== "boolean") {
    if (days !== null) throw invalid("verified_days goes with verified: true");
    return undefined;
  }
  if (!body.verified) return null;
  if (days !== null && (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 3650)) throw invalid("verified_days must be between 1 and 3650");
  return { days };
}

/** Applies a verificationPatch; whether anything changed. */
function applyVerification(r: Row, v: { days: number | null } | null | undefined): boolean {
  if (v === undefined) return false;
  if (v === null) {
    if (!r.verified_at) return false;
    Object.assign(r, { verified_by: null, verified_at: null, verified_until: null });
    return true;
  }
  const at = Date.now();
  Object.assign(r, { verified_by: db.meId, verified_at: new Date(at).toISOString(), verified_until: v.days ? new Date(at + v.days * DAY).toISOString() : null });
  return true;
}

const revOut = (x: Rev, body: boolean): WikiRevision => ({
  id: x.id,
  title: x.title,
  icon: x.icon,
  ...(body ? { body_html: x.body_html } : {}),
  author: userRef(x.author),
  created_at: x.created_at,
  updated_at: x.updated_at,
});

/**
 * Publishes an event about a page to the people who may see it: a private page's member
 * only, a private team's page that team only, else the workspace.
 */
function pageEvent(ws: WsData, space: Pick<Row, "private_to" | "team_id">, type: string, data: Record<string, unknown>) {
  if (space.private_to) {
    // Scoped to the member: their user channel gets it in full, the workspace channel a stand-in.
    publish(ws, type, data, { teamId: "__wiki_private", topics: [`user:${space.private_to}`] });
    return;
  }
  const team = space.team_id ? ws.teams.find((t) => t.id === space.team_id) : undefined;
  publish(ws, type, data, { teamId: team?.private ? team.id : null });
}

/** What wiki_page.created, .updated and .moved carry: the page without its body, and who changed it. */
const eventPage = (r: Row): Record<string, unknown> => ({ wiki_page: node(r), updated_by: userRef(r.updated_by) });

function newRow(fields: Partial<Row> & Pick<Row, "id" | "parent_id" | "title" | "icon" | "body_html">): Row {
  const now = nowIso();
  return {
    position: Number.MAX_SAFE_INTEGER,
    version: 1,
    created_by: db.meId,
    updated_by: db.meId,
    created_at: now,
    updated_at: now,
    private_to: null,
    team_id: null,
    template: false,
    journal: false,
    daily_date: null,
    deleted_at: null,
    deleted_by: null,
    trashed_with: null,
    verified_by: null,
    verified_at: null,
    verified_until: null,
    kind: "page",
    database: null,
    props: {},
    canvas: null,
    seq: ++rowSeq,
    aliases: [],
    area: "wiki",
    ...DEFAULT_LOOK,
    ...fields,
  };
}

/** The best matching pages of the tree the person sees, as GET /v1/wiki/search answers. */
export function searchWiki(ws: WsData, q: string, limit = 20, area?: WikiArea): WikiSearchHit[] {
  const st = stateOf(ws);
  const v = viewerOf(ws);
  const words = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!words.length) return [];
  // Both areas unless one is asked for; Pages' only while Pages is on.
  const inArea = (r: Row) => (area ? r.area === area : r.area === "wiki" || pagesOn(ws));
  const scored = st.pages
    .filter((r) => live(v, r) && inArea(r))
    .map((r) => {
      const title = [r.title, ...r.aliases].join(" ").toLowerCase();
      const text = stripHtml(r.body_html + canvasHtml(r));
      const lower = text.toLowerCase();
      const has = (w: string, s: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "u").test(s);
      if (!words.every((w) => has(w, title) || has(w, lower))) return null;
      const score = words.reduce((n, w) => n + (has(w, title) ? 3 : 0) + (has(w, lower) ? 1 : 0), 0);
      const at = Math.max(0, lower.indexOf(words[0] ?? "") - 40);
      const snippet = text.slice(at, at + 180).trim();
      return { r, score, snippet };
    })
    .filter((x): x is { r: Row; score: number; snippet: string } => !!x)
    .sort((a, b) => b.score - a.score || Date.parse(b.r.updated_at) - Date.parse(a.r.updated_at));
  return scored.slice(0, limit).map(({ r, snippet }) => ({ ...refOf(r), parent_id: r.parent_id, snippet, path: ancestorsOf(st, r.id).map(refOf), updated_at: r.updated_at, area: r.area }));
}

const pageOf = <T>(data: T[]) => ({ data, next_cursor: null });

export function registerWiki() {
  registerPages();
  registerTrash();
  registerTemplates();
  registerPersonal();
  registerLinks();
  registerDatabases();
  registerComments();
  registerDesk();
  registerTicketWiki();
  registerPort();
  registerAnalytics();
}

function registerPages() {
  get("/v1/wiki/pages", (ctx) => {
    const st = stateOf(ctx.ws);
    const v = viewerOf(ctx.ws);
    const area = areaParam(ctx);
    const tree = buildTree(st.pages.filter((r) => live(v, r) && r.area === area).map(node));
    const out: WikiNode[] = [];
    const walk = (p: string | null) => childrenOf(tree, p).forEach((n) => (out.push(n), walk(n.id)));
    walk(null);
    return pageOf(out);
  });

  get("/v1/wiki/pages/:id", (ctx) => {
    const st = stateOf(ctx.ws);
    const r = find(ctx, st);
    if (!r.deleted_at) recordVisit(st, db.meId, r.id);
    return pageOut(st, r);
  });

  post("/v1/wiki/pages", (ctx) => {
    requireAgent(ctx);
    const st = stateOf(ctx.ws);
    const title = cleanTitle(ctx.body.title);
    const icon = cleanIcon(ctx.body.icon);
    const body = cleanBody(ctx.body.body_html);
    const aliases = ctx.body.aliases === undefined ? [] : cleanAliases(ctx.body.aliases);
    roomFor(st, 1);
    const par = parentRef(ctx, st, ctx.body.parent_id);
    let space: { owner: string | null; team: string | null };
    let template: boolean;
    let area: WikiArea;
    if (par) {
      if (par.up.length + 2 > MAX_DEPTH) throw tooDeep();
      space = { owner: par.row.private_to, team: par.row.team_id };
      // A template under a database is that database's own.
      template = par.row.template || (ctx.body.template === true && par.row.kind === "database");
      // A subpage is in its parent's area.
      area = par.row.area;
    } else {
      space = spaceRef(ctx, ctx.body.space, ctx.body.team_id);
      template = ctx.body.template === true;
      area = areaField(ctx, ctx.body.area);
    }
    const kind = ctx.body.kind ?? "";
    if (kind !== "" && kind !== "page" && kind !== "database" && kind !== "canvas") throw invalid("kind must be page, database or canvas");
    let database: Database | null = null;
    if (kind === "database") database = ctx.body.database !== undefined ? cleanDatabase(ctx.body.database, null) : defaultDatabase();
    else if (ctx.body.database !== undefined) throw dbInvalid("database goes with kind database.");
    const canvas = newCanvas(ctx, st, kind);
    let props: Record<string, DbValue> = {};
    const parDb = par?.row.database;
    if (par && parDb) {
      let refs = noRefs();
      if (ctx.body.props !== undefined) ({ props, refs } = cleanProps(ctx.body.props, parDb, props));
      checkRefs(ctx, st, refs);
      if (!template) nextRowNumbers(parDb, props);
    } else if (ctx.body.props !== undefined) throw dbInvalid("props go with a page in a database.");
    const r = newRow({
      id: uuid(),
      parent_id: par?.row.id ?? null,
      title,
      icon,
      body_html: body,
      private_to: space.owner,
      team_id: space.team,
      template,
      kind: kind === "database" || kind === "canvas" ? kind : "page",
      database,
      props,
      canvas,
      aliases,
      area,
    });
    st.pages.push(r);
    place(st, r.parent_id, r.private_to, r.team_id, r.template, r.area, r.id, typeof ctx.body.position === "number" ? ctx.body.position : undefined);
    record(st, r, false);
    pageEvent(ctx.ws, r, "wiki_page.created", eventPage(r));
    notifyBodyMentions(ctx.ws, r, "");
    return respond(201, pageOut(st, r));
  });

  patch("/v1/wiki/pages/:id", (ctx) => {
    requireAgent(ctx);
    const st = stateOf(ctx.ws);
    const r = find(ctx, st);
    if (r.deleted_at) throw inTrash();
    if (typeof ctx.body.version === "number" && ctx.body.version !== r.version)
      throw new HttpError(409, "page_changed", "Someone else changed this page since you opened it. Reload it to see their changes.");
    const next = {
      title: "title" in ctx.body ? cleanTitle(ctx.body.title) : r.title,
      icon: "icon" in ctx.body ? cleanIcon(ctx.body.icon) : r.icon,
      body_html: "body_html" in ctx.body ? cleanBody(ctx.body.body_html) : r.body_html,
    };
    const look = settingsPatch(ctx.body, settingsOf(r));
    const lookChanged = JSON.stringify(look) !== JSON.stringify(settingsOf(r));
    const textChanged = next.title !== r.title || next.icon !== r.icon || next.body_html !== r.body_html;
    const verify = verificationPatch(ctx.body);
    const data = dataPatch(ctx, st, r);
    const nextCanvas = canvasPatch(ctx, st, r);
    const nextAliases = "aliases" in ctx.body ? cleanAliases(ctx.body.aliases) : r.aliases;
    const aliasesChanged = nextAliases.join("\u0000") !== r.aliases.join("\u0000");
    if (textChanged) {
      const before = r.body_html;
      Object.assign(r, next, { version: r.version + 1, updated_by: db.meId, updated_at: nowIso() });
      record(st, r, true);
      notifyBodyMentions(ctx.ws, r, before);
    }
    if (lookChanged) Object.assign(r, look);
    const verifyChanged = applyVerification(r, verify);
    const dataChanged = applyData(st, r, data);
    const canvasChanged = applyCanvas(r, nextCanvas);
    // Aliases keep the version, like the look (contracts/wiki.md "Aliases").
    if (aliasesChanged) r.aliases = nextAliases;
    if (textChanged || lookChanged || verifyChanged || dataChanged || canvasChanged || aliasesChanged) {
      const ev = eventPage(r);
      // Readers of the page take the new look as it comes: it has no version to compare.
      if (lookChanged) ev.settings = look;
      if (verifyChanged) ev.verification = pageOut(st, r).verification;
      // A row's values and a database's schema have no version either: taken as they come.
      if (dataChanged) {
        if (r.database) ev.database = structuredClone(r.database);
        else ev.props = structuredClone(r.props);
      }
      // A canvas has no version either.
      if (canvasChanged) ev.canvas = structuredClone(r.canvas);
      if (aliasesChanged) ev.aliases = [...r.aliases];
      pageEvent(ctx.ws, r, "wiki_page.updated", ev);
    }
    return pageOut(st, r);
  });

  post("/v1/wiki/pages/:id/move", (ctx) => {
    requireAgent(ctx);
    const st = stateOf(ctx.ws);
    const r = find(ctx, st);
    if (r.deleted_at) throw inTrash();
    if (r.journal) throw new HttpError(422, "journal_fixed", "A journal stays at the top of your private pages.");
    const par = parentRef(ctx, st, ctx.body.parent_id);
    const old = { parent: r.parent_id, owner: r.private_to, team: r.team_id, template: r.template, area: r.area };
    let owner = old.owner;
    let team = old.team;
    let template = old.template;
    let area = old.area;
    if (par) {
      if (par.row.id === r.id || par.up.some((a) => a.id === r.id)) throw cycle();
      owner = par.row.private_to;
      team = par.row.team_id;
      template = par.row.template;
      area = par.row.area;
    } else {
      if (typeof ctx.body.space === "string" && ctx.body.space !== "") ({ owner, team } = spaceRef(ctx, ctx.body.space, ctx.body.team_id));
      if (ctx.body.area === "wiki" || ctx.body.area === "pages") area = areaField(ctx, ctx.body.area);
    }
    const { ids: gone, height } = subtree(st, r.id);
    if ((par ? par.up.length + 1 : 0) + height > MAX_DEPTH) throw tooDeep();
    // Only the person a private page belongs to moves it out of their own.
    if (old.owner && old.owner !== owner && old.owner !== db.meId) throw notFound("Page");
    r.parent_id = par?.row.id ?? null;
    // The pages under it live where it does now; a daily note out of its journal (or its area) is a page.
    for (const x of st.pages.filter((p) => gone.includes(p.id))) {
      if (!par?.row.journal || x.area !== area) x.daily_date = null;
      Object.assign(x, { private_to: owner, team_id: team, template, area });
    }
    place(st, r.parent_id, owner, team, template, area, r.id, typeof ctx.body.position === "number" ? ctx.body.position : 0);
    const spaceChanged = old.owner !== owner || old.team !== team || old.area !== area;
    if (old.parent !== r.parent_id || spaceChanged) place(st, old.parent, old.owner, old.team, old.template, old.area);
    if (spaceChanged) {
      // Readers of the old space drop it; readers of the new one fetch the tree again.
      pageEvent(ctx.ws, { private_to: old.owner, team_id: old.team }, "wiki_page.deleted", { wiki_page_id: r.id, wiki_page_ids: gone, moved: true });
    }
    pageEvent(ctx.ws, r, "wiki_page.moved", eventPage(r));
    return respond(200, pageOut(st, r));
  });

  del("/v1/wiki/pages/:id", (ctx) => {
    requireAgent(ctx);
    const st = stateOf(ctx.ws);
    const r = find(ctx, st);
    // Everything under it goes, whether in the tree or in the trash.
    const all = everythingUnder(st, r.id);
    canDelete(ctx, st, all);
    removeRows(st, all);
    if (!r.deleted_at) place(st, r.parent_id, r.private_to, r.team_id, r.template, r.area);
    pageEvent(ctx.ws, r, "wiki_page.deleted", { wiki_page_id: r.id, wiki_page_ids: all });
    return respond(204);
  });

  get("/v1/wiki/pages/:id/revisions", (ctx) => {
    const st = stateOf(ctx.ws);
    const r = find(ctx, st);
    const list = st.revisions.filter((x) => x.page_id === r.id).sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
    return pageOf(list.map((x) => revOut(x, false)));
  });

  get("/v1/wiki/pages/:id/revisions/:rid", (ctx) => {
    const st = stateOf(ctx.ws);
    const r = find(ctx, st);
    const x = st.revisions.find((v) => v.page_id === r.id && v.id === ctx.params.rid);
    if (!x) throw notFound("Revision");
    return revOut(x, true);
  });

  post("/v1/wiki/pages/:id/revisions/:rid/restore", (ctx) => {
    requireAgent(ctx);
    const st = stateOf(ctx.ws);
    const r = find(ctx, st);
    if (r.deleted_at) throw inTrash();
    const x = st.revisions.find((v) => v.page_id === r.id && v.id === ctx.params.rid);
    if (!x) throw notFound("Revision");
    Object.assign(r, { title: x.title, icon: x.icon, body_html: x.body_html, version: r.version + 1, updated_by: db.meId, updated_at: nowIso() });
    record(st, r, false);
    pageEvent(ctx.ws, r, "wiki_page.updated", eventPage(r));
    return respond(200, pageOut(st, r));
  });

  post("/v1/wiki/unfurl", (ctx) => {
    requireAgent(ctx);
    const url = s(ctx, "url")?.trim() ?? "";
    if (!/^https:\/\//i.test(url)) throw invalid("url must start with https://");
    const host = new URL(url).hostname.replace(/^www\./, "");
    const name = host.split(".")[0] ?? host;
    return { title: `${name.charAt(0).toUpperCase()}${name.slice(1)}: ${decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() ?? "home").replace(/[-_]/g, " ")}`, description: `A page on ${host}.`, image: "", site: host };
  });

  get("/v1/wiki/search", (ctx) => {
    const q = ctx.query.get("q") ?? "";
    const limit = Math.min(Number(ctx.query.get("limit") ?? 20) || 20, 50);
    return pageOf(searchWiki(ctx.ws, q, limit, ctx.query.get("area") ? areaParam(ctx) : undefined));
  });
}

// ─── Databases (database.go, rows.go) ──────────────────────────────────────
// A page that is a database keeps its properties and views; its rows are its subpages, each
// holding values of the properties. Filters, sorts, groups, formulas and rollups are the
// app's to compute: the API keeps the schema and the values, each checked against its type.

const PROP_TYPES: readonly DbPropType[] = [
  "title",
  "text",
  "number",
  "select",
  "multi_select",
  "status",
  "date",
  "person",
  "checkbox",
  "url",
  "email",
  "phone",
  "files",
  "relation",
  "rollup",
  "formula",
  "created_time",
  "created_by",
  "edited_time",
  "edited_by",
  "unique_id",
  "ticket",
];
/** Types whose value is computed, never stored on a row. */
const COMPUTED_TYPES: readonly DbPropType[] = ["title", "rollup", "formula", "created_time", "created_by", "edited_time", "edited_by", "unique_id"];
const VIEW_TYPES: readonly string[] = ["table", "board", "list", "gallery", "calendar", "timeline", "chart", "form"];
const TONES: readonly string[] = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];
const ROLLUP_FNS: readonly string[] = [
  "show_original",
  "count",
  "count_values",
  "count_unique",
  "count_empty",
  "count_not_empty",
  "percent_empty",
  "percent_not_empty",
  "sum",
  "avg",
  "median",
  "min",
  "max",
  "range",
  "earliest",
  "latest",
  "checked",
  "unchecked",
  "percent_checked",
];
const NUMBER_FORMATS: readonly string[] = ["number", "comma", "percent", "usd", "eur", "gbp", "jpy", "chf", "cad", "aud", "inr", "brl", "huf", "pln"];
const PROP_ID = /^[a-z0-9_]{1,24}$/;
const MAX_DATABASE_BYTES = 128 << 10;
const MAX_PROPS_BYTES = 64 << 10;
const MAX_PROPERTIES = 100;
const MAX_VIEWS = 50;
const MAX_OPTIONS = 200;
const MAX_REFS = 100;

/** A new database: a title and tags, seen as a table. */
const defaultDatabase = (): Database => ({
  properties: [
    { id: "title", name: "Name", type: "title" },
    { id: "tags", name: "Tags", type: "multi_select" },
  ],
  views: [{ id: "table", name: "Table", type: "table" }],
  next_id: 1,
});

const dbInvalid = (detail: string) => new HttpError(422, "invalid_database", detail);
const runes = (s: string) => [...s].length;
const shortText = (s: string, max: number) => runes(s) <= max && !s.includes("\0");
const fields = (s: string) => s.split(/\s+/).filter(Boolean).join(" ");
const jsonBytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v) ?? "").length;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// Reading a schema as Go's json.Unmarshal reads it into the API's types: null is the zero
// value, a value of the wrong JSON type is refused, unknown fields are dropped.
const shapeError = (at: string) => dbInvalid(`The database isn't valid: ${at} has the wrong type.`);
const readStr = (v: unknown, at: string): string => {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") throw shapeError(at);
  return v;
};
const readObj = (v: unknown, at: string): Record<string, unknown> => {
  if (v === undefined || v === null) return {};
  if (!isObject(v)) throw shapeError(at);
  return v;
};
const readList = <T>(v: unknown, at: string, each: (x: unknown, at: string) => T): T[] => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw shapeError(at);
  return v.map((x, i) => each(x, `${at}[${i}]`));
};

function readProperty(v: unknown, at: string): DbProperty {
  const o = readObj(v, at);
  const p: DbProperty = { id: readStr(o.id, `${at}.id`), name: readStr(o.name, `${at}.name`), type: readStr(o.type, `${at}.type`) as DbPropType };
  const options = readList(o.options, `${at}.options`, (x, a): DbOption => {
    const opt = readObj(x, a);
    return { id: readStr(opt.id, `${a}.id`), name: readStr(opt.name, `${a}.name`), color: readStr(opt.color, `${a}.color`) as DbOption["color"] };
  });
  if (options.length) p.options = options;
  const groups = readList(o.groups, `${at}.groups`, (x, a): DbStatusGroup => {
    const g = readObj(x, a);
    return { id: readStr(g.id, `${a}.id`) as DbStatusGroup["id"], option_ids: readList(g.option_ids, `${a}.option_ids`, readStr) };
  });
  if (groups.length) p.groups = groups;
  const format = readStr(o.number_format, `${at}.number_format`);
  if (format) p.number_format = format as DbProperty["number_format"];
  if (o.date_time !== undefined && o.date_time !== null && typeof o.date_time !== "boolean") throw shapeError(`${at}.date_time`);
  if (o.date_time) p.date_time = true;
  if (o.database_id !== undefined && o.database_id !== null) {
    const id = typeof o.database_id === "string" ? parseUUID(o.database_id) : undefined;
    if (!id) throw shapeError(`${at}.database_id`);
    p.database_id = id;
  }
  if (o.rollup !== undefined && o.rollup !== null) {
    const r = readObj(o.rollup, `${at}.rollup`);
    p.rollup = { relation: readStr(r.relation, `${at}.rollup.relation`), property: readStr(r.property, `${at}.rollup.property`), fn: readStr(r.fn, `${at}.rollup.fn`) as NonNullable<DbProperty["rollup"]>["fn"] };
  }
  for (const k of ["formula", "prefix", "description"] as const) {
    const t = readStr(o[k], `${at}.${k}`);
    if (t) p[k] = t;
  }
  return p;
}

function readView(v: unknown, at: string): DbView {
  const o = readObj(v, at);
  const view: DbView = { id: readStr(o.id, `${at}.id`), name: readStr(o.name, `${at}.name`), type: readStr(o.type, `${at}.type`) as DbView["type"] };
  const settings = readObj(o.settings, `${at}.settings`);
  if (Object.keys(settings).length) view.settings = structuredClone(settings) as DbView["settings"];
  return view;
}

/** cleanDatabase: checks a database's schema. prev keeps the unique-id counter, which only the API moves. */
function cleanDatabase(raw: unknown, prev: Database | null): Database {
  if (jsonBytes(raw) > MAX_DATABASE_BYTES) throw dbInvalid("A database's properties and views hold up to 128 KB.");
  const o = readObj(raw, "database");
  if (o.next_id !== undefined && o.next_id !== null && !Number.isInteger(o.next_id)) throw shapeError("next_id");
  const db: Database = { properties: readList(o.properties, "properties", readProperty), views: readList(o.views, "views", readView), next_id: 1 };
  if (o.sub_items !== undefined && o.sub_items !== null) {
    const x = readObj(o.sub_items, "sub_items");
    db.sub_items = { parent: readStr(x.parent, "sub_items.parent"), children: readStr(x.children, "sub_items.children") };
  }
  if (o.dependencies !== undefined && o.dependencies !== null) {
    const x = readObj(o.dependencies, "dependencies");
    db.dependencies = { blocked_by: readStr(x.blocked_by, "dependencies.blocked_by"), blocking: readStr(x.blocking, "dependencies.blocking") };
  }
  if (db.properties.length === 0 || db.properties.length > MAX_PROPERTIES) throw dbInvalid("A database has 1 to 100 properties.");
  if (db.views.length === 0 || db.views.length > MAX_VIEWS) throw dbInvalid("A database has 1 to 50 views.");
  const seen = new Set<string>();
  let titles = 0;
  for (const p of db.properties) {
    p.name = fields(p.name);
    if (!PROP_ID.test(p.id) || seen.has(p.id)) throw dbInvalid("Each property needs its own id of 1 to 24 lowercase letters, digits or _.");
    seen.add(p.id);
    if (p.name === "" || !shortText(p.name, 100)) throw dbInvalid("Each property needs a name of 1 to 100 characters.");
    if (!PROP_TYPES.includes(p.type)) throw dbInvalid(`${JSON.stringify(p.type)} isn't a property type.`);
    if (p.type === "title") titles++;
    if (!shortText(p.description ?? "", 500) || !shortText(p.prefix ?? "", 10) || !shortText(p.formula ?? "", 4000))
      throw dbInvalid("A property's description, prefix or formula is too long.");
    switch (p.type) {
      case "select":
      case "multi_select":
      case "status": {
        const options = p.options ?? [];
        if (options.length > MAX_OPTIONS) throw dbInvalid("A property has up to 200 options.");
        const ids = new Set<string>();
        for (const o of options) {
          o.name = fields(o.name);
          if (!PROP_ID.test(o.id) || ids.has(o.id) || o.name === "" || !shortText(o.name, 100) || !TONES.includes(o.color))
            throw dbInvalid("Each option needs its own id, a name of 1 to 100 characters and a colour.");
          ids.add(o.id);
        }
        if (p.type === "status") {
          for (const g of p.groups ?? []) {
            if (!["todo", "doing", "done"].includes(g.id)) throw dbInvalid("A status group is todo, doing or done.");
            if (g.option_ids.some((id) => !ids.has(id))) throw dbInvalid("A status group names an option the property doesn't have.");
          }
        }
        break;
      }
      case "number":
        if (p.number_format && !NUMBER_FORMATS.includes(p.number_format)) throw dbInvalid(`${JSON.stringify(p.number_format)} isn't a number format.`);
        break;
      case "relation":
        if (!p.database_id) throw dbInvalid("A relation names the database it relates to.");
        break;
      case "rollup":
        if (!p.rollup || !ROLLUP_FNS.includes(p.rollup.fn) || !PROP_ID.test(p.rollup.relation) || !PROP_ID.test(p.rollup.property))
          throw dbInvalid("A rollup names a relation, a property of the related pages and how to sum them up.");
        break;
    }
  }
  if (titles !== 1 || db.properties[0]?.type !== "title") throw dbInvalid("A database's first property is its title, and it has only one.");
  for (const p of db.properties) {
    if (p.type !== "rollup") continue;
    const rel = db.properties.find((x) => x.id === p.rollup?.relation);
    if (rel?.type !== "relation") throw dbInvalid("A rollup's relation is a relation property of the database.");
  }
  checkPairs(db);
  const views = new Set<string>();
  for (const v of db.views) {
    v.name = fields(v.name);
    if (!PROP_ID.test(v.id) || views.has(v.id) || v.name === "" || !shortText(v.name, 100) || !VIEW_TYPES.includes(v.type))
      throw dbInvalid("Each view needs its own id, a name of 1 to 100 characters and a type.");
    views.add(v.id);
  }
  db.next_id = prev ? Math.max(prev.next_id, 1) : 1;
  return db;
}

/**
 * checkPairs: sub-items and dependencies each name two different relation properties of the
 * database that relate to the same database, none of them used twice.
 */
function checkPairs(db: Database) {
  const pairs: [string, string][] = [];
  if (db.sub_items) pairs.push([db.sub_items.parent, db.sub_items.children]);
  if (db.dependencies) pairs.push([db.dependencies.blocked_by, db.dependencies.blocking]);
  const used = new Set<string>();
  for (const pair of pairs) {
    let target: string | undefined;
    for (const id of pair) {
      const p = db.properties.find((x) => x.id === id);
      if (p?.type !== "relation" || used.has(id)) throw dbInvalid("Sub-items and dependencies each name two relation properties of the database.");
      used.add(id);
      if (target !== undefined && target !== p.database_id) throw dbInvalid("Sub-items and dependencies relate the database to itself.");
      target = p.database_id;
    }
  }
}

/** The people, related pages (by the database they must be rows of) and tickets a row's values name. */
type PropRefs = { users: string[]; tickets: string[]; pages: Map<string, string[]> };
const noRefs = (): PropRefs => ({ users: [], tickets: [], pages: new Map() });

/**
 * cleanProps: checks a row's values against its database's properties and merges them into
 * cur: a value of null takes it away; values of computed or unknown properties are refused.
 */
function cleanProps(raw: unknown, database: Database, cur: Record<string, DbValue>): { props: Record<string, DbValue>; refs: PropRefs } {
  const refs = noRefs();
  if (jsonBytes(raw) > MAX_PROPS_BYTES) throw dbInvalid("A row's values hold up to 64 KB.");
  if (raw !== null && !isObject(raw)) throw dbInvalid("props is an object of property ids to values.");
  const out: Record<string, DbValue> = { ...cur };
  const byId = new Map(database.properties.map((p) => [p.id, p]));
  for (const [id, v] of Object.entries(raw ?? {})) {
    const p = byId.get(id);
    if (!p) throw dbInvalid(`The database has no property ${JSON.stringify(id)}.`);
    if (COMPUTED_TYPES.includes(p.type)) throw dbInvalid(`${p.name} is worked out by the database, not set.`);
    if (v === null || v === undefined) {
      delete out[id];
      continue;
    }
    const value = cleanValue(p, v, refs);
    if (database.sub_items && id === database.sub_items.parent && Array.isArray(value) && value.length > 1) throw dbInvalid(`${p.name} names one parent item at most.`);
    out[id] = value;
  }
  // Values of properties the database no longer has are dropped.
  for (const k of Object.keys(out)) if (!byId.has(k)) delete out[k];
  return { props: out, refs };
}

// Go's RE2 \s is [\t\n\f\r ].
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const RFC3339 = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/;
const EMAILISH = /^[^\t\n\f\r @]{1,64}@[^\t\n\f\r @]{1,255}$/u;
const PHONEISH = /^[0-9+()./\t\n\f\r -]{1,40}$/;
const WIKI_SRC = /^(https:\/\/[^\s"'<>]+|\/v1\/attachments\/[0-9a-f-]{36}(\?[^\s"'<>]*)?)$/i;
const TEXT_LIMITS: Record<string, number> = { text: 10000, url: 2000, email: 320, phone: 40 };

function validDate(s: string): boolean {
  if (ISO_DAY.test(s)) return isDate(s);
  const m = RFC3339.exec(s);
  if (!m || !isDate(m[1])) return false;
  const [h, min, sec] = [Number(m[2]), Number(m[3]), Number(m[4])];
  const zone = m[7] === undefined || (Number(m[7]) < 24 && Number(m[8]) < 60);
  return h < 24 && min < 60 && sec < 60 && zone;
}

function cleanValue(p: DbProperty, v: unknown, refs: PropRefs): DbValue {
  const bad = () => dbInvalid(`${p.name} doesn't take that value.`);
  const optionIds = (p.options ?? []).map((o) => o.id);
  const ids = (): string[] => {
    if (!Array.isArray(v) || v.length > MAX_REFS) throw bad();
    const out: string[] = [];
    for (const x of v) {
      const id = typeof x === "string" ? parseUUID(x) : undefined;
      if (!id) throw bad();
      if (!out.includes(id)) out.push(id);
    }
    return out;
  };
  switch (p.type) {
    case "text":
    case "url":
    case "email":
    case "phone": {
      if (typeof v !== "string") throw bad();
      const s = v.trim();
      const limit = TEXT_LIMITS[p.type]!;
      if (!shortText(s, limit)) throw dbInvalid(`${p.name} holds up to ${limit} characters.`);
      if (s === "") return null;
      if (p.type === "url") {
        let u: URL | undefined;
        try {
          u = new URL(s);
        } catch {
          u = undefined;
        }
        if (!u || (u.protocol !== "https:" && u.protocol !== "http:") || !u.host) throw dbInvalid(`${p.name} takes a web address.`);
      }
      if (p.type === "email" && !EMAILISH.test(s)) throw dbInvalid(`${p.name} takes an email address.`);
      if (p.type === "phone" && !PHONEISH.test(s)) throw dbInvalid(`${p.name} takes a phone number.`);
      return s;
    }
    case "number":
      if (typeof v !== "number" || !Number.isFinite(v)) throw bad();
      return v;
    case "checkbox":
      if (typeof v !== "boolean") throw bad();
      return v;
    case "select":
    case "status":
      if (typeof v !== "string" || !optionIds.includes(v)) throw bad();
      return v;
    case "multi_select": {
      if (!Array.isArray(v) || v.length > MAX_OPTIONS) throw bad();
      const out: string[] = [];
      for (const x of v) {
        if (typeof x !== "string" || !optionIds.includes(x)) throw bad();
        if (!out.includes(x)) out.push(x);
      }
      return out;
    }
    case "date": {
      const wrong = () => dbInvalid(`${p.name} takes a day (YYYY-MM-DD) or a moment (RFC 3339), and an end.`);
      if (!isObject(v)) throw wrong();
      const start = v.start ?? "";
      const end = v.end ?? undefined;
      if (typeof start !== "string" || !validDate(start) || (end !== undefined && (typeof end !== "string" || !validDate(end)))) throw wrong();
      const d: DbDate = { start };
      if (end !== undefined) d.end = end;
      return d;
    }
    case "files": {
      if (!Array.isArray(v) || v.length > 50) throw bad();
      return v.map((x): DbFile => {
        if (x !== null && !isObject(x)) throw bad();
        const url = x?.url ?? "";
        const name = x?.name ?? "";
        if (typeof url !== "string" || typeof name !== "string") throw bad();
        if (!WIKI_SRC.test(url) || !shortText(name, 255)) throw dbInvalid(`${p.name} takes uploaded files or https links.`);
        return { url, name };
      });
    }
    case "person": {
      const list = ids();
      refs.users.push(...list);
      return list;
    }
    case "relation": {
      const list = ids();
      const dbId = p.database_id!;
      refs.pages.set(dbId, [...(refs.pages.get(dbId) ?? []), ...list]);
      return list;
    }
    case "ticket": {
      const list = ids();
      refs.tickets.push(...list);
      return list;
    }
  }
  throw bad();
}

/**
 * checkRefs: a row's values name only the workspace's members, rows of the related
 * databases the viewer may see, and tickets the viewer may see.
 */
function checkRefs(ctx: Ctx, st: State, refs: PropRefs) {
  const uniq = (list: string[]) => [...new Set(list)];
  const users = uniq(refs.users);
  if (users.some((u) => !ctx.ws.members.some((m) => m.user_id === u))) throw dbInvalid("A person property names someone who isn't a member of this workspace.");
  const v = viewerOf(ctx.ws);
  for (const [database, pages] of refs.pages) {
    const ok = (id: string) => st.pages.some((r) => r.id === id && r.parent_id === database && !r.deleted_at && !r.template && sees(v, r));
    if (!uniq(pages).every(ok)) throw dbInvalid("A relation names a page that isn't a row of its database.");
  }
  const ticketOk = (id: string) => ctx.ws.tickets.some((t) => t.id === id && (!t.team_id || !v.hidden.has(t.team_id)));
  if (!uniq(refs.tickets).every(ticketOk)) throw dbInvalid("A ticket property names a ticket that isn't in this workspace.");
}

/** nextRowNumbers: a new row of the database gets its unique ids (one per unique id property), and the counter moves. */
function nextRowNumbers(database: Database, props: Record<string, DbValue>) {
  const uniqueIds = database.properties.filter((p) => p.type === "unique_id");
  if (!uniqueIds.length) return;
  for (const p of uniqueIds) props[p.id] = database.next_id;
  database.next_id++;
}

/** numberRows: every row of a database gets a unique id it lacks for the unique id properties ids (added after the rows were), oldest first. */
function numberRows(st: State, dbId: string, database: Database, ids: string[]) {
  if (!ids.length) return;
  const rows = st.pages.filter((r) => r.parent_id === dbId && !r.template).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.seq - b.seq);
  for (const r of rows) {
    for (const id of ids) if (!(id in r.props)) r.props[id] = database.next_id;
    database.next_id++;
  }
}

/** JSON with every object's keys sorted, as Go marshals a map: equal values compare equal. */
const canonical = (v: unknown) => JSON.stringify(v, (_k, x: unknown) => (isObject(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));

type DataPatch = { database?: Database; props?: Record<string, DbValue> };

/** The schema or values a PATCH asks for, checked before anything changes (applyData's checks). */
function dataPatch(ctx: Ctx, st: State, r: Row): DataPatch {
  const out: DataPatch = {};
  if (ctx.body.database !== undefined) {
    if (r.kind !== "database" || !r.database) throw dbInvalid("Only a database has properties and views.");
    out.database = cleanDatabase(ctx.body.database, r.database);
  }
  if (ctx.body.props !== undefined) {
    const parentDb = r.parent_id ? st.pages.find((p) => p.id === r.parent_id)?.database : null;
    if (!parentDb) throw dbInvalid("Only a database's rows have values.");
    const { props, refs } = cleanProps(ctx.body.props, parentDb, r.props);
    checkRefs(ctx, st, refs);
    out.props = props;
  }
  return out;
}

/**
 * applyData: replaces a database's schema or changes a row's values; whether anything
 * changed. Neither moves the version nor adds a revision; a row's values do move its last edit.
 */
function applyData(st: State, r: Row, data: DataPatch): boolean {
  let changed = false;
  if (data.database && r.database) {
    const prev = r.database;
    // A unique id property added now numbers the rows already there.
    const added = data.database.properties.filter((np) => np.type === "unique_id" && !prev.properties.some((x) => x.id === np.id && x.type === "unique_id")).map((p) => p.id);
    numberRows(st, r.id, data.database, added);
    r.database = data.database;
    changed = true;
  }
  if (data.props && canonical(data.props) !== canonical(r.props)) {
    Object.assign(r, { props: data.props, updated_by: db.meId, updated_at: nowIso() });
    changed = true;
  }
  return changed;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const unescapeHtml = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? m;
    const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
  });

/** hd.Excerpt: the text's first n characters, cut at a word when one ends past the middle. */
function excerpt(text: string, n: number): string {
  const s = fields(text);
  const chars = [...s];
  if (chars.length <= n) return s;
  let out = chars.slice(0, n).join("");
  const i = out.lastIndexOf(" ");
  if (i > n / 2) out = out.slice(0, i);
  return `${out.replace(/[ ,.;:]+$/, "")}…`;
}

function registerDatabases() {
  get("/v1/wiki/databases/:id/rows", (ctx): DbRows => {
    const st = stateOf(ctx.ws);
    const d = find(ctx, st);
    if (d.kind !== "database") throw notFound("Database");
    const under = st.pages.filter((r) => r.parent_id === d.id && !r.deleted_at).sort(byPosition);
    const data = under
      .filter((r) => !r.template)
      .map(
        (r): DbRow => ({
          ...node(r),
          props: structuredClone(r.props),
          cover: r.cover,
          cover_y: r.cover_y,
          excerpt: excerpt(unescapeHtml(fields(r.body_html.replace(/<[^>]+>/g, " ")).slice(0, 400)), 280),
          created_at: r.created_at,
          created_by: userRef(r.created_by),
          updated_by: userRef(r.updated_by),
        }),
      );
    return { data, templates: under.filter((r) => r.template).map(node) };
  });
}

// ─── Canvas (canvas.go) ────────────────────────────────────────────────────
// A page that is a canvas keeps cards (text, pages, links, files, groups) and connections
// between them, checked as cleanCanvas checks them. Text cards are wiki HTML; the cards
// count as the page's text for links, tags and search.

const CANVAS_TYPES = new Set(["text", "page", "link", "file", "group"]);
const CANVAS_SIDES = new Set(["top", "right", "bottom", "left"]);
const CANVAS_ENDS = new Set(["none", "arrow"]);
const CANVAS_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CANVAS_COLOR = /^(?:[1-6]|#[0-9a-fA-F]{6})$/;
const canvasInvalid = (detail: string) => new HttpError(422, "invalid_canvas", detail);
const finiteIn = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
const optStr = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : "\u0000");

/** The text the API indexes for a canvas: its text cards, and a link to each page card. */
function canvasHtml(r: Pick<Row, "canvas">): string {
  if (!r.canvas) return "";
  return r.canvas.nodes
    .map((n) => (n.type === "text" ? n.html : n.type === "page" ? `<a href="/wiki/${n.page_id}"></a>` : n.type === "group" ? `<p>${escapeHtml(n.label ?? "")}</p>` : n.type === "link" ? `<p>${escapeHtml(n.title ?? "")}</p>` : ""))
    .concat(r.canvas.edges.map((e) => (e.label ? `<p>${escapeHtml(e.label)}</p>` : "")))
    .join(" ");
}

function cleanCanvas(ctx: Ctx, st: State, raw: unknown, prev: Canvas | null): Canvas {
  if (jsonBytes(raw) > 1 << 20) throw canvasInvalid("A canvas holds up to 1 MB.");
  if (!isObject(raw)) throw canvasInvalid("A canvas is an object with nodes and edges.");
  const rawNodes = raw.nodes ?? [];
  const rawEdges = raw.edges ?? [];
  if (!Array.isArray(rawNodes) || !Array.isArray(rawEdges)) throw canvasInvalid("The canvas isn't valid: nodes and edges are lists.");
  if (rawNodes.length > 2000) throw canvasInvalid("A canvas holds up to 2,000 cards.");
  if (rawEdges.length > 4000) throw canvasInvalid("A canvas holds up to 4,000 connections.");
  const had = new Set((prev?.nodes ?? []).flatMap((n) => (n.type === "page" ? [`page:${n.page_id}`] : n.type === "file" ? [`file:${n.src}`] : [])));
  const v = viewerOf(ctx.ws);
  const ids = new Set<string>();
  const nodes = rawNodes.map((x): CanvasNode => {
    if (!isObject(x)) throw canvasInvalid("The canvas isn't valid: a card is an object.");
    const id = optStr(x.id);
    if (!CANVAS_ID.test(id) || ids.has(id)) throw canvasInvalid("Each card needs its own id of 1 to 64 letters, digits, _ or -.");
    ids.add(id);
    if (!finiteIn(x.x, -1e6, 1e6) || !finiteIn(x.y, -1e6, 1e6)) throw canvasInvalid("A card sits within a million points of the middle.");
    if (!finiteIn(x.width, 20, 20000) || !finiteIn(x.height, 20, 20000)) throw canvasInvalid("A card is 20 to 20,000 points wide and high.");
    const color = optStr(x.color);
    if (color && !CANVAS_COLOR.test(color)) throw canvasInvalid("A colour is 1 to 6 or #rrggbb.");
    const base = { id, x: x.x, y: x.y, width: x.width, height: x.height, ...(color ? { color } : {}) };
    const type = optStr(x.type);
    if (!CANVAS_TYPES.has(type)) throw canvasInvalid(`"${type}" isn't a card type.`);
    switch (type) {
      case "text":
        return { ...base, type: "text", html: cleanBody(typeof x.html === "string" ? x.html : "") };
      case "page": {
        const pid = parseUUID(optStr(x.page_id));
        if (!pid) throw canvasInvalid("A page card needs page_id.");
        if (!had.has(`page:${pid}`)) {
          const target = st.pages.find((r) => r.id === pid);
          if (!target || target.deleted_at || !sees(v, target)) throw canvasInvalid("A page card names a page that isn't in this workspace.");
        }
        return { ...base, type: "page", page_id: pid };
      }
      case "link": {
        const url = optStr(x.url).trim();
        let ok = url.length <= 2000 && /^https:\/\//i.test(url) && !/[\s"'<>]/.test(url);
        try {
          ok = ok && !!new URL(url).hostname;
        } catch {
          ok = false;
        }
        if (!ok) throw canvasInvalid("A link card needs an https address.");
        const title = optStr(x.title);
        const description = optStr(x.description);
        const image = optStr(x.image);
        if ((image && (image.length > 2000 || !WIKI_SRC.test(image))) || !shortText(title, 300) || !shortText(description, 500))
          throw canvasInvalid("A link card's title, description or image isn't valid.");
        return { ...base, type: "link", url, ...(fields(title) ? { title: fields(title) } : {}), ...(fields(description) ? { description: fields(description) } : {}), ...(image ? { image } : {}) };
      }
      case "file": {
        const src = optStr(x.src);
        const name = optStr(x.name);
        if (!src || src.length > 2000 || !WIKI_SRC.test(src) || !shortText(name, 255))
          throw canvasInvalid("A file card needs an uploaded file or an https address, and a name of up to 255 characters.");
        return { ...base, type: "file", src, name: name.trim() };
      }
      default: {
        const label = optStr(x.label);
        if (!shortText(label, 200)) throw canvasInvalid("A group's label is up to 200 characters.");
        return { ...base, type: "group", ...(fields(label) ? { label: fields(label) } : {}) };
      }
    }
  });
  const edgeIds = new Set<string>();
  const edges = rawEdges.map((x): CanvasEdge => {
    if (!isObject(x)) throw canvasInvalid("The canvas isn't valid: a connection is an object.");
    const id = optStr(x.id);
    if (!CANVAS_ID.test(id) || edgeIds.has(id)) throw canvasInvalid("Each connection needs its own id of 1 to 64 letters, digits, _ or -.");
    edgeIds.add(id);
    const from = optStr(x.fromNode);
    const to = optStr(x.toNode);
    if (!ids.has(from) || !ids.has(to)) throw canvasInvalid("A connection joins two cards of the canvas.");
    const [fromSide, toSide, fromEnd, toEnd, color, label] = [x.fromSide, x.toSide, x.fromEnd, x.toEnd, x.color, x.label].map(optStr) as string[];
    if ((fromSide && !CANVAS_SIDES.has(fromSide)) || (toSide && !CANVAS_SIDES.has(toSide))) throw canvasInvalid("A side is top, right, bottom or left.");
    if ((fromEnd && !CANVAS_ENDS.has(fromEnd)) || (toEnd && !CANVAS_ENDS.has(toEnd))) throw canvasInvalid("An end is none or arrow.");
    if (color && !CANVAS_COLOR.test(color)) throw canvasInvalid("A colour is 1 to 6 or #rrggbb.");
    if (!shortText(label!, 200)) throw canvasInvalid("A connection's label is up to 200 characters.");
    return {
      id,
      fromNode: from,
      ...(fromSide ? { fromSide: fromSide as CanvasEdge["fromSide"] } : {}),
      ...(fromEnd && fromEnd !== "none" ? { fromEnd: fromEnd as CanvasEdge["fromEnd"] } : {}),
      toNode: to,
      ...(toSide ? { toSide: toSide as CanvasEdge["toSide"] } : {}),
      ...(toEnd && toEnd !== "arrow" ? { toEnd: toEnd as CanvasEdge["toEnd"] } : {}),
      ...(color ? { color } : {}),
      ...(fields(label!) ? { label: fields(label!) } : {}),
    };
  });
  return { nodes, edges };
}

/** A new page's canvas: empty unless one is sent, and only for kind canvas. */
function newCanvas(ctx: Ctx, st: State, kind: string): Canvas | null {
  if (kind === "canvas") return ctx.body.canvas !== undefined ? cleanCanvas(ctx, st, ctx.body.canvas, null) : { nodes: [], edges: [] };
  if (ctx.body.canvas !== undefined) throw canvasInvalid("canvas goes with kind canvas.");
  return null;
}

/** A PATCH's canvas, checked before anything changes; undefined when it sends none. */
function canvasPatch(ctx: Ctx, st: State, r: Row): Canvas | undefined {
  if (ctx.body.canvas === undefined) return undefined;
  if (r.kind !== "canvas") throw canvasInvalid("Only a canvas has cards.");
  return cleanCanvas(ctx, st, ctx.body.canvas, r.canvas);
}

/** Replaces a canvas: keeps the version, moves the last edit. */
function applyCanvas(r: Row, next: Canvas | undefined): boolean {
  if (!next || canonical(next) === canonical(r.canvas)) return false;
  Object.assign(r, { canvas: next, updated_by: db.meId, updated_at: nowIso() });
  return true;
}

/** The handbook's first response map: a canvas of steps, the pages they lean on, and a group. */
function seedCanvas(st: State, person: (i: number) => string | null) {
  const top = st.pages.filter((r) => !r.parent_id && !r.template && r.kind === "page").sort(byPosition);
  const [first, second] = top;
  const at = ago(2 * DAY);
  const card = (id: string, x: number, y: number, width: number, height: number) => ({ id, x, y, width, height });
  const nodes: CanvasNode[] = [
    { ...card("tier1", -40, -60, 680, 420), type: "group", label: "Tier 1: the first hour" },
    { ...card("start", 0, 0, 260, 120), type: "text", html: "<h3>A customer is blocked</h3><p>Reply within 15 minutes, even if it is only to say you are on it. #escalation</p>", color: "4" },
    { ...card("check", 340, 0, 260, 140), type: "text", html: "<p><strong>Can you fix it yourself?</strong></p><ul><li><p>Known issue: link it</p></li><li><p>Config: walk them through</p></li></ul>" },
    { ...card("page", 340, 200, 260, 140), type: "text", html: "<p>Still stuck after an hour: page the on-call engineer and tell the customer when you will write next.</p>", color: "1" },
    { ...card("tier2", 760, -60, 420, 420), type: "group", label: "Tier 2", color: "6" },
  ];
  const edges: CanvasEdge[] = [
    { id: "e1", fromNode: "start", fromSide: "right", toNode: "check", toSide: "left" },
    { id: "e2", fromNode: "check", fromSide: "bottom", toNode: "page", toSide: "top", label: "no" },
  ];
  if (first) {
    nodes.push({ ...card("ref1", 800, 0, 340, 150), type: "page", page_id: first.id });
    edges.push({ id: "e3", fromNode: "page", fromSide: "right", toNode: "ref1", toSide: "left", color: "6" });
  }
  if (second) nodes.push({ ...card("ref2", 800, 180, 340, 150), type: "page", page_id: second.id });
  nodes.push({ ...card("status", 0, 420, 320, 120), type: "link", url: "https://status.example.com", title: "Status page", description: "What customers see when something is down." });
  const by = person(0);
  const r = newRow({ id: uuid(), parent_id: null, title: "First response map", icon: "🗺️", body_html: "", position: top.length, created_by: by, updated_by: by, created_at: ago(9 * DAY), updated_at: at, kind: "canvas", canvas: { nodes, edges } });
  st.pages.push(r);
  st.revisions.push({ id: uuid(), page_id: r.id, title: r.title, icon: r.icon, body_html: "", author: by, created_at: r.created_at, updated_at: r.created_at });
}

// ─── The trash (trash.go) ──────────────────────────────────────────────────

function registerTrash() {
  post("/v1/wiki/pages/:id/trash", (ctx) => {
    requireAgent(ctx);
    const st = stateOf(ctx.ws);
    const r = find(ctx, st);
    if (r.deleted_at) throw inTrash();
    const { ids: gone } = subtree(st, r.id);
    canDelete(ctx, st, gone);
    const at = nowIso();
    for (const x of st.pages) if (gone.includes(x.id)) Object.assign(x, { deleted_at: at, deleted_by: db.meId, trashed_with: r.id });
    // Favorites of pages in the trash would point nowhere.
    for (const [user, list] of st.favorites) st.favorites.set(user, list.filter((id) => !gone.includes(id)));
    place(st, r.parent_id, r.private_to, r.team_id, r.template, r.area);
    pageEvent(ctx.ws, r, "wiki_page.deleted", { wiki_page_id: r.id, wiki_page_ids: gone, trashed: true });
    return respond(200, pageOut(st, r));
  });

  post("/v1/wiki/pages/:id/restore", (ctx) => {
    requireAgent(ctx);
    const st = stateOf(ctx.ws);
    const r = find(ctx, st);
    if (!r.trashed_with) throw new HttpError(422, "not_in_trash", "This page isn't in the trash.");
    if (r.trashed_with !== r.id) throw new HttpError(422, "trashed_with_parent", "This page went to the trash with a page above it. Restore that one.");
    const { ids: back, height } = subtree(st, r.id);
    // Back under its parent while that is in the tree; else at the top of its space.
    const parent = r.parent_id ? st.pages.find((p) => p.id === r.parent_id && !p.deleted_at) : undefined;
    const par = parent && ancestorsOf(st, parent.id).length + 1 + height <= MAX_DEPTH ? parent.id : null;
    const rows = st.pages.filter((p) => back.includes(p.id));
    for (const x of rows) Object.assign(x, { deleted_at: null, deleted_by: null, trashed_with: null });
    r.parent_id = par;
    // A journal or a daily note restored next to a live one becomes a plain page.
    const clash = (x: Row) =>
      st.pages.some(
        (o) =>
          o.id !== x.id && !o.deleted_at && x.private_to !== null && o.private_to === x.private_to && o.area === x.area && ((x.journal && o.journal) || (x.daily_date !== null && o.daily_date === x.daily_date)),
      );
    for (const x of rows.filter(clash)) Object.assign(x, { journal: false, daily_date: null });
    place(st, par, r.private_to, r.team_id, r.template, r.area, r.id);
    pageEvent(ctx.ws, r, "wiki_page.restored", { wiki_page: node(r), wiki_page_ids: back });
    return respond(200, pageOut(st, r));
  });

  get("/v1/wiki/trash", (ctx) => {
    const st = stateOf(ctx.ws);
    const v = viewerOf(ctx.ws);
    const area = areaParam(ctx);
    const out = st.pages
      .filter((r): r is Row & { deleted_at: string } => r.trashed_with === r.id && !!r.deleted_at && sees(v, r) && r.area === area)
      .sort((a, b) => Date.parse(b.deleted_at) - Date.parse(a.deleted_at))
      .slice(0, 500)
      .map(
        (r): WikiTrashed => ({
          ...node(r),
          deleted_at: r.deleted_at,
          deleted_by: userRef(r.deleted_by),
          purge_at: new Date(Date.parse(r.deleted_at) + TRASH_KEEP).toISOString(),
          subpages: st.pages.filter((x) => x.trashed_with === r.id).length - 1,
          path: ancestorsOf(st, r.id).map(refOf),
        }),
      );
    return pageOf(out);
  });
}

// ─── Templates and copies (templates.go) ───────────────────────────────────

function registerTemplates() {
  get("/v1/wiki/templates", (ctx) => {
    const st = stateOf(ctx.ws);
    const v = viewerOf(ctx.ws);
    const isTemplate = (id: string | null) => !!id && !!st.pages.find((a) => a.id === id)?.template;
    const out = st.pages
      .filter((r) => r.template && !r.deleted_at && !isTemplate(r.parent_id) && sees(v, r))
      .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
    return pageOf(out.map(node));
  });

  post("/v1/wiki/pages/:id/duplicate", (ctx) => {
    requireAgent(ctx);
    const st = stateOf(ctx.ws);
    const src = find(ctx, st);
    if (src.deleted_at) throw inTrash();
    const { ids: pages, height } = subtree(st, src.id);
    roomFor(st, pages.length);
    const par = parentRef(ctx, st, ctx.body.parent_id);
    const asTemplate = typeof ctx.body.template === "boolean" ? ctx.body.template : undefined;
    let owner = src.private_to;
    let team = src.team_id;
    let template = src.template;
    let area = src.area;
    if (par) {
      ({ private_to: owner, team_id: team, template, area } = par.row);
      if (par.row.template && asTemplate === false) throw invalid("a page under a template is part of the template");
      if (pages.includes(par.row.id)) throw cycle();
      if (par.up.length + 1 + height > MAX_DEPTH) throw tooDeep();
    } else {
      if (typeof ctx.body.space === "string" && ctx.body.space !== "") ({ owner, team } = spaceRef(ctx, ctx.body.space, ctx.body.team_id));
      else if (src.private_to && src.private_to !== db.meId) throw notFound("Page");
      if (asTemplate !== undefined) template = asTemplate;
      if (ctx.body.area === "wiki" || ctx.body.area === "pages") area = areaField(ctx, ctx.body.area);
    }
    if (height > MAX_DEPTH) throw tooDeep();
    const rootTitle = "title" in ctx.body && ctx.body.title !== null ? cleanTitle(ctx.body.title) : src.title;
    // Copies of the pages, ids mapped so links inside the copy point at the copy.
    const fresh = new Map(pages.map((id) => [id, uuid()]));
    const remap = (body: string) => [...fresh].reduce((b, [old, now]) => b.replaceAll(old, now), body);
    const remapJSON = <T>(v: T): T => JSON.parse(remap(JSON.stringify(v))) as T;
    const parDb = par?.row.database;
    for (const id of pages) {
      const x = st.pages.find((p) => p.id === id)!;
      // A row copied into a database keeps its values; one copied anywhere else is a page and leaves them behind.
      const props = id === src.id && !parDb ? {} : remapJSON(x.props);
      // A row copied into a database is a new row: it gets its own unique id.
      if (id === src.id && parDb && !template) nextRowNumbers(parDb, props);
      const copy = newRow({
        ...settingsOf(x),
        id: fresh.get(id)!,
        parent_id: id === src.id || !x.parent_id ? (par?.row.id ?? null) : (fresh.get(x.parent_id) ?? null),
        title: id === src.id ? rootTitle : x.title,
        icon: x.icon,
        body_html: remap(x.body_html),
        position: x.position,
        private_to: owner,
        team_id: team,
        template,
        kind: x.kind,
        database: x.database ? remapJSON(x.database) : null,
        props,
        canvas: x.canvas ? remapJSON(x.canvas) : null,
        area,
      });
      st.pages.push(copy);
      record(st, copy, false);
    }
    const root = st.pages.find((p) => p.id === fresh.get(src.id))!;
    place(st, root.parent_id, owner, team, template, area, root.id, typeof ctx.body.position === "number" ? ctx.body.position : undefined);
    pageEvent(ctx.ws, root, "wiki_page.created", { ...eventPage(root), wiki_page_ids: [...fresh.values()] });
    return respond(201, pageOut(st, root));
  });
}

// ─── A member's own wiki (personal.go) ─────────────────────────────────────

function recordVisit(st: State, user: string, page: string) {
  const v = st.visits.find((x) => x.user_id === user && x.page_id === page);
  countView(st, user, page, v?.last_at);
  if (v) Object.assign(v, { visits: v.visits + 1, last_at: nowIso(), seq: ++visitSeq });
  else st.visits.push({ user_id: user, page_id: page, visits: 1, last_at: nowIso(), seq: ++visitSeq });
}

const lastFirst = (a: Visit, b: Visit) => Date.parse(b.last_at) - Date.parse(a.last_at) || b.seq - a.seq;

function registerPersonal() {
  const favoritesOut = (ctx: Ctx, st: State) => {
    const v = viewerOf(ctx.ws);
    const rows = (st.favorites.get(db.meId) ?? [])
      .map((id) => st.pages.find((r) => r.id === id))
      .filter((r): r is Row => !!r && live(v, r) && (r.area === "wiki" || pagesOn(ctx.ws)));
    return pageOf(rows.map(node));
  };

  get("/v1/wiki/favorites", (ctx) => favoritesOut(ctx, stateOf(ctx.ws)));

  put("/v1/wiki/favorites", (ctx) => {
    const st = stateOf(ctx.ws);
    const raw = Array.isArray(ctx.body.page_ids) ? (ctx.body.page_ids as unknown[]) : [];
    if (raw.length > MAX_FAVORITES) throw invalid("at most 100 favorites");
    const list = raw.map((x) => {
      const id = typeof x === "string" ? parseUUID(x.trim()) : undefined;
      if (!id) throw invalid("page_ids is not a valid id");
      return id;
    });
    // Pages out of sight, in the trash or templates are left out; each page once, where it first comes.
    const v = viewerOf(ctx.ws);
    const keep = [...new Set(list)].filter((id) => st.pages.some((r) => r.id === id && live(v, r)));
    st.favorites.set(db.meId, keep);
    return favoritesOut(ctx, st);
  });

  get("/v1/wiki/recent", (ctx) => {
    const st = stateOf(ctx.ws);
    const v = viewerOf(ctx.ws);
    const limit = Math.min(Number(ctx.query.get("limit")) || 15, 50);
    const area = areaParam(ctx);
    const out = st.visits
      .filter((x) => x.user_id === db.meId)
      .sort(lastFirst)
      .map((x) => st.pages.find((r) => r.id === x.page_id))
      .filter((r): r is Row => !!r && live(v, r) && r.area === area)
      .slice(0, limit);
    return pageOf(out.map(node));
  });

  get("/v1/wiki/pages/:id/views", (ctx): WikiPageViews => {
    const st = stateOf(ctx.ws);
    const r = find(ctx, st);
    const all = st.visits.filter((x) => x.page_id === r.id);
    const readers = all
      .sort(lastFirst)
      .flatMap((x) => {
        const user = userRef(x.user_id);
        return user ? [{ user, visits: x.visits, last_at: x.last_at }] : [];
      })
      .slice(0, 20);
    return { views: all.reduce((n, x) => n + x.visits, 0), people: all.length, readers };
  });

  get("/v1/wiki/daily", (ctx) => {
    const st = stateOf(ctx.ws);
    const day = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);
    const from = ctx.query.get("from") || day(-60);
    const to = ctx.query.get("to") || day(60);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw invalid("from and to must be YYYY-MM-DD");
    const area = areaParam(ctx);
    const out = st.pages
      .filter((r): r is Row & { daily_date: string } => r.private_to === db.meId && r.area === area && !!r.daily_date && r.daily_date >= from && r.daily_date <= to && !r.deleted_at)
      .sort((a, b) => a.daily_date.localeCompare(b.daily_date))
      .map((r): WikiDailyNote => ({ date: r.daily_date, id: r.id }));
    return pageOf(out);
  });

  post("/v1/wiki/daily", (ctx) => {
    requireAgent(ctx);
    const st = stateOf(ctx.ws);
    const me = db.meId;
    const date = ctx.body.date;
    if (!isDate(date)) throw invalid("date must be YYYY-MM-DD");
    const title = cleanTitle(ctx.body.title);
    const journalTitle = cleanTitle(ctx.body.journal_title);
    const body = cleanBody(ctx.body.body_html);
    // Each area has its own journal (contracts/pages.md).
    const area = areaField(ctx, ctx.body.area);
    const existing = st.pages.find((r) => r.private_to === me && r.daily_date === date && r.area === area && !r.deleted_at);
    if (existing) return respond(200, pageOut(st, existing));
    let journal = st.pages.find((r) => r.private_to === me && r.journal && r.area === area && !r.deleted_at);
    if (!journal) {
      roomFor(st, 2);
      journal = newRow({ id: uuid(), parent_id: null, title: journalTitle || "Journal", icon: "📓", body_html: "", private_to: me, journal: true, area });
      st.pages.push(journal);
      place(st, null, me, null, false, area, journal.id, 0);
      record(st, journal, false);
      pageEvent(ctx.ws, journal, "wiki_page.created", eventPage(journal));
    } else roomFor(st, 1);
    const note = newRow({ id: uuid(), parent_id: journal.id, title: title || date, icon: "", body_html: body, private_to: me, daily_date: date, area });
    st.pages.push(note);
    // Newest day first, as a journal reads.
    place(st, journal.id, me, null, false, area, note.id, 0);
    record(st, note, false);
    pageEvent(ctx.ws, note, "wiki_page.created", eventPage(note));
    return respond(200, pageOut(st, note));
  });
}

// ─── Links and tags (links.go), read from the bodies as the API indexes them ─

function registerLinks() {
  const linksOf = (st: State) => {
    const known = new Set(st.pages.map((r) => r.id));
    return st.pages.flatMap((r) => linkedIds(r.body_html + canvasHtml(r)).filter((to) => to !== r.id && known.has(to)).map((to) => ({ from: r.id, to })));
  };
  const mentionOut = (r: Row, title: string) => {
    const text = stripHtml(r.body_html).replace(/\s+/g, " ");
    const at = title ? text.toLowerCase().indexOf(title.toLowerCase()) : -1;
    const start = Math.max(0, at - 60);
    return { id: r.id, parent_id: r.parent_id, title: r.title, icon: r.icon, snippet: (start ? "…" : "") + text.slice(start, start + 180), updated_at: r.updated_at };
  };
  const newestFirst = (a: Row, b: Row) => Date.parse(b.updated_at) - Date.parse(a.updated_at);

  get("/v1/wiki/pages/:id/backlinks", (ctx) => {
    const st = stateOf(ctx.ws);
    const v = viewerOf(ctx.ws);
    const target = find(ctx, st);
    const from = new Set(linksOf(st).filter((l) => l.to === target.id).map((l) => l.from));
    const out = st.pages.filter((r) => from.has(r.id) && live(v, r)).sort(newestFirst);
    return pageOf(out.slice(0, 200).map((r) => mentionOut(r, target.title)));
  });

  get("/v1/wiki/pages/:id/mentions", (ctx) => {
    const st = stateOf(ctx.ws);
    const v = viewerOf(ctx.ws);
    const target = find(ctx, st);
    // Its title and its aliases (contracts/wiki.md "Aliases"): the first the text has shows in the snippet.
    const names = [target.title, ...target.aliases].map((n) => n.trim()).filter(Boolean);
    if (!names.length) return pageOf([]);
    const linked = new Set(linksOf(st).filter((l) => l.to === target.id).map((l) => l.from));
    const named = (r: Row) => {
      const text = stripHtml(r.body_html).toLowerCase();
      return names.find((n) => text.includes(n.toLowerCase()));
    };
    const out = st.pages.filter((r) => r.id !== target.id && live(v, r) && !linked.has(r.id) && named(r)).sort(newestFirst);
    return pageOf(out.slice(0, 100).map((r) => mentionOut(r, named(r) ?? target.title)));
  });

  get("/v1/wiki/graph", (ctx) => {
    const st = stateOf(ctx.ws);
    const v = viewerOf(ctx.ws);
    const area = areaParam(ctx);
    const shown = new Set(st.pages.filter((r) => live(v, r) && r.area === area).map((r) => r.id));
    return pageOf(linksOf(st).filter((l) => shown.has(l.from) && shown.has(l.to)));
  });
}

// ─── Comments, following and mentions (contracts/wiki.md "Comments", "Following") ──

const MAX_COMMENT = 20000;
const MAX_QUOTE = 500;
const MAX_REACTIONS = 20;
let commentSeq = 0;

/** hd.SanitizeRich, as the mock has it: what can run goes, mentions and formatting stay. */
function cleanCommentBody(v: unknown): string {
  const html = DOMPurify.sanitize(typeof v === "string" ? v : "", { FORBID_TAGS: ["input", "label", "iframe", "form", "style", "script", "img"] });
  if (!stripHtml(html).trim()) throw invalid("body_html can't be empty");
  if (html.length > MAX_COMMENT) throw invalid("body_html must be at most 20000 characters");
  return html;
}

/** The people a comment mentions: the ones sent, else those in its HTML; members only, once each. */
function cleanMentions(ws: WsData, raw: unknown, html: string): string[] {
  const ids = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : mentionIds(html);
  return [...new Set(ids)].filter((id) => ws.members.some((m) => m.user_id === id));
}

/** Whether uid follows the page: what they chose, else whether they made it. */
function follows(st: State, r: Row, uid: string): boolean {
  return st.follows.get(r.id)?.get(uid) ?? r.created_by === uid;
}

function setFollow(st: State, r: Row, uid: string, on: boolean, onlyIfUnset = false) {
  let m = st.follows.get(r.id);
  if (!m) st.follows.set(r.id, (m = new Map()));
  if (onlyIfUnset && m.has(uid)) return;
  m.set(uid, on);
}

function threadOut(st: State, root: CommentRow): WikiThread {
  const comments = st.comments.filter((c) => c.thread_id === root.id).sort((a, b) => a.seq - b.seq);
  return {
    id: root.id,
    page_id: root.page_id,
    quote: root.quote,
    inline: root.inline,
    created_at: root.created_at,
    resolved_at: root.resolved_at,
    resolved_by: userRef(root.resolved_by),
    comments: comments.map((c) => {
      const mine = st.reactions.filter((x) => x.comment_id === c.id).sort((a, b) => a.seq - b.seq);
      const reactions: WikiReaction[] = [];
      for (const x of mine) {
        const at = reactions.find((y) => y.emoji === x.emoji);
        if (at) at.users.push(x.user_id);
        else reactions.push({ emoji: x.emoji, users: [x.user_id] });
      }
      return { id: c.id, thread_id: c.thread_id, author: userRef(c.author_id), body_html: c.body_html, mentions: [...c.mentions], created_at: c.created_at, edited_at: c.edited_at, reactions };
    }),
  };
}

/** A comment of a page the person sees, with its page and thread; else not found. */
function commentOf(ctx: Ctx, id: string, st = stateOf(ctx.ws)): { c: CommentRow; root: CommentRow; page: Row } {
  const c = st.comments.find((x) => x.id === id);
  const page = c && st.pages.find((r) => r.id === c.page_id);
  const root = c && st.comments.find((x) => x.id === c.thread_id);
  if (!c || !page || !root || !sees(viewerOf(ctx.ws), page)) throw notFound("Comment");
  return { c, root, page };
}

/**
 * A wiki notification (hd.Notify with no ticket) to someone who may see the page now; a
 * page in the trash notifies nobody. The mock's own person keeps theirs in the bell.
 */
function notifyWiki(ws: WsData, r: Row, uid: string, type: "wiki_mention" | "wiki_comment", data: Record<string, unknown>) {
  if (uid === db.meId || r.deleted_at || !ws.members.some((m) => m.user_id === uid) || !sees(viewerOf(ws, uid), r)) return;
  const n: Notification = { id: uuid(), type, ticket: null, data: { ...data, by: db.meId, actor: userRef(db.meId) }, read_at: null, created_at: nowIso() };
  publish(ws, "notification.created", { notification: n }, { topics: [`user:${uid}`] });
}

/** After a comment: who it newly mentions hears of the mention, the page's followers and the thread's people of the comment. */
function notifyComment(ws: WsData, st: State, r: Row, c: CommentRow, mentioned: string[], isNew: boolean) {
  const data = { page_id: r.id, page_title: r.title, preview: excerpt(stripHtml(c.body_html), 140), thread_id: c.thread_id, comment_id: c.id };
  for (const uid of mentioned) notifyWiki(ws, r, uid, "wiki_mention", data);
  if (!isNew) return;
  const told = new Set([db.meId, ...mentioned]);
  const people = new Set([
    ...ws.members.map((m) => m.user_id).filter((uid) => follows(st, r, uid)),
    ...st.comments.filter((x) => x.thread_id === c.thread_id && x.author_id).map((x) => x.author_id as string),
  ]);
  for (const uid of people) if (!told.has(uid)) notifyWiki(ws, r, uid, "wiki_comment", data);
}

/** People a page's text newly mentions (diffed with what it said before) hear of it. */
function notifyBodyMentions(ws: WsData, r: Row, before: string) {
  const had = new Set(mentionIds(before));
  const fresh = mentionIds(r.body_html).filter((id) => !had.has(id));
  for (const uid of fresh) notifyWiki(ws, r, uid, "wiki_mention", { page_id: r.id, page_title: r.title, preview: excerpt(stripHtml(r.body_html), 140) });
}

const commentChanged = (ws: WsData, r: Row, threadId: string) => pageEvent(ws, r, "wiki_comment.changed", { page_id: r.id, thread_id: threadId });

function registerComments() {
  get("/v1/wiki/pages/:id/comments", (ctx) => {
    const st = stateOf(ctx.ws);
    const r = find(ctx, st);
    const roots = st.comments.filter((c) => c.page_id === r.id && c.thread_id === c.id).sort((a, b) => a.seq - b.seq);
    return { data: roots.map((x) => threadOut(st, x)), following: follows(st, r, db.meId) } satisfies WikiComments;
  });

  post("/v1/wiki/pages/:id/comments", (ctx) => {
    requireAgent(ctx);
    const st = stateOf(ctx.ws);
    const r = find(ctx, st);
    if (r.deleted_at) throw inTrash();
    const body = cleanCommentBody(ctx.body.body_html);
    const mentions = cleanMentions(ctx.ws, ctx.body.mentions, body);
    let root: CommentRow | undefined;
    if (ctx.body.thread_id !== undefined && ctx.body.thread_id !== null && ctx.body.thread_id !== "") {
      const id = typeof ctx.body.thread_id === "string" ? parseUUID(ctx.body.thread_id) : undefined;
      root = id ? st.comments.find((c) => c.id === id && c.thread_id === c.id && c.page_id === r.id) : undefined;
      if (!root) throw invalid("thread_id is not a thread of this page");
    }
    const inline = !root && ctx.body.inline === true;
    const quote = inline && typeof ctx.body.quote === "string" ? [...ctx.body.quote.replace(/\s+/g, " ").trim()].slice(0, MAX_QUOTE).join("") : "";
    if (inline && !quote) throw invalid("an inline comment needs the quote it is on");
    const id = uuid();
    const c: CommentRow = {
      id,
      page_id: r.id,
      thread_id: root?.id ?? id,
      quote,
      inline,
      author_id: db.meId,
      body_html: body,
      mentions,
      created_at: nowIso(),
      edited_at: null,
      resolved_at: null,
      resolved_by: null,
      seq: ++commentSeq,
    };
    st.comments.push(c);
    // A reply brings a resolved thread back.
    if (root?.resolved_at) Object.assign(root, { resolved_at: null, resolved_by: null });
    setFollow(st, r, db.meId, true, true);
    notifyComment(ctx.ws, st, r, c, mentions, true);
    commentChanged(ctx.ws, r, c.thread_id);
    return respond(201, threadOut(st, root ?? c));
  });

  patch("/v1/wiki/comments/:id", (ctx) => {
    requireAgent(ctx);
    const st = stateOf(ctx.ws);
    const { c, root, page } = commentOf(ctx, ctx.params.id, st);
    if (page.deleted_at) throw inTrash();
    if (c.author_id !== db.meId) throw forbidden("Only its author edits a comment.");
    const body = cleanCommentBody(ctx.body.body_html);
    const mentions = cleanMentions(ctx.ws, ctx.body.mentions, body);
    const fresh = mentions.filter((id) => !c.mentions.includes(id));
    Object.assign(c, { body_html: body, mentions, edited_at: nowIso() });
    notifyComment(ctx.ws, st, page, c, fresh, false);
    commentChanged(ctx.ws, page, root.id);
    return threadOut(st, root);
  });

  del("/v1/wiki/comments/:id", (ctx) => {
    requireAgent(ctx);
    const st = stateOf(ctx.ws);
    const { c, root, page } = commentOf(ctx, ctx.params.id, st);
    if (page.deleted_at) throw inTrash();
    if (c.author_id !== db.meId && rank[role(ctx)] < rank.admin) throw forbidden("Someone else wrote this comment, so only an admin can delete it.");
    const gone = new Set(c.id === root.id ? st.comments.filter((x) => x.thread_id === root.id).map((x) => x.id) : [c.id]);
    st.comments = st.comments.filter((x) => !gone.has(x.id));
    st.reactions = st.reactions.filter((x) => !gone.has(x.comment_id));
    commentChanged(ctx.ws, page, root.id);
    return respond(204);
  });

  post("/v1/wiki/threads/:id/resolve", (ctx) => {
    requireAgent(ctx);
    const st = stateOf(ctx.ws);
    const { root, page } = commentOf(ctx, ctx.params.id, st);
    if (root.id !== ctx.params.id) throw notFound("Thread");
    if (page.deleted_at) throw inTrash();
    if (typeof ctx.body.resolved !== "boolean") throw invalid("resolved must be true or false");
    if (ctx.body.resolved && !root.resolved_at) Object.assign(root, { resolved_at: nowIso(), resolved_by: db.meId });
    if (!ctx.body.resolved) Object.assign(root, { resolved_at: null, resolved_by: null });
    commentChanged(ctx.ws, page, root.id);
    return threadOut(st, root);
  });

  post("/v1/wiki/comments/:id/reactions", (ctx) => {
    requireAgent(ctx);
    const st = stateOf(ctx.ws);
    const { c, root, page } = commentOf(ctx, ctx.params.id, st);
    if (page.deleted_at) throw inTrash();
    const emoji = typeof ctx.body.emoji === "string" ? ctx.body.emoji.trim() : "";
    if (!emoji || emoji.length > 64 || !oneEmoji.test(emoji)) throw invalid("emoji must be one emoji");
    if (typeof ctx.body.on !== "boolean") throw invalid("on must be true or false");
    const has = st.reactions.some((x) => x.comment_id === c.id && x.user_id === db.meId && x.emoji === emoji);
    const kinds = new Set(st.reactions.filter((x) => x.comment_id === c.id).map((x) => x.emoji));
    if (ctx.body.on && !kinds.has(emoji) && kinds.size >= MAX_REACTIONS) throw invalid("A comment takes up to 20 different reactions.");
    if (ctx.body.on && !has) st.reactions.push({ comment_id: c.id, user_id: db.meId, emoji, seq: ++commentSeq });
    if (!ctx.body.on) st.reactions = st.reactions.filter((x) => !(x.comment_id === c.id && x.user_id === db.meId && x.emoji === emoji));
    commentChanged(ctx.ws, page, root.id);
    return threadOut(st, root);
  });

  // Following is a reader's choice: viewers follow too.
  put("/v1/wiki/pages/:id/follow", (ctx) => {
    const st = stateOf(ctx.ws);
    const r = find(ctx, st);
    if (r.deleted_at) throw inTrash();
    if (typeof ctx.body.following !== "boolean") throw invalid("following must be true or false");
    setFollow(st, r, db.meId, ctx.body.following);
    return { following: ctx.body.following };
  });
}

/** Threads the starter handbook comes with: {c:<key>} in a seeded body is that thread's id. */
type SeedComment = { by: number; hours: number; body: string; reactions?: [string, number[]][] };
type SeedThread = { page: string; key?: string; quote?: string; resolvedBy?: number; resolvedHours?: number; comments: SeedComment[] };

const SEED_THREADS: SeedThread[] = [
  {
    page: "Escalation process",
    key: "money",
    quote: "money is at stake",
    comments: [
      { by: 1, hours: 50, body: "<p>Should we name a threshold here? Some of us escalate at 50 euros, some at 500.</p>", reactions: [["👍", [0, 2]]] },
      { by: 2, hours: 26, body: "<p>Refunds over 100 euros already need a lead. {me}, should we use the same line here?</p>", reactions: [["🎉", [1]]] },
    ],
  },
  {
    page: "Escalation process",
    comments: [{ by: 2, hours: 5, body: "<p>Worth adding a sev2 section? The on-call lead asked about it twice this week.</p>", reactions: [["👀", [1]]] }],
  },
  {
    page: "Refund policy",
    key: "annual",
    quote: "no questions asked",
    resolvedBy: 0,
    resolvedHours: 170,
    comments: [
      { by: 1, hours: 192, body: "<p>Does this include annual plans?</p>" },
      { by: 0, hours: 180, body: "<p>Yes, for the first 30 days. The second bullet covers the rest.</p>", reactions: [["🙏", [1]]] },
    ],
  },
];

function seedComments(ws: WsData, st: State, person: (i: number) => string | null) {
  const me = ws.members.find((m) => m.user_id === db.meId);
  const mention = me ? `<span data-type="mention" data-id="${me.user_id}" data-label="${escapeHtml(userRef(me.user_id)?.name ?? "")}" class="mention">@${escapeHtml(userRef(me.user_id)?.name ?? "")}</span>` : "";
  for (const s of SEED_THREADS) {
    const r = st.pages.find((p) => p.title === s.page && !p.template);
    if (!r) continue;
    const id = uuid();
    if (s.key) {
      r.body_html = r.body_html.replace(`{c:${s.key}}`, id);
      for (const x of st.revisions) if (x.page_id === r.id) x.body_html = x.body_html.replace(`{c:${s.key}}`, id);
    }
    s.comments.forEach((sc, i) => {
      const by = person(sc.by);
      const body = sc.body.replace("{me}", mention);
      const c: CommentRow = {
        id: i === 0 ? id : uuid(),
        page_id: r.id,
        thread_id: id,
        quote: i === 0 ? (s.quote ?? "") : "",
        inline: i === 0 && !!s.quote,
        author_id: by,
        body_html: body,
        mentions: mentionIds(body),
        created_at: ago(sc.hours * HOUR),
        edited_at: null,
        resolved_at: i === 0 && s.resolvedHours ? ago(s.resolvedHours * HOUR) : null,
        resolved_by: i === 0 && s.resolvedBy !== undefined ? person(s.resolvedBy) : null,
        seq: ++commentSeq,
      };
      st.comments.push(c);
      for (const [emoji, who] of sc.reactions ?? []) for (const w of who) {
        const uid = person(w);
        if (uid && !st.reactions.some((x) => x.comment_id === c.id && x.user_id === uid && x.emoji === emoji)) st.reactions.push({ comment_id: c.id, user_id: uid, emoji, seq: ++commentSeq });
      }
      if (by) setFollow(st, r, by, true, true);
    });
  }
}

// ─── Ollie writing, publishing and the desk seeds (contracts/ai.md, contracts/api.md) ──

const WRITE_MODES: readonly WikiWriteMode[] = ["improve", "fix_grammar", "shorter", "longer", "simplify", "more_formal", "friendlier", "summarize", "action_items", "explain", "continue", "custom"];
/** Modes that work on a selection (wikiSelectionModes): they need its text. */
const EDIT_MODES = new Set<WikiWriteMode>(["improve", "fix_grammar", "shorter", "longer", "simplify", "more_formal", "friendlier", "action_items", "explain"]);

const sentencesOf = (text: string) =>
  text
    .replace(/\n+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((x) => x.replace(/^[-•]\s*/, "").trim())
    .filter(Boolean);

/** What Ollie writes in the mock: built from the text it was given, never invented facts. */
export function ollieWiki(mode: WikiWriteMode, selection: string, page: string, title: string, instructions: string): string {
  const src = selection || page;
  const said = sentencesOf(src);
  const lines = src.split(/\n+/).map((l) => l.replace(/^-\s*/, "").trim()).filter(Boolean);
  const esc = escapeHtml;
  switch (mode) {
    case "improve":
      return textToParagraphs(rewriteText(rewriteText(src, "fix_grammar"), "simplify"));
    case "fix_grammar":
    case "shorter":
    case "longer":
    case "simplify":
    case "more_formal":
    case "friendlier":
      return textToParagraphs(rewriteText(src, mode));
    case "summarize": {
      const key = said.slice(1, 6);
      return `<p>${esc(said[0] ?? title)}</p>${key.length ? `<ul>${key.map((x) => `<li><p>${esc(x)}</p></li>`).join("")}</ul>` : ""}`;
    }
    case "action_items": {
      const items = (lines.length > 1 ? lines : said).slice(0, 6);
      return `<ul data-type="taskList">${items.map((x) => `<li data-type="taskItem" data-checked="false"><p>${esc(x)}</p></li>`).join("")}</ul>`;
    }
    case "explain":
      return `<p>In plain words: ${esc(said.slice(0, 2).join(" "))}</p><p>If you are new to this, ask the person who wrote it for an example from a real ticket.</p>`;
    case "continue": {
      const last = said[said.length - 1] ?? "";
      return `<p>${last ? "Once that is done, " : ""}write down what you tried and what the customer needs next, so whoever picks it up can carry on. Add the [owner] and the [date] you expect an answer by.</p>`;
    }
    case "custom":
      return `<p>${esc(instructions.replace(/[.!?]*$/, ""))}: here is a first draft from ${selection ? "the selected text" : `“${esc(title || "this page")}”`}.</p>${said
        .slice(0, 3)
        .map((x) => `<p>${esc(x)}</p>`)
        .join("")}`;
  }
}

/** The page as a help center article (wikiconv.Article): text kept, the wiki's own blocks left out and counted. */
export function articleFromWiki(html: string): { html: string; leftOut: number } {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  let leftOut = 0;
  const text = (el: Element, t = el.textContent ?? "") => el.replaceWith(doc.createTextNode(t));
  doc.querySelectorAll('a[data-type="page"], a[data-type="ticket"], a[data-type="contact"], time[data-type="date"]').forEach((el) => text(el));
  doc.querySelectorAll('span[data-type="mention"]').forEach((el) => text(el, (el.textContent ?? "").replace(/^@/, "")));
  doc.querySelectorAll('div[data-type="subpage"], div[data-type="database"]').forEach((el) => (el.remove(), leftOut++));
  doc.querySelectorAll('div[data-type="file"], div[data-type="video"], div[data-type="audio"]').forEach((el) => {
    const src = el.getAttribute("data-src") ?? "";
    if (!/^https:/.test(src)) return void (el.remove(), leftOut++);
    const a = doc.createElement("a");
    a.href = src;
    a.textContent = el.getAttribute("data-name") || src;
    el.replaceWith(a);
  });
  doc.querySelectorAll("img").forEach((el) => !/^https:/.test(el.getAttribute("src") ?? "") && (el.remove(), leftOut++));
  doc.querySelectorAll('div[data-type="callout"]').forEach((el) => {
    const q = doc.createElement("blockquote");
    q.append(...el.childNodes);
    el.replaceWith(q);
  });
  doc.querySelectorAll('div[data-type="toc"], div[data-type="tickets"], hr').forEach((el) => el.remove());
  return { html: doc.body.innerHTML, leftOut };
}

function registerDesk() {
  post("/v1/wiki/ai/write", (ctx) => {
    requireAgent(ctx);
    if (!ctx.ws.ai.enabled) throw new HttpError(403, "ai_off", "AI is turned off for this workspace.");
    const mode = s(ctx, "mode") as WikiWriteMode;
    if (!WRITE_MODES.includes(mode)) throw invalid("mode is not one Ollie knows");
    const selection = htmlToText(s(ctx, "html") ?? "");
    const page = htmlToText(s(ctx, "context_html") ?? "");
    const instructions = (s(ctx, "instructions") ?? "").trim();
    if (instructions.length > 1000) throw invalid("instructions must be 1000 characters or less");
    if (EDIT_MODES.has(mode) && !selection) throw invalid(`html is required for ${mode}`);
    if (mode === "custom" && !instructions) throw invalid("instructions are required for custom");
    if (!selection && !page && mode !== "custom") throw invalid("html or context_html is required");
    const feature = EDIT_MODES.has(mode) ? "rewrite" : "wiki_write";
    reserve(ctx.ws, feature);
    const html = ollieWiki(mode, selection, page, (s(ctx, "title") ?? "").trim(), instructions);
    spend(ctx.ws, feature);
    // The deltas are the model's raw HTML, as the API streams it; `done` has the sanitized copy.
    return sse(ctx, chunk(html, 2), { html: cleanBody(html) }, 28);
  });

  post("/v1/kb/articles/from-wiki", (ctx) => {
    requireAgent(ctx);
    const id = parseUUID(s(ctx, "page_id") ?? "");
    if (!id) throw invalid("page_id must be a wiki page's id");
    const st = stateOf(ctx.ws);
    const v = viewerOf(ctx.ws);
    const r = st.pages.find((p) => p.id === id && !p.deleted_at && sees(v, p));
    if (!r) throw notFound("Wiki page");
    const title = (s(ctx, "title") ?? "").trim().slice(0, 200) || r.title.trim();
    if (!title) throw invalid("title is required for a page without one");
    const collection = s(ctx, "collection_id") || null;
    if (collection && !ctx.ws.collections.some((c) => c.id === collection)) throw invalid("collection_id must be a collection of the workspace");
    const { html, leftOut } = articleFromWiki(r.body_html);
    const a: KbArticle = {
      id: uuid(),
      brand_id: kbBrandRef(ctx, ctx.body.brand_id),
      collection_id: collection,
      title,
      slug: uniqueSlug(sameCollection(ctx.ws, collection), slugify(title)),
      excerpt: stripHtml(html).replace(/\s+/g, " ").trim().slice(0, 300),
      body_html: html,
      status: "draft",
      author: userRef(db.meId),
      views: 0,
      published_at: null,
      updated_at: nowIso(),
      path: "",
    };
    ctx.ws.articles.unshift(a);
    recountCollections(ctx.ws);
    publish(ctx.ws, "kb_article.created", { kb_article: a });
    return respond(201, { article: a, left_out: leftOut });
  });
}

/** The handbook mentions tickets as a team would: an example ticket, a contact and a live list of a view. */
function seedDesk(ws: WsData, st: State) {
  const page = (title: string) => st.pages.find((p) => p.title === title && !p.template);
  const ticket = (subject: string) => ws.tickets.find((t) => t.subject === subject && !t.team_id) ?? ws.tickets.find((t) => t.subject === subject);
  const ticketLink = (t: { id: string; number: number; subject: string }) => `<a data-type="ticket" data-id="${t.id}" href="/tickets/${t.number}">#${t.number} ${escapeHtml(t.subject)}</a>`;
  const escalation = page("Escalation process");
  const sync = ticket("Shared journal stopped syncing photos");
  const urgent = ws.views.find((v) => v.name === "Urgent");
  if (escalation && (sync || urgent)) {
    escalation.body_html +=
      (sync ? `<h2>A recent example</h2><p>${ticketLink(sync)} went to the on-call lead within the hour: several customers were blocked at once.</p>` : "") +
      (urgent ? `<h2>Urgent right now</h2><div data-type="tickets" data-id="${urgent.id}" data-limit="5"></div>` : "");
  }
  const refunds = page("Refund policy");
  const twice = ticket("Refund for a paid subscriber");
  const who = twice?.contact;
  if (refunds && twice)
    refunds.body_html += `<p>Example: ${ticketLink(twice)}${who ? `, from <a data-type="contact" data-id="${who.id}" href="/contacts/${who.id}">${escapeHtml(who.name || who.email || "")}</a>` : ""}, a duplicate charge refunded the same day.</p>`;
}

// ─── Editor blocks: synced blocks, diagrams, footnotes, toggle headings, buttons ─

/**
 * The handbook uses the editor's newer blocks as a team would: the on-call page shows the
 * escalation steps as a synced block, the escalation process draws who gets a ticket as a
 * Mermaid diagram and cites a source in a footnote, and buttons log a known issue or add a
 * follow-up (contracts/wiki.md "Blocks").
 */
function seedEditorBlocks(st: State) {
  const page = (title: string) => st.pages.find((p) => p.title === title && !p.template && !p.deleted_at);
  const escalation = page("Escalation process");
  const oncall = page("Business hours and on-call");
  if (!escalation || !oncall) return;
  const steps = uuid();
  const note = uuid();
  escalation.body_html =
    escalation.body_html
      .replace("<h2>Steps</h2>", `<h2 data-block-id="${steps}">Steps</h2>`)
      .replace("every 30 minutes", `every 30 minutes<sup data-type="footnote" data-note="${note}">1</sup>`) +
    `<h2>Who gets it</h2><pre><code class="language-mermaid">flowchart LR\n  A[Customer blocked] --&gt; B{Money at stake?}\n  B -- yes --&gt; C[On-call lead]\n  B -- no --&gt; D{Tried twice?}\n  D -- yes --&gt; C\n  D -- no --&gt; E[Keep working it]</code></pre>` +
    `<div data-type="footnotes"><div data-type="footnote" data-note="${note}"><p>Customers asked for it in last year's survey: silence felt worse than a slow fix.</p></div></div>`;
  const issues = st.pages.find((p) => p.kind === "database" && p.title === "Known issues");
  const review = st.pages.find((p) => p.template && !p.parent_id && p.title === "Incident review");
  oncall.body_html +=
    `<h2>When it can't wait</h2><div data-type="transclusion" data-id="${escalation.id}" data-block="${steps}"></div>` +
    `<details data-heading="2"><summary>Holiday cover</summary><div data-type="detailsContent"><p>Swap shifts in the team channel at least a week ahead, and update the rota here.</p></div></details>` +
    `<div data-type="button" data-label="Add a follow-up" data-action="todo" data-title="Follow up with the customer"></div>` +
    (issues ? `<div data-type="button" data-label="Log a known issue" data-action="row" data-database="${issues.id}" data-title="New issue"></div>` : "") +
    (review ? `<div data-type="button" data-label="Start an incident review" data-action="template" data-template="${review.id}"></div>` : "");
}

// ─── The starter handbook ──────────────────────────────────────────────────

type Seed = { title: string; icon: string; body: string; days: number; by: number; cover?: string; verified?: { by: number; days: number; for: number }; children?: Seed[] };

const HANDBOOK: Seed[] = [
  {
    title: "Support handbook",
    icon: "📘",
    cover: "gradient:ocean",
    days: 40,
    by: 0,
    body: "<p>How our team works: who answers what, how fast, and what to do when it gets hard. Start with the escalation process if you are new. #handbook #process</p><h2>Our promises</h2><ul><li><p>A first answer within 4 business hours.</p></li><li><p>Every customer gets a name, never a queue.</p></li><li><p>We say when we don't know yet, and when we'll know.</p></li></ul><h2>Bugs</h2><p>Before you escalate a bug, look it up in Known issues: it may have a workaround to send already. Add a row when it is new, with the ticket and the accounts it hits.</p>",
    children: [
      {
        title: "Escalation process",
        icon: "🚨",
        days: 3,
        by: 1,
        verified: { by: 0, days: 2, for: 90 },
        body: "<p>Escalate when a customer is blocked, <span data-comment=\"{c:money}\">money is at stake</span> or you have tried twice without progress.</p><h2>Steps</h2><ol><li><p>Set the ticket to <strong>urgent</strong> and add the <code>escalated</code> label.</p></li><li><p>Leave a note with what you tried and what the customer needs.</p></li><li><p>Assign it to the on-call lead (see Business hours and on-call).</p></li><li><p>Tell the customer who has it now and when they will hear back.</p></li></ol><h2>Sev1 outages</h2><p>Page the on-call engineer from the incident channel. Post a status update every 30 minutes until it is resolved. #process #incidents</p>",
      },
      {
        title: "Refund policy",
        icon: "💸",
        days: 9,
        by: 2,
        body: "<p>Refund within 30 days of a charge, <span data-comment=\"{c:annual}\">no questions asked</span>, for any plan.</p><ul><li><p>Annual plans: refund the unused months after 30 days, if the customer asks.</p></li><li><p>Duplicate charges: refund at once and apologise.</p></li><li><p>Chargebacks: don't refund twice. Hand it to billing.</p></li></ul>",
        children: [
          {
            title: "Refunds over 100 euros",
            icon: "",
            days: 12,
            by: 2,
            body: "<p>A team lead approves refunds over 100 euros. Leave a note with the amount and the reason, and assign the ticket to a lead. They answer within one business day.</p>",
          },
        ],
      },
      {
        title: "Business hours and on-call",
        icon: "🕐",
        days: 20,
        by: 0,
        body: "<p>We answer Monday to Friday, 8:00 to 18:00 CET. Outside those hours, one lead is on call for sev1 and sev2 issues.</p><p>The on-call rota lives in the team calendar. Swap shifts in the team channel and update the calendar.</p>",
      },
    ],
  },
  {
    title: "Onboarding checklist",
    icon: "👋",
    days: 15,
    by: 1,
    body: "<p>Your first two weeks on the team.</p><h2>Week one</h2><ul><li><p>Read the support handbook.</p></li><li><p>Shadow a teammate for two shifts.</p></li><li><p>Answer ten tickets with a buddy reviewing your drafts.</p></li></ul><h2>Week two</h2><ul><li><p>Take your own queue for half a day.</p></li><li><p>Write or improve one help article.</p></li></ul>",
  },
  {
    title: "Tone of voice",
    icon: "💬",
    days: 60,
    by: 0,
    body: "<p>Warm, plain and specific. Use the customer's name, say what you did and what happens next. No jargon, no exclamation marks in apologies, no \"per my last email\".</p>",
  },
];

// Templates the gallery starts with. {sub} in a body is the id of the template's first subpage.
const TEMPLATES: Seed[] = [
  {
    title: "Incident review",
    icon: "🧯",
    cover: "gradient:ember",
    days: 25,
    by: 1,
    body: '<p>What happened, what it did to customers, and what we change so it doesn\'t happen again. Blameless: name systems and steps, not people. #incidents</p><h2>Summary</h2><p></p><h2>Customer impact</h2><ul><li><p>Who was affected, and for how long:</p></li><li><p>Tickets that came in about it:</p></li></ul><h2>Root cause</h2><p></p><h2>What we change</h2><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p></p></li></ul><div data-type="subpage" data-id="{sub}"></div>',
    children: [
      {
        title: "Timeline",
        icon: "🕒",
        days: 25,
        by: 1,
        body: "<p>Times in UTC, from the first sign to the all-clear.</p><table><tbody><tr><th><p>Time</p></th><th><p>What happened</p></th></tr><tr><td><p></p></td><td><p></p></td></tr></tbody></table>",
      },
    ],
  },
  {
    title: "Meeting notes",
    icon: "📝",
    days: 30,
    by: 0,
    body: '<p><strong>Date:</strong> </p><p><strong>Who:</strong> </p><h2>Agenda</h2><ul><li><p></p></li></ul><h2>Notes</h2><p></p><h2>Decisions</h2><ul><li><p></p></li></ul><h2>Action items</h2><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p></p></li></ul>',
  },
];

function seedHandbook(ws: WsData, st: State) {
  const people = ws.members.map((m) => m.user_id);
  const person = (i: number) => people[i % Math.max(people.length, 1)] ?? null;
  const add = (list: Seed[], parent: string | null, template: boolean) =>
    list.forEach((x, i) => {
      const at = ago(x.days * DAY);
      const by = person(x.by);
      const r = newRow({
        id: uuid(),
        parent_id: parent,
        title: x.title,
        icon: x.icon,
        body_html: x.body,
        position: i,
        version: 3,
        created_by: by,
        updated_by: by,
        created_at: ago((x.days + 30) * DAY),
        updated_at: at,
        template,
        ...(x.cover ? { cover: x.cover } : {}),
        ...(x.verified ? { verified_by: person(x.verified.by), verified_at: ago(x.verified.days * DAY), verified_until: new Date(NOW + (x.verified.for - x.verified.days) * DAY).toISOString() } : {}),
      });
      st.pages.push(r);
      st.revisions.push(
        { id: uuid(), page_id: r.id, title: r.title, icon: r.icon, body_html: x.body.replace(/<h2>[\s\S]*$/, ""), author: by, created_at: r.created_at, updated_at: ago((x.days + 29) * DAY) },
        { id: uuid(), page_id: r.id, title: r.title, icon: r.icon, body_html: r.body_html, author: by, created_at: at, updated_at: at },
      );
      if (x.children) add(x.children, r.id, template);
    });
  add(HANDBOOK, null, false);
  seedDatabases(ws, st, person, HANDBOOK.length);
  // Where one page names another, the first mention becomes a link, as a team would write it:
  // the backlinks, the graph and link previews have something to show.
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const r of st.pages) {
    for (const other of st.pages) {
      if (other.id === r.id || !other.title) continue;
      const re = new RegExp(`(>[^<]*?)\\b(${esc(other.title)})\\b`, "i");
      r.body_html = r.body_html.replace(re, (_m, before: string, name: string) => `${before}<a data-type="page" data-id="${other.id}" href="/wiki/${other.id}">${name}</a>`);
    }
  }
  seedComments(ws, st, person);
  seedDesk(ws, st);
  seedCanvas(st, person);
  seedPagesArea(ws, st, person);
  add(TEMPLATES, null, true);
  for (const r of st.pages.filter((p) => p.template && p.body_html.includes("{sub}"))) {
    const sub = st.pages.filter((c) => c.parent_id === r.id).sort(byPosition)[0];
    r.body_html = sub ? r.body_html.replace("{sub}", sub.id) : r.body_html.replace(/<div data-type="subpage"[^>]*><\/div>/, "");
  }
  seedEditorBlocks(st);
  // Teammates read the handbook, so its readers aren't empty; the person's own visits fill recent pages.
  const handbook = st.pages.filter((p) => !p.template);
  handbook.forEach((p, i) => {
    people.forEach((u, j) => {
      if ((i + j) % 3 === 2) return;
      const visits = 1 + ((i * 5 + j * 3) % 9);
      st.visits.push({ user_id: u, page_id: p.id, visits, last_at: ago(((i + 1) * (j + 2) * 5 * HOUR) % (20 * DAY)), seq: ++visitSeq });
    });
  });
  seedAliasesAndViews(st, people);
}

// ─── Pages (contracts/pages.md) ────────────────────────────────────────────

/**
 * Pages' own tree beside the handbook: a team home, a roadmap with its subpages, a projects
 * database, a brainstorm canvas, a teamspace page and a private note, as a team using Pages
 * for its own work would have them.
 */
function seedPagesArea(ws: WsData, st: State, person: (i: number) => string | null) {
  const team = ws.teams.find((t) => !t.private);
  const made: Row[] = [];
  const page = (fields: Partial<Row> & Pick<Row, "title" | "icon" | "body_html">, days: number, by: number) => {
    const who = person(by);
    const r = newRow({
      id: uuid(),
      parent_id: null,
      created_by: who,
      updated_by: who,
      created_at: ago((days + 20) * DAY),
      updated_at: ago(days * DAY),
      version: 2,
      area: "pages",
      ...fields,
    });
    st.pages.push(r);
    st.revisions.push({ id: uuid(), page_id: r.id, title: r.title, icon: r.icon, body_html: r.body_html, author: who, created_at: r.updated_at, updated_at: r.updated_at });
    made.push(r);
    return r;
  };
  const home = page(
    {
      title: "Team home",
      icon: "🏠",
      position: 0,
      body_html:
        "<p>Everything the team is working on, in one place. Start with the roadmap, add a project to the database, or sketch an idea on the brainstorm canvas.</p><h2>This week</h2><ul data-type=\"taskList\"><li data-type=\"taskItem\" data-checked=\"true\"><label><input type=\"checkbox\" checked><span></span></label><div><p>Agree on the Q4 goals</p></div></li><li data-type=\"taskItem\" data-checked=\"false\"><label><input type=\"checkbox\"><span></span></label><div><p>Draft the launch checklist</p></div></li></ul>",
      cover: "gradient:dawn",
    },
    1,
    0,
  );
  const roadmap = page({ title: "Q4 roadmap", icon: "🗺️", position: 1, body_html: "<p>What we ship before the end of the year, and why.</p><h2>Goals</h2><ol><li><p>Answer every chat within two minutes.</p></li><li><p>Move the help center to the new design.</p></li><li><p>Cut repeat tickets about sign-in by half.</p></li></ol>" }, 2, 1);
  page({ title: "Launch checklist", icon: "✅", parent_id: roadmap.id, position: 0, body_html: "<p>Before a launch goes out.</p><ul data-type=\"taskList\"><li data-type=\"taskItem\" data-checked=\"false\"><label><input type=\"checkbox\"><span></span></label><div><p>Help center articles updated</p></div></li><li data-type=\"taskItem\" data-checked=\"false\"><label><input type=\"checkbox\"><span></span></label><div><p>Saved replies for the new questions</p></div></li></ul>" }, 3, 1);
  page({ title: "Planning notes", icon: "📝", parent_id: roadmap.id, position: 1, body_html: "<p>Notes from the planning day: the sign-in work goes first, the redesign after it.</p>" }, 6, 2);
  const projects = page(
    {
      title: "Projects",
      icon: "📊",
      position: 2,
      body_html: "",
      kind: "database",
      database: {
        properties: [
          { id: "title", name: "Project", type: "title" },
          {
            id: "status",
            name: "Status",
            type: "status",
            options: [
              { id: "planned", name: "Planned", color: "gray" },
              { id: "doing", name: "In progress", color: "blue" },
              { id: "done", name: "Done", color: "green" },
            ],
            groups: [
              { id: "todo", option_ids: ["planned"] },
              { id: "doing", option_ids: ["doing"] },
              { id: "done", option_ids: ["done"] },
            ],
          },
          { id: "owner", name: "Owner", type: "person" },
          { id: "due", name: "Due", type: "date" },
        ],
        views: [
          { id: "board", name: "Board", type: "board", settings: { group_by: "status" } },
          { id: "all", name: "All projects", type: "table" },
          { id: "timeline", name: "Timeline", type: "calendar", settings: { date_property: "due" } },
        ],
        next_id: 1,
      },
    },
    1,
    0,
  );
  const ids = (...i: number[]) => i.map(person).filter((x): x is string => !!x);
  (
    [
      ["Help center redesign", "doing", 0, 21],
      ["Sign-in troubleshooting guide", "doing", 1, 9],
      ["Onboarding emails", "planned", 2, 35],
      ["SLA dashboard", "done", 1, -4],
    ] as const
  ).forEach(([title, status, by, due], i) =>
    page({ title, icon: "", parent_id: projects.id, position: i, body_html: "", props: { status, owner: ids(by), due: { start: day(due) } } }, i + 1, by),
  );
  page(
    {
      title: "Brainstorm",
      icon: "💡",
      position: 3,
      body_html: "",
      kind: "canvas",
      canvas: {
        nodes: [
          { id: "idea", x: 0, y: 0, width: 280, height: 120, type: "text", html: "<h3>Fewer repeat tickets</h3><p>What do customers ask twice?</p>", color: "4" },
          { id: "faq", x: 360, y: -40, width: 240, height: 100, type: "text", html: "<p>A clearer sign-in page</p>" },
          { id: "bot", x: 360, y: 100, width: 240, height: 100, type: "text", html: "<p>Ollie answers the top ten questions</p>", color: "6" },
          { id: "home", x: 0, y: 200, width: 280, height: 130, type: "page", page_id: home.id },
        ],
        edges: [
          { id: "e1", fromNode: "idea", fromSide: "right", toNode: "faq", toSide: "left" },
          { id: "e2", fromNode: "idea", fromSide: "right", toNode: "bot", toSide: "left" },
        ],
      },
    },
    4,
    2,
  );
  if (team) page({ title: `${team.name} rituals`, icon: "🧑‍🤝‍🧑", team_id: team.id, position: 0, body_html: "<p>Standup at 9:30, ticket review on Fridays, and a retro at the end of each month.</p>" }, 5, 0);
  page({ title: "My notes", icon: "🗒️", private_to: db.meId, position: 0, body_html: "<p>Ideas to bring up at the next planning day.</p>" }, 2, 0);
  // The person opened the team home and the roadmap lately, so Pages' recent pages aren't empty.
  for (const r of [home, roadmap, projects]) st.visits.push({ user_id: db.meId, page_id: r.id, visits: 2, last_at: ago(3 * HOUR), seq: ++visitSeq });
  st.favorites.set(db.meId, [...(st.favorites.get(db.meId) ?? []), home.id, projects.id]);
}

// ─── The starter databases ─────────────────────────────────────────────────

type SeedRow = { title: string; icon?: string; days: number; by: number; body?: string; props: Record<string, DbValue> };

const day = (offset: number) => new Date(NOW + offset * DAY).toISOString().slice(0, 10);

/**
 * Two linked databases a support team keeps: the known issues customers write in about
 * (with a workaround, the ticket and the accounts hit) and the key accounts they belong
 * to. The handbook links to the known issues, so its backlinks show it.
 */
function seedDatabases(ws: WsData, st: State, person: (i: number) => string | null, position: number) {
  const people = (...i: number[]) => i.map(person).filter((x): x is string => !!x);
  const hidden = viewerOf(ws).hidden;
  const ticket = (subject: string): Record<string, DbValue> => {
    const t = ws.tickets.find((x) => x.subject === subject && (!x.team_id || !hidden.has(x.team_id)));
    return t ? { ticket: [t.id] } : {};
  };
  const accountsId = uuid();
  const issuesId = uuid();

  const accounts: Database = {
    properties: [
      { id: "title", name: "Name", type: "title" },
      {
        id: "plan",
        name: "Plan",
        type: "select",
        options: [
          { id: "team", name: "Team", color: "blue" },
          { id: "business", name: "Business", color: "purple" },
          { id: "enterprise", name: "Enterprise", color: "orange" },
        ],
      },
      { id: "mrr", name: "MRR", type: "number", number_format: "usd" },
      { id: "owner", name: "Account owner", type: "person" },
      { id: "renewal", name: "Renewal", type: "date" },
      {
        id: "health",
        name: "Health",
        type: "status",
        options: [
          { id: "at_risk", name: "At risk", color: "red" },
          { id: "attention", name: "Needs attention", color: "yellow" },
          { id: "healthy", name: "Healthy", color: "green" },
        ],
        groups: [
          { id: "todo", option_ids: ["at_risk"] },
          { id: "doing", option_ids: ["attention"] },
          { id: "done", option_ids: ["healthy"] },
        ],
      },
    ],
    views: [
      { id: "all", name: "All accounts", type: "table", settings: { sorts: [{ property: "mrr", dir: "desc" }], calculations: { mrr: "sum" }, widths: { title: 220 } } },
      { id: "health", name: "By health", type: "board", settings: { group_by: "health" } },
      { id: "renewals", name: "Renewals", type: "calendar", settings: { date_property: "renewal" } },
    ],
    next_id: 1,
  };
  const ACCOUNTS: SeedRow[] = [
    {
      title: "Northwind Traders",
      days: 120,
      by: 0,
      body: "<p>Enterprise plan, 240 seats across sales and operations. Their IT team runs SSO through Azure AD and reviews every incident report.</p>",
      props: { plan: "enterprise", mrr: 9600, owner: people(0), renewal: { start: day(118) }, health: "attention" },
    },
    {
      title: "Oakridge Health",
      days: 110,
      by: 1,
      body: "<p>Business plan with a HIPAA addendum. Sign-in goes through Okta; any login trouble reaches their clinicians first.</p>",
      props: { plan: "business", mrr: 4200, owner: people(1), renewal: { start: day(41) }, health: "at_risk" },
    },
    {
      title: "Kestrel Robotics",
      days: 95,
      by: 2,
      body: "<p>Field engineers on phones and tablets, often offline for hours. Mobile stability matters more than anything else to them.</p>",
      props: { plan: "business", mrr: 3300, owner: people(2), renewal: { start: day(73) }, health: "attention" },
    },
    {
      title: "Copperleaf",
      days: 80,
      by: 1,
      body: "<p>Builds on our API and webhooks; their engineers read the changelog closely.</p>",
      props: { plan: "business", mrr: 2100, owner: people(1), renewal: { start: day(160) }, health: "healthy" },
    },
    {
      title: "Fjord Analytics",
      days: 70,
      by: 0,
      body: "<p>Team plan. Syncs notes nightly through the API into their warehouse.</p>",
      props: { plan: "team", mrr: 1450, owner: people(0), renewal: { start: day(205) }, health: "healthy" },
    },
  ];

  const issues: Database = {
    properties: [
      { id: "title", name: "Name", type: "title" },
      {
        id: "status",
        name: "Status",
        type: "status",
        options: [
          { id: "investigating", name: "Investigating", color: "orange" },
          { id: "fixing", name: "Fix in progress", color: "blue" },
          { id: "fixed", name: "Fixed", color: "green" },
        ],
        groups: [
          { id: "todo", option_ids: ["investigating"] },
          { id: "doing", option_ids: ["fixing"] },
          { id: "done", option_ids: ["fixed"] },
        ],
      },
      {
        id: "severity",
        name: "Severity",
        type: "select",
        options: [
          { id: "low", name: "Low", color: "gray" },
          { id: "medium", name: "Medium", color: "yellow" },
          { id: "high", name: "High", color: "orange" },
          { id: "critical", name: "Critical", color: "red" },
        ],
      },
      {
        id: "area",
        name: "Area",
        type: "multi_select",
        options: [
          { id: "billing", name: "Billing", color: "green" },
          { id: "login", name: "Login", color: "blue" },
          { id: "mobile", name: "Mobile", color: "pink" },
          { id: "email", name: "Email", color: "yellow" },
          { id: "integrations", name: "Integrations", color: "purple" },
        ],
      },
      { id: "owner", name: "Owner", type: "person" },
      { id: "reported", name: "Reported", type: "date" },
      { id: "affected", name: "Customers affected", type: "number", number_format: "number" },
      { id: "workaround", name: "Workaround", type: "text" },
      { id: "ticket", name: "Ticket", type: "ticket" },
      { id: "issue_id", name: "Issue ID", type: "unique_id", prefix: "ISS" },
      { id: "published", name: "Workaround published", type: "checkbox" },
      { id: "docs", name: "Docs", type: "url" },
      { id: "weight", name: "Weight", type: "formula", formula: 'prop("Customers affected") * if(prop("Severity") == "Critical", 3, 1)', description: "Customers affected, tripled for critical issues" },
      { id: "customer", name: "Customer", type: "relation", database_id: accountsId },
      { id: "mrr_at_risk", name: "MRR at risk", type: "rollup", rollup: { relation: "customer", property: "mrr", fn: "sum" } },
    ],
    views: [
      {
        id: "all",
        name: "All issues",
        type: "table",
        settings: {
          sorts: [{ property: "reported", dir: "desc" }],
          order: ["title", "issue_id", "status", "severity", "area", "owner", "affected", "customer", "mrr_at_risk", "reported", "ticket", "workaround", "published", "docs", "weight"],
          hidden: ["docs", "weight", "published"],
          widths: { title: 320, workaround: 280 },
          calculations: { affected: "sum", mrr_at_risk: "sum" },
        },
      },
      { id: "board", name: "By status", type: "board", settings: { group_by: "status", hidden: ["workaround", "docs", "ticket", "published", "weight", "mrr_at_risk"] } },
      { id: "timeline", name: "Timeline", type: "timeline", settings: { date_property: "reported", timeline_scale: "week" } },
      { id: "calendar", name: "Calendar", type: "calendar", settings: { date_property: "reported" } },
      { id: "gallery", name: "Gallery", type: "gallery", settings: { card_preview: "content", card_size: "medium" } },
      { id: "chart", name: "Severity chart", type: "chart", settings: { chart: { kind: "bar", x: "severity" } } },
    ],
    next_id: 1,
  };
  const ISSUES: SeedRow[] = [
    {
      title: "SSO sign-in loops back to the login page",
      icon: "🔁",
      days: 9,
      by: 1,
      body: "<h2>Symptoms</h2><p>After a successful Okta or Azure AD sign-in, the browser lands on the login page again. It happens when a stale session cookie from before the SSO switch is still around.</p><h2>Status</h2><p>The fix that clears the old cookie ships with the next release. Oakridge Health is the hardest hit: follow the Escalation process for any new report from them.</p>",
      props: {
        status: "fixing",
        severity: "critical",
        area: ["login"],
        owner: people(1),
        reported: { start: day(-9) },
        affected: 14,
        workaround: "Sign out everywhere from Settings, clear cookies for margin.app, then sign in with SSO again.",
        ...ticket("SSO login loops back to sign-in page"),
        published: true,
        docs: "https://docs.margin.app/sso/troubleshooting",
      },
    },
    {
      title: "Mobile app crashes opening shared notebooks",
      icon: "📱",
      days: 6,
      by: 2,
      body: "<h2>Symptoms</h2><p>The iOS app closes as soon as someone opens a notebook another workspace shared with them. Android is not affected.</p><h2>What we know</h2><p>Only notebooks with more than 500 pages crash. Engineering has a crash log and is reproducing it.</p>",
      props: {
        status: "investigating",
        severity: "high",
        area: ["mobile"],
        owner: people(2),
        reported: { start: day(-6) },
        affected: 23,
        workaround: "Open the notebook on the web once and pin it for offline use; the app then opens it.",
        ...ticket("Mobile app crashes when opening shared notebook"),
        published: false,
      },
    },
    {
      title: "Offline notes lost when Android reconnects",
      icon: "📵",
      days: 3,
      by: 0,
      body: "<p>Notes written offline on Android disappear when the phone reconnects, if the same notebook changed on the web in the meantime. Kestrel Robotics has reported it three times.</p>",
      props: {
        status: "investigating",
        severity: "critical",
        area: ["mobile"],
        owner: people(0),
        reported: { start: day(-3) },
        affected: 7,
        workaround: "Copy the note's text before reconnecting, or stay online while writing.",
        ...ticket("Offline mode on Android"),
        published: false,
      },
    },
    {
      title: "Webhook signatures fail after rotating the secret",
      icon: "🪝",
      days: 24,
      by: 1,
      body: "<p>For ten minutes after a rotation we kept signing with the old secret. Fixed on the 14th; deliveries now switch to the new secret at once.</p>",
      props: {
        status: "fixed",
        severity: "high",
        area: ["integrations"],
        owner: people(1),
        reported: { start: day(-24), end: day(-17) },
        affected: 6,
        workaround: "Accept both the old and the new secret for a few minutes after rotating.",
        ...ticket("Webhook signature doesn't validate"),
        published: true,
        docs: "https://docs.margin.app/api/webhooks#signatures",
      },
    },
    {
      title: "Invoices show the old VAT number",
      icon: "🧾",
      days: 30,
      by: 2,
      body: "<p>Invoices issued before a VAT number change kept showing the old one when downloaded again. Corrected invoices can be sent from the billing tool.</p>",
      props: {
        status: "fixed",
        severity: "medium",
        area: ["billing"],
        owner: people(2),
        reported: { start: day(-30), end: day(-21) },
        affected: 9,
        ...ticket("Invoice shows wrong VAT number"),
        published: true,
        docs: "https://docs.margin.app/billing/invoices",
      },
    },
    {
      title: "API rate limit too strict for nightly syncs",
      icon: "🚦",
      days: 12,
      by: 0,
      body: "<p>Syncs of more than 10,000 notes hit 429 responses after the limit change. A higher limit for bulk sync tokens is being rolled out.</p>",
      props: {
        status: "fixing",
        severity: "medium",
        area: ["integrations"],
        owner: people(0),
        reported: { start: day(-12) },
        affected: 4,
        workaround: "Back off on 429 using the Retry-After header, and sync in pages of 500.",
        ...ticket("API returns 429 when syncing notes"),
        published: true,
        docs: "https://docs.margin.app/api/rate-limits",
      },
    },
    {
      title: "Two-factor codes rejected after a phone transfer",
      icon: "🔐",
      days: 5,
      by: 1,
      props: {
        status: "investigating",
        severity: "high",
        area: ["login", "mobile"],
        owner: people(1),
        reported: { start: day(-5) },
        affected: 11,
        workaround: "Sign in with a recovery code, then set up two-factor again on the new phone.",
        ...ticket("Two-factor codes not accepted"),
        published: true,
      },
    },
    {
      title: "Calendar notes stop syncing with Google Calendar",
      icon: "📅",
      days: 15,
      by: 2,
      body: "<p>Meeting notes stop appearing for new events when the Google token expires silently. We now refresh it before it expires; affected workspaces need to reconnect once.</p>",
      props: {
        status: "fixing",
        severity: "medium",
        area: ["integrations", "email"],
        owner: people(2),
        reported: { start: day(-15) },
        affected: 31,
        workaround: "Disconnect and reconnect Google Calendar in Settings > Integrations.",
        ...ticket("Calendar integration stopped syncing"),
        published: true,
      },
    },
    {
      title: "Reminder emails arrive an hour late after the clock change",
      icon: "⏰",
      days: 20,
      by: 0,
      props: {
        status: "fixed",
        severity: "low",
        area: ["email"],
        owner: people(0),
        reported: { start: day(-20), end: day(-16) },
        affected: 18,
        ...ticket("Wrong timezone on reminders"),
        published: false,
      },
    },
    {
      title: "Text pasted from Google Docs gets extra spacing",
      icon: "📋",
      days: 2,
      by: 1,
      body: "<p>Every paragraph pasted from Google Docs gets an empty line after it. Plain-text paste (Ctrl+Shift+V) avoids it.</p>",
      props: {
        status: "investigating",
        severity: "low",
        area: [],
        owner: people(1),
        reported: { start: day(-2) },
        affected: 5,
        workaround: "Paste as plain text with Ctrl+Shift+V (Cmd+Shift+V on a Mac).",
        ...ticket("Pasting from Google Docs adds extra spacing"),
        published: false,
      },
    },
  ];
  // Which accounts each issue hits, by the issue's index.
  const HITS: Record<number, string[]> = {
    0: ["Oakridge Health", "Northwind Traders"],
    1: ["Kestrel Robotics"],
    2: ["Kestrel Robotics"],
    3: ["Copperleaf"],
    4: ["Northwind Traders"],
    5: ["Fjord Analytics", "Copperleaf"],
    7: ["Northwind Traders", "Oakridge Health"],
  };

  const add = (fields: Parameters<typeof newRow>[0], days: number, by: string | null) => {
    const at = ago(days * DAY);
    const r = newRow({ version: 2, created_by: by, updated_by: by, created_at: ago((days + 1) * DAY), updated_at: at, ...fields });
    st.pages.push(r);
    st.revisions.push({ id: uuid(), page_id: r.id, title: r.title, icon: r.icon, body_html: r.body_html, author: by, created_at: at, updated_at: at });
    return r;
  };
  const accountsPage = add(
    { id: accountsId, parent_id: null, title: "Key accounts", icon: "🏢", body_html: "<p>The customers we look after most closely: their plan, who owns them and how they are doing.</p>", position: position + 1, kind: "database", database: accounts },
    130,
    person(0),
  );
  const accountIds = new Map<string, string>();
  ACCOUNTS.forEach((x, i) => {
    const props = { ...x.props };
    nextRowNumbers(accounts, props);
    accountIds.set(x.title, add({ id: uuid(), parent_id: accountsPage.id, title: x.title, icon: x.icon ?? "", body_html: x.body ?? "", position: i, props }, x.days, person(x.by)).id);
  });
  const issuesPage = add(
    {
      id: issuesId,
      parent_id: null,
      title: "Known issues",
      icon: "🐞",
      cover: "gradient:dusk",
      body_html: "<p>Bugs customers write in about, with the workaround to send them and the accounts they hit. Link the ticket, and mark the workaround published once the help center has it.</p>",
      position,
      kind: "database",
      database: issues,
    },
    40,
    person(1),
  );
  // Oldest first, so the issue ids count up with the dates.
  const order = ISSUES.map((x, i) => ({ x, i })).sort((a, b) => b.x.days - a.x.days);
  for (const { x, i } of order) {
    const customer = (HITS[i] ?? []).map((n) => accountIds.get(n)).filter((id): id is string => !!id);
    const props: Record<string, DbValue> = { ...x.props, ...(customer.length ? { customer } : {}) };
    nextRowNumbers(issues, props);
    add({ id: uuid(), parent_id: issuesPage.id, title: x.title, icon: x.icon ?? "", body_html: x.body ?? "", position: i, props }, x.days, person(x.by));
  }
  // A new issue starts from the database's own template.
  add(
    {
      id: uuid(),
      parent_id: issuesPage.id,
      title: "New issue",
      icon: "🐞",
      body_html: "<h2>Symptoms</h2><p></p><h2>Steps to reproduce</h2><ol><li><p></p></li></ol><h2>Workaround</h2><p></p>",
      position: 0,
      template: true,
      props: { status: "investigating", severity: "medium" },
    },
    40,
    person(1),
  );
}

// ─── Ticket backlinks (links.go, contracts/wiki.md "Desk") ──────────────────

/** The ticket ids a body mentions: `<a data-type="ticket" data-id="…">`. */
function mentionedTickets(html: string): Set<string> {
  const out = new Set<string>();
  for (const tag of html.match(/<a\b[^>]*>/gi) ?? []) {
    const id = /\bdata-id="([^"]+)"/.exec(tag)?.[1];
    if (id && /\bdata-type="ticket"/.test(tag)) out.add(id.toLowerCase());
  }
  return out;
}

function registerTicketWiki() {
  // The live pages the caller may see that mention the ticket, newest edit first, at most 50.
  // A ticket the caller may not see is not found.
  get("/v1/tickets/:id/wiki", (ctx) => {
    const t = findTicket(ctx.ws, ctx.params.id);
    if (!t || !canSeeTicket(ctx.ws, t)) throw notFound("Ticket");
    const v = viewerOf(ctx.ws);
    const out = stateOf(ctx.ws)
      .pages.filter((r) => live(v, r) && (r.area === "wiki" || pagesOn(ctx.ws)) && mentionedTickets(r.body_html).has(t.id.toLowerCase()))
      .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
    return pageOf(out.slice(0, 50).map(node));
  });
}

// ─── Import and export (port.go, contracts/wiki.md "Import and export") ─────
//
// The mock reads a small part of what wikiport reads: each Markdown, text or HTML file becomes a
// page (its title from front matter, the first heading or <title>, else the file name), and an
// Obsidian .canvas file a canvas of its text, link and group cards (a file card as text). It can't unpack a zip, build
// a database from a CSV or keep files, and says so with the skip reasons the API uses. Exports
// are real: Markdown with front matter or standalone HTML, and a zip (stored, not compressed) of
// a page with its subpages or of the whole tree, with the API's download headers.

const MAX_UPLOAD = 100 << 20;
const MAX_FILE = 25 << 20;
const MAX_SOURCE = 4 << 20;
const EXECUTABLE = /\.(exe|msi|bat|cmd|com|scr|ps1|sh|bash|js|mjs|vbs|jar|app|dmg|apk|dll|so|py|rb|pl|php)$/i;

type Skip = { path: string; reason: string };
type Source = { key: string; title: string; body: string; canvas: Canvas | null };

const extOf = (name: string) => /\.[^./\\]+$/.exec(name.toLowerCase())?.[0] ?? "";
const stem = (name: string) => (name.split(/[\\/]/).pop() ?? name).replace(/\.[^.]+$/, "");

/** Markdown as wiki HTML: front matter's title, headings, then markdownToHtml's paragraphs, lists, bold and links. */
function markdownPage(text: string, name: string): { title: string; body: string } {
  let md = text.replace(/\r\n?/g, "\n");
  let title = "";
  const front = /^---\n([\s\S]*?)\n---\n?/.exec(md);
  if (front) {
    title = /^title:\s*["']?(.*?)["']?\s*$/m.exec(front[1])?.[1] ?? "";
    md = md.slice(front[0].length);
  }
  const blocks = md.replace(/%%[\s\S]*?%%/g, "").split(/\n{2,}/);
  const html = blocks
    .map((b) => {
      const h = /^(#{1,3})\s+(.+)$/.exec(b.trim());
      if (h && !b.trim().includes("\n")) {
        if (!title && h[1].length === 1) {
          title = h[2].trim();
          return "";
        }
        return `<h${h[1].length}>${escapeHtml(h[2].trim())}</h${h[1].length}>`;
      }
      return markdownToHtml(b.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_m, target: string, alias?: string) => alias ?? target));
    })
    .join("");
  return { title: title || stem(name), body: html };
}

/** An HTML file's page: its <title> or first heading, and its body. */
function htmlPage(text: string, name: string): { title: string; body: string } {
  const doc = new DOMParser().parseFromString(text, "text/html");
  const heading = doc.body.querySelector("h1");
  const title = doc.title.trim() || heading?.textContent?.trim() || stem(name);
  if (heading && heading.textContent?.trim() === title) heading.remove();
  return { title, body: doc.body.innerHTML };
}

/**
 * An Obsidian canvas (JSON Canvas 1.0) as the wiki's: text, https link and group cards and the
 * connections between them. A file card or an http link becomes a text card and other nodes are
 * left out (simplified); cards and connections past a canvas's limits are cut (trimmed).
 */
function obsidianCanvas(text: string): { canvas: Canvas; simplified: boolean; trimmed: boolean } {
  const raw = JSON.parse(text) as { nodes?: unknown[]; edges?: unknown[] };
  const nodes: Record<string, unknown>[] = [];
  let simplified = false;
  for (const n of Array.isArray(raw.nodes) ? raw.nodes : []) {
    if (!isObject(n)) continue;
    const base = { id: n.id, x: n.x, y: n.y, width: n.width, height: n.height, ...(n.color !== undefined ? { color: n.color } : {}) };
    if (n.type === "text") nodes.push({ ...base, type: "text", html: markdownToHtml(String(n.text ?? "")) });
    else if (n.type === "link" && typeof n.url === "string" && n.url.startsWith("https://")) nodes.push({ ...base, type: "link", url: n.url });
    else if (n.type === "group") nodes.push({ ...base, type: "group", ...(typeof n.label === "string" ? { label: n.label } : {}) });
    else if (n.type === "file" || n.type === "link") {
      nodes.push({ ...base, type: "text", html: `<p>${escapeHtml(String(n.file ?? n.url ?? ""))}</p>` });
      simplified = true;
    } else simplified = true;
  }
  const kept = nodes.slice(0, 2000);
  const ids = new Set(kept.map((n) => n.id));
  const linked = (Array.isArray(raw.edges) ? raw.edges : []).filter((e): e is Record<string, unknown> => isObject(e) && ids.has(e.fromNode) && ids.has(e.toNode));
  const edges = linked.slice(0, 4000);
  return { canvas: { nodes: kept, edges } as unknown as Canvas, simplified, trimmed: kept.length < nodes.length || edges.length < linked.length };
}

function registerPort() {
  post("/v1/wiki/import", async (ctx) => {
    requireAgent(ctx);
    const st = stateOf(ctx.ws);
    const field = (k: string) => {
      const v = ctx.form?.get(k);
      return typeof v === "string" ? v : undefined;
    };
    const files = (ctx.form?.getAll("files") ?? []).filter((f): f is File => typeof f !== "string");
    if (!files.length) throw invalid("files is required");
    if (files.reduce((n, f) => n + f.size, 0) > MAX_UPLOAD)
      throw new HttpError(413, "import_too_large", "The import holds more than 200 MB once unpacked, or the upload is over 100 MB. Split it into smaller exports.");
    const par = parentRef(ctx, st, field("parent_id"));
    if (par?.row.kind === "database") throw new HttpError(422, "import_into_database", "Pages can't be imported into a database. Pick a page, or the top level.");
    if (par && par.up.length + 2 > MAX_DEPTH) throw tooDeep();
    const space = par ? { owner: par.row.private_to, team: par.row.team_id } : spaceRef(ctx, field("space"), field("team_id"));
    const area: WikiArea = par ? par.row.area : areaField(ctx, field("area"));

    const skipped: Skip[] = [];
    const sources: Source[] = [];
    let zips = 0;
    for (const f of files) {
      const ext = extOf(f.name);
      if (EXECUTABLE.test(f.name)) skipped.push({ path: f.name, reason: "executable" });
      else if (f.size > MAX_FILE || ([".md", ".markdown", ".txt", ".html", ".htm", ".canvas"].includes(ext) && f.size > MAX_SOURCE))
        skipped.push({ path: f.name, reason: "too_large" });
      else if (ext === ".md" || ext === ".markdown") sources.push({ key: f.name, ...markdownPage(await f.text(), f.name), canvas: null });
      else if (ext === ".txt") sources.push({ key: f.name, title: stem(f.name), body: textToParagraphs(await f.text()), canvas: null });
      else if (ext === ".html" || ext === ".htm") sources.push({ key: f.name, ...htmlPage(await f.text(), f.name), canvas: null });
      else if (ext === ".canvas") {
        try {
          const read = obsidianCanvas(await f.text());
          sources.push({ key: f.name, title: stem(f.name), body: "", canvas: cleanCanvas(ctx, st, read.canvas, null) });
          if (read.trimmed) skipped.push({ path: f.name, reason: "canvas_trimmed" });
          if (read.simplified) skipped.push({ path: f.name, reason: "canvas_simplified" });
        } catch {
          skipped.push({ path: f.name, reason: "unreadable" });
        }
      } else {
        if (ext === ".zip") zips++;
        // The mock has no zip reader, and keeps no files a page doesn't hold.
        skipped.push({ path: f.name, reason: ext === ".zip" || ext === ".csv" ? "unsupported" : "unused" });
      }
    }
    if (!sources.length) {
      if (zips) throw new HttpError(422, "import_unsupported", "The mock app can't unpack a zip. Upload Markdown, HTML, text or canvas files instead.");
      throw new HttpError(422, "import_empty", "The upload holds no pages to import.");
    }
    roomFor(st, sources.length);

    const root_ids: string[] = [];
    for (const src of sources) {
      let body = src.body;
      try {
        body = cleanBody(body);
      } catch {
        body = "";
        skipped.push({ path: src.key, reason: "body_too_large" });
      }
      const r = newRow({
        id: uuid(),
        parent_id: par?.row.id ?? null,
        title: [...src.title.replace(/\s+/g, " ").trim()].slice(0, 200).join(""),
        icon: "",
        body_html: body,
        private_to: space.owner,
        team_id: space.team,
        template: par?.row.template ?? false,
        kind: src.canvas ? "canvas" : "page",
        canvas: src.canvas,
        area,
      });
      st.pages.push(r);
      place(st, r.parent_id, r.private_to, r.team_id, r.template, r.area, r.id);
      record(st, r, false);
      pageEvent(ctx.ws, r, "wiki_page.created", eventPage(r));
      root_ids.push(r.id);
    }
    return respond(201, { pages: root_ids.length, root_ids, skipped });
  });

  get("/v1/wiki/pages/:id/export", (ctx) => {
    const st = stateOf(ctx.ws);
    const r = find(ctx, st);
    if (r.deleted_at) throw notFound("Page");
    const format = exportFormat(ctx);
    const v = viewerOf(ctx.ws);
    const below = (id: string): Row[] => st.pages.filter((c) => c.parent_id === id && !c.deleted_at && c.template === r.template && sees(v, c)).sort(byPosition);
    if (ctx.query.get("subpages") !== "true" || !below(r.id).length) {
      const ext = format === "html" ? "html" : r.kind === "canvas" ? "canvas" : "md";
      const type = { html: "text/html; charset=utf-8", canvas: "application/json; charset=utf-8", md: "text/markdown; charset=utf-8" }[ext];
      return download(type, `${exportBaseName(r.title)}.${ext}`, exportText(st, r, format));
    }
    const files: ZipFile[] = [];
    const walk = (p: Row, dir: string) => {
      const name = uniqueName(files, dir, p, format);
      files.push({ name, data: new TextEncoder().encode(exportText(st, p, format)) });
      for (const c of below(p.id)) walk(c, `${dir}${exportBaseName(p.title)}/`);
    };
    walk(r, "");
    return download("application/zip", `${exportBaseName(r.title)}.zip`, storedZip(files));
  });

  get("/v1/wiki/export", (ctx) => {
    const st = stateOf(ctx.ws);
    const format = exportFormat(ctx);
    const v = viewerOf(ctx.ws);
    const area = areaParam(ctx);
    const tree = st.pages.filter((r) => live(v, r) && r.area === area);
    if (!tree.length) throw new HttpError(422, "wiki_empty", "There are no pages to export yet.");
    const files: ZipFile[] = [];
    const walk = (parent: string | null, dir: string) => {
      for (const p of tree.filter((r) => r.parent_id === parent).sort(byPosition)) {
        files.push({ name: uniqueName(files, dir, p, format), data: new TextEncoder().encode(exportText(st, p, format)) });
        walk(p.id, `${dir}${exportBaseName(p.title)}/`);
      }
    };
    walk(null, "");
    return download("application/zip", `${area === "pages" ? "Pages" : "Wiki"} ${new Date().toISOString().slice(0, 10)}.zip`, storedZip(files));
  });
}

function exportFormat(ctx: Ctx): "markdown" | "html" {
  const f = ctx.query.get("format") ?? "markdown";
  if (f !== "markdown" && f !== "html") throw invalid("format must be markdown or html");
  return f;
}

/** A page as its export file: Markdown with front matter (a canvas as JSON Canvas), or a standalone HTML page. */
function exportText(st: State, r: Row, format: "markdown" | "html"): string {
  const title = r.title.trim() || "Untitled";
  if (format === "html") {
    const cards = r.canvas ? r.canvas.nodes.map((n) => (n.type === "text" ? n.html : n.type === "group" ? `<h2>${escapeHtml(n.label ?? "")}</h2>` : n.type === "link" ? `<p><a href="${escapeHtml(n.url)}">${escapeHtml(n.title || n.url)}</a></p>` : "")).join("") : "";
    return `<!doctype html>\n<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1>${r.body_html}${cards}</body></html>\n`;
  }
  if (r.canvas) {
    const nodes = r.canvas.nodes.map((n) => {
      const base = { id: n.id, x: n.x, y: n.y, width: n.width, height: n.height, ...(n.color ? { color: n.color } : {}) };
      switch (n.type) {
        case "text":
          return { ...base, type: "text", text: htmlToMarkdown(n.html) };
        case "page":
          return { ...base, type: "text", text: `[[${st.pages.find((p) => p.id === n.page_id)?.title || "Untitled"}]]` };
        case "link":
          return { ...base, type: "link", url: n.url };
        case "file":
          return n.src.startsWith("https://") ? { ...base, type: "link", url: n.src } : { ...base, type: "text", text: n.name };
        case "group":
          return { ...base, type: "group", ...(n.label ? { label: n.label } : {}) };
      }
    });
    return JSON.stringify({ nodes, edges: r.canvas.edges }, null, "\t") + "\n";
  }
  const tags = pageTags(r.body_html, stripHtml);
  const front = [`title: ${JSON.stringify(title)}`, ...(r.icon ? [`icon: ${JSON.stringify(r.icon)}`] : []), `created: ${r.created_at}`, `updated: ${r.updated_at}`, ...(tags.length ? [`tags: [${tags.join(", ")}]`] : [])];
  return `---\n${front.join("\n")}\n---\n\n${htmlToMarkdown(r.body_html)}\n`;
}

/** A page's path in a zip, made unique among the files already there. */
function uniqueName(files: ZipFile[], dir: string, r: Row, format: "markdown" | "html"): string {
  const ext = format === "html" ? "html" : r.kind === "canvas" ? "canvas" : "md";
  const base = `${dir}${exportBaseName(r.title)}`;
  let name = `${base}.${ext}`;
  for (let i = 2; files.some((f) => f.name === name); i++) name = `${base} ${i}.${ext}`;
  return name;
}

/** A download as the API answers one: never shown or sniffed, never stored. */
function download(contentType: string, name: string, body: string | Uint8Array): Response {
  const disposition = /^[\x20-\x7e]*$/.test(name) ? `attachment; filename="${name.replace(/["\\]/g, "\\$&")}"` : `attachment; filename*=utf-8''${encodeURIComponent(name)}`;
  return new Response(body as BodyInit, {
    status: 200,
    headers: {
      "content-type": contentType,
      "content-disposition": disposition,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, no-store",
    },
  });
}

type ZipFile = { name: string; data: Uint8Array };

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip of files stored as they are (method 0), with UTF-8 names. */
export function storedZip(files: ZipFile[]): Uint8Array {
  const enc = new TextEncoder();
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true);
    head.setUint16(4, 20, true);
    head.setUint16(6, 0x0800, true); // names in UTF-8
    head.setUint32(14, crc, true);
    head.setUint32(18, f.data.length, true);
    head.setUint32(22, f.data.length, true);
    head.setUint16(26, name.length, true);
    local.push(new Uint8Array(head.buffer), name, f.data);
    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(4, 20, true);
    dir.setUint16(6, 20, true);
    dir.setUint16(8, 0x0800, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, f.data.length, true);
    dir.setUint32(24, f.data.length, true);
    dir.setUint16(28, name.length, true);
    dir.setUint32(42, offset, true);
    central.push(new Uint8Array(dir.buffer), name);
    offset += 30 + name.length + f.data.length;
  }
  const size = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  const parts = [...local, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ─── Aliases and page analytics (aliases.go, analytics.go) ─────────────────

const MAX_ALIASES = 10;
const MAX_ALIAS = 100;
const VIEW_GAP = 30 * MIN;
const VIEW_DAYS = 90;

/** Aliases as the API keeps them: whitespace folded, empty and repeated (any case) left out, 10 of 100 characters at most. */
export function cleanAliases(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw invalid("aliases must be a list of names");
  const out: string[] = [];
  for (const x of raw) {
    if (typeof x !== "string") throw invalid("aliases must be a list of names");
    const a = x.split(/\s+/).filter(Boolean).join(" ");
    if (!a) continue;
    if ([...a].length > MAX_ALIAS) throw invalid("an alias is at most 100 characters");
    if (!out.some((o) => o.toLowerCase() === a.toLowerCase())) out.push(a);
  }
  if (out.length > MAX_ALIASES) throw invalid("a page has at most 10 aliases");
  return out;
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** A view of the day, once per person and VIEW_GAP: `last` is their read before this one. */
function countView(st: State, user: string, page: string, last: string | undefined) {
  const today = utcDay(Date.now());
  const same = !!last && Date.now() - Date.parse(last) < VIEW_GAP;
  const v = st.views.find((x) => x.user_id === user && x.page_id === page && x.day === today);
  if (v) v.views += same ? 0 : 1;
  else st.views.push({ user_id: user, page_id: page, day: today, views: 1 });
}

/** A few aliases on the handbook, and its readers' views over the last weeks. */
function seedAliasesAndViews(st: State, people: string[]) {
  const named: Record<string, string[]> = { "Refund policy": ["Money back", "Returns"], "Escalation process": ["Escalating a ticket"] };
  for (const r of st.pages) if (!r.template && named[r.title]) r.aliases = named[r.title];
  st.pages
    .filter((p) => !p.template && !p.private_to)
    .forEach((p, i) => {
      for (let d = 0; d < 40; d++) {
        people.forEach((u, j) => {
          // A busy start of the week, quieter weekends, and some pages read more than others.
          const n = (i * 7 + j * 3 + d * 5) % (i % 3 === 0 ? 4 : 9);
          if (n > 2) return;
          st.views.push({ user_id: u, page_id: p.id, day: utcDay(NOW - d * DAY), views: 1 + ((i + j + d) % 3) });
        });
      }
    });
}

function registerAnalytics() {
  get("/v1/wiki/pages/:id/analytics", (ctx) => {
    const st = stateOf(ctx.ws);
    const r = find(ctx, st);
    const raw = ctx.query.get("days");
    const days = raw === null || raw === "" ? 28 : Number(raw);
    if (!Number.isInteger(days) || days < 0 || days > VIEW_DAYS) throw invalid("days must be from 1 to 90");
    const n = days || 28;
    const range = Array.from({ length: n }, (_, i) => utcDay(Date.now() - (n - 1 - i) * DAY));
    const inRange = new Set(range);
    const views = st.views.filter((x) => x.page_id === r.id && inRange.has(x.day));
    const out = range.map((date) => {
      const of = views.filter((x) => x.day === date);
      return { date, views: of.reduce((t, x) => t + x.views, 0), viewers: of.length };
    });
    const edits = range.map((date) => ({ date, count: st.revisions.filter((x) => x.page_id === r.id && utcDay(Date.parse(x.created_at)) === date).length }));
    return { days: out, total_views: out.reduce((t, x) => t + x.views, 0), total_viewers: new Set(views.map((x) => x.user_id)).size, edits };
  });
}

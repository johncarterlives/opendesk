// The changelog (contracts/api.md "Changelog"): entries a workspace publishes on its help centers.

import type { ChangelogCategory, ChangelogEntry } from "@/lib/api/types";
import { db, userRef, type WsData } from "../db";
import { publish } from "../gateway";
import { HttpError, del, forbidden, get, invalid, notFound, paginate, patch, post, required, respond, s, strArr, type Ctx } from "../router";
import { nowIso, slugify, uuid } from "../util";

const MAX_CATEGORIES = 5;
const MAX_CATEGORY = 32;

/** The date an entry is listed by: its own, else when it was last edited (drafts). */
const listedAt = (e: ChangelogEntry) => Date.parse(e.published_at ?? e.updated_at);

function stateOf(e: ChangelogEntry, now = Date.now()): "draft" | "published" | "scheduled" {
  if (e.status === "draft") return "draft";
  return e.published_at && Date.parse(e.published_at) > now ? "scheduled" : "published";
}

/** Up to five names, whitespace collapsed, a second spelling of one already there dropped. */
function categories(v: unknown): string[] {
  const list = strArr(v);
  if (!list) throw invalid("categories must be a list of names");
  const out: string[] = [];
  for (const raw of list) {
    const name = raw.trim().replace(/\s+/g, " ");
    if (!name) continue;
    if ([...name].length > MAX_CATEGORY) throw invalid(`A category can be up to ${MAX_CATEGORY} characters`);
    if (out.some((c) => c.toLowerCase() === name.toLowerCase())) continue;
    out.push(name);
  }
  if (out.length > MAX_CATEGORIES) throw invalid(`An entry can have up to ${MAX_CATEGORIES} categories`);
  return out;
}

function brandRef(ctx: Ctx, v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string" || !ctx.ws.brands.some((b) => b.id === v)) throw invalid("brand_id must be a brand of the workspace");
  return v;
}

function date(v: unknown): string | null {
  if (v === null) return null;
  if (typeof v !== "string" || Number.isNaN(Date.parse(v))) throw invalid("published_at must be a date");
  return new Date(v).toISOString();
}

function slugFor(ws: WsData, raw: string, self?: ChangelogEntry): string {
  const slug = slugify(raw) || "update";
  if (ws.changelog.some((e) => e !== self && e.slug === slug)) throw new HttpError(409, "conflict", "Another update uses this address");
  return slug;
}

function uniqueSlug(ws: WsData, title: string): string {
  const base = slugify(title) || "update";
  let slug = base;
  for (let i = 2; ws.changelog.some((e) => e.slug === slug); i++) slug = `${base}-${i}`;
  return slug;
}

/** Plain text of the body, cut to 300 characters. */
function excerptOf(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}

function find(ctx: Ctx): ChangelogEntry {
  const e = ctx.ws.changelog.find((x) => x.id === ctx.params.id);
  if (!e) throw notFound("Changelog entry");
  return e;
}

function requireAgent(ctx: Ctx) {
  const me = ctx.ws.members.find((m) => m.user_id === db.meId);
  if (!me || me.role === "viewer") throw forbidden("Viewers can't change the changelog");
}

export function registerChangelog() {
  get("/v1/changelog/entries", (ctx) => {
    const status = ctx.query.get("status");
    const category = (ctx.query.get("category") ?? "").trim().toLowerCase();
    const q = (ctx.query.get("q") ?? "").trim().toLowerCase();
    const brand = (ctx.query.get("brand_id") ?? "").trim();
    const forBrand = ctx.query.get("for_brand_id");
    let list = ctx.ws.changelog;
    if (status) {
      if (status !== "draft" && status !== "published" && status !== "scheduled") throw invalid("status must be draft, published or scheduled");
      list = list.filter((e) => stateOf(e) === status);
    }
    if (category) list = list.filter((e) => e.categories.some((c) => c.toLowerCase() === category));
    if (brand) list = list.filter((e) => (brand === "none" ? e.brand_id === null : e.brand_id === brand));
    if (forBrand) {
      if (!ctx.ws.brands.some((b) => b.id === forBrand)) throw invalid("for_brand_id must be a brand of the workspace");
      list = list.filter((e) => e.brand_id === null || e.brand_id === forBrand);
    }
    if (q) {
      // Best match first, and one page: a title hit before a body hit.
      const score = (e: ChangelogEntry) => (e.title.toLowerCase().includes(q) ? 2 : 0) + ((e.excerpt + " " + e.body_html).toLowerCase().includes(q) ? 1 : 0);
      const hits = list.filter((e) => score(e) > 0).sort((a, b) => score(b) - score(a) || listedAt(b) - listedAt(a));
      return { data: hits.slice(0, 50), next_cursor: null };
    }
    return paginate(ctx, list.slice().sort((a, b) => listedAt(b) - listedAt(a) || b.id.localeCompare(a.id)), 20);
  });

  get("/v1/changelog/entries/:id", (ctx) => find(ctx));

  get("/v1/changelog/categories", (ctx) => {
    const counts = new Map<string, ChangelogCategory>();
    for (const e of ctx.ws.changelog)
      for (const name of e.categories) {
        const c = counts.get(name.toLowerCase());
        if (c) c.count++;
        else counts.set(name.toLowerCase(), { name, count: 1 });
      }
    return [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  });

  post("/v1/changelog/entries", (ctx) => {
    requireAgent(ctx);
    const title = required(ctx, "title");
    if (title.length > 200) throw invalid("title can be up to 200 characters");
    const status = s(ctx, "status") === "published" ? "published" : "draft";
    const body = s(ctx, "body_html") ?? "";
    const now = nowIso();
    const given = "published_at" in ctx.body ? date(ctx.body.published_at) : null;
    const e: ChangelogEntry = {
      id: uuid(),
      title,
      slug: s(ctx, "slug") ? slugFor(ctx.ws, s(ctx, "slug")!) : uniqueSlug(ctx.ws, title),
      excerpt: s(ctx, "excerpt")?.trim().slice(0, 300) || excerptOf(body),
      body_html: body,
      categories: "categories" in ctx.body ? categories(ctx.body.categories) : [],
      status,
      published_at: given ?? (status === "published" ? now : null),
      author: userRef(db.meId),
      brand_id: brandRef(ctx, ctx.body.brand_id),
      created_at: now,
      updated_at: now,
    };
    ctx.ws.changelog.unshift(e);
    publish(ctx.ws, "changelog_entry.created", { changelog_entry: e });
    return respond(201, e);
  });

  patch("/v1/changelog/entries/:id", (ctx) => {
    requireAgent(ctx);
    const e = find(ctx);
    if ("title" in ctx.body) {
      const title = s(ctx, "title")?.trim();
      if (!title) throw invalid("Title can't be empty");
      if (title.length > 200) throw invalid("title can be up to 200 characters");
      e.title = title;
    }
    if (s(ctx, "slug")) e.slug = slugFor(ctx.ws, s(ctx, "slug")!, e);
    if (typeof ctx.body.body_html === "string") e.body_html = ctx.body.body_html;
    if (typeof ctx.body.excerpt === "string") e.excerpt = ctx.body.excerpt.trim().slice(0, 300) || excerptOf(e.body_html);
    if ("categories" in ctx.body) e.categories = categories(ctx.body.categories);
    if ("brand_id" in ctx.body) e.brand_id = brandRef(ctx, ctx.body.brand_id);
    if ("published_at" in ctx.body) e.published_at = date(ctx.body.published_at);
    const status = s(ctx, "status");
    if (status === "published" || status === "draft") e.status = status;
    // Dated when first published unless given; kept when unpublished.
    if (e.status === "published" && !e.published_at) e.published_at = nowIso();
    e.updated_at = nowIso();
    publish(ctx.ws, "changelog_entry.updated", { changelog_entry: e });
    return e;
  });

  del("/v1/changelog/entries/:id", (ctx) => {
    requireAgent(ctx);
    const e = find(ctx);
    ctx.ws.changelog = ctx.ws.changelog.filter((x) => x !== e);
    publish(ctx.ws, "changelog_entry.deleted", { changelog_entry_id: e.id });
    return respond(204);
  });
}

/** A deleted brand's entries go with it. */
export function removeBrandChangelog(ws: WsData, brandId: string) {
  for (const e of ws.changelog.filter((x) => x.brand_id === brandId)) publish(ws, "changelog_entry.deleted", { changelog_entry_id: e.id });
  ws.changelog = ws.changelog.filter((x) => x.brand_id !== brandId);
}

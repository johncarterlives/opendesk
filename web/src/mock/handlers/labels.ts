// Labels (/v1/tags), label groups (/v1/tag-groups) and custom field
// definitions (/v1/custom-fields). Definitions are managed by admins.

import type { CustomField, FieldEntity, FieldOption, FieldType, LabelColor, LabelScope, Tag, TagGroup, TagRef } from "@/lib/api/types";
import { LABEL_COLORS } from "@/lib/api/types";
import { db, userRef, type WsData } from "../db";
import { publish } from "../gateway";
import { HttpError, del, forbidden, get, invalid, notFound, patch, post, required, respond, s, strArr, type Ctx } from "../router";
import {
  ALL_SCOPES,
  MAX_FIELDS_PER_ENTITY,
  MAX_OPTIONS,
  applyLabels,
  cleanTagName,
  compareTags,
  defaultColor,
  fieldEmpty,
  makeTag,
  syncTagRefs,
  tagOut,
} from "../labels";
import { publishTicketUpdated } from "../tickets";
import { nowIso, slugify, uuid } from "../util";

const MAX_TAG_GROUPS = 50;
const FIELD_TYPES: FieldType[] = ["text", "long_text", "number", "select", "multi_select", "date", "checkbox", "url", "email", "user"];
const ENTITIES: FieldEntity[] = ["ticket", "contact", "company"];

function requireAdmin(ws: WsData) {
  const r = ws.members.find((m) => m.user_id === db.meId)?.role;
  if (r !== "owner" && r !== "admin") throw forbidden("Only admins can change labels and fields");
}

function audit(ws: WsData, action: string, entity_type: string, entity_id: string, data: Record<string, unknown>) {
  ws.audit.unshift({
    id: uuid(),
    actor: { type: "user", user: userRef(db.meId), api_key_id: null },
    action,
    entity_type,
    entity_id,
    data,
    ip: "84.152.33.17",
    created_at: nowIso(),
  });
}

/** Names people choose: trimmed, no markup, bounded. */
function cleanName(raw: unknown, what: string, max: number): string {
  if (typeof raw !== "string") throw invalid(`${what} is required`);
  const v = raw.trim().replace(/\s+/g, " ");
  if (!v) throw invalid(`${what} is required`);
  if ([...v].length > max) throw invalid(`${what} must be ${max} characters or less`);
  if (/[<>]/.test(v)) throw invalid(`${what} can't contain < or >`);
  return v;
}

function color(v: unknown, what = "color"): LabelColor {
  if (typeof v !== "string" || !LABEL_COLORS.includes(v as LabelColor)) throw invalid(`${what} must be one of ${LABEL_COLORS.join(", ")}`);
  return v as LabelColor;
}

function description(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") throw invalid("description must be text");
  const d = v.trim();
  if ([...d].length > 300) throw invalid("description must be 300 characters or less");
  if (/[<>]/.test(d)) throw invalid("description can't contain < or >");
  return d;
}

function scopes(v: unknown): LabelScope[] {
  const list = strArr(v);
  if (!list?.length || list.some((x) => !ALL_SCOPES.includes(x as LabelScope))) throw invalid("applies_to must list tickets, contacts or companies");
  return ALL_SCOPES.filter((x) => list.includes(x));
}

function groupId(ws: WsData, v: unknown): string | null {
  if (v === null || v === "") return null;
  if (typeof v !== "string" || !ws.tagGroups.some((g) => g.id === v)) throw invalid("Unknown label group");
  return v;
}

function sortedTags(ws: WsData): Tag[] {
  return ws.tags.slice().sort(compareTags(ws)).map((t) => tagOut(ws, t));
}

function groupOut(ws: WsData, g: TagGroup): TagGroup {
  g.tag_count = ws.tags.filter((t) => t.group_id === g.id).length;
  return g;
}

/** Renames from to to in a comma-separated label list, keeping each name once. */
function renameInList(list: string | undefined, from: string, to: string): string | undefined {
  if (!list) return list;
  const names = list.split(",").map((x) => x.trim()).filter(Boolean);
  if (!names.some((n) => n.toLowerCase() === from.toLowerCase())) return list;
  const out: string[] = [];
  for (const n of names.map((x) => (x.toLowerCase() === from.toLowerCase() ? to : x))) if (!out.some((x) => x.toLowerCase() === n.toLowerCase())) out.push(n);
  return out.join(",");
}

/** Views and automations name labels; keep them pointing at the label after a rename or merge. */
function rewriteLabelRefs(ws: WsData, from: string, to: string) {
  const same = (x: string | undefined) => !!x && x.toLowerCase() === from.toLowerCase();
  for (const v of ws.views) {
    const tag = renameInList(v.filters.tag, from, to);
    const tagNot = renameInList(v.filters.tag_not, from, to);
    if (tag !== v.filters.tag || tagNot !== v.filters.tag_not) v.filters = { ...v.filters, tag, tag_not: tagNot };
  }
  for (const a of ws.automations) {
    for (const c of a.conditions) if (c.field === "tag" && same(c.value)) c.value = to;
    for (const x of a.actions) if ((x.type === "add_tag" || x.type === "remove_tag") && same(x.value)) x.value = to;
  }
}

function reorder<R extends { id: string; position: number }>(rows: R[], ids: string[] | undefined, what: string) {
  if (!ids?.length) throw invalid("ids is required");
  if (ids.length > 1000) throw invalid("At most 1000 ids");
  if (new Set(ids).size !== ids.length) throw invalid("ids must not repeat");
  for (const id of ids) if (!rows.some((r) => r.id === id)) throw invalid(`Unknown ${what} ${id}`);
  ids.forEach((id, i) => {
    rows.find((r) => r.id === id)!.position = i;
  });
}

function findTag(ctx: Ctx): Tag {
  const t = ctx.ws.tags.find((x) => x.id === ctx.params.id);
  if (!t) throw notFound("Tag");
  return t;
}

function findGroup(ctx: Ctx): TagGroup {
  const g = ctx.ws.tagGroups.find((x) => x.id === ctx.params.id);
  if (!g) throw notFound("Tag group");
  return g;
}

function findField(ctx: Ctx): CustomField {
  const f = ctx.ws.customFields.find((x) => x.id === ctx.params.id);
  if (!f) throw notFound("Custom field");
  return f;
}

function recordsOf(ws: WsData, entity: FieldEntity): { fields: Record<string, unknown> }[] {
  return entity === "ticket" ? ws.tickets : entity === "contact" ? ws.contacts : ws.companies;
}

function options(raw: unknown, prev: FieldOption[] = []): FieldOption[] {
  if (raw === undefined) return prev;
  if (!Array.isArray(raw)) throw invalid("options must be a list");
  if (raw.length > MAX_OPTIONS) throw invalid(`A field can have at most ${MAX_OPTIONS} options`);
  const out: FieldOption[] = [];
  for (const o of raw as Record<string, unknown>[]) {
    const label = cleanName(o?.label, "Option label", 60);
    let id = typeof o.id === "string" && o.id ? o.id : slugify(label).replace(/-/g, "_").slice(0, 40) || "option";
    if (!o.id) for (let i = 2; out.some((x) => x.id === id); i++) id = `${id.replace(/_\d+$/, "")}_${i}`;
    if (!/^[a-z0-9_-]{1,40}$/.test(id)) throw invalid(`Option id "${id}" must be lowercase letters, numbers, - and _`);
    if (out.some((x) => x.id === id)) throw invalid(`Option id "${id}" is used twice`);
    out.push({ id, label, color: o.color === undefined ? "gray" : color(o.color, "option color") });
  }
  return out;
}

export function registerLabels() {
  // Labels.
  get("/v1/tags", (ctx) => {
    const q = (ctx.query.get("q") ?? "").trim().toLowerCase();
    const group = ctx.query.get("group_id");
    const archived = ctx.query.get("archived") ?? "any";
    const scope = ctx.query.get("applies_to") as LabelScope | null;
    let list = sortedTags(ctx.ws);
    if (q) list = list.filter((t) => t.name.toLowerCase().includes(q));
    if (group === "none") list = list.filter((t) => !t.group_id);
    else if (group) list = list.filter((t) => t.group_id === group);
    if (archived !== "any") list = list.filter((t) => t.archived === (archived === "true"));
    if (scope) list = list.filter((t) => t.applies_to.includes(scope));
    return { data: list, next_cursor: null };
  });
  get("/v1/tags/:id", (ctx) => tagOut(ctx.ws, findTag(ctx)));
  post("/v1/tags/reorder", (ctx) => {
    requireAdmin(ctx.ws);
    reorder(ctx.ws.tags, strArr(ctx.body.ids), "tag");
    syncTagRefs(ctx.ws);
    audit(ctx.ws, "tags.reordered", "tag", "", { count: strArr(ctx.body.ids)?.length ?? 0 });
    for (const t of ctx.ws.tags) publish(ctx.ws, "tag.updated", { tag: tagOut(ctx.ws, t) });
    return respond(200, { data: sortedTags(ctx.ws), next_cursor: null });
  });
  post("/v1/tags", (ctx) => {
    requireAdmin(ctx.ws);
    const name = cleanTagName(required(ctx, "name"));
    if (ctx.ws.tags.some((t) => t.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, "conflict", "A label with this name already exists");
    if (ctx.ws.tags.length >= 1000) throw invalid("A workspace can have at most 1000 labels");
    const tag = makeTag(ctx.ws, name, {
      color: ctx.body.color === undefined ? defaultColor(name) : color(ctx.body.color),
      description: description(ctx.body.description),
      group_id: groupId(ctx.ws, ctx.body.group_id ?? null),
      applies_to: ctx.body.applies_to === undefined ? [...ALL_SCOPES] : scopes(ctx.body.applies_to),
      position: typeof ctx.body.position === "number" ? ctx.body.position : undefined,
    });
    audit(ctx.ws, "tag.created", "tag", tag.id, { name });
    publish(ctx.ws, "tag.created", { tag: tagOut(ctx.ws, tag) });
    return respond(201, tagOut(ctx.ws, tag));
  });
  patch("/v1/tags/:id", (ctx) => {
    requireAdmin(ctx.ws);
    const tag = findTag(ctx);
    const before = tag.name;
    if ("name" in ctx.body) {
      const name = cleanTagName(required(ctx, "name"));
      if (ctx.ws.tags.some((t) => t.id !== tag.id && t.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, "conflict", "A label with this name already exists");
      tag.name = name;
    }
    if ("color" in ctx.body) tag.color = color(ctx.body.color);
    if ("description" in ctx.body) tag.description = description(ctx.body.description);
    if ("group_id" in ctx.body) tag.group_id = groupId(ctx.ws, ctx.body.group_id);
    if (typeof ctx.body.position === "number") tag.position = ctx.body.position;
    if (typeof ctx.body.archived === "boolean") tag.archived = ctx.body.archived;
    if ("applies_to" in ctx.body) tag.applies_to = scopes(ctx.body.applies_to);
    tag.updated_at = nowIso();
    if (tag.name !== before) rewriteLabelRefs(ctx.ws, before, tag.name);
    syncTagRefs(ctx.ws);
    audit(ctx.ws, "tag.updated", "tag", tag.id, { fields: Object.keys(ctx.body) });
    publish(ctx.ws, "tag.updated", { tag: tagOut(ctx.ws, tag) });
    return tagOut(ctx.ws, tag);
  });
  del("/v1/tags/:id", (ctx) => {
    requireAdmin(ctx.ws);
    const tag = findTag(ctx);
    ctx.ws.tags = ctx.ws.tags.filter((x) => x !== tag);
    for (const t of ctx.ws.tickets) t.tags = t.tags.filter((x) => x.id !== tag.id);
    for (const c of ctx.ws.contacts) c.tags = c.tags.filter((x) => x.id !== tag.id);
    for (const c of ctx.ws.companies) c.tags = c.tags.filter((x) => x.id !== tag.id);
    audit(ctx.ws, "tag.deleted", "tag", tag.id, { name: tag.name });
    publish(ctx.ws, "tag.deleted", { tag_id: tag.id });
    return respond(204);
  });
  post("/v1/tags/:id/merge", (ctx) => {
    requireAdmin(ctx.ws);
    const from = findTag(ctx);
    const into = ctx.ws.tags.find((x) => x.id === s(ctx, "into"));
    if (!into) throw invalid("Unknown label to merge into");
    if (into.id === from.id) throw invalid("A label can't be merged into itself");
    const move = (rows: { tags: TagRef[] }[], scope: LabelScope) => {
      for (const r of rows) {
        if (!r.tags.some((x) => x.id === from.id)) continue;
        const rest = r.tags.filter((x) => x.id !== from.id);
        r.tags = into.applies_to.includes(scope) ? applyLabels(ctx.ws, scope, rest, { add: [into.name] }, { create: false, lenient: true }).next : rest;
      }
    };
    move(ctx.ws.tickets, "tickets");
    move(ctx.ws.contacts, "contacts");
    move(ctx.ws.companies, "companies");
    ctx.ws.tags = ctx.ws.tags.filter((x) => x !== from);
    rewriteLabelRefs(ctx.ws, from.name, into.name);
    audit(ctx.ws, "tag.merged", "tag", into.id, { from: from.name, into: into.name });
    publish(ctx.ws, "tag.merged", { tag_id: from.id, into: tagOut(ctx.ws, into) });
    return respond(200, tagOut(ctx.ws, into));
  });

  // Label groups.
  get("/v1/tag-groups", (ctx) => ({
    data: ctx.ws.tagGroups
      .slice()
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
      .map((g) => groupOut(ctx.ws, g)),
    next_cursor: null,
  }));
  get("/v1/tag-groups/:id", (ctx) => groupOut(ctx.ws, findGroup(ctx)));
  post("/v1/tag-groups/reorder", (ctx) => {
    requireAdmin(ctx.ws);
    reorder(ctx.ws.tagGroups, strArr(ctx.body.ids), "tag group");
    syncTagRefs(ctx.ws);
    audit(ctx.ws, "tag_groups.reordered", "tag_group", "", { count: strArr(ctx.body.ids)?.length ?? 0 });
    const data = ctx.ws.tagGroups.slice().sort((a, b) => a.position - b.position).map((g) => groupOut(ctx.ws, g));
    for (const g of data) publish(ctx.ws, "tag_group.updated", { tag_group: g });
    return respond(200, { data, next_cursor: null });
  });
  post("/v1/tag-groups", (ctx) => {
    requireAdmin(ctx.ws);
    if (ctx.ws.tagGroups.length >= MAX_TAG_GROUPS) throw invalid(`A workspace can have at most ${MAX_TAG_GROUPS} label groups`);
    const name = cleanName(ctx.body.name, "Name", 50);
    if (ctx.ws.tagGroups.some((g) => g.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, "conflict", "A label group with this name already exists");
    const at = nowIso();
    const g: TagGroup = {
      id: uuid(),
      name,
      color: ctx.body.color === undefined || ctx.body.color === null ? null : color(ctx.body.color),
      exclusive: ctx.body.exclusive === true,
      position: typeof ctx.body.position === "number" ? ctx.body.position : ctx.ws.tagGroups.length,
      tag_count: 0,
      created_at: at,
      updated_at: at,
    };
    ctx.ws.tagGroups.push(g);
    audit(ctx.ws, "tag_group.created", "tag_group", g.id, { name });
    publish(ctx.ws, "tag_group.created", { tag_group: g });
    return respond(201, g);
  });
  patch("/v1/tag-groups/:id", (ctx) => {
    requireAdmin(ctx.ws);
    const g = findGroup(ctx);
    if ("name" in ctx.body) {
      const name = cleanName(ctx.body.name, "Name", 50);
      if (ctx.ws.tagGroups.some((x) => x.id !== g.id && x.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, "conflict", "A label group with this name already exists");
      g.name = name;
    }
    if ("color" in ctx.body) g.color = ctx.body.color === null ? null : color(ctx.body.color);
    if (typeof ctx.body.exclusive === "boolean") g.exclusive = ctx.body.exclusive;
    if (typeof ctx.body.position === "number") g.position = ctx.body.position;
    g.updated_at = nowIso();
    syncTagRefs(ctx.ws);
    audit(ctx.ws, "tag_group.updated", "tag_group", g.id, { fields: Object.keys(ctx.body) });
    publish(ctx.ws, "tag_group.updated", { tag_group: groupOut(ctx.ws, g) });
    return groupOut(ctx.ws, g);
  });
  del("/v1/tag-groups/:id", (ctx) => {
    requireAdmin(ctx.ws);
    const g = findGroup(ctx);
    ctx.ws.tagGroups = ctx.ws.tagGroups.filter((x) => x !== g);
    for (const t of ctx.ws.tags) {
      if (t.group_id !== g.id) continue;
      t.group_id = null;
      publish(ctx.ws, "tag.updated", { tag: tagOut(ctx.ws, t) });
    }
    syncTagRefs(ctx.ws);
    audit(ctx.ws, "tag_group.deleted", "tag_group", g.id, { name: g.name });
    publish(ctx.ws, "tag_group.deleted", { tag_group_id: g.id });
    return respond(204);
  });

  // Custom fields.
  get("/v1/custom-fields", (ctx) => {
    const entity = ctx.query.get("entity") as FieldEntity | null;
    const archived = ctx.query.get("archived") ?? "any";
    let list = ctx.ws.customFields.slice();
    if (entity) list = list.filter((f) => f.entity === entity);
    if (archived !== "any") list = list.filter((f) => f.archived === (archived === "true"));
    list.sort((a, b) => ENTITIES.indexOf(a.entity) - ENTITIES.indexOf(b.entity) || a.position - b.position);
    return { data: list, next_cursor: null };
  });
  get("/v1/custom-fields/:id", (ctx) => findField(ctx));
  post("/v1/custom-fields/reorder", (ctx) => {
    requireAdmin(ctx.ws);
    const entity = s(ctx, "entity") as FieldEntity;
    if (!ENTITIES.includes(entity)) throw invalid("entity must be ticket, contact or company");
    const rows = ctx.ws.customFields.filter((f) => f.entity === entity);
    reorder(rows, strArr(ctx.body.ids), "custom field");
    audit(ctx.ws, "custom_fields.reordered", "custom_field", "", { entity });
    const data = rows.sort((a, b) => a.position - b.position);
    for (const f of data) publish(ctx.ws, "custom_field.updated", { custom_field: f });
    return respond(200, { data, next_cursor: null });
  });
  post("/v1/custom-fields", (ctx) => {
    requireAdmin(ctx.ws);
    const entity = s(ctx, "entity") as FieldEntity;
    if (!ENTITIES.includes(entity)) throw invalid("entity must be ticket, contact or company");
    const type = s(ctx, "type") as FieldType;
    if (!FIELD_TYPES.includes(type)) throw invalid(`type must be one of ${FIELD_TYPES.join(", ")}`);
    const name = cleanName(ctx.body.name, "Name", 60);
    const siblings = ctx.ws.customFields.filter((f) => f.entity === entity);
    if (siblings.length >= MAX_FIELDS_PER_ENTITY) throw invalid(`A ${entity} can have at most ${MAX_FIELDS_PER_ENTITY} fields`);
    const explicit = s(ctx, "key");
    let key = explicit ?? (slugify(name).replace(/-/g, "_").slice(0, 40) || "field");
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(key)) throw invalid("key must start with a letter and use lowercase letters, numbers and _ (at most 40)");
    if (siblings.some((f) => f.key === key)) {
      if (explicit) throw new HttpError(409, "conflict", `A ${entity} field with the key ${key} already exists`);
      const base = key.slice(0, 37);
      for (let i = 2; siblings.some((f) => f.key === key); i++) key = `${base}_${i}`;
    }
    const opts = type === "select" || type === "multi_select" ? options(ctx.body.options) : [];
    if (ctx.body.required_on_solve === true && entity !== "ticket") throw invalid("required_on_solve applies to ticket fields only");
    const at = nowIso();
    const f: CustomField = {
      id: uuid(),
      entity,
      key,
      name,
      type,
      options: opts,
      required_on_solve: ctx.body.required_on_solve === true,
      description: description(ctx.body.description),
      position: typeof ctx.body.position === "number" ? ctx.body.position : siblings.length,
      archived: false,
      created_at: at,
      updated_at: at,
    };
    ctx.ws.customFields.push(f);
    audit(ctx.ws, "custom_field.created", "custom_field", f.id, { entity, key, type });
    publish(ctx.ws, "custom_field.created", { custom_field: f });
    return respond(201, f);
  });
  patch("/v1/custom-fields/:id", (ctx) => {
    requireAdmin(ctx.ws);
    const f = findField(ctx);
    for (const k of ["entity", "key", "type"] as const) {
      if (k in ctx.body && ctx.body[k] !== f[k]) throw invalid(`${k} can't change; create a new field instead`);
    }
    if ("name" in ctx.body) f.name = cleanName(ctx.body.name, "Name", 60);
    if ("description" in ctx.body) f.description = description(ctx.body.description);
    if (typeof ctx.body.position === "number") f.position = ctx.body.position;
    if (typeof ctx.body.archived === "boolean") f.archived = ctx.body.archived;
    if (typeof ctx.body.required_on_solve === "boolean") {
      if (ctx.body.required_on_solve && f.entity !== "ticket") throw invalid("required_on_solve applies to ticket fields only");
      f.required_on_solve = ctx.body.required_on_solve;
    }
    if ("options" in ctx.body && (f.type === "select" || f.type === "multi_select")) {
      const next = options(ctx.body.options, f.options);
      const gone = f.options.filter((o) => !next.some((n) => n.id === o.id)).map((o) => o.id);
      f.options = next;
      if (gone.length) {
        for (const r of recordsOf(ctx.ws, f.entity)) {
          const v = r.fields[f.key];
          const kept = Array.isArray(v) ? v.filter((x) => !gone.includes(x as string)) : gone.includes(v as string) ? null : v;
          if (fieldEmpty(kept)) delete r.fields[f.key];
          else r.fields[f.key] = kept;
        }
      }
    }
    f.updated_at = nowIso();
    audit(ctx.ws, "custom_field.updated", "custom_field", f.id, { fields: Object.keys(ctx.body) });
    publish(ctx.ws, "custom_field.updated", { custom_field: f });
    return f;
  });
  del("/v1/custom-fields/:id", (ctx) => {
    requireAdmin(ctx.ws);
    const f = findField(ctx);
    ctx.ws.customFields = ctx.ws.customFields.filter((x) => x !== f);
    const touched = f.entity === "ticket" ? ctx.ws.tickets.filter((t) => f.key in t.fields) : [];
    for (const r of recordsOf(ctx.ws, f.entity)) delete r.fields[f.key];
    for (const t of touched) publishTicketUpdated(ctx.ws, t, ["fields"]);
    audit(ctx.ws, "custom_field.deleted", "custom_field", f.id, { entity: f.entity, key: f.key });
    publish(ctx.ws, "custom_field.deleted", { custom_field_id: f.id, entity: f.entity, key: f.key });
    return respond(204);
  });
}

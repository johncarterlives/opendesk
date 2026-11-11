// Customer portal invitations in mock mode (contracts/customer-portal.md "Invitations"): each
// contact's access, an invitation from a brand whose help center is on, and removing access.
// The same rules as the API, with the email left out.

import type { Contact, PortalAccess, PortalBrand } from "@/lib/api/types";
import type { WsData } from "../db";
import { HttpError, del, get, invalid, notFound, post, respond, type Ctx } from "../router";

const DAY = 864e5;
const INVITE_DAYS = 7;

/** What the API reads from passwords, provider sign-ins, open links and sessions, per contact. */
type Access = { password: boolean; sso: boolean; invitedAt: string | null; expiresAt: string | null; lastSignIn: string | null; sent: number[] };
const state = new Map<string, Access>();
const blank = (): Access => ({ password: false, sso: false, invitedAt: null, expiresAt: null, lastSignIn: null, sent: [] });

function brandsOf(ws: WsData): PortalBrand[] {
  return ws.brands
    .filter((b) => b.help_center.enabled)
    .map((b) => ({ id: b.id, name: b.name, slug: b.slug, auth_mode: b.portal_auth.mode, default: b.is_default }))
    .sort((a, b) => Number(b.default) - Number(a.default) || a.name.localeCompare(b.name));
}

function accessOf(ws: WsData, c: Contact): PortalAccess {
  const a = state.get(c.id) ?? blank();
  const open = a.expiresAt && Date.parse(a.expiresAt) > Date.now() ? a : null;
  const status = a.password || a.sso ? "active" : open ? "invited" : "none";
  return {
    status,
    password: a.password,
    sso: a.sso,
    invited_at: open?.invitedAt ?? null,
    invite_expires_at: open?.expiresAt ?? null,
    last_sign_in_at: a.lastSignIn,
    brands: brandsOf(ws),
  };
}

function contactOf(ctx: Ctx): Contact {
  const c = ctx.ws.contacts.find((x) => x.id === ctx.params.id);
  if (!c) throw notFound("Contact");
  return c;
}

/** The brand an invitation is from, as the API picks it. */
function inviteBrand(ws: WsData, want: unknown): PortalBrand {
  const brands = brandsOf(ws);
  const pick = typeof want === "string" ? brands.find((b) => b.id === want) : (brands.find((b) => b.default) ?? (brands.length === 1 ? brands[0] : undefined));
  if (!pick) {
    if (typeof want === "string") throw new HttpError(422, "help_center_off", "That brand's help center is off, so it has no customer portal.");
    if (brands.length === 0) throw new HttpError(422, "help_center_off", "Turn on a help center first: the customer portal is part of it.");
    throw new HttpError(422, "brand_required", "Choose which brand's portal the invitation is for.");
  }
  if (pick.auth_mode === "oidc")
    throw new HttpError(422, "password_sign_in_off", "Customers of this brand sign in through its identity provider, with no password to choose. They can sign in there without an invitation.");
  return pick;
}

/** Why an invitation could not go out, or "" when it went. */
function invite(c: Contact): string {
  if (!c.email) return "no_email";
  if (c.blocked) return "blocked";
  const a = state.get(c.id) ?? blank();
  a.sent = a.sent.filter((t) => t > Date.now() - 3600_000);
  if (a.sent.length >= 5) return "rate_limited";
  a.sent.push(Date.now());
  a.invitedAt = new Date().toISOString();
  a.expiresAt = new Date(Date.now() + INVITE_DAYS * DAY).toISOString();
  state.set(c.id, a);
  return "";
}

/** Seeds a few states so the drawer shows each of them. */
export function seedPortalAccess(ws: WsData) {
  state.clear();
  const [first, second] = ws.contacts.filter((c) => c.email && !c.blocked);
  if (first) state.set(first.id, { ...blank(), password: true, lastSignIn: new Date(Date.now() - 2 * DAY).toISOString() });
  if (second) state.set(second.id, { ...blank(), invitedAt: new Date(Date.now() - DAY).toISOString(), expiresAt: new Date(Date.now() + 6 * DAY).toISOString() });
}

export function registerPortalInviteRoutes() {
  get("/v1/contacts/:id/portal", (ctx) => accessOf(ctx.ws, contactOf(ctx)));
  post("/v1/contacts/:id/portal/invite", (ctx) => {
    const c = contactOf(ctx);
    inviteBrand(ctx.ws, ctx.body.brand_id);
    const why = invite(c);
    if (why === "no_email") throw new HttpError(422, "no_email", "Give the contact an email address first.");
    if (why === "blocked") throw new HttpError(422, "contact_blocked", "This contact is blocked. Unblock them first.");
    if (why === "rate_limited") throw new HttpError(429, "rate_limited", "Several links went to this contact in the last hour. Try again later.");
    return respond(200, accessOf(ctx.ws, c));
  });
  post("/v1/contacts/portal/invite", (ctx) => {
    const ids = Array.isArray(ctx.body.ids) ? (ctx.body.ids as unknown[]).filter((x): x is string => typeof x === "string") : [];
    if (ids.length === 0 || ids.length > 100) throw invalid("ids: 1 to 100 contacts");
    inviteBrand(ctx.ws, ctx.body.brand_id);
    const out = { sent: 0, skipped: {} as Record<string, number> };
    const skip = (why: string) => (out.skipped[why] = (out.skipped[why] ?? 0) + 1);
    for (const id of new Set(ids)) {
      const c = ctx.ws.contacts.find((x) => x.id === id);
      if (!c) skip("not_found");
      else if (accessOf(ctx.ws, c).status === "active") skip("active");
      else {
        const why = invite(c);
        if (why) skip(why);
        else out.sent++;
      }
    }
    return respond(200, out);
  });
  del("/v1/contacts/:id/portal", (ctx) => {
    const c = contactOf(ctx);
    state.set(c.id, { ...blank(), sent: state.get(c.id)?.sent ?? [] });
    return respond(204);
  });
}

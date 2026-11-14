// Help center addresses (contracts/teams.md "Help center addresses"). The API
// renders every help center itself, so the app only ever links to one: a brand's
// `help_center.url` (its active custom domain, else its default address) as a
// plain external link.

import type { Brand } from "./api/types";
import { appOrigin, config } from "./config";

type HelpBrand = Pick<Brand, "slug" | "help_center">;

/** A page of a brand's help center: "" is its home, an article's path (KbArticle.path) an article, "/c/<slug>" a topic. */
export function helpCenterHref(brand: Pick<Brand, "help_center">, path = ""): string {
  return brand.help_center.url.replace(/\/+$/, "") + path;
}

/** The default address a slug gets: https://<slug>.<helpDomain>, else <app>/help/<slug>. */
export function defaultHelpUrl(slug: string, helpDomain = config.helpDomain, origin = appOrigin()): string {
  return helpDomain ? `https://${slug}.${helpDomain}` : `${origin.replace(/\/+$/, "")}/help/${slug}`;
}

/** How the default address is built around the slug, for the slug field. */
export type HelpAddressForm = { kind: "subdomain"; suffix: string } | { kind: "path"; prefix: string };

/**
 * The address form of this instance: a subdomain of HELP_DOMAIN, or a path on the
 * app's host. Without helpDomain in the runtime config, a brand's default_url tells.
 */
export function helpAddressForm(brand?: HelpBrand, helpDomain = config.helpDomain): HelpAddressForm {
  if (helpDomain) return { kind: "subdomain", suffix: helpDomain };
  const host = brand ? hostOf(brand.help_center.default_url) : "";
  if (brand && host.startsWith(`${brand.slug}.`)) return { kind: "subdomain", suffix: host.slice(brand.slug.length + 1) };
  return { kind: "path", prefix: "/help/" };
}

/** A brand's default address with another slug, as the server will build it. */
export function withSlug(brand: HelpBrand, slug: string): string {
  const url = brand.help_center.default_url;
  if (!url) return defaultHelpUrl(slug);
  const host = hostOf(url);
  if (host.startsWith(`${brand.slug}.`)) return url.replace(`//${brand.slug}.`, `//${slug}.`);
  return url.replace(new RegExp(`/help/${escapeRe(brand.slug)}(/?)$`), `/help/${slug}$1`);
}

/** An address without its scheme, for display. */
export function bareUrl(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

/**
 * Where an old /help/<slug>/... link of the app goes now: the same page on the
 * help center's default address (`/help/<slug>/c/x` is `/c/x` there). Null without
 * helpDomain, where this instance serves /help/<slug> itself.
 */
export function legacyHelpTarget(loc: { pathname: string; search: string; hash: string }, helpDomain = config.helpDomain): string | null {
  const m = /^\/help\/([a-z0-9-]+)(\/.*)?$/i.exec(loc.pathname);
  if (!m || !helpDomain) return null;
  const rest = m[2] && m[2] !== "/" ? m[2] : "/";
  return `https://${m[1].toLowerCase()}.${helpDomain}${rest}${loc.search}${loc.hash}`;
}

/**
 * What an admin typed for a custom domain, as the API expects it: no scheme, path,
 * port or trailing dot, lowercase.
 */
export function normalizeHostname(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/:\d+$/, "")
    .replace(/\.+$/, "");
}

const HOSTNAME = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Looks like a hostname with at least one dot; the API decides the rest. */
export function looksLikeHostname(host: string): boolean {
  return host.length <= 253 && HOSTNAME.test(host);
}

/**
 * The name to type at a DNS provider that appends the domain itself, e.g.
 * "_opendesk-verify.help" for "_opendesk-verify.help.acme.com". A guess from the
 * last two labels; providers differ, so it is offered as a hint only.
 */
export function relativeRecordName(name: string): string {
  const labels = name.split(".");
  return labels.length > 2 ? labels.slice(0, -2).join(".") : name;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

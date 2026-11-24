import { afterAll, beforeAll, describe, expect, it } from "vitest";
import settingsIndex from "virtual:settings-index";
import docsIndex from "virtual:docs-index";
import i18n from "i18next";
import { loadAgentCatalogs } from "@/i18n";
import { SETTINGS_RULES, type SettingsAccess } from "@/lib/settingsAccess";
import { docItems, resolveRef, search, settingsItems, type Translate } from "./engine";
import { asSource, type AppHit } from "./index";

const t = i18n.t.bind(i18n) as unknown as Translate;

const owner: SettingsAccess = { role: "owner", tickets: true, collab: true, ai: true, cloud: true, severalWorkspaces: true };
const as = (a: Partial<SettingsAccess>) => settingsItems(settingsIndex, { ...owner, ...a }, t);
const titles = (hits: AppHit[]) => hits.map((h) => h.title);
const find = (q: string, a: Partial<SettingsAccess> = {}) => search(as(a), q, { limit: 10 });

describe("the settings index", () => {
  it("reads every settings page's sections and rows from the code", () => {
    // A guard against the indexer reading less than it did: the pages and the rows they have.
    expect(Object.keys(settingsIndex.pages).length).toBeGreaterThan(40);
    expect(settingsIndex.entries.filter((e) => e.k === "r").length).toBeGreaterThan(200);
    const security = settingsIndex.entries.filter((e) => e.r === "/settings/security").map((e) => e.t);
    expect(security).toEqual(expect.arrayContaining(["auth:password", "auth:twofactorAuthentication", "auth:passkeys", "auth:sessions"]));
  });

  it("has every labelled section and row a settings page writes with a literal t(…)", () => {
    // What a quick scan finds must be in the index: a new page or section is indexed by the build, not by hand.
    const pages = import.meta.glob<string>(["../../pages/settings/**/*.tsx", "!../../pages/settings/**/*.test.tsx", "!../../pages/settings/SettingsLayout.tsx"], {
      query: "?raw",
      import: "default",
      eager: true,
    });
    const indexed = new Set(settingsIndex.entries.map((e) => e.t.slice(e.t.indexOf(":") + 1)));
    const missing: string[] = [];
    for (const [f, src] of Object.entries(pages))
      for (const m of src.matchAll(/<(?:Section|Row)\s+(?:title|label)=\{t\("([\w.]+)"\)\}/g)) if (!indexed.has(m[1])) missing.push(`${f}: ${m[1]}`);
    expect(Object.keys(pages).length).toBeGreaterThan(40);
    expect(missing).toEqual([]);
  });

  it("knows who each indexed settings page is for", () => {
    const routes = new Set(settingsIndex.entries.map((e) => e.r));
    expect([...routes].filter((r) => !(r in SETTINGS_RULES))).toEqual([]);
  });

  it("leaves out labels that are only placeholders", () => {
    // "{{name}}" or "{{a}} {{b}}" in English has no words of its own to find.
    const empty = settingsIndex.entries.filter((e) => !/\p{L}/u.test(String(t(e.t.slice(e.t.indexOf(":") + 1), { ns: e.t.slice(0, e.t.indexOf(":")), lng: "en" })).replace(/\{\{[^}]*\}\}/g, "")));
    expect(empty.map((e) => e.t)).toEqual([]);
  });

  it("deep-links a section or row to its label, and a page to its top", () => {
    const hit = find("two factor")[0];
    expect(hit).toMatchObject({ kind: "setting", route: "/settings/security", title: "Two-factor authentication", hash: "find=auth%3AtwofactorAuthentication" });
    const page = find("security").find((h) => h.kind === "setting" && h.entry.k === "p");
    expect(page && "hash" in page ? page.hash : "x").toBeUndefined();
  });
});

describe("searching settings", () => {
  it("finds the sidebar from the words people use", () => {
    expect(titles(find("custom sidebar"))[0]).toBe("Customize sidebar");
    expect(titles(find("sidbar"))[0]).toBe("Customize sidebar");
    expect(titles(find("rearrange navigation"))).toContain("Customize sidebar");
  });

  it("forgives a typo only in a longer word, so a name finds no settings", () => {
    expect(find("jane")).toEqual([]);
    expect(titles(find("acme"))).not.toContain("Accent colour");
    expect(titles(find("sidbar"))[0]).toBe("Customize sidebar");
    expect(titles(find("custom sidebar"))[0]).toBe("Customize sidebar");
  });

  it("finds a row by a word anywhere in it, its hint or the fields under it", () => {
    expect(titles(find("2fa"))).toContain("Two-factor authentication");
    expect(titles(find("timezone"))).toContain("Time zone");
    const pw = find("confirm new password")[0];
    expect(pw.title).toBe("Password");
    expect(pw.where).toEqual(["Settings", "Security"]);
  });

  it("names where a row is: its page and its section", () => {
    const row = find("authenticator app")[0];
    expect(row.where).toEqual(["Settings", "Security", "Two-factor authentication"]);
  });
});

describe("visibility", () => {
  it("leaves admin settings out for agents and viewers", () => {
    const routes = (a: Partial<SettingsAccess>) => new Set(find("time zone", a).flatMap((h) => (h.kind === "setting" ? [h.route] : [])));
    expect([...routes({ role: "admin" })]).toEqual(expect.arrayContaining(["/settings/workspace", "/settings/business-hours"]));
    const agent = [...routes({ role: "agent" })];
    expect(agent).toContain("/settings/profile");
    expect(agent.filter((r) => SETTINGS_RULES[r].role === "admin")).toEqual([]);
    expect(titles(find("password", { role: "viewer" }))).toContain("Password");
  });

  it("shows the owner's danger zone to owners alone", () => {
    expect(titles(find("transfer ownership", { role: "owner" }))).toContain("Transfer ownership");
    expect(titles(find("transfer ownership", { role: "admin" }))).not.toContain("Transfer ownership");
  });

  it("shows billing's balance and recharge on Cloud only", () => {
    expect(find("auto recharge", { cloud: true }).length).toBeGreaterThan(0);
    expect(find("auto recharge", { cloud: false })).toEqual([]);
  });

  it("follows the workspace's products and Collab", () => {
    const sla = (a: Partial<SettingsAccess>) => find("sla policies", a).some((h) => h.kind === "setting" && h.route === "/settings/sla");
    expect(sla({})).toBe(true);
    expect(sla({ tickets: false })).toBe(false);
    expect(find("mail categories").some((h) => h.kind === "setting" && h.route === "/settings/mail-categories")).toBe(true);
    expect(find("mail categories", { collab: false }).some((h) => h.kind === "setting" && h.route === "/settings/mail-categories")).toBe(false);
  });

  it("leaves the AI agent pages out without an AI provider", () => {
    const agent = (a: Partial<SettingsAccess>) => as(a).some((i) => i.hit.kind === "setting" && i.hit.route.startsWith("/settings/ai/"));
    expect(agent({})).toBe(true);
    expect(agent({ ai: false })).toBe(false);
    expect(agent({ role: "agent" })).toBe(false);
  });
});

describe("in another language", () => {
  beforeAll(async () => {
    await loadAgentCatalogs("es");
    await i18n.changeLanguage("es");
  });
  afterAll(async () => {
    await i18n.changeLanguage("en");
  });

  it("searches the reader's language", () => {
    const sidebar = resolveRef(t, "collab:nav.customize");
    expect(sidebar).not.toBe("Customize sidebar");
    expect(titles(find("barra lateral"))).toContain(sidebar);
  });
});

describe("the docs index", () => {
  const items = docItems(docsIndex, "Docs");

  it("has the docs' pages and sections, with Starlight's anchors", () => {
    expect(docsIndex.find((d) => d.u === "guides/sidebar/" && !d.h)?.t).toBe("Your sidebar");
    expect(docsIndex.some((d) => d.u === "guides/sidebar/" && d.h === "edit-your-sidebar")).toBe(true);
    expect(docsIndex.some((d) => d.u.startsWith("contributing/"))).toBe(false);
  });

  it("answers a how-to question with a docs section", () => {
    const hits = search(items, "how do I customize my sidebar", { mode: "most", limit: 4 });
    expect(hits.some((h) => h.kind === "doc" && h.href.startsWith("https://docs.opendesk.sh/guides/sidebar/"))).toBe(true);
  });

  it("makes a hit an excerpt for an answer, within the API's limits", () => {
    const [hit] = search(items, "edit your sidebar", { limit: 1 });
    const src = asSource(hit);
    expect(src.title).toMatch(/Edit your sidebar$/);
    expect(src.url).toBe("https://docs.opendesk.sh/guides/sidebar/#edit-your-sidebar");
    expect(src.text.length).toBeGreaterThan(20);
    expect(src.text.length).toBeLessThanOrEqual(2000);
  });
});

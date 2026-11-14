import { beforeAll, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { i18n, loadAgentCatalogs } from "@/i18n";
import type { ImportCheck } from "@/lib/api/types";
import { CredentialsForm, credentialsReady } from "./Connect";
import { OptionsForm, defaultOptions } from "./Options";
import { SourceMark, importedFrom } from "./sources";

beforeAll(async () => {
  await loadAgentCatalogs();
  await i18n.changeLanguage("en");
});

const check: ImportCheck = {
  account: { name: "support.example.com", url: "https://support.example.com/freescout" },
  totals: { tickets: 12, articles: null },
  agents: [],
  groups: [],
  samples: [],
  has_articles: false,
};

describe("FreeScout import", () => {
  it("requires the instance address and a secret key, with only the key needed to replace credentials", () => {
    expect(credentialsReady("freescout", {})).toBe(false);
    expect(credentialsReady("freescout", { url: check.account.url, api_key: "  " })).toBe(false);
    expect(credentialsReady("freescout", { api_key: "key" })).toBe(false);
    expect(credentialsReady("freescout", { url: check.account.url, api_key: "key" })).toBe(true);
    expect(credentialsReady("freescout", { api_key: "key" }, true)).toBe(true);

    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(<CredentialsForm source="freescout" value={{ api_key: "private-key" }} onChange={() => {}} errors={{}} />);
    expect(host.querySelector('input[type="password"]')?.getAttribute("value")).toBe("private-key");
    expect(host.textContent).toContain("including its subdirectory");
    expect(host.textContent).toContain("API & Webhooks module");
    expect(host.textContent).toContain("read access to all mailboxes and users");
  });

  it("defaults to conversations and attachments and explains why articles are unavailable", () => {
    const options = defaultOptions("freescout", check);
    expect(options).toMatchObject({ tickets: true, attachments: true, articles: false, tag: "freescout-import" });
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(<OptionsForm source="freescout" check={check} value={options} onChange={() => {}} mailboxes={[]} />);
    expect(host.textContent).toContain("The FreeScout API does not expose knowledge base articles.");
    expect(host.querySelector('[aria-label="Help center articles"]')?.hasAttribute("disabled")).toBe(true);
  });

  it("uses the shared initial mark and labels links back to the source", () => {
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(<SourceMark source="freescout" />);
    expect(host.textContent).toBe("F");
    expect(importedFrom({ import: { source: "freescout", ref: "#42", url: `${check.account.url}/conversation/42` } })).toEqual({
      label: "FreeScout #42", url: `${check.account.url}/conversation/42`,
    });
  });
});

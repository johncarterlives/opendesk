import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { i18n, loadAgentCatalogs } from "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { MailAccount, Workspace } from "@/lib/api/types";
import { qk } from "@/lib/queries";
import { SnoozeUnavailable } from "./SnoozeUnavailable";

// The settings link outside a router: an anchor to the route it names.
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, params, children, className }: { to: string; params: { accountId: string }; children: ReactNode; className?: string }) => (
    <a href={to.replace("$accountId", params.accountId)} className={className}>
      {children}
    </a>
  ),
}));

beforeAll(() => loadAgentCatalogs("de"));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  await i18n.changeLanguage("en");
  vi.unstubAllGlobals();
});

const account = (over: Partial<MailAccount>) => ({ id: "a1", visibility: "shared", handling_enabled: false, can_manage: true, ...over }) as MailAccount;

async function open(accounts: MailAccount[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData<Workspace>(qk.workspace, { id: "w", name: "Acme", settings: {} } as Workspace);
  await act(async () =>
    root.render(
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <SnoozeUnavailable accounts={accounts} />
        </TooltipProvider>
      </QueryClientProvider>,
    ),
  );
  await act(async () => document.querySelector<HTMLButtonElement>("button[aria-disabled='true']")!.click());
  const panel = document.querySelector("[role='dialog']");
  if (!panel) throw new Error("Snooze did not open its reason");
  return { text: panel.querySelector("p")?.textContent, link: panel.querySelector("a") };
}

it("tells a shared account to turn Handling on, with its settings a click away for who manages it", async () => {
  const { text, link } = await open([account({})]);
  expect(text).toBe("Snooze works on shared accounts with Handling on. Turn it on in the account's settings.");
  expect(link?.getAttribute("href")).toBe("/settings/mail-accounts/a1");
  expect(link?.textContent).toBe("Account settings");
});

it("tells a private account to be shared first, since only shared accounts have Handling", async () => {
  const { text, link } = await open([account({ visibility: "private" })]);
  expect(text).toBe("Snooze works on shared accounts with Handling on. Share the account and turn on Handling in its settings.");
  expect(link?.getAttribute("href")).toBe("/settings/mail-accounts/a1");
});

it("says so in the reader's language", async () => {
  await i18n.changeLanguage("de");
  const { text } = await open([account({ visibility: "private" })]);
  expect(text).toBe("Zurückstellen gibt es bei geteilten Konten mit aktivierter Bearbeitung. Teile das Konto und aktiviere die Bearbeitung in seinen Einstellungen.");
});

it("links nowhere for an account the reader cannot manage", async () => {
  const { text, link } = await open([account({ can_manage: false })]);
  expect(text).toContain("Turn it on");
  expect(link).toBeNull();
});

it("links nowhere when the selection spans several accounts without Handling, and asks for sharing if one is private", async () => {
  const { text, link } = await open([account({ id: "a1" }), account({ id: "a2", visibility: "private" }), account({ id: "a3", handling_enabled: true })]);
  expect(text).toContain("Share the account");
  expect(link).toBeNull();
});

it("links to the one account without Handling in a selection that spans accounts", async () => {
  const { link } = await open([account({ id: "a1", handling_enabled: true }), account({ id: "a2" })]);
  expect(link?.getAttribute("href")).toBe("/settings/mail-accounts/a2");
});

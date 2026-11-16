import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ConfirmProvider } from "@/components/ui/confirm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { i18n } from "@/i18n";
import { setWorkspaceId } from "@/lib/api/client";
import { api, rows } from "@/lib/api/endpoints";
import type { MailAccount, MailThreadDetail } from "@/lib/api/types";
import { qk } from "@/lib/queries";
import { installMock } from "@/mock";
import { db } from "@/mock/db";
import { ThreadView } from "./ThreadView";

// Navigation belongs to the surrounding page; the conversation renders normally.
vi.mock("@tanstack/react-router", async (original) => ({ ...await original<typeof import("@tanstack/react-router")>(), useNavigate: () => vi.fn() }));

let detail: MailThreadDetail;
let account: MailAccount;
let qc: QueryClient;
let host: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(async () => {
  installMock();
  setWorkspaceId(db.workspaces[0].workspace.id);
  await i18n.changeLanguage("en");
  const accounts = rows(await api.collab.accounts.list());
  account = accounts[0];
  const threads = await api.collab.threads.list({ account_id: account.id });
  detail = await api.collab.threads.get(threads.data[0].id);
  const message = detail.messages.find((m) => !m.draft);
  if (!message) throw new Error("Missing received message");
  detail = {
    ...detail, comments: [], can_act: true,
    account: { ...detail.account, reply_all: true },
    messages: [{ ...message, draft: false, outgoing: false, from: { name: "Sender", email: "sender@example.com" }, to: [{ name: "", email: account.email }], cc: [{ name: "Other", email: "other@example.com" }], reply_to: [] }],
  };
  qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(qk.collabStatus, { enabled: true });
  qc.setQueryData(qk.mailAccounts, []);
});
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  qc.clear();
  setWorkspaceId(null);
  vi.unstubAllGlobals();
});

function renderMarkup() {
  qc.setQueryData(qk.mailThread(detail.thread.id), detail);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}><TooltipProvider>
      <ThreadView threadId={detail.thread.id} onClose={() => undefined} onAction={() => undefined} markReadOnOpen={false} />
    </TooltipProvider></QueryClientProvider>,
  );
}

/** The footer's reply buttons, in order: the account's usual reply first. */
function replyButtons() {
  const html = renderMarkup();
  const doc = new DOMParser().parseFromString(html, "text/html");
  return [...doc.querySelectorAll("footer button[aria-label]")].map((b) => b.getAttribute("aria-label")).filter((name) => name === "Reply" || name === "Reply all");
}

it("offers plain Reply, Forward and Comment buttons, with no mode toggle and no composer", () => {
  const doc = new DOMParser().parseFromString(renderMarkup(), "text/html");
  const names = [...doc.querySelectorAll("footer button[aria-label]")].map((b) => b.getAttribute("aria-label"));
  expect(names).toEqual(["Reply all", "Reply", "Forward", "Comment"]);
  expect(doc.querySelector("footer [aria-pressed]")).toBeNull();
  expect(doc.querySelector('footer [contenteditable="true"]')).toBeNull();
});

it("switches between an internal comment and a reply whose Send comes first", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", vi.fn());
  qc.setQueryData(qk.mailThread(detail.thread.id), detail);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<QueryClientProvider client={qc}><TooltipProvider><ConfirmProvider>
      <ThreadView threadId={detail.thread.id} onClose={() => undefined} onAction={() => undefined} markReadOnOpen={false} />
    </ConfirmProvider></TooltipProvider></QueryClientProvider>);
  });
  const switchTo = (name: string) => [...host!.querySelectorAll<HTMLButtonElement>("[role='radiogroup'] [role='radio']")].find((b) => b.textContent === name);
  const comment = host.querySelector<HTMLButtonElement>("footer button[aria-label='Comment']");
  expect(comment).toBeTruthy();
  await act(async () => comment?.click());
  expect(host.querySelector("footer [role='radiogroup']")?.getAttribute("aria-label")).toBe("Choose whether to reply to the sender or comment for your team");
  expect(switchTo("Comment")?.getAttribute("aria-checked")).toBe("true");
  expect(host.textContent).toContain("Only your team sees this. It will not be sent to the sender.");
  expect(host.querySelector('footer [contenteditable="true"]')).not.toBeNull();
  // Back to a reply: the account's usual one opens, the footer gives way to it.
  await act(async () => switchTo("Reply all")?.click());
  expect(host.textContent).not.toContain("Only your team sees this. It will not be sent to the sender.");
  expect(host.querySelector("footer")).toBeNull();
  expect(switchTo("Reply all")?.getAttribute("aria-checked")).toBe("true");
  // Send is the composer toolbar's first button, and the coloured one.
  const send = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Send");
  expect(send?.className).toContain("bg-send");
  const toolbar = send?.parentElement?.parentElement;
  expect(toolbar?.querySelector("button")).toBe(send);
  expect(toolbar?.querySelectorAll("button").length).toBeGreaterThan(3);
});

it("uses the account's Reply all default and keeps Reply after it", async () => {
  await api.collab.accounts.update(account.id, { reply_all: true });
  detail.account = (await api.collab.threads.get(detail.thread.id)).account;
  expect(replyButtons()).toEqual(["Reply all", "Reply"]);
});
it("uses the live account preference ahead of a stale conversation default", () => {
  qc.setQueryData(qk.mailAccounts, [{ ...account, reply_all: false }]);
  expect(replyButtons()).toEqual(["Reply", "Reply all"]);
  detail.account.reply_all = false;
  qc.setQueryData(qk.mailAccounts, [{ ...account, reply_all: true }]);
  expect(replyButtons()).toEqual(["Reply all", "Reply"]);
});
it("keeps Reply first for disabled preferences and older servers without the field", () => {
  detail.account.reply_all = false;
  expect(replyButtons()).toEqual(["Reply", "Reply all"]);
  delete detail.account.reply_all;
  expect(replyButtons()).toEqual(["Reply", "Reply all"]);
});
it("offers only Reply when Reply all adds no recipient", () => {
  detail.messages[0].cc = [];
  expect(replyButtons()).toEqual(["Reply"]);
});

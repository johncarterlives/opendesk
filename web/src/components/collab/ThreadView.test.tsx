import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
afterEach(() => { qc.clear(); setWorkspaceId(null); });

function buttons() {
  qc.setQueryData(qk.mailThread(detail.thread.id), detail);
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}><TooltipProvider>
      <ThreadView threadId={detail.thread.id} onClose={() => undefined} onAction={() => undefined} markReadOnOpen={false} />
    </TooltipProvider></QueryClientProvider>,
  );
  const doc = new DOMParser().parseFromString(html, "text/html");
  return [...doc.querySelectorAll("footer button[aria-label]")].map((b) => b.getAttribute("aria-label")).filter((name) => name === "Reply" || name === "Reply all");
}

it("puts Reply all first for a conversation-only agent with no account in the list", async () => {
  await api.collab.accounts.update(account.id, { reply_all: true });
  detail.account = (await api.collab.threads.get(detail.thread.id)).account;
  expect(buttons()).toEqual(["Reply all", "Reply"]);
});
it("uses the live account preference ahead of a stale conversation default", () => {
  qc.setQueryData(qk.mailAccounts, [{ ...account, reply_all: false }]);
  expect(buttons()).toEqual(["Reply", "Reply all"]);
  detail.account.reply_all = false;
  qc.setQueryData(qk.mailAccounts, [{ ...account, reply_all: true }]);
  expect(buttons()).toEqual(["Reply all", "Reply"]);
});
it("keeps Reply first for disabled preferences and older servers without the field", () => {
  detail.account.reply_all = false;
  expect(buttons()).toEqual(["Reply", "Reply all"]);
  delete detail.account.reply_all;
  expect(buttons()).toEqual(["Reply", "Reply all"]);
});
it("offers only Reply when Reply all adds no recipient", () => {
  detail.messages[0].cc = [];
  expect(buttons()).toEqual(["Reply"]);
});

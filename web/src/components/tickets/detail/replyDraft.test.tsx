import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplyDraft } from "@/lib/api/types";

const replyDraft = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), discard: vi.fn() }));
vi.mock("@/lib/api/endpoints", () => ({ api: { tickets: { replyDraft } } }));

import { draftRecipients, recipientsBody, useReplyDraftSync, type ReplyRecipients } from "./replyDraft";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const saved = (html: string): ReplyDraft => ({ ticket_id: "t", body_html: html, attachments: [], updated_at: "2026-11-08T10:00:00Z" });
/** Polls until the assertion holds, or fails with its last error. */
async function waitFor(check: () => void, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      return check();
    } catch (e) {
      if (Date.now() > end) throw e;
      await act(async () => void (await new Promise((r) => setTimeout(r, 25))));
    }
  }
}
const wait = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

type Props = { ticketId: string; html: string; enabled?: boolean; recipients?: ReplyRecipients };
const none: ReplyRecipients = { cc: [], bcc: [] };
let root: Root | null = null;
let settled = false;
function Probe({ p, onRestore }: { p: Props; onRestore: (d: ReplyDraft, r: ReplyRecipients) => void }) {
  settled = useReplyDraftSync({ ticketId: p.ticketId, enabled: p.enabled ?? true, html: p.html, attachmentIds: [], recipients: p.recipients ?? none, ticketMailboxId: "mb-ticket", onRestore }).settled;
  return null;
}
const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const setup = async (initial: Props) => {
  const onRestore = vi.fn();
  const host = document.createElement("div");
  root = createRoot(host);
  const render = (p: Props) =>
    act(async () => {
      root!.render(
        <QueryClientProvider client={qc}>
          <Probe p={p} onRestore={onRestore} />
        </QueryClientProvider>,
      );
    });
  await render(initial);
  return { onRestore, rerender: render };
};

describe("useReplyDraftSync", () => {
  beforeEach(() => {
    replyDraft.get.mockReset();
    replyDraft.save.mockReset().mockResolvedValue({ draft: null });
    replyDraft.discard.mockReset().mockResolvedValue(undefined);
  });
  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    qc.clear();
  });

  it("brings my saved reply into an empty composer, once, without saving it back", async () => {
    replyDraft.get.mockResolvedValue({ draft: saved("<p>Half</p>") });
    const { onRestore, rerender } = await setup({ ticketId: "restore", html: "" });
    await waitFor(() => expect(onRestore).toHaveBeenCalledTimes(1));
    expect(onRestore.mock.calls[0]![0].body_html).toBe("<p>Half</p>");
    expect(settled).toBe(true);
    // The composer now holds it: nothing to save.
    await rerender({ ticketId: "restore", html: "<p>Half</p>" });
    await wait(1100);
    expect(replyDraft.save).not.toHaveBeenCalled();
    expect(onRestore).toHaveBeenCalledTimes(1);
  });

  it("keeps what is already in the composer and saves it a moment after typing stops", async () => {
    replyDraft.get.mockResolvedValue({ draft: saved("<p>Old</p>") });
    const { onRestore, rerender } = await setup({ ticketId: "typed", html: "<p>New</p>" });
    await waitFor(() => expect(replyDraft.get).toHaveBeenCalled());
    await waitFor(() => expect(replyDraft.save).toHaveBeenCalledWith("typed", { body_html: "<p>New</p>", attachment_ids: [] }));
    expect(onRestore).not.toHaveBeenCalled();
    await rerender({ ticketId: "typed", html: "<p>New, longer</p>" });
    await waitFor(() => expect(replyDraft.save).toHaveBeenLastCalledWith("typed", { body_html: "<p>New, longer</p>", attachment_ids: [] }));
  });

  it("discards the saved copy when the composer is emptied, and does not touch an empty server on open", async () => {
    replyDraft.get.mockResolvedValue({ draft: null });
    const { rerender } = await setup({ ticketId: "empty", html: "" });
    await waitFor(() => expect(replyDraft.get).toHaveBeenCalled());
    await wait(1100);
    expect(replyDraft.discard).not.toHaveBeenCalled();
    await rerender({ ticketId: "empty", html: "<p>Typed</p>" });
    await waitFor(() => expect(replyDraft.save).toHaveBeenCalledTimes(1));
    await rerender({ ticketId: "empty", html: "" });
    await waitFor(() => expect(replyDraft.discard).toHaveBeenCalledWith("empty"));
  });

  it("saves nothing while the composer is not writing a reply", async () => {
    replyDraft.get.mockResolvedValue({ draft: null });
    await setup({ ticketId: "note", html: "<p>A note</p>", enabled: false });
    await wait(1100);
    expect(replyDraft.get).not.toHaveBeenCalled();
    expect(replyDraft.save).not.toHaveBeenCalled();
  });
  it("does not save a reply sent right after typing as a draft when the ticket is left", async () => {
    replyDraft.get.mockResolvedValue({ draft: null });
    const { rerender } = await setup({ ticketId: "sent", html: "" });
    await waitFor(() => expect(settled).toBe(true));
    // Typed, then sent within the save delay: the composer empties.
    await rerender({ ticketId: "sent", html: "<p>Our answer</p>" });
    await wait(200);
    await rerender({ ticketId: "sent", html: "" });
    // On to the next ticket.
    await rerender({ ticketId: "next", html: "" });
    await wait(1100);
    expect(replyDraft.save).not.toHaveBeenCalledWith("sent", expect.anything());
  });

  it("saves what was typed when the ticket is left before the save delay", async () => {
    replyDraft.get.mockResolvedValue({ draft: null });
    const { rerender } = await setup({ ticketId: "unsaved", html: "" });
    await waitFor(() => expect(settled).toBe(true));
    await rerender({ ticketId: "unsaved", html: "<p>Half an answer</p>" });
    await wait(200);
    await rerender({ ticketId: "other", html: "" });
    await waitFor(() => expect(replyDraft.save).toHaveBeenCalledWith("unsaved", { body_html: "<p>Half an answer</p>", attachment_ids: [] }));
  });

  it("brings back who the reply goes to and the address it goes from, and saves a change to them", async () => {
    replyDraft.get.mockResolvedValue({ draft: { ...saved("<p>Half</p>"), to: ["a@example.com", "b@example.com"], cc: ["boss@example.com"], bcc: [], mailbox_id: "mb-other", from_account: null } });
    const { onRestore, rerender } = await setup({ ticketId: "recipients", html: "" });
    await waitFor(() => expect(onRestore).toHaveBeenCalledTimes(1));
    const restored = onRestore.mock.calls[0]![1] as ReplyRecipients;
    expect(restored).toEqual({ to: ["a@example.com", "b@example.com"], cc: ["boss@example.com"], bcc: [], mailboxId: "mb-other", fromAccount: null });
    // Held as it came: nothing to save.
    await rerender({ ticketId: "recipients", html: "<p>Half</p>", recipients: restored });
    await wait(1100);
    expect(replyDraft.save).not.toHaveBeenCalled();
    // A copy added alone is saved.
    await rerender({ ticketId: "recipients", html: "<p>Half</p>", recipients: { ...restored, bcc: ["audit@example.com"] } });
    await waitFor(() =>
      expect(replyDraft.save).toHaveBeenCalledWith("recipients", {
        body_html: "<p>Half</p>",
        attachment_ids: [],
        to: ["a@example.com", "b@example.com"],
        cc: ["boss@example.com"],
        bcc: ["audit@example.com"],
        mailbox_id: "mb-other",
      }),
    );
  });

  it("keeps the sending address through a save and back", () => {
    const cases: ReplyRecipients[] = [
      { cc: [], bcc: [] },
      { cc: [], bcc: [], fromAccount: null },
      { cc: [], bcc: [], mailboxId: "mb-other", fromAccount: null },
      { cc: [], bcc: [], fromAccount: { accountId: "acc", email: "me@example.com", replyTo: "mailbox" } },
    ];
    for (const r of cases) {
      const body = recipientsBody(r, "mb-ticket");
      const back = draftRecipients({ ...saved(""), to: body.to ?? null, cc: body.cc ?? [], bcc: body.bcc ?? [], mailbox_id: body.mailbox_id ?? null, from_account: body.from_account ? { account_id: body.from_account.account_id, email: body.from_account.email ?? "", reply_to: body.from_account.reply_to ?? "" } : null }, "mb-ticket");
      expect(back).toEqual({ to: undefined, cc: [], bcc: [], mailboxId: r.mailboxId, fromAccount: r.fromAccount });
    }
  });

  it("does not autosave over a scheduled reply", async () => {
    const d = { ...saved("<p>Scheduled</p>"), schedule: { send_at: new Date(Date.now() + 3600000).toISOString(), cc: [], bcc: [], status: null, mailbox_id: "" } };
    replyDraft.get.mockResolvedValue({ draft: d });
    const { rerender } = await setup({ ticketId: "scheduled", html: "" });
    await waitFor(() => expect(settled).toBe(true));
    await rerender({ ticketId: "scheduled", html: "<p>Changed</p>" });
    await wait(1000);
    expect(replyDraft.save).not.toHaveBeenCalled();
    expect(replyDraft.discard).not.toHaveBeenCalled();
  });

});

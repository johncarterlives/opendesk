// My own unsent reply, kept on the server (contracts/api.md "Reply drafts"): the composer saves
// it a moment after I stop typing, and brings it back when I open the ticket on another device
// or after a refresh. It is mine alone; the ticket's shared draft (SharedDraft.tsx) is the
// team's. An empty composer on open takes my saved reply; a composer that already has text
// keeps it, and replaces what the server holds. Who it goes to (To, Cc, Bcc) and the address it
// goes from are saved with it; the server gives back only an address that can still send.

import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { api, type ReplyDraftBody } from "@/lib/api/endpoints";
import type { ReplyDraft } from "@/lib/api/types";
import { q } from "@/lib/queries";
import type { PersonalFrom } from "./personalFrom";

const SAVE_DELAY_MS = 800;

type Snap = { ticketId: string; html: string; attachmentIds: string[]; extras: Extras };

/**
 * Who a reply goes to and from, as the composer holds it. to left out: the customer's reply
 * address. mailboxId left out: the ticket's address. fromAccount: one of my Collab addresses;
 * null: a team address picked over the one I last answered from; left out: that one.
 */
export type ReplyRecipients = { to?: string[]; cc: string[]; bcc: string[]; mailboxId?: string; fromAccount?: PersonalFrom | null };

type Extras = Omit<ReplyDraftBody, "body_html" | "attachment_ids">;

/** What the server keeps of the recipients. A team address picked over my own is saved as that address. */
export function recipientsBody(r: ReplyRecipients, ticketMailboxId: string | null): Extras {
  const e: Extras = {};
  if (r.to?.length) e.to = r.to;
  if (r.cc.length) e.cc = r.cc;
  if (r.bcc.length) e.bcc = r.bcc;
  if (r.fromAccount) e.from_account = { account_id: r.fromAccount.accountId, email: r.fromAccount.email || undefined, reply_to: r.fromAccount.replyTo || undefined };
  else if (r.mailboxId || (r.fromAccount === null && ticketMailboxId)) e.mailbox_id = r.mailboxId ?? ticketMailboxId ?? undefined;
  return e;
}

/** The composer's recipients from a saved draft: the reverse of recipientsBody. */
export function draftRecipients(d: ReplyDraft, ticketMailboxId: string | null): ReplyRecipients {
  return {
    to: d.to?.length ? d.to : undefined,
    cc: d.cc ?? [],
    bcc: d.bcc ?? [],
    mailboxId: d.mailbox_id && d.mailbox_id !== ticketMailboxId ? d.mailbox_id : undefined,
    fromAccount: d.from_account ? { accountId: d.from_account.account_id, email: d.from_account.email, replyTo: d.from_account.reply_to } : d.mailbox_id ? null : undefined,
  };
}

/** What the server holds for each ticket this tab has synced: "" for nothing. */
const synced = new Map<string, string>();
const keyOf = (html: string, attachmentIds: string[], extras: Extras) =>
  html.trim() || attachmentIds.length ? `${html}\u0000${attachmentIds.join(",")}\u0000${JSON.stringify(extras)}` : "";
const savedKey = (d: ReplyDraft, ticketMailboxId: string | null) =>
  keyOf(d.body_html, d.attachments.map((a) => a.id), recipientsBody(draftRecipients(d, ticketMailboxId), ticketMailboxId));

export function useReplyDraftSync({
  ticketId,
  enabled,
  html,
  attachmentIds,
  recipients,
  ticketMailboxId,
  onRestore,
}: {
  ticketId: string;
  enabled: boolean;
  html: string;
  attachmentIds: string[];
  recipients: ReplyRecipients;
  /** The ticket's own address, which a draft does not name. */
  ticketMailboxId: string | null;
  onRestore: (draft: ReplyDraft, recipients: ReplyRecipients) => void;
}): { settled: boolean; draft: ReplyDraft | null | undefined } {
  // A scheduled reply going out, or kept with why it did not, arrives as reply_draft.updated.
  const { data, isPending, isError } = useQuery({ ...q.replyDraft(ticketId), enabled });
  const scheduled = useRef(false);
  scheduled.current = !!data?.schedule;
  const settled = !enabled || !isPending || isError;
  const decided = useRef<string | null>(null);
  const latest = useRef({ html, attachmentIds });
  latest.current = { html, attachmentIds };
  const restore = useRef(onRestore);
  restore.current = onRestore;

  // Once per open: take my saved reply into an empty composer, else keep what is there.
  useEffect(() => {
    if (!enabled || isPending || decided.current === ticketId) return;
    decided.current = ticketId;
    const cur = latest.current;
    if (data && !cur.html.trim() && cur.attachmentIds.length === 0) {
      synced.set(ticketId, savedKey(data, ticketMailboxId));
      restore.current(data, draftRecipients(data, ticketMailboxId));
    } else {
      synced.set(ticketId, data ? savedKey(data, ticketMailboxId) : "");
    }
  }, [enabled, isPending, data, ticketId, ticketMailboxId]);

  const pending = useRef<Snap | null>(null);
  const push = useCallback((p: Snap) => {
    if (scheduled.current) return;
    const k = keyOf(p.html, p.attachmentIds, p.extras);
    if (synced.get(p.ticketId) === k) return;
    synced.set(p.ticketId, k);
    const req = k ? api.tickets.replyDraft.save(p.ticketId, { body_html: p.html, attachment_ids: p.attachmentIds, ...p.extras }) : api.tickets.replyDraft.discard(p.ticketId);
    // A failed save is retried by the next change; the composer still holds the text.
    Promise.resolve(req).catch(() => synced.delete(p.ticketId));
  }, []);

  // A moment after I stop typing.
  const extras = recipientsBody(recipients, ticketMailboxId);
  const key = keyOf(html, attachmentIds, extras);
  useEffect(() => {
    if (!enabled || data?.schedule || decided.current !== ticketId) return;
    // Back to what the server holds, as when a reply typed a moment ago goes out and empties the
    // composer: the text waiting to be saved is dropped, or leaving the ticket would save the
    // sent reply as a draft again.
    if (synced.get(ticketId) === key) {
      if (pending.current?.ticketId === ticketId) pending.current = null;
      return;
    }
    const snap = { ticketId, html, attachmentIds, extras };
    pending.current = snap;
    const timer = setTimeout(() => push(snap), SAVE_DELAY_MS);
    return () => clearTimeout(timer);
    // isPending: the open is decided once the saved reply is in. The key holds the words, files and recipients.
  }, [enabled, ticketId, key, push, data?.schedule, isPending]); // eslint-disable-line react-hooks/exhaustive-deps

  // Leaving the ticket, or the app, saves what has not gone yet.
  useEffect(
    () => () => {
      if (pending.current?.ticketId === ticketId) push(pending.current);
    },
    [ticketId, push],
  );

  return { settled, draft: data };
}

// My own unsent reply, kept on the server (contracts/api.md "Reply drafts"): the composer saves
// it a moment after I stop typing, and brings it back when I open the ticket on another device
// or after a refresh. It is mine alone; the ticket's shared draft (SharedDraft.tsx) is the
// team's. An empty composer on open takes my saved reply; a composer that already has text
// keeps it, and replaces what the server holds.

import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { api } from "@/lib/api/endpoints";
import type { ReplyDraft } from "@/lib/api/types";
import { q } from "@/lib/queries";

const SAVE_DELAY_MS = 800;

/** What the server holds for each ticket this tab has synced: "" for nothing. */
const synced = new Map<string, string>();
const keyOf = (html: string, attachmentIds: string[]) => (html.trim() || attachmentIds.length ? `${html}\u0000${attachmentIds.join(",")}` : "");

export function useReplyDraftSync({
  ticketId,
  enabled,
  html,
  attachmentIds,
  onRestore,
}: {
  ticketId: string;
  enabled: boolean;
  html: string;
  attachmentIds: string[];
  onRestore: (draft: ReplyDraft) => void;
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
      synced.set(ticketId, keyOf(data.body_html, data.attachments.map((a) => a.id)));
      restore.current(data);
    } else {
      synced.set(ticketId, data ? keyOf(data.body_html, data.attachments.map((a) => a.id)) : "");
    }
  }, [enabled, isPending, data, ticketId]);

  const pending = useRef<{ ticketId: string; html: string; attachmentIds: string[] } | null>(null);
  const push = useCallback((p: { ticketId: string; html: string; attachmentIds: string[] }) => {
    if (scheduled.current) return;
    const k = keyOf(p.html, p.attachmentIds);
    if (synced.get(p.ticketId) === k) return;
    synced.set(p.ticketId, k);
    const req = k ? api.tickets.replyDraft.save(p.ticketId, { body_html: p.html, attachment_ids: p.attachmentIds }) : api.tickets.replyDraft.discard(p.ticketId);
    // A failed save is retried by the next change; the composer still holds the text.
    Promise.resolve(req).catch(() => synced.delete(p.ticketId));
  }, []);

  // A moment after I stop typing.
  const key = keyOf(html, attachmentIds);
  useEffect(() => {
    if (!enabled || data?.schedule || decided.current !== ticketId || synced.get(ticketId) === key) return;
    const snap = { ticketId, html, attachmentIds };
    pending.current = snap;
    const timer = setTimeout(() => push(snap), SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [enabled, ticketId, key, html, attachmentIds, push, data?.schedule]);

  // Leaving the ticket, or the app, saves what has not gone yet.
  useEffect(
    () => () => {
      if (pending.current?.ticketId === ticketId) push(pending.current);
    },
    [ticketId, push],
  );

  return { settled, draft: data };
}

import { create } from "zustand";
import { getActiveAccount, getWorkspaceId, inWorkspace } from "@/lib/api/client";
import { api, type CollabDraftBody } from "@/lib/api/endpoints";
import type { MailMessage, MailThreadDetail, WorkspaceSettings } from "@/lib/api/types";
import { compose } from "@/lib/collab/compose";
import { qk } from "@/lib/queries";
import { queryClient as qc } from "@/lib/queryClient";
import { beforeSignOut, useSession } from "@/lib/session";
import { i18n } from "@/i18n";
import { toast } from "@/components/ui/toast";

// Undo send for mail (contracts/collab.md "Undo send"): Send saves the draft at the provider
// and holds it here, in the app, for the workspace's undo window; nothing reaches anyone until
// it ends. Undo leaves it a draft and opens it again where it was written. It lives outside the
// composer, so closing the conversation keeps the countdown and it still goes out; leaving the
// page, switching account or workspace, or signing out sends it at once, as Tickets' outbox does
// (components/tickets/detail/outbox.ts).

/** The seconds a send waits: the workspace's email undo window, the one Tickets use (5 by default). */
export function undoSendSeconds(settings: WorkspaceSettings | undefined): number {
  return settings?.undo_send_seconds ?? 5;
}

type Origin = { account: string | null; workspace: string | null };
const currentOrigin = (): Origin => ({ account: getActiveAccount(), workspace: getWorkspaceId() });

export type HeldSend = {
  /** The saved draft it sends (its id at /v1/collab/drafts). */
  draftId: string;
  /** The draft as saved: what Undo opens again. */
  draft: MailMessage;
  body: CollabDraftBody;
  /** The address it goes out from, for the "Sent" toast. */
  from: string;
  /** Written under a conversation (it reopens there) or as new mail (the floating composer). */
  inline: boolean;
};

type Held = HeldSend & { origin: Origin; timer: ReturnType<typeof setTimeout>; toast: string | number };

const held = new Map<string, Held>();

/** Drafts on hold, by draft id: the conversation hides them while they wait. */
export const useHeldSends = create<Record<string, true>>(() => ({}));
/** Drafts taken back, by conversation, until that conversation's composer opens them again. */
export const useUndoneSends = create<Record<string, MailMessage>>(() => ({}));

/** Sends a saved draft now, as the account and in the workspace it was written in. */
async function deliver(h: HeldSend, origin: Origin, opts: { keepalive?: boolean } = {}): Promise<boolean> {
  const here = <T>(fn: () => T) => inWorkspace(origin.workspace, fn);
  const t = i18n.getFixedT(null, "collab");
  try {
    const m = await api.collab.drafts.send(h.draftId, h.body, { keepalive: !!opts.keepalive, as: origin.account ?? undefined, workspace: origin.workspace ?? undefined });
    here(() => {
      // The conversation shows it at once; collab.changed brings the rest.
      qc.setQueryData<MailThreadDetail>(qk.mailThread(m.thread_id), (old) => {
        if (!old) return old;
        const messages = old.messages.filter((x) => x.id !== h.draft.id && x.id !== h.draftId);
        return messages.some((x) => x.id === m.id) ? { ...old, messages } : { ...old, messages: [...messages, m], thread: { ...old.thread, message_count: messages.length + 1, last_message_at: m.sent_at } };
      });
      void qc.invalidateQueries({ queryKey: qk.mailThreadLists });
    });
    if (!opts.keepalive) toast.success(t("toast.sent", { email: m.from.email || h.from }));
    return true;
  } catch (e) {
    // Not sent: it stays a draft in its conversation, to open and send again.
    here(() => void qc.invalidateQueries({ queryKey: qk.of("collab", "thread") }));
    toast.error(e, t("composer.sendFailed"));
    return false;
  }
}

/** Holds a saved draft for `seconds`, then sends it; 0 sends now. */
export function holdSend(h: HeldSend, seconds: number): Promise<boolean> | void {
  if (seconds <= 0) return deliver(h, currentOrigin());
  const t = i18n.getFixedT(null, "collab");
  const ms = seconds * 1000;
  const id = toast.held(t("composer.sendingHeld"), ms, { label: t("composer.undo"), onClick: () => undoSend(h.draftId) }, { label: t("composer.sendNow"), onClick: () => void releaseSend(h.draftId) });
  held.set(h.draftId, { ...h, origin: currentOrigin(), timer: setTimeout(() => void releaseSend(h.draftId), ms), toast: id });
  useHeldSends.setState({ [h.draftId]: true });
}

function take(draftId: string): Held | undefined {
  const h = held.get(draftId);
  if (!h) return undefined;
  held.delete(draftId);
  clearTimeout(h.timer);
  toast.dismiss(h.toast);
  useHeldSends.setState((s) => Object.fromEntries(Object.entries(s).filter(([k]) => k !== draftId)), true);
  return h;
}

/** Sends a held draft now. */
export function releaseSend(draftId: string, opts: { keepalive?: boolean } = {}): Promise<boolean> {
  const h = take(draftId);
  return h ? deliver(h, h.origin, opts) : Promise.resolve(false);
}

/** Sends every held draft now (leaving the page, switching away, signing out). */
export function flushSends(opts: { keepalive?: boolean } = {}): Promise<boolean[]> {
  return Promise.all([...held.keys()].map((id) => releaseSend(id, opts)));
}

/** Takes a held draft back: nothing is sent, and it opens again where it was written. */
export function undoSend(draftId: string) {
  const h = take(draftId);
  if (!h) return;
  const draft = { ...h.draft, body_html: h.body.body_html };
  if (h.inline && draft.thread_id) useUndoneSends.setState({ [draft.thread_id]: draft });
  else compose.open({ fromDraft: draft });
  toast.info(i18n.getFixedT(null, "collab")("composer.unsent"));
}

if (typeof window !== "undefined") {
  // Leaving with mail on hold asks first; leaving anyway sends it, as the member meant.
  window.addEventListener("beforeunload", (e) => {
    if (held.size) e.preventDefault();
  });
  window.addEventListener("pagehide", () => void flushSends({ keepalive: true }));
  useSession.subscribe(() => {
    const now = currentOrigin();
    for (const [id, h] of [...held]) if (h.origin.account !== now.account || h.origin.workspace !== now.workspace) void releaseSend(id);
  });
  beforeSignOut(() => flushSends());
}

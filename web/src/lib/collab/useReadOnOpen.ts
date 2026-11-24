import { useCallback, useEffect, useRef } from "react";
import type { MailThreadAction, MailThreadDetail } from "../api/types";

type Message = Pick<MailThreadDetail["messages"][number], "id" | "draft" | "drafted_by_ai" | "ai_draft">;

/** A draft an AI client wrote that is waiting for a person (a person may have saved over it since). */
const waitingAI = (m: Message) => m.draft && !!(m.drafted_by_ai || m.ai_draft);

/**
 * Read each delivery shown during this visit, without undoing an explicit mark as unread.
 * A visit that opens on an AI draft waiting for review reads nothing: reviewing, editing or
 * discarding the draft is not handling the customer's mail (GH#592). A reply sent during it
 * is, so the returned `replied` reads the conversation then, as opening would have.
 */
export function useReadOnOpen({ detail, current, enabled, onAction }: {
  detail: (Pick<MailThreadDetail, "can_act"> & {
    thread: Pick<MailThreadDetail["thread"], "id" | "unread">;
    messages: Message[];
  }) | undefined;
  current: boolean;
  enabled: boolean;
  onAction: (action: MailThreadAction, opts: { silent: boolean }) => void;
}) {
  const seen = useRef<{ threadId: string; messages: Set<string>; held: boolean } | null>(null);
  useEffect(() => {
    if (!detail || !current || !detail.can_act || !enabled) return;
    const messages = detail.messages.filter((m) => !m.draft);
    const previous = seen.current;
    const first = previous?.threadId !== detail.thread.id;
    const held = first ? detail.messages.some(waitingAI) : previous.held;
    const delivered = first || messages.some((m) => !previous.messages.has(m.id));
    seen.current = { threadId: detail.thread.id, messages: new Set(messages.map((m) => m.id)), held };
    if (delivered && !held && detail.thread.unread) onAction("read", { silent: true });
  }, [detail, current, enabled, onAction]);

  /** A reply was sent from this conversation: read it now if opening held off (an AI draft was waiting). */
  return useCallback(
    (threadId: string, unread: boolean) => {
      const visit = seen.current;
      if (!enabled || !unread || visit?.threadId !== threadId || !visit.held) return;
      onAction("read", { silent: true });
    },
    [enabled, onAction],
  );
}

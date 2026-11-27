// "Copy for AI agent" on a ticket and on each of its messages: the prompt
// (lib/agentPrompt.ts) on the clipboard, and a toast saying whether it got there.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { Message, Ticket } from "@/lib/api/types";
import { api } from "@/lib/api/endpoints";
import { q, qk } from "@/lib/queries";
import { ticketMessagePrompt, ticketPrompt } from "@/lib/agentPrompt";
import { copyText } from "@/components/ui/copy-button";
import { toast } from "@/components/ui/toast";

export function useCopyForAgent(ticket: Ticket | undefined) {
  const { t } = useTranslation("inbox");
  const qc = useQueryClient();
  const { data: mailboxes } = useQuery(q.mailboxes());
  return useMemo(() => {
    if (!ticket) return null;
    const ctx = { origin: location.origin, mailbox: mailboxes?.find((mb) => mb.id === ticket.mailbox_id) ?? null };
    const copy = async (text: string | Promise<string>) => {
      if (await copyText(text)) toast.success(t("toast.copiedForAgent"));
      else toast.error(t("toast.copyFailed"));
    };
    return {
      /** The whole conversation, internal notes and side conversations labelled. */
      ticket: (messages: Message[]) => void copy(ticketPrompt(ticket, messages, ctx)),
      /** One message, with the email it quoted in full when it has one (the same copy the message shows). */
      message: (m: Message) => {
        const full = m.has_quoted
          ? qc
              .fetchQuery({ queryKey: qk.of("message-original", m.id), queryFn: () => api.messages.original(m.id), staleTime: Infinity })
              .then((r) => r.full_html, () => null)
          : Promise.resolve(null);
        void copy(full.then((fullHtml) => ticketMessagePrompt(ticket, m, { ...ctx, fullHtml })));
      },
    };
  }, [ticket, mailboxes, qc, t]);
}

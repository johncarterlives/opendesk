import { CornerDownRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Ticket } from "@/lib/api/types";

/**
 * The closed ticket a follow-up answers: an email that answers a closed ticket opens a new
 * one with `custom.previous_ticket_id` (contracts/api.md "Follow-ups of closed tickets").
 */
export function previousTicketId(t: Pick<Ticket, "custom">): string | null {
  const id = t.custom?.previous_ticket_id;
  return typeof id === "string" && id ? id : null;
}

/** A search row's quiet mark that the ticket follows an earlier one. */
export function FollowUpHint({ ticket }: { ticket: Pick<Ticket, "custom"> }) {
  const { t } = useTranslation("navigation");
  if (!previousTicketId(ticket)) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5 text-[11px] text-fg-4" data-follow-up>
      <CornerDownRight className="size-3" aria-hidden />
      {t("command.followUp")}
    </span>
  );
}

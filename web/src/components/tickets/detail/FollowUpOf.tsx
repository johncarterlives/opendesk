import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { CornerDownRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Tooltip } from "@/components/ui/tooltip";
import type { Ticket } from "@/lib/api/types";
import { q } from "@/lib/queries";
import { previousTicketId } from "../followUp";
import { mergedTicketDest } from "./MergeDialog";

/**
 * "Follow-up of #N" in the ticket header, linking to the earlier ticket in the list being
 * worked. An earlier ticket the reader may not see (a private team's) is not named or linked.
 */
export function FollowUpOf({ ticket }: { ticket: Ticket }) {
  const { t } = useTranslation("inbox");
  const id = previousTicketId(ticket);
  const where = useParams({ strict: false }) as { folder?: string; viewId?: string; teamId?: string };
  const prev = useQuery({ ...q.ticket(id ?? ""), enabled: !!id, retry: false });
  if (!id || prev.isPending) return null;
  if (!prev.data)
    return <span className="hidden shrink-0 text-[11.5px] text-fg-4 md:inline">{t("detail.followUpHidden")}</span>;
  return (
    <Tooltip content={t("detail.followUpHint", { number: prev.data.number })}>
      <Link
        {...mergedTicketDest(where, prev.data.id)}
        className="hidden shrink-0 items-center gap-1 rounded-sm px-1 text-[11.5px] text-fg-3 hover:bg-hover hover:text-fg md:inline-flex"
        data-follow-up-of
      >
        <CornerDownRight className="size-3" aria-hidden />
        {t("detail.followUpOf", { number: prev.data.number })}
      </Link>
    </Tooltip>
  );
}

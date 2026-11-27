// Reply all in a ticket's reply box, and the recipients of an inbound email under its header.
// The logic is in replyAllRecipients.ts.

import { useQuery } from "@tanstack/react-query";
import { ReplyAll, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Ticket } from "@/lib/api/types";
import { q } from "@/lib/queries";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/cn";
import { Tooltip } from "@/components/ui/tooltip";
import { addReplyAll, latestInbound, ownAddresses, removeReplyAll, replyAllExtras, replyAllOn } from "./replyAllRecipients";

export type ReplyAllState = {
  /** Who Reply all would add to the Cc now. */
  extras: string[];
  /** Reply all is on: what it added is (partly) still in the Cc. */
  on: boolean;
  /** The addresses it added that are still in the Cc. */
  inCc: string[];
};

/** What the draft becomes when the agent switches between Reply and Reply all. */
export type ReplyAllChange = { cc: string[]; replyAll: string[] | undefined; showCc?: boolean };

export function useReplyAll(
  ticket: Ticket,
  enabled: boolean,
  draft: { to: readonly string[]; contactEmail: string; cc: readonly string[]; bcc: readonly string[]; replyAll?: readonly string[] },
): ReplyAllState & { toggle: () => ReplyAllChange } {
  const { data: mailboxes } = useQuery({ ...q.mailboxes(), enabled });
  const { data: messages } = useQuery({ ...q.messages(ticket.id), enabled });
  const userEmail = useSession((s) => s.user?.email);
  const own = ownAddresses(mailboxes, userEmail);
  const extras = enabled ? replyAllExtras(latestInbound(messages), { own, contactEmail: draft.contactEmail, to: draft.to, bcc: draft.bcc }) : [];
  const on = enabled && replyAllOn(draft.cc, draft.replyAll);
  const added = new Set((draft.replyAll ?? []).map((a) => a.toLowerCase()));
  const inCc = on ? draft.cc.filter((a) => added.has(a.toLowerCase())) : [];
  const toggle = (): ReplyAllChange => {
    if (on) return { cc: removeReplyAll(draft.cc, draft.replyAll), replyAll: undefined };
    const next = addReplyAll(draft.cc, extras);
    return { cc: next.cc, replyAll: next.added, showCc: true };
  };
  return { extras, on, inCc, toggle };
}

/** Reply or Reply all: offered when the latest email named someone the reply would not reach. */
export function ReplyAllButton({ r, onChange }: { r: ReplyAllState & { toggle: () => ReplyAllChange }; onChange: (p: ReplyAllChange) => void }) {
  const { t } = useTranslation("inbox");
  if (!r.on && r.extras.length === 0) return null;
  const hint = r.on ? t("composer.replyAllOff", { list: r.inCc.join(", ") }) : t("composer.replyAllHint", { list: r.extras.join(", ") });
  return (
    <Tooltip
      content={
        <span className="block max-w-[320px] break-words font-normal leading-snug" data-ph-mask>
          {hint}
        </span>
      }
    >
      <button
        type="button"
        aria-pressed={r.on}
        aria-label={t("composer.replyAll")}
        onClick={() => onChange(r.toggle())}
        className={cn(
          "flex h-5 shrink-0 items-center gap-1 rounded-sm px-1.5 text-xs text-fg-3 transition-colors hover:bg-hover hover:text-fg",
          r.on && "bg-hover text-fg",
        )}
      >
        <ReplyAll className="size-3.5" aria-hidden />
        {/* A narrow reply box keeps the icon, so the To address keeps its room. */}
        <span className="hidden @xl/reply-head:inline">{t("composer.replyAll")}</span>
      </button>
    </Tooltip>
  );
}

/**
 * An inbound email's recipients, under its header, when it had more than one: "To a, b · Cc c",
 * our own address included. The line wraps rather than truncating, so every address shows.
 */
export function InboundRecipients({ to, cc }: { to: readonly string[]; cc: readonly string[] }) {
  const { t } = useTranslation("inbox");
  const list = (xs: readonly string[]) => <span className="mono text-fg-2">{xs.join(", ")}</span>;
  return (
    <span className="flex min-w-0 max-w-full items-start gap-1.5" data-recipients>
      <Users className="mt-[3px] size-3 shrink-0 text-fg-4" aria-hidden />
      <span className="min-w-0 break-words">
        {to.length > 0 && (
          <>
            {t("composer.to")} {list(to)}
          </>
        )}
        {to.length > 0 && cc.length > 0 && <span className="text-fg-4"> · </span>}
        {cc.length > 0 && (
          <>
            {t("composer.cc")} {list(cc)}
          </>
        )}
      </span>
    </span>
  );
}

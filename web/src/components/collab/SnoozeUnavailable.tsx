// Snooze greyed out where Handling is off (GH#532): it says why, and for one account the reader
// manages, links to its settings, where Handling is turned on (shared accounts only).

import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type { MailAccount } from "@/lib/api/types";
import { SnoozeMenu } from "@/components/tickets/detail/SnoozeMenu";

export function SnoozeUnavailable({ accounts }: { accounts: MailAccount[] }) {
  const { t } = useTranslation("collab");
  const off = accounts.filter((a) => !(a.handling_enabled && a.visibility === "shared"));
  const reason = off.some((a) => a.visibility === "private") ? t("action.snoozeNeedsSharing") : t("action.snoozeNeedsHandling");
  const manage = off.length === 1 && off[0].can_manage ? off[0] : null;
  return (
    <SnoozeMenu
      onSnooze={() => {}}
      unavailable={reason}
      unavailableAction={
        manage && (
          <Link to="/settings/mail-accounts/$accountId" params={{ accountId: manage.id }} className="rounded-sm font-medium text-fg underline-offset-4 outline-none hover:underline focus-visible:shadow-[0_0_0_2px_var(--focus)]">
            {t("rowMenu.accountSettings")}
          </Link>
        )
      }
    />
  );
}

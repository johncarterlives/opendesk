// New mail from the top of the sidebar on the mail pages, where Gmail and Outlook put it
// (GH#528): full width, or an icon on the collapsed rail. On a phone the sidebar is a drawer
// and the mail list header keeps its own button. The header's Compose ▾ stays for tickets too.

import { useRouterState } from "@tanstack/react-router";
import { PenSquare } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { compose } from "@/lib/collab/compose";
import { useAllFolders, useCanAct, useMailAccounts } from "@/lib/collab/hooks";

export function SidebarCompose({ rail }: { rail: boolean }) {
  const { t } = useTranslation("collab");
  const canAct = useCanAct();
  const { data: accounts } = useMailAccounts();
  const search = useRouterState({ select: (s) => s.location.search as { account?: string; folder?: string } });
  // A folder's page writes from that folder's account, as the list header did.
  const folderMap = useAllFolders(accounts, !!search.folder);
  if (!canAct || !accounts?.length) return null;
  const folderAccount = search.folder
    ? Object.values(folderMap)
        .flatMap((f) => f ?? [])
        .find((f) => f.id === search.folder)?.account_id
    : undefined;
  const accountId = (search.account && accounts.some((a) => a.id === search.account) ? search.account : undefined) ?? folderAccount;
  const label = t("list.compose");
  return (
    <div className={cn("shrink-0 pb-2 pt-1", rail ? "px-3" : "px-2.5")}>
      <Tooltip content={label} shortcut="c" side="right">
        <Button
          size="md"
          variant="secondary"
          square={rail}
          icon={<PenSquare />}
          aria-label={label}
          onClick={() => compose.open({ accountId })}
          className={cn(!rail && "w-full")}
        >
          {rail ? null : label}
        </Button>
      </Tooltip>
    </div>
  );
}

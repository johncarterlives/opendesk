// The right-click menu of a conversation in the mail list (GH#455), as Gmail has it. The page
// builds its items (pages/mail/MailPage.tsx), so each does what its button or key does; this
// file holds the menu around a row (ThreadRow renders it), the Snooze choices and Share for a
// conversation of the list.

import { useQuery } from "@tanstack/react-query";
import type { MouseEvent, ReactElement, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { snoozeAt, snoozeLabel, snoozePresets } from "@/components/tickets/detail/snooze";
import type { MailThread } from "@/lib/api/types";
import { weekdayClock } from "@/lib/format";
import { q } from "@/lib/queries";
import { ShareDialog } from "./ShareDialog";

/** Mounted only while the menu is open, so a closed row's menu costs nothing. */
function Items({ render }: { render: () => ReactNode }) {
  return <>{render()}</>;
}

export function ThreadMenu({
  thread,
  render,
  onPoint,
  onCloseAutoFocus,
  children,
}: {
  thread: MailThread;
  /** The items for this row (and the selection it is in). */
  render: (t: MailThread) => ReactNode;
  /** Where the menu opened: a picker an item opens shows there. */
  onPoint?: (x: number, y: number) => void;
  onCloseAutoFocus?: (e: Event) => void;
  children: ReactElement;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger onContextMenu={(e: MouseEvent) => onPoint?.(e.clientX, e.clientY)}>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-[236px]" onCloseAutoFocus={onCloseAutoFocus}>
        <Items render={() => render(thread)} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** The workspace's snooze choices (the ticket snooze's, as the open conversation has them). */
export function SnoozeItems({ onSnooze }: { onSnooze: (at: Date) => void }) {
  const { t } = useTranslation("inbox");
  const { data: workspace } = useQuery(q.workspace());
  const now = new Date();
  return (
    <>
      {snoozePresets(workspace?.settings).map((p, i) => {
        const at = snoozeAt(p, now);
        return (
          <ContextMenuItem key={i} onSelect={() => onSnooze(at)}>
            <span className="flex items-center justify-between gap-3">
              <span className="truncate">{snoozeLabel(p, t)}</span>
              <span className="mono shrink-0 text-[11px] text-fg-4">{weekdayClock(at)}</span>
            </span>
          </ContextMenuItem>
        );
      })}
    </>
  );
}

/** Share for a conversation picked in the list: the dialog of the open conversation, once its shares are here. */
export function ListShareDialog({ threadId, onClose }: { threadId: string; onClose: () => void }) {
  const { data } = useQuery(q.mailThread(threadId));
  if (!data) return null;
  return <ShareDialog detail={data} open onOpenChange={(o) => !o && onClose()} />;
}

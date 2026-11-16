// The master checkbox above Collab's conversation list, with the scope of what it selects:
// the conversations loaded, or (one click more) every one in the box, folder, tab or search in view.

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SELECT_ALL_MAX } from "@/lib/collab/hooks";
import { MAIL_PAGE_SIZE } from "@/lib/queries";
import { cn } from "@/lib/cn";

export type SelectAllBarProps = {
  /** Conversations loaded into the list. */
  loaded: number;
  selected: number;
  /** More conversations than the loaded ones exist in this box or folder. */
  hasMore: boolean;
  /** Loading the rest, to select it; the checkbox then stops it. */
  loading: boolean;
  /** The box, folder or tab in view, by its name. */
  scope: string;
  /** The list is a search's results: "all" means every conversation matching it. */
  matching?: boolean;
  /** Selects, or clears, the loaded conversations; stops loading the rest. */
  onToggle: () => void;
  /** Loads the rest of the folder and selects it. */
  onSelectEvery: () => void;
  /**
   * What to do with the selection. Shown in this row, beside the count, as Gmail and Outlook
   * keep theirs at the top of the list; the note about "all" then takes a line of its own.
   */
  actions?: ReactNode;
  /** A narrow list (beside an open conversation): the count is left to the checkbox and the toolbar's name. */
  compact?: boolean;
};

export function SelectAllBar({ loaded, selected, hasMore, loading, scope, matching, onToggle, onSelectEvery, actions, compact }: SelectAllBarProps) {
  const { t } = useTranslation("collab");
  const all = loaded > 0 && selected === loaded;
  const state = all ? true : selected > 0 ? "indeterminate" : false;
  // The note under the checkbox says what "all" means, never silently more than it is.
  const note = loading
    ? t("list.selecting")
    : !all
    ? null
    : hasMore && loaded >= SELECT_ALL_MAX
      ? matching ? t("list.firstSelectedMatching", { count: loaded }) : t("list.firstSelected", { count: loaded, scope })
      : hasMore
        ? t("list.pageSelected", { count: loaded })
        : loaded > MAIL_PAGE_SIZE
          ? matching ? t("list.folderSelectedMatching", { count: loaded }) : t("list.folderSelected", { count: loaded, scope })
          : null;
  const noteRow = note && (
    <span className={cn("flex min-w-0 items-center gap-1.5 truncate", actions && "px-3.5 pb-1.5")} role="status">
      <span className="truncate">{note}</span>
      {hasMore && !loading && loaded < SELECT_ALL_MAX && (
        <Button size="sm" variant="ghost" onClick={onSelectEvery}>
          {matching ? t("list.selectEveryMatching") : t("list.selectEvery", { scope })}
        </Button>
      )}
    </span>
  );
  return (
    <div className="flex shrink-0 flex-col border-b border-line-soft text-[12px] text-fg-3">
      <div className="flex min-h-9 items-center gap-2.5 px-3.5">
        <Checkbox checked={state} disabled={!loaded} aria-label={selected || loading ? t("list.clear") : t("list.selectAll")} onCheckedChange={onToggle} />
        <span className={cn("mono shrink-0 tabular-nums", actions && compact && "sr-only")}>{selected ? t("list.selected", { count: selected }) : t("list.selectAll")}</span>
        {actions ? (
          <div role="toolbar" aria-label={t("list.selected", { count: selected })} className="-my-1 flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
            <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-line" />
            {actions}
          </div>
        ) : (
          noteRow
        )}
      </div>
      {actions && noteRow}
    </div>
  );
}

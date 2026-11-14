// The master checkbox above Collab's conversation list, with the scope of what it selects:
// the conversations loaded, or (one click more) every one in the box, folder, tab or search in view.

import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SELECT_ALL_MAX } from "@/lib/collab/hooks";
import { MAIL_PAGE_SIZE } from "@/lib/queries";

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
};

export function SelectAllBar({ loaded, selected, hasMore, loading, scope, matching, onToggle, onSelectEvery }: SelectAllBarProps) {
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
  return (
    <div className="flex min-h-9 shrink-0 items-center gap-2.5 border-b border-line-soft px-3.5 text-[12px] text-fg-3">
      <Checkbox checked={state} disabled={!loaded} aria-label={selected || loading ? t("list.clear") : t("list.selectAll")} onCheckedChange={onToggle} />
      <span className="mono tabular-nums">{selected ? t("list.selected", { count: selected }) : t("list.selectAll")}</span>
      {note && (
        <span className="flex min-w-0 items-center gap-1.5 truncate" role="status">
          <span className="truncate">{note}</span>
          {hasMore && !loading && loaded < SELECT_ALL_MAX && (
            <Button size="sm" variant="ghost" onClick={onSelectEvery}>
              {matching ? t("list.selectEveryMatching") : t("list.selectEvery", { scope })}
            </Button>
          )}
        </span>
      )}
    </div>
  );
}

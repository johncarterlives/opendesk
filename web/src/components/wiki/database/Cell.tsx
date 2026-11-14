// One editable cell: its value as CellView draws it, and on a click its editor: a popover
// for text, numbers, dates and files, a picker for options, people, pages and tickets, a
// tick in place for a checkbox. Computed values never open. Used by every view.

import { Popover as P } from "radix-ui";
import { useState, type ReactNode } from "react";
import { floatingPanel } from "@/components/ui/popover";
import type { DbOption, DbProperty, DbRow, DbValue } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import type { DbContext } from "@/lib/wiki/db";
import { CellEditor, CellView, CheckMark, editsInPlace, pickerTypes, readOnly, ValuePicker } from "./cells";

export type CellProps = {
  prop: DbProperty;
  row: DbRow;
  ctx: DbContext;
  canEdit: boolean;
  onChange: (value: DbValue) => void;
  onAddOption: (prop: DbProperty, name: string) => DbOption;
  /** How the cell sits: a table cell fills its box, a card or the row page wraps. */
  variant?: "table" | "card" | "page";
  placeholder?: ReactNode;
  className?: string;
};

export function Cell({ prop, row, ctx, canEdit, onChange, onAddOption, variant = "table", placeholder, className }: CellProps) {
  const [open, setOpen] = useState(false);
  const wrap = variant !== "table";
  const box = cn(
    "flex min-w-0 items-center text-left outline-none",
    variant === "table" && "h-full w-full px-2",
    variant === "page" && "min-h-8 w-full rounded-md px-2 py-1 transition-colors",
    variant === "card" && "min-h-5",
    canEdit && !readOnly(prop.type) && variant === "page" && "hover:bg-hover",
    className,
  );
  const view = <CellView prop={prop} row={row} ctx={ctx} wrap={wrap} column={variant === "table"} />;
  const empty = row.props[prop.id] === undefined && prop.type !== "checkbox" && !readOnly(prop.type);

  if (prop.type === "checkbox") {
    const checked = row.props[prop.id] === true;
    return (
      <span className={box}>
        <CheckMark checked={checked} disabled={!canEdit} onToggle={canEdit ? () => onChange(!checked) : undefined} />
      </span>
    );
  }
  if (!canEdit || readOnly(prop.type) || editsInPlace(prop.type)) return <span className={box}>{view}</span>;

  const trigger = (
    <button type="button" className={cn(box, "focus-visible:shadow-[inset_0_0_0_2px_var(--focus)]", open && variant === "table" && "shadow-[inset_0_0_0_2px_var(--focus)]")}>
      {empty && variant === "page" ? <span className="text-[13px] text-fg-4">{placeholder}</span> : view}
    </button>
  );
  if (pickerTypes.includes(prop.type))
    return <ValuePicker prop={prop} row={row} ctx={ctx} onChange={onChange} onAddOption={onAddOption} trigger={trigger} open={open} onOpenChange={setOpen} />;
  return (
    <P.Root open={open} onOpenChange={setOpen}>
      <P.Trigger asChild>{trigger}</P.Trigger>
      <P.Portal>
        <P.Content
          align="start"
          side="bottom"
          sideOffset={variant === "table" ? -32 : 4}
          collisionPadding={8}
          className={cn(floatingPanel, "min-w-[calc(var(--radix-popover-trigger-width)/var(--od-zoom,1))] overflow-hidden p-0")}
          onClick={(e) => e.stopPropagation()}
        >
          <CellEditor prop={prop} row={row} ctx={ctx} onChange={onChange} onAddOption={onAddOption} onClose={() => setOpen(false)} />
        </P.Content>
      </P.Portal>
    </P.Root>
  );
}

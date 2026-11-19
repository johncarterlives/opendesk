// The small copy of a row or section that follows the pointer while it drags (useEditDrag).

import { GripVertical } from "lucide-react";
import { createPortal } from "react-dom";
import type { Drag } from "./useEditDrag";

export function DragGhost({ drag }: { drag: Pick<Drag<unknown>, "label" | "x" | "y"> | null }) {
  if (!drag) return null;
  return createPortal(
    <div
      aria-hidden
      className="pointer-events-none fixed z-[90] flex h-7 max-w-[220px] items-center gap-2 rounded-md bg-surface px-2.5 text-[12.5px] text-fg shadow-lg ring-1 ring-line"
      style={{ left: drag.x + 10, top: drag.y - 14 }}
    >
      <GripVertical className="size-3.5 shrink-0 text-fg-4" />
      <span className="truncate">{drag.label}</span>
    </div>,
    document.body,
  );
}

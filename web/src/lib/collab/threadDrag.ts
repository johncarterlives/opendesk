// Dragging conversations from the mail list onto a place that acts on them (GH#455): the
// sidebar's mail rows, the folder bar's tabs and the inbox's category tabs. The drag carries the
// conversations' ids under a type of its own; a row that takes them says where it leads (a box,
// an account's box, a folder or label, a category), and the mail page that started the drag acts
// on them as its own buttons would, with the same toast and Undo (pages/mail/MailPage.tsx).

import { useEffect, useState, type DragEvent } from "react";
import type { MailBox } from "../api/types";

export const THREAD_DRAG = "application/x-od-mail-threads";

/** Where conversations are dropped: what the row or tab under them opens; a category tab moves them to its category. */
export type ThreadDropTarget = { box: MailBox | "folder"; account?: string; folder?: string; category?: string };

/** Boxes that do something with conversations dropped on them: move them there, star them, assign them to the member. */
const DROP_BOXES: ReadonlySet<string> = new Set(["inbox", "starred", "archive", "spam", "trash", "needs_action", "assigned"]);

export function takesThreads(to: ThreadDropTarget): boolean {
  return to.box === "folder" ? !!to.folder : DROP_BOXES.has(to.box);
}

/** Whether a drag carries conversations (its data is readable only on drop). */
export const carriesThreads = (e: DragEvent) => e.dataTransfer.types.includes(THREAD_DRAG);

type Drop = (ids: string[], to: ThreadDropTarget) => void;
/** Whether these conversations may be dropped there; asked while they are over it. */
type Accepts = (ids: string[], to: ThreadDropTarget) => boolean;
let handler: { drop: Drop; accepts?: Accepts } | null = null;
// The conversations of the drag this window started; the drag's data is readable only on drop.
let dragging: string[] | null = null;

/** The mail page takes the drops while its list shows; returns the cleanup. */
export function takeThreadDrops(drop: Drop, accepts?: Accepts): () => void {
  const h = { drop, accepts };
  handler = h;
  return () => {
    if (handler === h) handler = null;
  };
}

/** Whether the conversations over a place may be dropped there: a drag from another window is checked on drop. */
function accepted(to: ThreadDropTarget): boolean {
  return !!handler && (!dragging || !handler.accepts || handler.accepts(dragging, to));
}

/** How many conversations this window drags that the page refuses here (0 when it takes them, or cannot tell before the drop). */
function refusedHere(to: ThreadDropTarget): number {
  return handler?.accepts && dragging && !handler.accepts(dragging, to) ? dragging.length : 0;
}

/** Starts dragging conversations: the drag shows how many, as a small label by the pointer. */
export function startThreadDrag(e: DragEvent, ids: string[], label: string) {
  dragging = ids;
  window.addEventListener("dragend", () => (dragging = null), { once: true, capture: true });
  e.dataTransfer.setData(THREAD_DRAG, JSON.stringify(ids));
  e.dataTransfer.setData("text/plain", label);
  e.dataTransfer.effectAllowed = "move";
  const ghost = document.createElement("div");
  ghost.textContent = label;
  ghost.style.cssText =
    "position:fixed;top:-1000px;left:-1000px;padding:4px 10px;border-radius:6px;font:500 12px/18px system-ui,sans-serif;background:var(--inverse,#111);color:var(--inverse-fg,#fff);white-space:nowrap";
  document.body.appendChild(ghost);
  e.dataTransfer.setDragImage(ghost, -12, -8);
  setTimeout(() => ghost.remove(), 0);
}

function readIds(e: DragEvent): string[] | null {
  try {
    const v: unknown = JSON.parse(e.dataTransfer.getData(THREAD_DRAG));
    return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string") ? (v as string[]) : null;
  } catch {
    return null;
  }
}

/**
 * Drop handlers for a row or tab leading to `to`, whether conversations are over it, and, while the page refuses the
 * ones over it, how many (the place says why; the pointer shows they cannot drop). Inert for places that take none, and without a place.
 */
export function useThreadDrop(to: ThreadDropTarget | null) {
  const [over, setOver] = useState(false);
  const [refused, setRefused] = useState(0);
  // A drag that ends anywhere leaves nothing lit.
  useEffect(() => {
    if (!over && !refused) return;
    const clear = () => {
      setOver(false);
      setRefused(0);
    };
    window.addEventListener("dragend", clear, true);
    window.addEventListener("drop", clear, true);
    return () => {
      window.removeEventListener("dragend", clear, true);
      window.removeEventListener("drop", clear, true);
    };
  }, [over, refused]);
  if (!to || !takesThreads(to)) return { over: false, refused: 0, props: {} };
  return {
    over,
    refused,
    props: {
      onDragOver: (e: DragEvent) => {
        if (!carriesThreads(e)) return;
        if (!accepted(to)) {
          const n = refusedHere(to);
          // Refused: the pointer says they cannot drop here, and the place says why.
          if (n) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "none";
          }
          if (refused !== n) setRefused(n);
          return;
        }
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (!over) setOver(true);
        if (refused) setRefused(0);
      },
      onDragLeave: (e: DragEvent) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setOver(false);
        setRefused(0);
      },
      onDrop: (e: DragEvent) => {
        setOver(false);
        setRefused(0);
        const ids = readIds(e);
        if (!ids || !handler) return;
        e.preventDefault();
        e.stopPropagation();
        if (!handler.accepts || handler.accepts(ids, to)) handler.drop(ids, to);
      },
    },
  };
}

/** How a place that takes dropped conversations shows that it would. */
export const dropOverCls = "bg-chrome-hover shadow-[inset_0_0_0_1px_var(--tone-blue-solid)]";

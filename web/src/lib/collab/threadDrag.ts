// Dragging conversations from the mail list onto a place that acts on them (GH#455): the
// sidebar's mail rows and the folder bar's tabs. The drag carries the conversations' ids under
// a type of its own; a row that takes them says where it leads (a box, an account's box, a
// folder or label), and the mail page that started the drag acts on them as its own buttons
// would, with the same toast and Undo (pages/mail/MailPage.tsx).

import { useState, type DragEvent } from "react";
import type { MailBox } from "../api/types";

export const THREAD_DRAG = "application/x-od-mail-threads";

/** Where conversations are dropped: what the row or tab under them opens. */
export type ThreadDropTarget = { box: MailBox | "folder"; account?: string; folder?: string };

/** Boxes that do something with conversations dropped on them: move them there, star them, assign them to the member. */
const DROP_BOXES: ReadonlySet<string> = new Set(["inbox", "starred", "archive", "spam", "trash", "needs_action", "assigned"]);

export function takesThreads(to: ThreadDropTarget): boolean {
  return to.box === "folder" ? !!to.folder : DROP_BOXES.has(to.box);
}

/** Whether a drag carries conversations (its data is readable only on drop). */
export const carriesThreads = (e: DragEvent) => e.dataTransfer.types.includes(THREAD_DRAG);

type Handler = (ids: string[], to: ThreadDropTarget) => void;
let handler: Handler | null = null;

/** The mail page takes the drops while its list shows; returns the cleanup. */
export function takeThreadDrops(fn: Handler): () => void {
  handler = fn;
  return () => {
    if (handler === fn) handler = null;
  };
}

/** Starts dragging conversations: the drag shows how many, as a small label by the pointer. */
export function startThreadDrag(e: DragEvent, ids: string[], label: string) {
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

/** Drop handlers for a row or tab leading to `to`, and whether conversations are over it. Inert for places that take none. */
export function useThreadDrop(to: ThreadDropTarget) {
  const [over, setOver] = useState(false);
  if (!takesThreads(to)) return { over: false, props: {} };
  return {
    over,
    props: {
      onDragOver: (e: DragEvent) => {
        if (!carriesThreads(e) || !handler) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (!over) setOver(true);
      },
      onDragLeave: (e: DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      },
      onDrop: (e: DragEvent) => {
        setOver(false);
        const ids = readIds(e);
        if (!ids || !handler) return;
        e.preventDefault();
        e.stopPropagation();
        handler(ids, to);
      },
    },
  };
}

/** How a place that takes dropped conversations shows that it would. */
export const dropOverCls = "bg-chrome-hover shadow-[inset_0_0_0_1px_var(--tone-blue-solid)]";

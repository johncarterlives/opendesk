// Dragging in the sidebar: in edit mode sections and rows move by their handle with the mouse,
// a finger or a pen (pointer events, so touch works without the HTML drag API); outside it,
// by the row or the section's title itself (`pressable`), past a few pixels or a finger's hold. While a drag
// runs, a small copy of the row follows the pointer, the target shows a line where it would
// land, and the sidebar scrolls when the pointer nears its top or bottom edge.
//
// The editor marks what can be dropped on: a section's block `data-edit-section="<key>"` with
// its header `data-edit-head`, each of its rows `data-edit-row="<key>"`. Which drops are
// allowed, and what a drop does, are the editor's (`accepts`, `onDrop`).

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

export type Drag<S> = { source: S; label: string; x: number; y: number };

/** Where a drag would land: between sections, or among a section's rows (before a row, or at the end). */
export type Target = { kind: "section"; before: string | null } | { kind: "row"; section: string; before: string | null };

const START_AT = 4; // px the pointer moves before a press becomes a drag
const EDGE = 36; // px from the scroller's edge where it starts to scroll
const STEP = 12; // px scrolled per frame at the edge
const HOLD_MS = 350; // a finger holds this long on a row before it drags it

const sameTarget = (a: Target | null, b: Target | null) =>
  a === b || (!!a && !!b && a.kind === b.kind && a.before === b.before && (a.kind === "section" || (b.kind === "row" && a.section === b.section)));

/**
 * Which drops a point names: for a section drag, the gap between headers; for a row drag, the gap
 * between the rows of the section under it, then of each section around that one (a group of rows
 * inside a section, as the Space editor has), innermost first.
 */
function targetsAt(root: HTMLElement, x: number, y: number, kind: "section" | "row"): Target[] {
  if (kind === "section") {
    // Only the sidebar's own sections: groups inside one (a teamspace under Pages) are not places a section goes.
    const blocks = [...root.querySelectorAll<HTMLElement>("[data-edit-section]")].filter((b) => {
      const outer = b.parentElement?.closest("[data-edit-section]");
      return !outer || !root.contains(outer);
    });
    for (const b of blocks) {
      const head = b.querySelector<HTMLElement>("[data-edit-head]") ?? b;
      const r = head.getBoundingClientRect();
      if (y <= r.top + r.height / 2) return [{ kind: "section", before: b.dataset.editSection ?? null }];
    }
    return [{ kind: "section", before: null }];
  }
  const out: Target[] = [];
  let el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-edit-section]") ?? null;
  while (el && root.contains(el)) {
    const section = el.dataset.editSection ?? "";
    // Its own rows: a nested section's rows are that section's.
    const rows = [...el.querySelectorAll<HTMLElement>("[data-edit-row]")].filter((r) => r.closest("[data-edit-section]") === el);
    const row = rows.find((r) => {
      const b = r.getBoundingClientRect();
      return y < b.top + b.height / 2;
    });
    out.push({ kind: "row", section, before: row?.dataset.editRow ?? null });
    el = el.parentElement?.closest<HTMLElement>("[data-edit-section]") ?? null;
  }
  return out;
}

export function useEditDrag<S extends { kind: "section" | "row" }>({
  root,
  accepts,
  onDrop,
}: {
  /** The editor's element, inside the sidebar's scroller. */
  root: React.RefObject<HTMLElement | null>;
  /** Whether a source may land on a target. */
  accepts: (source: S, target: Target) => boolean;
  onDrop: (source: S, target: Target) => void;
}) {
  const [drag, setDrag] = useState<Drag<S> | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const live = useRef<{ source: S; label: string; x0: number; y0: number; started: boolean; target: Target | null; y: number } | null>(null);
  const frame = useRef<number | null>(null);
  const handlers = useRef({ accepts, onDrop });
  handlers.current = { accepts, onDrop };

  const scroller = useCallback(() => root.current?.closest<HTMLElement>(".overflow-y-auto") ?? null, [root]);

  const retarget = useCallback(
    (x: number, y: number) => {
      const d = live.current;
      const el = root.current;
      if (!d || !el) return;
      const ok = targetsAt(el, x, y, d.source.kind).find((t) => handlers.current.accepts(d.source, t)) ?? null;
      if (!sameTarget(ok, d.target)) {
        d.target = ok;
        setTarget(ok);
      }
    },
    [root],
  );

  // Near the scroller's edge, it scrolls on each frame and the target follows.
  const tick = useCallback(() => {
    frame.current = null;
    const d = live.current;
    const sc = scroller();
    if (!d?.started || !sc) return;
    const r = sc.getBoundingClientRect();
    const dy = d.y < r.top + EDGE ? -STEP : d.y > r.bottom - EDGE ? STEP : 0;
    if (!dy) return;
    sc.scrollTop += dy;
    frame.current = requestAnimationFrame(tick);
  }, [scroller]);

  const end = useCallback(
    (commit: boolean) => {
      const d = live.current;
      live.current = null;
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      setDrag(null);
      setTarget(null);
      if (commit && d?.started && d.target) handlers.current.onDrop(d.source, d.target);
    },
    [],
  );

  useEffect(() => {
    if (!drag) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        end(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [drag, end]);

  /** The props of a handle that drags `source`. */
  const handle = (source: S, label: string) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* a pointer the browser no longer tracks: the drag still follows it on this element */
      }
      live.current = { source, label, x0: e.clientX, y0: e.clientY, started: false, target: null, y: e.clientY };
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      const d = live.current;
      if (!d) return;
      if (!d.started) {
        if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < START_AT) return;
        d.started = true;
      }
      d.y = e.clientY;
      setDrag({ source: d.source, label: d.label, x: e.clientX, y: e.clientY });
      retarget(e.clientX, e.clientY);
      if (frame.current === null) frame.current = requestAnimationFrame(tick);
    },
    onPointerUp: () => end(true),
    onPointerCancel: () => end(false),
    onLostPointerCapture: () => {
      if (live.current) end(true);
    },
    style: { touchAction: "none" as const },
  });

  // Pressing a row or a section's title outside edit mode: it stays a link or a button for a
  // click, and becomes a drag once the pointer moves a few pixels (a finger holds still first,
  // so the sidebar still scrolls under it). A drag swallows the click that would follow it.
  const press = useRef<{ stop: () => void } | null>(null);
  useEffect(() => () => press.current?.stop(), []);
  const pressable = (source: S, label: string) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0 || press.current) return;
      // Its own buttons (the ⋯, a fold chevron) and fields keep their pointer.
      const inner = (e.target as Element).closest("button, input, textarea, select, [data-no-drag]");
      if (inner && inner !== e.currentTarget && e.currentTarget.contains(inner)) return;
      const touch = e.pointerType !== "mouse";
      const id = e.pointerId;
      const x0 = e.clientX;
      const y0 = e.clientY;
      let armed = !touch;
      const hold = touch
        ? setTimeout(() => {
            armed = true;
            window.addEventListener("touchmove", block, { passive: false });
            navigator.vibrate?.(8);
          }, HOLD_MS)
        : undefined;
      // Once a finger has held, the page does not scroll under the drag.
      const block = (ev: TouchEvent) => ev.preventDefault();
      const move = (ev: PointerEvent) => {
        if (ev.pointerId !== id) return;
        if (!armed) {
          // A finger that moves before it held is scrolling: let it go.
          if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > START_AT * 2) stop();
          return;
        }
        if (!live.current) {
          if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < START_AT) return;
          live.current = { source, label, x0, y0, started: true, target: null, y: ev.clientY };
          document.getSelection()?.removeAllRanges();
          document.documentElement.classList.add("cursor-grabbing", "select-none");
        }
        const d = live.current;
        d.y = ev.clientY;
        setDrag({ source: d.source, label: d.label, x: ev.clientX, y: ev.clientY });
        retarget(ev.clientX, ev.clientY);
        if (frame.current === null) frame.current = requestAnimationFrame(tick);
      };
      const up = (ev: PointerEvent) => {
        if (ev.pointerId !== id) return;
        const dragged = !!live.current?.started;
        stop();
        if (!dragged) return;
        // The click the release would make lands on the row: it is not a click.
        const swallow = (c: MouseEvent) => {
          c.preventDefault();
          c.stopPropagation();
        };
        window.addEventListener("click", swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
        end(true);
      };
      const cancel = (ev: PointerEvent) => {
        if (ev.pointerId !== id) return;
        stop();
        end(false);
      };
      // A link's own drag would take the pointer away.
      const native = (ev: DragEvent) => ev.preventDefault();
      function stop() {
        clearTimeout(hold);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("touchmove", block);
        window.removeEventListener("dragstart", native, true);
        document.documentElement.classList.remove("cursor-grabbing", "select-none");
        press.current = null;
      }
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
      window.addEventListener("dragstart", native, true);
      press.current = { stop };
    },
  });

  return { drag, target, handle, pressable };
}

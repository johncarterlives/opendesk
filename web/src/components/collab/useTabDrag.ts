// Reordering a row of tabs by dragging them left and right, as the sidebar's rows are dragged
// (useEditDrag.ts): pointer events, so a mouse, a finger or a pen; a press stays a click on the tab
// until the pointer moves a few pixels (a finger holds still first, so the row still scrolls under it).
// The dragged tab follows the pointer and the others slide aside to show where it lands; the first
// `fixed` tabs stay where they are and nothing goes before them. It never uses the HTML drag API, so a
// conversation dragged onto a tab (threadDrag.ts) is never taken for a reorder, nor a reorder for one.
//
// Each tab's element is registered by its key (`slot`); the row is their parent, and positioned, so
// their offsets are in its content.

import { animate, useMotionValue, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { springs } from "@/lib/motion";

const START_AT = 4; // px the pointer moves before a press becomes a drag
const HOLD_MS = 350; // a finger holds this long on a tab before it drags it
const EDGE = 32; // px from the row's edge where it starts to scroll
const STEP = 8; // px scrolled per frame at the edge

type Live = { key: string; id: number; x0: number; scroll0: number; left0: number; cx: number; left: number; started: boolean };

export function useTabDrag({ keys, fixed, onDrop }: { keys: string[]; fixed: number; onDrop: (keys: string[]) => Promise<unknown> }) {
  const reduce = useReducedMotion();
  const x = useMotionValue(0);
  const els = useRef(new Map<string, HTMLElement>());
  const live = useRef<Live | null>(null);
  const frame = useRef<number | null>(null);
  const press = useRef<{ stop: () => void } | null>(null);
  // The order shown while a drag runs, and after a drop until the saved order arrives.
  const [order, setOrder] = useState<string[] | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const sig = keys.join("\n");
  const [prevSig, setPrevSig] = useState(sig);
  if (sig !== prevSig) {
    // The tabs changed (the saved order arrived, or another change): they show as they are.
    setPrevSig(sig);
    setOrder(null);
  }
  const shown = order ?? keys;
  const current = useRef(shown);
  current.current = shown;
  const handlers = useRef({ onDrop, keys });
  handlers.current = { onDrop, keys };
  /** Saves an order, shown until the saved one arrives (or a failure puts the old one back); a drag started since keeps its own. */
  const save = useCallback((next: string[]) => {
    setOrder(next);
    void handlers.current.onDrop(next).finally(() => {
      if (!live.current) setOrder(null);
    });
  }, []);

  const row = () => els.current.get(current.current[0])?.parentElement;

  /** Places the dragged tab under the pointer, between the fixed tabs and the end, and the others around it. */
  const follow = useCallback(() => {
    const d = live.current;
    const el = d && els.current.get(d.key);
    const r = row();
    if (!d?.started || !el || !r) return;
    const list = current.current;
    const lead = els.current.get(list[fixed - 1]);
    const gap = parseFloat(getComputedStyle(r).columnGap) || 0;
    const min = lead ? lead.offsetLeft + lead.offsetWidth + gap : 0;
    const end = Math.max(...list.map((k) => (els.current.get(k)?.offsetLeft ?? 0) + (els.current.get(k)?.offsetWidth ?? 0)));
    const left = Math.min(Math.max(d.left0 + d.cx - d.x0 + r.scrollLeft - d.scroll0, min), end - el.offsetWidth);
    d.left = left;
    x.set(left - el.offsetLeft);
    // It goes after every other tab whose middle it has passed (the slots are where tabs settle, not where they glide).
    const mid = left + el.offsetWidth / 2;
    const others = list.filter((k) => k !== d.key);
    let at = fixed;
    while (at < others.length) {
      const o = els.current.get(others[at]);
      if (!o || o.offsetLeft + o.offsetWidth / 2 > mid) break;
      at++;
    }
    const next = [...others.slice(0, at), d.key, ...others.slice(at)];
    if (next.join("\n") !== list.join("\n")) setOrder(next);
  }, [fixed, x]);

  // A new order moves the dragged tab's slot: it stays under the pointer.
  useLayoutEffect(() => {
    const d = live.current;
    const el = d?.started ? els.current.get(d.key) : null;
    if (d && el) x.set(d.left - el.offsetLeft);
  }, [order, x]);

  // Near the row's edge, it scrolls on each frame and the tab follows.
  const tick = useCallback(() => {
    frame.current = null;
    const d = live.current;
    const r = row();
    if (!d?.started || !r) return;
    const b = r.getBoundingClientRect();
    const dx = d.cx < b.left + EDGE ? -STEP : d.cx > b.right - EDGE ? STEP : 0;
    if (!dx || r.scrollWidth <= r.clientWidth) return;
    r.scrollLeft += dx;
    follow();
    frame.current = requestAnimationFrame(tick);
  }, [follow]);

  const end = useCallback(
    (commit: boolean) => {
      press.current?.stop();
      const d = live.current;
      live.current = null;
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      if (!d?.started) return;
      const next = current.current;
      const changed = commit && next.join("\n") !== handlers.current.keys.join("\n");
      if (changed) save(next);
      else setOrder(null);
      // It glides from under the pointer into its slot.
      if (reduce) {
        x.set(0);
        setDragging(null);
      } else void animate(x, 0, springs.row).then(() => setDragging((k) => (k === d.key && !live.current ? null : k)));
    },
    [reduce, save, x],
  );

  useEffect(() => {
    if (!dragging) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !live.current?.started) return;
      e.preventDefault();
      e.stopPropagation();
      end(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [dragging, end]);
  useEffect(() => () => press.current?.stop(), []);

  /** The props of a tab that may be dragged; its own click is a click until the pointer moves. */
  const pressable = (key: string) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0 || press.current || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const r = row();
      const el = els.current.get(key);
      if (!r || !el) return;
      const touch = e.pointerType !== "mouse";
      const id = e.pointerId;
      const d: Live = { key, id, x0: e.clientX, scroll0: r.scrollLeft, left0: el.offsetLeft, cx: e.clientX, left: el.offsetLeft, started: false };
      let armed = !touch;
      const y0 = e.clientY;
      // Once a finger has held, the row does not scroll under the drag.
      const block = (ev: TouchEvent) => ev.preventDefault();
      const hold = touch
        ? setTimeout(() => {
            armed = true;
            window.addEventListener("touchmove", block, { passive: false });
            navigator.vibrate?.(8);
          }, HOLD_MS)
        : undefined;
      const move = (ev: PointerEvent) => {
        if (ev.pointerId !== id) return;
        if (!armed) {
          // A finger that moves before it held is scrolling the row: let it go.
          if (Math.hypot(ev.clientX - d.x0, ev.clientY - y0) > START_AT * 2) stop();
          return;
        }
        d.cx = ev.clientX;
        if (!d.started) {
          if (Math.abs(ev.clientX - d.x0) < START_AT) return;
          d.started = true;
          live.current = d;
          x.set(0);
          setDragging(key);
          document.getSelection()?.removeAllRanges();
          document.documentElement.classList.add("cursor-grabbing", "select-none");
        }
        follow();
        if (frame.current === null) frame.current = requestAnimationFrame(tick);
      };
      const up = (ev: PointerEvent) => {
        if (ev.pointerId !== id) return;
        const dragged = d.started;
        stop();
        if (!dragged) return;
        // The click the release would make lands on the tab: it is not a click.
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
      // The link's own drag would take the pointer away.
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

  /** A tab's element, by its key. */
  const slot = (key: string) => (el: HTMLElement | null) => {
    if (el) els.current.set(key, el);
    else els.current.delete(key);
  };

  return { order: shown, dragging, x, pressable, slot, save, reduce: !!reduce };
}

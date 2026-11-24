import { useMemo, useRef, type RefObject } from "react";

/**
 * Keeps the command menu's highlight on its first item while results arrive. cmdk picks its first
 * item when the query changes, not when items that skip its filter (`forceMount`) mount later: the
 * app's settings hits show before a search's tickets arrive above them, and Enter would open the
 * setting. So whenever results change, the first item is highlighted again, until the reader moves
 * the highlight with the arrow keys; a new query hands it back.
 */
export function usePaletteHighlight(root: RefObject<HTMLElement | null>, setActive: (value: string) => void) {
  const moved = useRef(false);
  return useMemo(
    () => ({
      /** The query changed. */
      reset: () => {
        moved.current = false;
      },
      /** The input's keydown. */
      onKeyDown: (e: { key: string }) => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") moved.current = true;
      },
      /** Results changed. `onlyWhenNone`: fill an empty highlight but never move one (Ask AI). */
      pickFirst: (onlyWhenNone = false) => {
        const list = root.current;
        if (!list || (onlyWhenNone ? list.querySelector('[cmdk-item][aria-selected="true"]') : moved.current)) return;
        const first = list.querySelector('[cmdk-item]:not([aria-disabled="true"])')?.getAttribute("data-value");
        if (first) setActive(first);
      },
    }),
    [root, setActive],
  );
}

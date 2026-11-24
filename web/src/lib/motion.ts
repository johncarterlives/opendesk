// Motion tokens: one vocabulary for the whole app. Short (120-250ms), springy,
// subtle. Everything here is skipped or reduced to a fade under
// prefers-reduced-motion by the components that use it.

import type { Transition } from "motion/react";

export const ease = { out: [0.16, 1, 0.3, 1], in: [0.4, 0, 1, 1], inOut: [0.65, 0, 0.35, 1] } as const;
export const dur = { fast: 0.12, base: 0.18, slow: 0.25 } as const;

export const springs = {
  /** Indicators that glide (nav pill, tab underline, segmented thumb). */
  glide: { type: "spring", stiffness: 550, damping: 42, mass: 0.7 },
  /** Rows and cards entering or making room. */
  row: { type: "spring", stiffness: 500, damping: 40, mass: 0.8 },
  /** Overlays (dialogs, sheets, palette). */
  pop: { type: "spring", stiffness: 420, damping: 32, mass: 0.8 },
  /** Small things that bounce once (checks, badges). */
  snap: { type: "spring", stiffness: 700, damping: 28 },
} satisfies Record<string, Transition>;

/** A staggered entrance for a group of children. */
export const stagger = (each = 0.04, delay = 0) => ({ staggerChildren: each, delayChildren: delay });

/** How long a found setting stays highlighted (flash). */
export const FLASH_MS = 1800;

/**
 * Draws the eye to what the reader was sent to (a setting found by search): a soft
 * highlight that fades. Under reduced motion it shows still for the same time, then goes.
 */
export function flash(el: HTMLElement, reduced: boolean) {
  el.dataset.findFlash = reduced ? "still" : "on";
  window.setTimeout(() => {
    delete el.dataset.findFlash;
  }, FLASH_MS);
}

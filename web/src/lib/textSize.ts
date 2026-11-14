// How large the app reads, per browser like the theme (Settings → Profile → Appearance).
// Text sizes are set in pixels throughout, so this scales the whole interface, like the
// browser's own zoom but saved with the app. public/theme.js applies it before first paint.
//
// It is a CSS zoom on the app root and on the layers Radix portals to <body> (menus,
// popovers, dialogs), not on <html>: zooming <html> also scales the coordinates Radix
// places those layers with, which puts a menu hundreds of pixels from its trigger.

import { useSyncExternalStore } from "react";

export type TextSize = "default" | "large" | "larger";

export const TEXT_SIZE_ZOOM: Record<TextSize, number> = { default: 1, large: 1.125, larger: 1.25 };

const KEY = "od-text-size";
const listeners = new Set<() => void>();

function read(): TextSize {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "large" || v === "larger") return v;
  } catch {
    /* storage unavailable */
  }
  return "default";
}

let size = read();

export function applyTextSize(next: TextSize = size) {
  const root = document.documentElement;
  if (next === "default") {
    root.style.removeProperty("--od-zoom");
    delete root.dataset.textSize;
  } else {
    root.style.setProperty("--od-zoom", String(TEXT_SIZE_ZOOM[next]));
    root.dataset.textSize = next;
  }
}

export function setTextSize(next: TextSize) {
  size = next;
  try {
    if (next === "default") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch {
    /* storage unavailable */
  }
  applyTextSize(next);
  listeners.forEach((l) => l());
}

export function initTextSize() {
  applyTextSize();
  // Another tab changed it.
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY && e.key !== null) return;
    size = read();
    applyTextSize();
    listeners.forEach((l) => l());
  });
}

// Stable across renders, so a reader subscribes once.
function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function snapshot() {
  return size;
}

export function useTextSize(): TextSize {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

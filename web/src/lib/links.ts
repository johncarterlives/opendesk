// Places that open a ticket, a contact or a page render a real link (<a href>), so the
// browser's own ways of opening it elsewhere work: a right click's "Open in new tab", a
// Ctrl/Cmd or middle click, a drag to the tab bar. A plain click still opens it in place,
// through the router, as before.

import { useRouter, type NavigateOptions } from "@tanstack/react-router";
import { useCallback } from "react";
import { useSession } from "./session";
import { withWorkspaceParam } from "./workspaceParam";

type Click = { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; defaultPrevented: boolean };

/**
 * A click on a link that the browser handles itself: a new tab or window (Ctrl/Cmd,
 * Shift, the middle button), a download (Alt), or one a handler already took. Only a
 * plain click with the main button opens the link in place.
 */
export function browserClick(e: Click): boolean {
  return e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
}

/** Ctrl+Enter (⌘+Enter on a Mac): open the selected link in a new tab from the keyboard. */
export function newTabKey(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): boolean {
  return e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;
}

/** Opens an app href in a new tab, as a Ctrl/Cmd click on its link would. */
export function openInNewTab(href: string): void {
  window.open(href, "_blank", "noopener");
}

/** The href of a router destination, for a link that navigates with that destination in place. */
export function useHref(): (to: NavigateOptions) => string {
  const router = useRouter();
  const workspaceId = useSession((s) => s.workspaceId);
  return useCallback((to: NavigateOptions) => withWorkspaceParam(router.buildLocation(to).href, workspaceId), [router, workspaceId]);
}

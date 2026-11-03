import { Command } from "cmdk";
import { useRef, type ReactNode } from "react";
import { browserClick, newTabKey, openInNewTab } from "@/lib/links";

/**
 * A command palette item that goes to a page, as a real link (cmdk's asChild): a right
 * click, a Ctrl/Cmd, Shift or middle click open it where the browser does, the palette
 * staying open for the next one; a plain click and Enter run onSelect, which opens it here.
 * The option keeps the listbox's semantics and its aria-activedescendant focus: the link
 * never takes the focus itself (tabIndex -1).
 */
export function LinkItem({
  href,
  onSelect,
  value,
  keywords,
  forceMount,
  className,
  children,
}: {
  href: string;
  onSelect: () => void;
  value: string;
  keywords?: string[];
  forceMount?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const toBrowser = useRef(false);
  return (
    <Command.Item
      asChild
      value={value}
      keywords={keywords}
      forceMount={forceMount}
      className={className}
      onSelect={() => {
        if (toBrowser.current) toBrowser.current = false;
        else onSelect();
      }}
    >
      <a
        href={href}
        tabIndex={-1}
        onClick={(e) => {
          // Runs before cmdk's own click handler, which then selects the item.
          toBrowser.current = browserClick(e);
          if (!toBrowser.current) e.preventDefault();
        }}
      >
        {children}
      </a>
    </Command.Item>
  );
}

/**
 * Ctrl/Cmd+Enter in the palette's input: the selected item in a new tab when it is a link,
 * the palette staying open. True when it took the key (cmdk then skips its Enter); an item
 * that is not a link is left to run as on Enter.
 */
export function openSelectedInNewTab(e: React.KeyboardEvent, root: HTMLElement | null): boolean {
  if (!newTabKey(e)) return false;
  const selected = root?.querySelector('[cmdk-item][aria-selected="true"]');
  if (!(selected instanceof HTMLAnchorElement)) return false;
  e.preventDefault();
  openInNewTab(selected.href);
  return true;
}

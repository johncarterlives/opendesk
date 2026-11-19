import { Command } from "cmdk";
import { CircleHelp, LayoutPanelLeft, PencilRuler, Settings } from "lucide-react";
import type { ReactNode } from "react";
import type { AppHit } from "@/lib/appSearch";
import { LinkItem } from "./paletteLink";

export const itemCls =
  "flex h-9 cursor-default select-none items-center gap-2.5 rounded-md px-2.5 text-[13px] text-fg transition-colors duration-100 animate-item-in motion-reduce:animate-none data-[selected=true]:bg-hover [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-fg-3";
export const groupCls =
  "[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1.5 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:text-[11.5px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-fg-3";

export function Item({ children, onSelect, icon, hint, value, keywords, forceMount, href }: { children: ReactNode; onSelect: () => void; icon?: ReactNode; hint?: ReactNode; value: string; keywords?: string[]; forceMount?: boolean; href?: string }) {
  const body = (
    <>
      {icon}
      <span className="flex min-w-0 flex-1 items-center gap-2 truncate">{children}</span>
      {hint && <span className="shrink-0 text-xs text-fg-4">{hint}</span>}
    </>
  );
  // An item that goes to a page is a real link, which the browser can open in a new tab.
  if (href)
    return (
      <LinkItem href={href} value={value} keywords={keywords} onSelect={onSelect} forceMount={forceMount} className={itemCls}>
        {body}
      </LinkItem>
    );
  return (
    <Command.Item value={value} keywords={keywords} onSelect={onSelect} forceMount={forceMount} className={itemCls}>
      {body}
    </Command.Item>
  );
}

function hitIcon(h: AppHit) {
  if (h.kind === "doc") return <CircleHelp />;
  if (h.kind === "feature") return h.action === "newSpace" ? <LayoutPanelLeft /> : <PencilRuler />;
  return <Settings />;
}

/** A match of the app's own search: a setting, a place like the sidebar, or a docs page. */
export function HitItem({ hit, query, href, onSelect }: { hit: AppHit; query: string; href?: string; onSelect: () => void }) {
  return (
    <Item
      forceMount
      value={`app ${hit.id}`}
      // Matched by the app's own search: the query keeps it ranked with the rest.
      keywords={query ? [query] : undefined}
      icon={hitIcon(hit)}
      hint={<span className="block max-w-[38vw] truncate sm:max-w-[240px]">{hit.where.join(" / ")}</span>}
      href={href}
      onSelect={onSelect}
    >
      <span className="truncate">{hit.title}</span>
    </Item>
  );
}


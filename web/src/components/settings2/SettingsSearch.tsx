import { Command } from "cmdk";
import { Search } from "lucide-react";
import { useDeferredValue, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { LinkItem } from "@/app/paletteLink";
import { EmptyState } from "@/components/ui/empty";
import { cn } from "@/lib/cn";
import { useAppSearch, type AppHit } from "@/lib/appSearch";
import { useOpenHit } from "@/lib/appSearch/open";
import { useSettingsAccess } from "@/lib/settingsAccess";

const itemCls =
  "flex cursor-default select-none flex-col gap-px rounded-md px-2 py-1.5 outline-none transition-colors duration-100 data-[selected=true]:bg-hover";

/**
 * Search over every settings page's sections and fields (lib/appSearch), above the settings
 * nav. While it has words it lists what matches in place of the nav; Enter or a click opens
 * the page at that setting, and Escape clears it.
 */
export function SettingsSearch({ children, collapse, className }: { children?: ReactNode; collapse?: boolean; className?: string }) {
  const { t } = useTranslation("navigation");
  const [query, setQuery] = useState("");
  const [armed, setArmed] = useState(false);
  const words = useDeferredValue(query.trim());
  const access = useSettingsAccess({ cloud: !!query });
  const app = useAppSearch(words, { access, settings: armed || !!query, docs: false, limit: 30 });
  const openHit = useOpenHit();
  const link = (h: AppHit) => openHit(h, collapse ? () => setQuery("") : undefined);

  return (
    <>
      <Command shouldFilter={false} loop label={t("command.searchSettings")} className={className}>
        <div className="relative">
          <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-4" />
          <Command.Input
            value={query}
            onValueChange={setQuery}
            // The index loads as the field is reached, so the first words find something at once.
            onFocus={() => setArmed(true)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.preventDefault();
                e.stopPropagation();
                setQuery("");
              }
            }}
            placeholder={t("command.searchSettings")}
            className="h-8 w-full rounded-md border border-line bg-surface pl-8 pr-2 text-[12.5px] text-fg outline-none placeholder:text-fg-4 focus-visible:shadow-[0_0_0_2px_var(--focus)]"
          />
        </div>
        {words && (
          <Command.List className={cn("mt-2 animate-fade-in", collapse && "max-h-[50vh] overflow-y-auto")}>
            {app.settings.map((h) => {
              const where = h.where.slice(h.kind === "setting" ? 1 : 0);
              const { href, onSelect } = link(h);
              const body = (
                <>
                  <span className="truncate text-[12.5px] text-fg">{h.title}</span>
                  {where.length > 0 && <span className="truncate text-[11.5px] text-fg-3">{where.join(" / ")}</span>}
                </>
              );
              return href ? (
                <LinkItem key={h.id} href={href} value={h.id} onSelect={onSelect} className={itemCls}>
                  {body}
                </LinkItem>
              ) : (
                <Command.Item key={h.id} value={h.id} onSelect={onSelect} className={itemCls}>
                  {body}
                </Command.Item>
              );
            })}
            {!app.settings.length && !app.loading && (
              <EmptyState compact lit={2} title={t("command.settingsNoResults")} description={t("command.settingsNoResultsHelp")} />
            )}
          </Command.List>
        )}
      </Command>
      {!words && children}
    </>
  );
}

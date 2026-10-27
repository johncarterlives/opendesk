import { useQuery } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { useEffect, useReducer, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, TagChip } from "@/components/ui/badge";
import { Picker } from "@/components/ui/picker";
import { useBrands } from "@/components/settings2/teams";
import { cn } from "@/lib/cn";
import { fullDate } from "@/lib/format";
import { defaultHelpUrl, helpCenterHref } from "@/lib/helpCenter";
import { q } from "@/lib/queries";
import { useWorkspace } from "@/lib/session";
import { tone, toneFor } from "@/lib/tones";
import type { ChangelogEntry } from "@/lib/api/types";
import { addCategory, entryState, MAX_CATEGORIES, MAX_CATEGORY_LENGTH, type CategoryProblem, type EntryState } from "./changelog";

/** An entry's state, waking once at the moment a scheduled entry goes live. */
export function useEntryState(e: Pick<ChangelogEntry, "status" | "published_at">): EntryState {
  const [woken, wake] = useReducer((n: number) => n + 1, 0);
  const state = entryState(e);
  const at = state === "scheduled" && e.published_at ? Date.parse(e.published_at) : 0;
  useEffect(() => {
    if (!at) return;
    // setTimeout holds up to about 24 days; a later date wakes, finds it still ahead and waits again.
    const id = setTimeout(wake, Math.min(Math.max(at - Date.now(), 0) + 50, 2_000_000_000));
    return () => clearTimeout(id);
  }, [at, woken]);
  return state;
}

/** Draft, published or scheduled, each in its tone. */
export function EntryStatus({ entry }: { entry: Pick<ChangelogEntry, "status" | "published_at"> }) {
  const { t } = useTranslation("kb");
  const state = useEntryState(entry);
  if (state === "scheduled")
    return (
      <span title={entry.published_at ? fullDate(entry.published_at) : undefined} className="inline-flex">
        <Badge tone="blue" dot>
          {t("changelog.status.scheduled")}
        </Badge>
      </span>
    );
  return (
    <Badge tone={state === "published" ? "green" : "amber"} dot>
      {state === "published" ? t("status.published") : t("status.draft")}
    </Badge>
  );
}

/** An entry's categories as soft pills in their names' tones. */
export function CategoryPills({ names, className }: { names: string[]; className?: string }) {
  if (!names.length) return null;
  return (
    <span className={cn("flex min-w-0 flex-wrap items-center gap-1", className)}>
      {names.map((c) => (
        <TagChip key={c} name={c} />
      ))}
    </span>
  );
}

/**
 * The categories of an entry, edited as pills: pick one the workspace already uses or
 * type a new one. At most five, 32 characters each; another spelling of one already
 * there is refused.
 */
export function CategoryInput({ value, onChange, disabled }: { value: string[]; onChange: (v: string[]) => void; disabled?: boolean }) {
  const { t } = useTranslation("kb");
  const used = useQuery(q.changelogCategories());
  const [problem, setProblem] = useState<CategoryProblem | null>(null);
  const full = value.length >= MAX_CATEGORIES;
  const chosen = new Set(value.map((c) => c.toLowerCase()));
  const items = [
    ...value.map((c) => ({ value: c, label: c })),
    ...(used.data ?? []).filter((c) => !chosen.has(c.name.toLowerCase())).map((c) => ({ value: c.name, label: c.name, hint: String(c.count) })),
  ].map((i) => ({ ...i, icon: <span className={cn("size-2 rounded-xs", tone[toneFor(i.value)].solid)} /> }));

  const add = (name: string) => {
    const r = addCategory(value, name);
    if ("problem" in r) return setProblem(r.problem);
    setProblem(null);
    onChange(r.list);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {value.map((c) => (
          <span key={c} className={cn("inline-flex h-6 max-w-full items-center gap-1 rounded-sm pl-2 text-[12px] font-medium", tone[toneFor(c)].chip, disabled ? "pr-2" : "pr-0.5")}>
            <span className="truncate">{c}</span>
            {!disabled && (
              <button
                type="button"
                aria-label={t("changelog.categories.remove", { name: c })}
                onClick={() => {
                  setProblem(null);
                  onChange(value.filter((x) => x !== c));
                }}
                className="flex size-5 shrink-0 items-center justify-center rounded-xs opacity-60 transition-opacity hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10"
              >
                <X className="size-3" />
              </button>
            )}
          </span>
        ))}
        {!disabled && (
          <Picker
            multi
            items={items}
            values={value}
            onChange={(next) => {
              // A pick adds or removes one name; removing is always fine.
              const added = next.find((n) => !value.includes(n));
              if (added) add(added);
              else {
                setProblem(null);
                onChange(next);
              }
            }}
            onCreate={add}
            createLabel={t("changelog.categories.create")}
            placeholder={t("changelog.categories.search")}
            emptyText={t("changelog.categories.none")}
            trigger={
              <button
                type="button"
                disabled={full}
                className="inline-flex h-6 items-center gap-1 rounded-sm border border-dashed border-line-strong px-2 text-[12px] text-fg-3 transition-colors hover:border-fg-4 hover:text-fg disabled:pointer-events-none disabled:opacity-50"
              >
                <Plus className="size-3" />
                {value.length ? t("changelog.categories.add") : t("changelog.categories.addFirst")}
              </button>
            }
          />
        )}
        {disabled && !value.length && <span className="text-[12.5px] text-fg-4">{t("changelog.categories.empty")}</span>}
      </div>
      {problem ? (
        <p role="alert" className="text-xs text-danger-fg">
          {t(`changelog.categories.problem.${problem}`, { max: MAX_CATEGORIES, length: MAX_CATEGORY_LENGTH })}
        </p>
      ) : (
        !disabled && <p className="text-xs leading-[18px] text-fg-3">{t("changelog.categories.hint", { max: MAX_CATEGORIES })}</p>
      )}
    </div>
  );
}

/**
 * The help center that shows what a brand shows: the brand's own when it is on, else
 * for entries of every brand the default brand's. Null when there is none to open.
 */
export function useHelpBase(brandId: string | null | undefined): string | null {
  const ws = useWorkspace();
  const { brands, defaultBrand } = useBrands();
  const brand = brandId ? brands.find((b) => b.id === brandId) : undefined;
  const helpBrand = brand ?? defaultBrand;
  if (helpBrand?.help_center.enabled) return helpCenterHref(helpBrand);
  if (brand || !ws?.settings.help_center_enabled) return null;
  return helpBrand ? helpCenterHref(helpBrand) : defaultHelpUrl(ws.slug);
}

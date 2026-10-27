import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { BookOpen, ExternalLink, Plus, Tags } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { PageHeader } from "@/components/layout";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { EmptyState, GhostList } from "@/components/ui/empty";
import { SearchInput } from "@/components/ui/input";
import { Segmented } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { SinglePick } from "@/components/settings2/pickers";
import { useDebounced } from "@/components/contacts/hooks";
import { PresenceList, PresenceRow } from "@/components/motion";
import { KbBrandPick } from "@/components/kb/brand";
import { KbSwitch } from "@/components/kb/KbSwitch";
import type { EntryState } from "@/components/kb/changelog";
import { CategoryPills, EntryStatus, useHelpBase } from "@/components/kb/changelogBits";
import { useBrands } from "@/components/settings2/teams";
import { BrandChip } from "@/components/tickets/teams";
import { errorMessage } from "@/lib/api/client";
import { cn } from "@/lib/cn";
import { fullDate, shortDate } from "@/lib/format";
import { q } from "@/lib/queries";
import { atLeast, useRole } from "@/lib/session";
import { tone, toneFor } from "@/lib/tones";

const route = getRouteApi("/app/kb/changelog");

type StatusFilter = "all" | EntryState;
const ALL = "__all";

const cols =
  "grid items-center gap-4 grid-cols-[minmax(0,1fr)_96px] md:grid-cols-[minmax(0,2.4fr)_minmax(0,1.2fr)_96px_88px] xl:grid-cols-[minmax(0,2.4fr)_minmax(0,1.2fr)_96px_88px_minmax(0,1fr)]";
const md = "hidden md:flex";
const xl = "hidden xl:flex";

export default function ChangelogPage() {
  const { t } = useTranslation("kb");
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const canEdit = atLeast(useRole(), "agent");
  const [term, setTerm] = useState(search.q ?? "");
  const debounced = useDebounced(term, 250);

  useEffect(() => {
    if ((debounced || undefined) === search.q) return;
    void navigate({ search: (s) => ({ ...s, q: debounced || undefined }), replace: true });
  }, [debounced, search.q, navigate]);

  const { brands, multi: multiBrand } = useBrands();
  const brandOf = (id: string | null | undefined) => (id ? brands.find((b) => b.id === id) : undefined);
  const helpBase = useHelpBase(search.brand);
  const categories = useQuery(q.changelogCategories());
  const list = useInfiniteQuery(q.changelogEntries({ status: search.status, category: search.category, q: search.q, for_brand_id: search.brand }));
  const entries = list.data?.pages.flatMap((p) => p.data) ?? [];
  const filtered = !!(search.q || search.status || search.category);

  const newEntry = canEdit ? (
    <Button asChild variant="primary">
      <Link to="/kb/changelog/$entryId" params={{ entryId: "new" }}>
        <Plus className="size-3.5" />
        {t("changelog.new")}
      </Link>
    </Button>
  ) : undefined;

  const categoryItems = [
    { value: ALL, label: t("changelog.filter.allCategories"), icon: <Tags className="text-fg-3" /> },
    ...(categories.data ?? []).map((c) => ({ value: c.name, label: c.name, hint: String(c.count), icon: <span className={cn("size-2 rounded-xs", tone[toneFor(c.name)].solid)} /> })),
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title={t("title")}
        icon={<BookOpen />}
        actions={
          <>
            {helpBase && (
              <Button asChild variant="ghost" size="sm">
                <a href={`${helpBase}/changelog`} target="_blank" rel="noreferrer">
                  <ExternalLink className="size-3.5" />
                  {t("changelog.view")}
                </a>
              </Button>
            )}
            {newEntry}
          </>
        }
      >
        <KbSwitch />
      </PageHeader>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="sticky top-0 z-20 flex h-12 items-center gap-3 border-b border-line bg-surface px-4 md:px-5">
          <h2 className="min-w-0 truncate text-[13px] font-semibold tracking-[-0.01em]">{search.category ?? t("changelog.all")}</h2>
          {list.data && (
            <span className="mono text-[11px] tabular-nums text-fg-4">
              {entries.length}
              {list.hasNextPage ? "+" : ""}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {(multiBrand || search.brand) && (
              <KbBrandPick
                value={search.brand ?? null}
                onChange={(brand) => void navigate({ search: (s) => ({ ...s, brand: brand ?? undefined }) })}
                className="hidden max-w-[180px] md:flex"
                filter
              />
            )}
            {(!!categories.data?.length || search.category) && (
              <SinglePick
                items={categoryItems}
                value={search.category ?? ALL}
                onChange={(v) => void navigate({ search: (s) => ({ ...s, category: v === ALL ? undefined : v }) })}
                placeholder={t("changelog.filter.allCategories")}
                searchPlaceholder={t("changelog.categories.search")}
                className="hidden max-w-[180px] md:flex"
              />
            )}
            <Segmented<StatusFilter>
              size="xs"
              value={search.status ?? "all"}
              onChange={(v) => void navigate({ search: (s) => ({ ...s, status: v === "all" ? undefined : v }) })}
              options={[
                { value: "all", label: t("filter.all") },
                { value: "published", label: t("filter.published") },
                { value: "scheduled", label: t("changelog.filter.scheduled") },
                { value: "draft", label: t("filter.drafts") },
              ]}
            />
            <div className="hidden w-[220px] sm:block">
              <SearchInput value={term} onChange={setTerm} placeholder={t("changelog.search")} />
            </div>
          </div>
        </div>
        <div className={`${cols} sticky top-12 z-10 h-9 border-b border-line bg-surface px-4 md:px-5`}>
          <span className="label-caps">{t("changelog.col.update")}</span>
          <span className={`label-caps ${md}`}>{t("changelog.col.categories")}</span>
          <span className="label-caps">{t("col.status")}</span>
          <span className={`label-caps justify-end ${md}`}>{t("changelog.col.date")}</span>
          <span className={`label-caps ${xl}`}>{t("col.author")}</span>
        </div>

        {list.isLoading ? (
          <EntrySkeleton />
        ) : list.error ? (
          <EmptyState lit={3} title={t("changelog.error")} description={errorMessage(list.error)} action={<Button onClick={() => void list.refetch()}>{t("retry")}</Button>} />
        ) : !entries.length ? (
          filtered ? (
            <EmptyState
              className="min-h-[360px]"
              art="search"
              ghost={<GhostList rows={6} variant="table" />}
              title={search.q ? t("changelog.empty.noMatch") : t("changelog.empty.noneHere")}
              description={search.q ? t("empty.noMatchFor", { q: search.q }) : t("changelog.empty.noneHereHint")}
              action={
                <Button
                  onClick={() => {
                    setTerm("");
                    void navigate({ search: (s) => ({ ...s, q: undefined, status: undefined, category: undefined }) });
                  }}
                >
                  {t("clearFilters")}
                </Button>
              }
              tips={search.q ? [{ label: t("tips.spelling") }, { label: t("tips.fewerWords") }] : undefined}
            />
          ) : (
            <EmptyState
              className="min-h-[420px]"
              art="kb"
              ghost={<GhostList rows={6} variant="table" />}
              title={t("changelog.empty.title")}
              description={t("changelog.empty.description")}
              action={newEntry}
              tips={[{ label: t("changelog.tips.categories") }, { label: t("changelog.tips.schedule") }, { label: t("changelog.tips.api") }]}
            />
          )
        ) : (
          <div role="list" className="pb-10">
            <PresenceList>
              {entries.map((e) => {
                const pill = multiBrand ? brandOf(e.brand_id) : undefined;
                return (
                  <PresenceRow key={e.id}>
                    <div role="listitem">
                      <Link
                        to="/kb/changelog/$entryId"
                        params={{ entryId: e.id }}
                        className={`${cols} min-h-14 border-b border-line-soft px-4 py-2.5 transition-colors duration-100 hover:bg-sunken md:px-5`}
                      >
                        <span className="min-w-0">
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="truncate text-[13px] font-medium">{e.title || t("untitled")}</span>
                            {pill && <BrandChip brand={pill} />}
                          </span>
                          <span className="mt-0.5 block truncate text-xs text-fg-3">{e.excerpt || t("noExcerpt")}</span>
                        </span>
                        <span className={`min-w-0 overflow-hidden ${md}`}>
                          {e.categories.length ? <CategoryPills names={e.categories} className="flex-nowrap" /> : <span className="text-[12.5px] text-fg-4">–</span>}
                        </span>
                        <span>
                          <EntryStatus entry={e} />
                        </span>
                        <span className={`mono justify-end text-[11px] text-fg-3 ${md}`} title={e.published_at ? fullDate(e.published_at) : undefined}>
                          {e.published_at ? shortDate(e.published_at) : <span className="font-sans text-fg-4">{t("changelog.undated")}</span>}
                        </span>
                        <span className={`min-w-0 items-center gap-2 ${xl}`}>
                          {e.author ? (
                            <>
                              <Avatar name={e.author.name} src={e.author.avatar_url} size="sm" />
                              <span className="truncate text-[12.5px] text-fg-2">{e.author.name}</span>
                            </>
                          ) : (
                            <span className="text-fg-4">–</span>
                          )}
                        </span>
                      </Link>
                    </div>
                  </PresenceRow>
                );
              })}
            </PresenceList>
            {list.hasNextPage && (
              <div className="flex justify-center py-4">
                <Button variant="ghost" size="sm" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                  {t("changelog.loadMore")}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function EntrySkeleton() {
  const { t: ui } = useTranslation("ui");
  return (
    <div aria-busy="true" aria-label={ui("loading")}>
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className={`${cols} min-h-14 border-b border-line-soft px-4 py-2.5 md:px-5`} style={{ opacity: 1 - i * 0.09 }}>
          <span className="flex flex-col gap-2">
            <Skeleton className="h-2.5" style={{ width: `${40 + ((i * 17) % 35)}%` }} />
            <Skeleton className="h-2 opacity-60" style={{ width: `${55 + ((i * 13) % 30)}%` }} />
          </span>
          <span className={`gap-1 ${md}`}>
            <Skeleton className="h-4 w-12 rounded-sm" />
            {i % 2 === 0 && <Skeleton className="h-4 w-14 rounded-sm" />}
          </span>
          <Skeleton className="h-4 w-16 rounded-sm" />
          <Skeleton className={`ml-auto h-2.5 w-12 ${md}`} />
          <Skeleton className={`h-2.5 w-24 ${xl}`} />
        </div>
      ))}
    </div>
  );
}

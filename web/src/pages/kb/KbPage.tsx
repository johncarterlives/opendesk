import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { BookOpen, ExternalLink, Folder, FolderPlus, Library, MoreHorizontal, Pencil, Plus, Settings2, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { PageHeader, Stat, StatStrip } from "@/components/layout";
import { Avatar } from "@/components/ui/avatar";
import { ArticleStatus } from "@/components/kb/ArticleStatus";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState, GhostGrid, GhostList } from "@/components/ui/empty";
import { Field, SearchInput, Textarea, TextInput } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Segmented } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirm } from "@/components/ui/confirm";
import { toast } from "@/components/ui/toast";
import { useDebounced } from "@/components/contacts/hooks";
import { api } from "@/lib/api/endpoints";
import { errorMessage } from "@/lib/api/client";
import type { KbCollection } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { compact, fullDate, relShort } from "@/lib/format";
import { tone, type Tone } from "@/lib/tones";
import { collectionTone } from "@/components/kb/tone";
import { AnimatedNumber, PresenceList, PresenceRow } from "@/components/motion";
import { q, qk, removeFromList, upsertInList } from "@/lib/queries";
import { atLeast, useRole, useWorkspace } from "@/lib/session";
import { useAI } from "@/lib/ai";
import { useTranslation } from "react-i18next";
import { AiIcon, AiTooltip } from "@/components/ai/bits";
import { requestKbDraft } from "@/components/ai/kbDraftIntent";
import { articleBrandId, KbBrandPick } from "@/components/kb/brand";
import { KbSwitch } from "@/components/kb/KbSwitch";
import { useBrands } from "@/components/settings2/teams";
import { defaultHelpUrl, helpCenterHref } from "@/lib/helpCenter";
import { BrandChip } from "@/components/tickets/teams";
import type { Brand } from "@/lib/api/types";

const route = getRouteApi("/app/kb");

type StatusFilter = "all" | "published" | "draft";

const cols =
  "grid items-center gap-4 grid-cols-[minmax(0,1fr)_96px] md:grid-cols-[minmax(0,2.4fr)_minmax(0,1fr)_96px_72px] xl:grid-cols-[minmax(0,2.4fr)_minmax(0,1fr)_96px_72px_minmax(0,1fr)_64px]";
const md = "hidden md:flex";
const xl = "hidden xl:flex";

export default function KbPage() {
  const { t } = useTranslation("kb");
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const ws = useWorkspace();
  const role = useRole();
  const canEdit = atLeast(role, "agent");
  const canConfigure = atLeast(role, "admin");
  const [term, setTerm] = useState(search.q ?? "");
  const debounced = useDebounced(term, 250);
  const [editing, setEditing] = useState<KbCollection | "new" | null>(null);

  useEffect(() => {
    if ((debounced || undefined) === search.q) return;
    void navigate({ search: (s) => ({ ...s, q: debounced || undefined }), replace: true });
  }, [debounced, search.q, navigate]);

  const { brands, multi: multiBrand, defaultBrand } = useBrands();
  const brandOf = (id: string | null | undefined) => (id ? brands.find((b) => b.id === id) : undefined);
  // A brand filter shows what that brand's help center shows: its own and the shared.
  const brandFilter = brandOf(search.brand);
  const collections = useQuery(q.kbCollections());
  const articles = useQuery(q.kbArticles({ collection_id: search.collection, status: search.status, q: search.q, for_brand_id: search.brand }));
  const all = useQuery(q.kbArticles({ for_brand_id: search.brand }));
  const sorted = [...(collections.data ?? [])]
    .filter((c) => !search.brand || !c.brand_id || c.brand_id === search.brand)
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  // A pill names the brand of a collection or article that belongs to one, once there are two brands.
  const pillFor = (id: string | null | undefined) => (multiBrand ? brandOf(id) : undefined);
  const helpBrand = brandFilter ?? defaultBrand;
  const helpHref = helpBrand?.help_center.enabled
    ? helpCenterHref(helpBrand)
    : !brandFilter && ws?.settings.help_center_enabled
      ? helpBrand
        ? helpCenterHref(helpBrand)
        : defaultHelpUrl(ws.slug)
      : null;
  const current = sorted.find((c) => c.id === search.collection);
  const collectionName = (id: string | null) => sorted.find((c) => c.id === id)?.name;
  const everything = all.data ?? [];
  const published = everything.filter((a) => a.status === "published");
  const views = published.reduce((n, a) => n + a.views, 0);
  const top = [...published].sort((a, b) => b.views - a.views)[0];
  const viewsBy = (cid: string) => everything.filter((a) => a.collection_id === cid && a.status === "published").reduce((n, a) => n + a.views, 0);
  const draftsBy = (cid: string) => everything.filter((a) => a.collection_id === cid && a.status === "draft").length;

  const newArticle = canEdit ? (
    <Button asChild variant="primary">
      <Link to="/kb/articles/$articleId" params={{ articleId: "new" }} search={{ collection: search.collection }}>
        <Plus className="size-3.5" />
        {t("newArticle")}
      </Link>
    </Button>
  ) : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title={t("title")}
        icon={<BookOpen />}
        actions={
          <>
            {helpHref && (
              <Button asChild variant="ghost" size="sm">
                <a href={helpHref} target="_blank" rel="noreferrer">
                  <ExternalLink className="size-3.5" />
                  {t("viewHelpCenter")}
                </a>
              </Button>
            )}
            {canConfigure && helpBrand && (
              // The help center's address, custom domain and look live on its brand.
              <Button asChild variant="ghost" size="sm">
                <Link to="/settings/brands/$brandId" params={{ brandId: helpBrand.id }} search={{ tab: "help" }}>
                  <Settings2 className="size-3.5" />
                  {t("helpCenterSettings")}
                </Link>
              </Button>
            )}
            {canEdit && <DraftFromTicketsLink collection={search.collection} />}
            {newArticle}
          </>
        }
      >
        <KbSwitch />
      </PageHeader>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {all.data && everything.length > 0 && (
          <StatStrip>
            <Stat label={t("stat.articles")} value={<AnimatedNumber value={everything.length} />} sub={t("stat.inCollections", { count: sorted.length })} />
            <Stat label={t("stat.published")} value={<AnimatedNumber value={published.length} />} sub={t("stat.live")} />
            <Stat label={t("stat.drafts")} value={<AnimatedNumber value={everything.length - published.length} />} sub={t("stat.notLive")} />
            <Stat label={t("stat.views")} value={<AnimatedNumber value={views} />} sub={top ? t("stat.top", { title: top.title }) : t("stat.noViews")} />
          </StatStrip>
        )}

        <section className="px-4 pb-5 pt-4 md:px-5">
          <div className="mb-3 flex h-7 items-center gap-2">
            <h2 className="label-caps">{t("collections")}</h2>
            <span className="mono text-[10.5px] tabular-nums text-fg-4">{sorted.length}</span>
            {canEdit && (
              <Button size="xs" variant="ghost" className="ml-auto" icon={<FolderPlus className="size-3.5" />} onClick={() => setEditing("new")}>
                {t("newCollection")}
              </Button>
            )}
          </div>
          <nav aria-label={t("collections")} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            <CollectionTile
              active={!search.collection}
              name={t("allArticles")}
              description={t("allArticlesHint")}
              count={everything.length}
              views={views}
              collection={undefined}
              icon={<Library />}
              hue="gray"
            />
            {collections.isLoading
              ? [0, 1, 2].map((i) => (
                  <div key={i} className="flex h-[118px] flex-col gap-3 rounded-lg border border-line p-4">
                    <Skeleton className="size-7 rounded-md" />
                    <Skeleton className="h-3 w-1/2" />
                    <Skeleton className="h-2.5 w-3/4 opacity-60" />
                  </div>
                ))
              : sorted.map((c) => (
                  <div key={c.id} className="group/c relative">
                    <CollectionTile
                      active={search.collection === c.id}
                      name={c.name}
                      description={c.description}
                      count={c.article_count}
                      drafts={draftsBy(c.id)}
                      views={viewsBy(c.id)}
                      collection={c.id}
                      icon={<Folder />}
                      hue={collectionTone(sorted, c.id)}
                      brand={pillFor(c.brand_id)}
                    />
                    {canEdit && (
                      <CollectionMenu
                        c={c}
                        onRename={() => setEditing(c)}
                        onDeleted={() => search.collection === c.id && void navigate({ search: (s) => ({ ...s, collection: undefined }) })}
                      />
                    )}
                  </div>
                ))}
          </nav>
        </section>

        <div className="sticky top-0 z-20 flex h-12 items-center gap-3 border-y border-line bg-surface px-4 md:px-5">
          <h2 className="min-w-0 truncate text-[13px] font-semibold tracking-[-0.01em]">{current?.name ?? t("allArticles")}</h2>
          {articles.data && <span className="mono text-[11px] tabular-nums text-fg-4">{articles.data.length}</span>}
          <div className="ml-auto flex items-center gap-2">
            {(multiBrand || search.brand) && (
              <KbBrandPick
                value={search.brand ?? null}
                onChange={(brand) => void navigate({ search: (s) => ({ ...s, brand: brand ?? undefined }) })}
                className="max-w-[180px]"
                filter
              />
            )}
            <Segmented<StatusFilter>
              size="xs"
              value={search.status ?? "all"}
              onChange={(v) => void navigate({ search: (s) => ({ ...s, status: v === "all" ? undefined : v }) })}
              options={[
                { value: "all", label: t("filter.all") },
                { value: "published", label: t("filter.published") },
                { value: "draft", label: t("filter.drafts") },
              ]}
            />
            <div className="hidden w-[240px] sm:block">
              <SearchInput value={term} onChange={setTerm} placeholder={t("searchArticles")} />
            </div>
          </div>
        </div>
        <div className={`${cols} sticky top-12 z-10 h-9 border-b border-line bg-surface px-4 md:px-5`}>
          <span className="label-caps">{t("col.title")}</span>
          <span className={`label-caps ${md}`}>{t("col.collection")}</span>
          <span className="label-caps">{t("col.status")}</span>
          <span className={`label-caps justify-end ${md}`}>{t("col.views")}</span>
          <span className={`label-caps ${xl}`}>{t("col.author")}</span>
          <span className={`label-caps justify-end ${xl}`}>{t("col.updated")}</span>
        </div>

        {articles.isLoading ? (
          <ArticleSkeleton />
        ) : articles.error ? (
          <EmptyState lit={3} title={t("error.title")} description={errorMessage(articles.error)} action={<Button onClick={() => void articles.refetch()}>{t("retry")}</Button>} />
        ) : !articles.data?.length ? (
          search.q || search.status ? (
            <EmptyState
              className="min-h-[360px]"
              art="search"
              ghost={<GhostList rows={6} variant="table" />}
              title={search.q ? t("empty.noMatch") : t("empty.noDrafts")}
              description={search.q ? t("empty.noMatchFor", { q: search.q }) : t("empty.noDraftsHint")}
              action={
                <Button
                  onClick={() => {
                    setTerm("");
                    void navigate({ search: (s) => ({ ...s, q: undefined, status: undefined }) });
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
              ghost={<GhostGrid cards={6} />}
              title={current ? t("empty.collectionTitle") : t("empty.title")}
              description={t("empty.description")}
              action={newArticle}
              secondary={canEdit ? <DraftFromTicketsLink collection={search.collection} /> : undefined}
              tips={[{ label: t("tips.collections") }, { label: t("tips.publish") }]}
            />
          )
        ) : (
          <div role="list" className="pb-10">
            <PresenceList>
              {articles.data.map((a) => {
                const cname = collectionName(a.collection_id);
                const pill = pillFor(articleBrandId(a, collections.data));
                return (
                  <PresenceRow key={a.id}>
                  <div role="listitem">
                    <Link
                      to="/kb/articles/$articleId"
                      params={{ articleId: a.id }}
                      search={{ collection: undefined }}
                      className={`${cols} min-h-14 border-b border-line-soft px-4 py-2.5 transition-colors duration-100 hover:bg-sunken md:px-5`}
                    >
                      <span className="min-w-0">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-[13px] font-medium">{a.title || t("untitled")}</span>
                          {pill && <BrandChip brand={pill} />}
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-fg-3">{a.excerpt || t("noExcerpt")}</span>
                      </span>
                      <span className={`min-w-0 items-center gap-2 ${md}`}>
                        {cname ? (
                          <>
                            <span className={cn("size-2 shrink-0 rounded-xs", tone[collectionTone(sorted, a.collection_id)].solid)} />
                            <span className="truncate text-[12.5px] text-fg-2">{cname}</span>
                          </>
                        ) : (
                          <span className="text-[12.5px] text-fg-4">{t("noCollection")}</span>
                        )}
                      </span>
                      <span>
                        <ArticleStatus status={a.status} />
                      </span>
                      <span className={`mono justify-end text-xs tabular-nums text-fg-2 ${md}`}>{a.status === "published" ? compact(a.views) : <span className="text-fg-4">–</span>}</span>
                      <span className={`min-w-0 items-center gap-2 ${xl}`}>
                        {a.author ? (
                          <>
                            <Avatar name={a.author.name} src={a.author.avatar_url} size="sm" />
                            <span className="truncate text-[12.5px] text-fg-2">{a.author.name}</span>
                          </>
                        ) : (
                          <span className="text-fg-4">–</span>
                        )}
                      </span>
                      <span className={`mono justify-end text-[11px] text-fg-3 ${xl}`} title={fullDate(a.updated_at)}>
                        {relShort(a.updated_at)}
                      </span>
                    </Link>
                  </div>
                  </PresenceRow>
                );
              })}
            </PresenceList>
          </div>
        )}
      </div>

      <CollectionDialog
        value={editing}
        newBrand={search.brand ?? null}
        showBrand={multiBrand}
        onClose={() => setEditing(null)}
        onCreated={(id) => void navigate({ search: (s) => ({ ...s, collection: id }) })}
      />
    </div>
  );
}

function ArticleSkeleton() {
  const { t: ui } = useTranslation("ui");
  return (
    <div aria-busy="true" aria-label={ui("loading")}>
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className={`${cols} min-h-14 border-b border-line-soft px-4 py-2.5 md:px-5`} style={{ opacity: 1 - i * 0.09 }}>
          <span className="flex flex-col gap-2">
            <Skeleton className="h-2.5" style={{ width: `${40 + ((i * 17) % 35)}%` }} />
            <Skeleton className="h-2 opacity-60" style={{ width: `${55 + ((i * 13) % 30)}%` }} />
          </span>
          <Skeleton className={`h-2.5 w-20 ${md}`} />
          <Skeleton className="h-4 w-16 rounded-sm" />
          <Skeleton className={`ml-auto h-2.5 w-8 ${md}`} />
          <Skeleton className={`h-2.5 w-24 ${xl}`} />
          <Skeleton className={`ml-auto h-2.5 w-8 ${xl}`} />
        </div>
      ))}
    </div>
  );
}

function CollectionTile({
  active,
  name,
  description,
  count,
  drafts,
  views,
  icon,
  hue,
  collection,
  brand,
}: {
  active: boolean;
  name: string;
  description: string;
  count: number;
  drafts?: number;
  views: number;
  icon: React.ReactNode;
  hue: Tone;
  collection: string | undefined;
  /** The one brand it belongs to, as a pill. */
  brand?: Brand;
}) {
  const { t } = useTranslation("kb");
  return (
    <Link
      from="/kb"
      to="/kb"
      search={(s) => ({ ...s, collection })}
      aria-current={active ? "true" : undefined}
      className={cn(
        "flex h-full min-h-[118px] flex-col rounded-lg border bg-surface p-4 transition-[border-color,box-shadow,background-color] duration-150 active:scale-[0.995] motion-reduce:active:scale-100",
        active ? "border-fg-3 shadow-xs" : "border-line hover:border-line-strong hover:bg-sunken/50",
      )}
    >
      <span className="flex items-center gap-2.5 pr-6">
        <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-md [&_svg]:size-3.5", tone[hue].chip)}>{icon}</span>
        <span className="min-w-0 truncate text-[13px] font-semibold tracking-[-0.01em] text-fg">{name}</span>
        {brand && <BrandChip brand={brand} className="ml-auto" />}
      </span>
      <span className="mt-2 line-clamp-2 text-xs leading-[18px] text-fg-3">{description || t("noDescription")}</span>
      <span className="mt-auto flex items-center gap-3 pt-3 text-[11px] text-fg-4">
        <span className="mono tabular-nums">{t("articleCount", { count })}</span>
        {!!drafts && <span className="mono tabular-nums text-tone-amber">{t("draftCount", { count: drafts })}</span>}
        <span className="mono ml-auto tabular-nums">{t("viewCount", { count: views, n: compact(views) })}</span>
      </span>
    </Link>
  );
}

function CollectionMenu({ c, onRename, onDeleted }: { c: KbCollection; onRename: () => void; onDeleted: () => void }) {
  const { t } = useTranslation("kb");
  const qc = useQueryClient();
  const confirm = useConfirm();
  const remove = useMutation({
    mutationFn: () => api.kb.collections.remove(c.id),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: qk.kbCollections });
      const prev = qc.getQueryData(qk.kbCollections);
      removeFromList(qc, qk.kbCollections, c.id);
      onDeleted();
      return { prev };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.kbCollections, ctx.prev);
      toast.error(e);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.kbArticleLists }),
  });
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label={t("collection.options", { name: c.name })}
          className="absolute right-3 top-3.5 flex size-6 items-center justify-center rounded-md text-fg-3 opacity-100 transition-opacity hover:bg-hover hover:text-fg data-[state=open]:opacity-100 md:opacity-0 md:group-hover/c:opacity-100 focus-visible:opacity-100"
        >
          <MoreHorizontal className="size-3.5" />
        </button>
      </MenuTrigger>
      <MenuContent align="start">
        <MenuItem icon={<Pencil />} onSelect={onRename}>
          {t("collection.rename")}
        </MenuItem>
        <MenuItem
          danger
          icon={<Trash2 />}
          onSelect={() =>
            confirm.show(
              c.article_count ? t("collection.deleteBody", { count: c.article_count }) : t("collection.deleteEmpty"),
              () => remove.mutateAsync(),
              { title: t("collection.deleteTitle", { name: c.name }), confirmLabel: t("collection.deleteConfirm"), danger: true },
            )
          }
        >
          {t("collection.delete")}
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

function CollectionDialog({
  value,
  newBrand,
  showBrand,
  onClose,
  onCreated,
}: {
  value: KbCollection | "new" | null;
  /** A new collection starts in this brand (the list's brand filter), or shared. */
  newBrand: string | null;
  /** Brand pickers show once the workspace has a second brand. */
  showBrand: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { t } = useTranslation("kb");
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [brandId, setBrandId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isNew = value === "new";

  useEffect(() => {
    if (!value) return;
    setError(null);
    setName(value === "new" ? "" : value.name);
    setDescription(value === "new" ? "" : value.description);
    setBrandId(value === "new" ? newBrand : (value.brand_id ?? null));
    // The brand is read when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const brandField = showBrand || !!brandId;

  const save = useMutation({
    mutationFn: () =>
      isNew
        ? api.kb.collections.create({ name: name.trim(), description: description.trim(), ...(brandField ? { brand_id: brandId } : {}) })
        : api.kb.collections.update((value as KbCollection).id, { name: name.trim(), description: description.trim(), ...(brandField ? { brand_id: brandId } : {}) }),
    onSuccess: (c) => {
      upsertInList(qc, qk.kbCollections, c);
      toast.success(isNew ? t("collection.created") : t("collection.saved"));
      // An article's brand follows its collection's.
      if (!isNew) void qc.invalidateQueries({ queryKey: qk.kbArticleLists });
      onClose();
      if (isNew) onCreated(c.id);
    },
    onError: (e) => setError(errorMessage(e)),
  });

  return (
    <Dialog
      open={!!value}
      onOpenChange={(o) => !o && onClose()}
      title={isNew ? t("newCollection") : t("collection.edit")}
      size="sm"
      footer={
        <>
          {error && (
            <p role="alert" className="mr-auto text-xs text-danger-fg">
              {error}
            </p>
          )}
          <Button variant="ghost" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button variant="primary" type="submit" form="kb-collection" loading={save.isPending}>
            {isNew ? t("collection.create") : t("collection.save")}
          </Button>
        </>
      }
    >
      <form
        id="kb-collection"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return setError(t("collection.nameRequired"));
          save.mutate();
        }}
      >
        <Field label={t("collection.name")}>{(p) => <TextInput {...p} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t("collection.namePlaceholder")} />}</Field>
        <Field label={t("collection.description")} optional hint={t("collection.descriptionHint")}>
          {(p) => <Textarea {...p} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />}
        </Field>
        {brandField && (
          <Field label={t("brand.label")} hint={t("brand.collectionHint")}>
            {() => <KbBrandPick value={brandId} onChange={setBrandId} size="md" className="w-full" />}
          </Field>
        )}
      </form>
    </Dialog>
  );
}

/** Opens a new article with the AI draft dialog already up. */
function DraftFromTicketsLink({ collection }: { collection?: string }) {
  const ai = useAI();
  const { t } = useTranslation("ai");
  if (!ai.enabled) return null;
  return (
    <AiTooltip feature="kb_draft" label={t("kb_draft.tooltip")}>
      <Button asChild variant="ghost" size="sm">
        <Link to="/kb/articles/$articleId" params={{ articleId: "new" }} search={{ collection }} onClick={requestKbDraft}>
          <AiIcon />
          {t("kb_draft.button")}
        </Link>
      </Button>
    </AiTooltip>
  );
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useBlocker, useNavigate } from "@tanstack/react-router";
import type { Editor } from "@tiptap/react";
import { Check, ChevronDown, ChevronRight, ExternalLink, Eye, Folder, MoreHorizontal, Trash2, Undo2 } from "lucide-react";
import { useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { BackLink } from "@/components/layout";
import { RichEditor, Toolbar, type RichEditorHandle } from "@/components/editor/RichEditor";
import { Avatar } from "@/components/ui/avatar";
import { ArticleStatus } from "@/components/kb/ArticleStatus";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty";
import { TextInput } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Picker } from "@/components/ui/picker";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Morph } from "@/components/motion";
import { Tooltip } from "@/components/ui/tooltip";
import { useConfirm } from "@/components/ui/confirm";
import { toast } from "@/components/ui/toast";
import { useDocumentTitle } from "@/app/RootLayout";
import { usePageCrumb } from "@/app/useBreadcrumbs";
import { api } from "@/lib/api/endpoints";
import { errorMessage } from "@/lib/api/client";
import type { KbArticle } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { compact, fullDate, relLong, shortDate } from "@/lib/format";
import { tone } from "@/lib/tones";
import { collectionTone } from "@/components/kb/tone";
import { q, qk } from "@/lib/queries";
import { atLeast, useRole, useWorkspace } from "@/lib/session";
import { slugify } from "@/components/kb/slug";
import { AiIcon, AiTooltip } from "@/components/ai/bits";
import { KbDraftDialog } from "@/components/ai/KbDraftDialog";
import { takeKbDraftRequest } from "@/components/ai/kbDraftIntent";
import { useAI } from "@/lib/ai";
import type { KBArticleDraft } from "@/lib/api/types";
import { articleBrandId, KbBrandPick } from "@/components/kb/brand";
import { useBrands } from "@/components/settings2/teams";
import { defaultHelpUrl, helpCenterHref } from "@/lib/helpCenter";
import { BrandChip } from "@/components/tickets/teams";
import { useTranslation } from "react-i18next";

const route = getRouteApi("/app/kb/articles/$articleId");

type Draft = { title: string; excerpt: string; slug: string; collection_id: string | null; body_html: string; brand_id: string | null };

const same = (a: Draft, b: Draft) =>
  a.title === b.title && a.excerpt === b.excerpt && a.slug === b.slug && a.collection_id === b.collection_id && a.body_html === b.body_html && a.brand_id === b.brand_id;

const WIDE = "(min-width: 1280px)";
function useWide() {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(WIDE);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(WIDE).matches,
    () => false,
  );
}

export default function ArticleEditor() {
  const { t } = useTranslation("kb");
  const { articleId } = route.useParams();
  const isNew = articleId === "new";
  const article = useQuery({ ...q.kbArticle(articleId), enabled: !isNew });

  if (!isNew && article.isLoading)
    return (
      <div className="mx-auto w-full max-w-[720px] px-6 pt-20">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="mt-4 h-3 w-1/2" />
        <Skeleton className="mt-10 h-3 w-full" />
        <Skeleton className="mt-3 h-3 w-5/6" />
        <Skeleton className="mt-3 h-3 w-4/6" />
      </div>
    );
  if (!isNew && (article.error || !article.data))
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState lit={3} title={t("editor.notFound")} description={article.error ? errorMessage(article.error) : undefined} />
      </div>
    );
  return <EditorScreen key={articleId} article={isNew ? null : article.data!} />;
}

function EditorScreen({ article }: { article: KbArticle | null }) {
  const { t: ui } = useTranslation("ui");
  const { t } = useTranslation("kb");
  const wide = useWide();
  const search = route.useSearch();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const ws = useWorkspace();
  const canEdit = atLeast(useRole(), "agent");
  const collections = useQuery(q.kbCollections());

  const initial: Draft = useMemo(
    () => ({
      title: article?.title ?? "",
      excerpt: article?.excerpt ?? "",
      slug: article?.slug ?? "",
      collection_id: article ? article.collection_id : (search.collection ?? null),
      body_html: article?.body_html ?? "",
      brand_id: article?.brand_id ?? null,
    }),
    // The baseline is the article as loaded; later saves move it explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [saved, setSaved] = useState<Draft>(initial);
  // A new article may arrive with a title (a knowledge gap from the agent report); it counts as an unsaved edit.
  const [draft, setDraft] = useState<Draft>(() => (!article && search.title ? { ...initial, title: search.title, slug: slugify(search.title) } : initial));
  const [status, setStatus] = useState<KbArticle["status"]>(article?.status ?? "draft");
  const [current, setCurrent] = useState<KbArticle | null>(article);
  const [slugTouched, setSlugTouched] = useState(!!article);
  const [advanced, setAdvanced] = useState(false);
  const dirty = !same(draft, saved);
  useDocumentTitle(draft.title || (current ? t("untitled") : t("newArticle")));
  usePageCrumb(saved.title || (current ? t("untitled") : t("newArticle")));

  const set = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));

  const save = useMutation({
    mutationFn: (nextStatus: KbArticle["status"]) => {
      const body = {
        title: draft.title.trim() || "Untitled",
        excerpt: draft.excerpt.trim(),
        slug: (draft.slug || slugify(draft.title)) || undefined,
        // On update an empty string takes the article out of its collection (null means "unchanged").
        collection_id: current ? (draft.collection_id ?? "") : draft.collection_id,
        body_html: draft.body_html,
        status: nextStatus,
        ...(showBrand ? { brand_id: draft.brand_id } : {}),
      };
      return current ? api.kb.articles.update(current.id, body) : api.kb.articles.create(body);
    },
    onSuccess: (a, nextStatus) => {
      const wasNew = !current;
      qc.setQueryData(qk.kbArticle(a.id), a);
      void qc.invalidateQueries({ queryKey: qk.kbArticleLists });
      void qc.invalidateQueries({ queryKey: qk.kbCollections });
      const next: Draft = { title: a.title, excerpt: a.excerpt, slug: a.slug, collection_id: a.collection_id, body_html: draft.body_html, brand_id: a.brand_id ?? null };
      setSaved(next);
      setDraft((d) => ({ ...d, title: a.title, slug: a.slug, excerpt: a.excerpt }));
      setCurrent(a);
      setStatus(a.status);
      setSlugTouched(true);
      toast.success(
        nextStatus === "published" && status === "draft" ? t("toast.published") : nextStatus === "draft" && status === "published" ? t("toast.unpublished") : t("toast.saved"),
      );
      if (wasNew) void navigate({ to: "/kb/articles/$articleId", params: { articleId: a.id }, search: { collection: undefined }, replace: true, ignoreBlocker: true });
    },
    onError: (e) => toast.error(e),
  });

  const remove = useMutation({
    mutationFn: () => api.kb.articles.remove(current!.id),
    onSuccess: () => {
      qc.removeQueries({ queryKey: qk.kbArticle(current!.id) });
      void qc.invalidateQueries({ queryKey: qk.kbArticleLists });
      void qc.invalidateQueries({ queryKey: qk.kbCollections });
      toast.success(t("toast.deleted"));
      void navigate({ to: "/kb", ignoreBlocker: true });
    },
  });

  // Cmd/Ctrl+S saves without changing the published state.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (canEdit && !save.isPending) save.mutate(status);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canEdit, save, status]);

  const blocker = useBlocker({ shouldBlockFn: () => dirty && !save.isPending, enableBeforeUnload: () => dirty, withResolver: true });

  const editorRef = useRef<RichEditorHandle>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const ed = editorRef.current?.editor ?? null;
    setEditor(ed);
    if (!ed) return;
    // The editor normalises stored HTML; that normalised form is the saved baseline.
    const normalised = ed.isEmpty ? "" : ed.getHTML();
    setSaved((d) => ({ ...d, body_html: normalised }));
    setDraft((d) => ({ ...d, body_html: normalised }));
    ed.on("transaction", rerender);
    return () => {
      ed.off("transaction", rerender);
    };
  }, []);

  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const upload = async (file: File) => {
    setUploading(true);
    try {
      const a = await api.attachments.upload(file);
      // Use the URL exactly as returned (signed); only escape it for the attribute.
      const src = a.url.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
      const alt = file.name.replace(/\.[^.]+$/, "").replace(/[<>"]/g, "");
      editorRef.current?.insertHtml(`<img src="${src}" alt="${alt}">`);
    } catch (e) {
      toast.error(e, t("editor.uploadFailed"));
    } finally {
      setUploading(false);
    }
  };

  const ai = useAI();
  const { t: tai } = useTranslation("ai");
  const [draftOpen, setDraftOpen] = useState(() => !article && takeKbDraftRequest());
  const applyDraft = (d: KBArticleDraft) => {
    const fill = () => {
      set(slugTouched ? { title: d.title, excerpt: d.excerpt, body_html: d.body_html } : { title: d.title, excerpt: d.excerpt, body_html: d.body_html, slug: slugify(d.title) });
      editorRef.current?.setHtml(d.body_html);
      toast.success(tai("kb_draft.done"));
    };
    const hasContent = !!draft.title.trim() || !!draft.excerpt.trim() || !(editorRef.current?.isEmpty() ?? true);
    if (!hasContent) return fill();
    confirm.show(tai("kb_draft.replace_body"), fill, { title: tai("kb_draft.replace_title"), confirmLabel: tai("kb_draft.replace_confirm") });
  };

  const collection = collections.data?.find((c) => c.id === draft.collection_id);
  const collectionName = collection?.name;
  // Brand: its collection's when that has one, else its own; null is every brand.
  const { brands, multi: multiBrand, defaultBrand } = useBrands();
  const showBrand = multiBrand || !!draft.brand_id;
  const effectiveBrand = brands.find((b) => b.id === articleBrandId(draft, collections.data));
  const collectionBrand = collection?.brand_id ? brands.find((b) => b.id === collection.brand_id) : undefined;
  // The help center that shows it: its brand's, else the default brand's.
  const helpBrand = effectiveBrand ?? defaultBrand;
  const helpBase = helpBrand ? (helpBrand.help_center.enabled ? helpCenterHref(helpBrand) : null) : ws ? defaultHelpUrl(ws.slug) : null;
  const publicUrl = current && status === "published" && helpBase ? `${helpBase}${current.path}` : null;
  const brandField = (
    <>
      <KbBrandPick
        value={collectionBrand ? collectionBrand.id : draft.brand_id}
        onChange={(brand_id) => set({ brand_id })}
        disabled={!canEdit || !!collectionBrand}
        className="w-full"
      />
      <p className="mt-2 text-xs leading-[18px] text-fg-3">{collectionBrand ? t("brand.fromCollection", { name: collection!.name }) : t("brand.articleHint")}</p>
    </>
  );

  const slugField = (
    <div className="flex items-center gap-1.5 rounded-md border border-line bg-sunken py-1 pl-2.5 pr-1">
      <label htmlFor="kb-slug" className="mono shrink-0 truncate text-xs text-fg-4">
        {/* Where it lives on the help center: in its collection, else at /a/. */}
        {collection ? `/c/${collection.slug}/` : "/a/"}
      </label>
      <TextInput
        id="kb-slug"
        inputSize="sm"
        className="mono"
        aria-label={t("details.url")}
        value={draft.slug}
        readOnly={!canEdit}
        onChange={(e) => {
          setSlugTouched(true);
          set({ slug: slugify(e.target.value) || e.target.value.toLowerCase() });
        }}
        placeholder={slugify(draft.title) || "article-url"}
      />
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-surface px-4">
        <BackLink to="/kb">{t("title")}</BackLink>
        <span className="text-fg-4">/</span>
        <Picker
          items={[
            { value: "__none", label: t("noCollection") },
            ...(collections.data ?? []).map((c) => ({ value: c.id, label: c.name, icon: <Folder /> })),
          ]}
          value={draft.collection_id ?? "__none"}
          onSelect={(v) => set({ collection_id: v === "__none" ? null : v })}
          placeholder={t("editor.moveTo")}
          trigger={
            <button
              type="button"
              disabled={!canEdit}
              className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-fg-2 transition-colors hover:bg-hover hover:text-fg disabled:pointer-events-none"
            >
              {collectionName ? <span className={cn("size-2 rounded-xs", tone[collectionTone(collections.data, draft.collection_id)].solid)} /> : <Folder className="size-3.5 text-fg-3" />}
              {collectionName ?? t("noCollection")}
              <ChevronDown className="size-3 text-fg-4" />
            </button>
          }
        />
        <ArticleStatus status={status} />
        {multiBrand && effectiveBrand && <BrandChip brand={effectiveBrand} />}
        <span className="ml-1 hidden items-center gap-1.5 text-xs text-fg-4 lg:inline-flex" aria-live="polite">
          <Morph k={save.isPending ? "saving" : dirty ? "dirty" : current ? `saved-${current.updated_at}` : "new"} className="items-center gap-1.5">
            {save.isPending ? (
              <>
                <Spinner className="size-3" />
                {t("editor.saving")}
              </>
            ) : dirty ? (
              <>
                <span className="size-1.5 rounded-full bg-tone-amber-solid" />
                {t("editor.unsaved")}
              </>
            ) : current ? (
              <>
                <Check className="size-3 text-tone-green" strokeWidth={2.5} />
                <span title={fullDate(current.updated_at)}>{t("editor.savedAgo", { when: relLong(current.updated_at) })}</span>
              </>
            ) : null}
          </Morph>
        </span>

        <div className="ml-auto flex items-center gap-1.5">
          {publicUrl && (
            <Tooltip content={t("editor.openInHelp")}>
              <Button asChild variant="ghost" size="sm">
                <a href={publicUrl} target="_blank" rel="noreferrer">
                  <ExternalLink className="size-3.5" />
                  {t("editor.view")}
                </a>
              </Button>
            </Tooltip>
          )}
          {canEdit && ai.enabled && (
            <AiTooltip feature="kb_draft" label={tai("kb_draft.tooltip")}>
              <Button variant="ghost" size="sm" icon={<AiIcon />} onClick={() => setDraftOpen(true)}>
                <span className="hidden sm:inline">{tai("kb_draft.button")}</span>
              </Button>
            </AiTooltip>
          )}
          {canEdit && (
            <>
              <Tooltip content={status === "published" ? t("editor.saveLiveHint") : t("editor.saveDraftHint")} shortcut="mod s">
                <Button variant="secondary" disabled={!dirty && !!current} loading={save.isPending && save.variables === status} onClick={() => save.mutate(status)}>
                  {status === "published" ? t("editor.save") : t("editor.saveDraft")}
                </Button>
              </Tooltip>
              {status === "draft" ? (
                <Button variant="primary" loading={save.isPending && save.variables === "published"} onClick={() => save.mutate("published")}>
                  {t("editor.publish")}
                </Button>
              ) : null}
              <Menu>
                <MenuTrigger asChild>
                  <Button square variant="ghost" aria-label={t("editor.more")}>
                    <MoreHorizontal className="size-4" />
                  </Button>
                </MenuTrigger>
                <MenuContent>
                  {status === "published" && (
                    <MenuItem icon={<Undo2 />} onSelect={() => save.mutate("draft")}>
                      {t("editor.unpublish")}
                    </MenuItem>
                  )}
                  {current && (
                    <>
                      {status === "published" && <MenuSeparator />}
                      <MenuItem
                        danger
                        icon={<Trash2 />}
                        onSelect={() =>
                          confirm.show(
                            status === "published" ? t("editor.deletePublished") : t("editor.deleteDraft"),
                            () => remove.mutateAsync(),
                            { title: t("editor.deleteTitle", { title: current.title || t("untitled") }), confirmLabel: t("editor.deleteArticle"), danger: true },
                          )
                        }
                      >
                        {t("editor.deleteArticle")}
                      </MenuItem>
                    </>
                  )}
                  {!current && <MenuItem disabled>{t("editor.saveFirst")}</MenuItem>}
                </MenuContent>
              </Menu>
            </>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[760px] px-6 pb-32 pt-12 md:px-10">
          <textarea
            value={draft.title}
            onChange={(e) => {
              const title = e.target.value.replace(/\n/g, " ");
              set(slugTouched ? { title } : { title, slug: slugify(title) });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                editorRef.current?.focus();
              }
            }}
            readOnly={!canEdit}
            rows={1}
            placeholder={t("editor.titlePlaceholder")}
            aria-label={ui("title")}
            autoFocus={!current}
            className="field-sizing-content w-full resize-none bg-transparent text-[28px] font-semibold leading-[34px] tracking-[-0.03em] text-fg outline-none placeholder:text-fg-4 focus-visible:shadow-none"
          />
          <input
            value={draft.excerpt}
            onChange={(e) => set({ excerpt: e.target.value })}
            readOnly={!canEdit}
            placeholder={t("editor.excerptPlaceholder")}
            aria-label={ui("excerpt")}
            className="mt-2 w-full bg-transparent text-[15px] text-fg-2 outline-none placeholder:text-fg-4 focus-visible:shadow-none"
          />

          {!wide && (
            <div className="mt-4">
              <button
                type="button"
                onClick={() => setAdvanced((v) => !v)}
                aria-expanded={advanced}
                className="-ml-1 inline-flex h-6 items-center gap-1 rounded-md px-1 text-xs text-fg-3 transition-colors hover:bg-hover hover:text-fg"
              >
                <ChevronRight className={cn("size-3 transition-transform", advanced && "rotate-90")} />
                {t("editor.advanced")}
              </button>
              {advanced && (
                <div className="mt-2 flex max-w-[480px] flex-col gap-4">
                  {slugField}
                  {showBrand && (
                    <div>
                      <h2 className="label-caps mb-2">{t("brand.label")}</h2>
                      {brandField}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {canEdit && editor && (
            <div className="sticky top-3 z-10 -mx-3 mt-8 rounded-lg border border-line bg-surface/95 pt-1.5 shadow-xs backdrop-blur">
              <Toolbar editor={editor} full onImage={() => fileRef.current?.click()} end={uploading ? <span className="pr-2 text-xs text-fg-4">{t("editor.uploading")}</span> : undefined} />
            </div>
          )}
          <RichEditor
            ref={editorRef}
            value={draft.body_html}
            onChange={(html) => set({ body_html: html })}
            toolbar="none"
            editable={canEdit}
            placeholder={t("editor.bodyPlaceholder")}
            ariaLabel="Article body"
            className="mt-6"
            contentClassName="prose-lg min-h-[360px] px-0"
          />
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
              e.target.value = "";
            }}
          />
        </div>
      </div>
        {wide && (
          <aside className="w-[300px] shrink-0 overflow-y-auto border-l border-line px-5 py-6" aria-label={t("details.title")}>
            <h2 className="label-caps mb-3">{t("details.title")}</h2>
            <dl className="flex flex-col divide-y divide-line-soft text-[12.5px]">
              <Meta label={t("details.status")}>
                <ArticleStatus status={status} />
              </Meta>
              <Meta label={t("details.collection")}>
                <span className="truncate text-fg">{collectionName ?? t("noCollection")}</span>
              </Meta>
              <Meta label={t("details.author")}>
                {current?.author ? (
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Avatar name={current.author.name} src={current.author.avatar_url} size="xs" />
                    <span className="truncate text-fg">{current.author.name}</span>
                  </span>
                ) : (
                  <span className="text-fg-4">–</span>
                )}
              </Meta>
              <Meta label={t("details.views")}>
                <span className="mono flex items-center gap-1.5 text-fg">
                  <Eye className="size-3.5 text-fg-4" />
                  {current && status === "published" ? compact(current.views) : "–"}
                </span>
              </Meta>
              <Meta label={t("details.published")}>
                <span className="text-fg" title={current?.published_at ? fullDate(current.published_at) : undefined}>
                  {current?.published_at && status === "published" ? shortDate(current.published_at) : "–"}
                </span>
              </Meta>
              <Meta label={t("details.updated")}>
                <span className="text-fg" title={current ? fullDate(current.updated_at) : undefined}>
                  {current ? relLong(current.updated_at) : "–"}
                </span>
              </Meta>
            </dl>
            <h2 className="label-caps mb-2 mt-7">{t("details.url")}</h2>
            {slugField}
            <p className="mt-2 text-xs leading-[18px] text-fg-3">{t("details.urlHint")}</p>
            {showBrand && (
              <>
                <h2 className="label-caps mb-2 mt-7">{t("brand.label")}</h2>
                {brandField}
              </>
            )}
          </aside>
        )}
      </div>

      {ai.enabled && <KbDraftDialog open={draftOpen} onOpenChange={setDraftOpen} onDraft={applyDraft} />}

      <Dialog
        open={blocker.status === "blocked"}
        onOpenChange={(o) => !o && blocker.reset?.()}
        title={t("editor.leaveTitle")}
        description={t("editor.leaveBody")}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => blocker.reset?.()}>
              {t("editor.keepEditing")}
            </Button>
            <Button variant="danger-solid" onClick={() => blocker.proceed?.()}>
              {t("editor.discard")}
            </Button>
          </>
        }
      />
    </div>
  );
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-9 items-center justify-between gap-3 py-1.5">
      <dt className="shrink-0 text-fg-3">{label}</dt>
      <dd className="flex min-w-0 justify-end">{children}</dd>
    </div>
  );
}

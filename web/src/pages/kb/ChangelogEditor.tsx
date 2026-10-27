import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useBlocker, useNavigate } from "@tanstack/react-router";
import type { Editor } from "@tiptap/react";
import { Check, ChevronRight, ExternalLink, MoreHorizontal, Trash2, Undo2 } from "lucide-react";
import { useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { BackLink } from "@/components/layout";
import { RichEditor, Toolbar, type RichEditorHandle } from "@/components/editor/RichEditor";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { DateField, TimeField } from "@/components/ui/date-picker";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty";
import { TextInput } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { useConfirm } from "@/components/ui/confirm";
import { toast } from "@/components/ui/toast";
import { Morph } from "@/components/motion";
import { useDocumentTitle } from "@/app/RootLayout";
import { usePageCrumb } from "@/app/useBreadcrumbs";
import { KbBrandPick } from "@/components/kb/brand";
import { slugify } from "@/components/kb/slug";
import { entryState, fromLocalParts, localParts, sameCategories } from "@/components/kb/changelog";
import { CategoryInput, EntryStatus, useEntryState, useHelpBase } from "@/components/kb/changelogBits";
import { useBrands } from "@/components/settings2/teams";
import { BrandChip } from "@/components/tickets/teams";
import { api, type ChangelogEntryBody } from "@/lib/api/endpoints";
import { errorMessage } from "@/lib/api/client";
import type { ChangelogEntry } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { fullDate, relLong, shortDate } from "@/lib/format";
import { q, qk } from "@/lib/queries";
import { atLeast, useRole } from "@/lib/session";

const route = getRouteApi("/app/kb/changelog/$entryId");

type Draft = {
  title: string;
  excerpt: string;
  slug: string;
  body_html: string;
  categories: string[];
  brand_id: string | null;
  /** The date it carries; null = set when it is published. */
  published_at: string | null;
};

const same = (a: Draft, b: Draft) =>
  a.title === b.title &&
  a.excerpt === b.excerpt &&
  a.slug === b.slug &&
  a.body_html === b.body_html &&
  sameCategories(a.categories, b.categories) &&
  a.brand_id === b.brand_id &&
  a.published_at === b.published_at;

const fromEntry = (e: ChangelogEntry | null): Draft => ({
  title: e?.title ?? "",
  excerpt: e?.excerpt ?? "",
  slug: e?.slug ?? "",
  body_html: e?.body_html ?? "",
  categories: e?.categories ?? [],
  brand_id: e?.brand_id ?? null,
  published_at: e?.published_at ?? null,
});

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

export default function ChangelogEditor() {
  const { t } = useTranslation("kb");
  const { entryId } = route.useParams();
  const isNew = entryId === "new";
  const entry = useQuery({ ...q.changelogEntry(entryId), enabled: !isNew });

  if (!isNew && entry.isLoading)
    return (
      <div className="mx-auto w-full max-w-[720px] px-6 pt-20">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="mt-4 h-3 w-1/2" />
        <Skeleton className="mt-10 h-3 w-full" />
        <Skeleton className="mt-3 h-3 w-5/6" />
        <Skeleton className="mt-3 h-3 w-4/6" />
      </div>
    );
  if (!isNew && (entry.error || !entry.data))
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState lit={3} title={t("changelog.editor.notFound")} description={entry.error ? errorMessage(entry.error) : undefined} />
      </div>
    );
  return <EditorScreen key={entryId} entry={isNew ? null : entry.data!} />;
}

function EditorScreen({ entry }: { entry: ChangelogEntry | null }) {
  const { t: ui } = useTranslation("ui");
  const { t } = useTranslation("kb");
  const wide = useWide();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const canEdit = atLeast(useRole(), "agent");

  // The baseline is the entry as loaded; later saves move it explicitly.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const initial = useMemo(() => fromEntry(entry), []);
  const [saved, setSaved] = useState<Draft>(initial);
  const [draft, setDraft] = useState<Draft>(initial);
  const [current, setCurrent] = useState<ChangelogEntry | null>(entry);
  const [slugTouched, setSlugTouched] = useState(!!entry);
  const [advanced, setAdvanced] = useState(false);
  const status = current?.status ?? "draft";
  const savedEntry = { status, published_at: current?.published_at ?? null };
  const savedState = useEntryState(savedEntry);
  const dirty = !same(draft, saved);
  useDocumentTitle(draft.title || (current ? t("untitled") : t("changelog.new")));
  usePageCrumb(saved.title || (current ? t("untitled") : t("changelog.new")));

  const set = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));

  const { multi: multiBrand, brands } = useBrands();
  const showBrand = multiBrand || !!draft.brand_id;
  const brand = brands.find((b) => b.id === saved.brand_id);
  const helpBase = useHelpBase(saved.brand_id);

  const save = useMutation({
    mutationFn: (nextStatus: ChangelogEntry["status"]) => {
      const body: ChangelogEntryBody = {
        title: draft.title.trim() || t("untitled"),
        slug: draft.slug || slugify(draft.title) || undefined,
        body_html: draft.body_html,
        categories: draft.categories,
        status: nextStatus,
        ...(showBrand ? { brand_id: draft.brand_id } : {}),
      };
      // The excerpt is derived from the body unless written, and the date is set when first
      // published unless given: each is sent only once it was changed here.
      if (current ? draft.excerpt !== saved.excerpt : draft.excerpt.trim()) body.excerpt = draft.excerpt.trim();
      if (current ? draft.published_at !== saved.published_at : draft.published_at) body.published_at = draft.published_at;
      return current ? api.changelog.entries.update(current.id, body) : api.changelog.entries.create(body);
    },
    onSuccess: (e, nextStatus) => {
      const wasNew = !current;
      qc.setQueryData(qk.changelogEntry(e.id), e);
      void qc.invalidateQueries({ queryKey: qk.changelogEntryLists });
      void qc.invalidateQueries({ queryKey: qk.changelogCategories });
      // The editor's normalised body stays the baseline; the rest is the server's.
      setSaved({ ...fromEntry(e), body_html: draft.body_html });
      setDraft((d) => ({ ...fromEntry(e), body_html: d.body_html }));
      setCurrent(e);
      setSlugTouched(true);
      toast.success(
        nextStatus === "published" && status === "draft"
          ? entryState(e) === "scheduled"
            ? t("changelog.toast.scheduled", { date: shortDate(e.published_at) })
            : t("changelog.toast.published")
          : nextStatus === "draft" && status === "published"
            ? t("changelog.toast.unpublished")
            : t("toast.saved"),
      );
      if (wasNew) void navigate({ to: "/kb/changelog/$entryId", params: { entryId: e.id }, replace: true, ignoreBlocker: true });
    },
    onError: (e) => toast.error(e),
  });

  const remove = useMutation({
    mutationFn: () => api.changelog.entries.remove(current!.id),
    onSuccess: () => {
      qc.removeQueries({ queryKey: qk.changelogEntry(current!.id) });
      void qc.invalidateQueries({ queryKey: qk.changelogEntryLists });
      void qc.invalidateQueries({ queryKey: qk.changelogCategories });
      toast.success(t("changelog.toast.deleted"));
      void navigate({ to: "/kb/changelog", ignoreBlocker: true });
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

  // Publishing an entry dated later schedules it.
  const willSchedule = !!draft.published_at && Date.parse(draft.published_at) > Date.now();
  const publicUrl = current && savedState === "published" && helpBase ? `${helpBase}/changelog/${current.slug}` : null;

  const slugField = (
    <div className="flex items-center gap-1.5 rounded-md border border-line bg-sunken py-1 pl-2.5 pr-1">
      <label htmlFor="changelog-slug" className="mono shrink-0 text-xs text-fg-4">
        /changelog/
      </label>
      <TextInput
        id="changelog-slug"
        inputSize="sm"
        className="mono"
        aria-label={t("details.url")}
        value={draft.slug}
        readOnly={!canEdit}
        onChange={(e) => {
          setSlugTouched(true);
          set({ slug: slugify(e.target.value) || e.target.value.toLowerCase() });
        }}
        placeholder={slugify(draft.title) || "update-url"}
      />
    </div>
  );

  const brandField = (
    <>
      <KbBrandPick value={draft.brand_id} onChange={(brand_id) => set({ brand_id })} disabled={!canEdit} className="w-full" />
      <p className="mt-2 text-xs leading-[18px] text-fg-3">{t("changelog.details.brandHint")}</p>
    </>
  );

  const dateField = <DateTimeField value={draft.published_at} onChange={(published_at) => set({ published_at })} disabled={!canEdit} status={status} />;
  const categoriesField = <CategoryInput value={draft.categories} onChange={(categories) => set({ categories })} disabled={!canEdit} />;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-surface px-4">
        <BackLink to="/kb/changelog">{t("switch.changelog")}</BackLink>
        <span className="text-fg-4">/</span>
        <EntryStatus entry={savedEntry} />
        {multiBrand && brand && <BrandChip brand={brand} />}
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
            <Tooltip content={t("changelog.editor.openInHelp")}>
              <Button asChild variant="ghost" size="sm">
                <a href={publicUrl} target="_blank" rel="noreferrer">
                  <ExternalLink className="size-3.5" />
                  {t("editor.view")}
                </a>
              </Button>
            </Tooltip>
          )}
          {canEdit && (
            <>
              <Tooltip content={status === "published" ? t("changelog.editor.saveLiveHint") : t("editor.saveDraftHint")} shortcut="mod s">
                <Button variant="secondary" disabled={!dirty && !!current} loading={save.isPending && save.variables === status} onClick={() => save.mutate(status)}>
                  {status === "published" ? t("editor.save") : t("editor.saveDraft")}
                </Button>
              </Tooltip>
              {status === "draft" && (
                <Button variant="primary" loading={save.isPending && save.variables === "published"} onClick={() => save.mutate("published")}>
                  {willSchedule ? t("changelog.editor.schedule") : t("editor.publish")}
                </Button>
              )}
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
                  {current ? (
                    <>
                      {status === "published" && <MenuSeparator />}
                      <MenuItem
                        danger
                        icon={<Trash2 />}
                        onSelect={() =>
                          confirm.show(
                            status === "published" ? t("changelog.editor.deletePublished") : t("editor.deleteDraft"),
                            () => remove.mutateAsync(),
                            { title: t("editor.deleteTitle", { title: current.title || t("untitled") }), confirmLabel: t("changelog.editor.delete"), danger: true },
                          )
                        }
                      >
                        {t("changelog.editor.delete")}
                      </MenuItem>
                    </>
                  ) : (
                    <MenuItem disabled>{t("editor.saveFirst")}</MenuItem>
                  )}
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
                const title = e.target.value.replace(/\n/g, " ").slice(0, 200);
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
              placeholder={t("changelog.editor.titlePlaceholder")}
              aria-label={ui("title")}
              autoFocus={!current}
              className="field-sizing-content w-full resize-none bg-transparent text-[28px] font-semibold leading-[34px] tracking-[-0.03em] text-fg outline-none placeholder:text-fg-4 focus-visible:shadow-none"
            />
            <input
              value={draft.excerpt}
              onChange={(e) => set({ excerpt: e.target.value.slice(0, 300) })}
              readOnly={!canEdit}
              placeholder={t("changelog.editor.excerptPlaceholder")}
              aria-label={ui("excerpt")}
              className="mt-2 w-full bg-transparent text-[15px] text-fg-2 outline-none placeholder:text-fg-4 focus-visible:shadow-none"
            />

            {!wide && (
              <div className="mt-4 flex flex-col gap-3">
                {categoriesField}
                <div>
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
                      <div>
                        <h2 className="label-caps mb-2">{t("changelog.details.date")}</h2>
                        {dateField}
                      </div>
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
              placeholder={t("changelog.editor.bodyPlaceholder")}
              ariaLabel={t("changelog.editor.body")}
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
                <EntryStatus entry={savedEntry} />
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
              <Meta label={t("details.updated")}>
                <span className="text-fg" title={current ? fullDate(current.updated_at) : undefined}>
                  {current ? relLong(current.updated_at) : "–"}
                </span>
              </Meta>
            </dl>
            <h2 className="label-caps mb-2 mt-7">{t("changelog.details.date")}</h2>
            {dateField}
            <h2 className="label-caps mb-2 mt-7">{t("changelog.details.categories")}</h2>
            {categoriesField}
            <h2 className="label-caps mb-2 mt-7">{t("details.url")}</h2>
            {slugField}
            <p className="mt-2 text-xs leading-[18px] text-fg-3">{t("changelog.details.urlHint")}</p>
            {showBrand && (
              <>
                <h2 className="label-caps mb-2 mt-7">{t("brand.label")}</h2>
                {brandField}
              </>
            )}
          </aside>
        )}
      </div>

      <Dialog
        open={blocker.status === "blocked"}
        onOpenChange={(o) => !o && blocker.reset?.()}
        title={t("editor.leaveTitle")}
        description={t("changelog.editor.leaveBody")}
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

/** The entry's date as a day and a time on the reader's clock; empty is "when published". */
function DateTimeField({ value, onChange, disabled, status }: { value: string | null; onChange: (v: string | null) => void; disabled: boolean; status: ChangelogEntry["status"] }) {
  const { t } = useTranslation("kb");
  const { day, time } = localParts(value);
  const future = !!value && Date.parse(value) > Date.now();
  const hint = !value
    ? t("changelog.details.dateEmptyHint")
    : future
      ? status === "published"
        ? t("changelog.details.scheduledFor", { date: fullDate(value) })
        : t("changelog.details.willSchedule", { date: fullDate(value) })
      : t("changelog.details.dateHint");
  return (
    <div>
      {disabled ? (
        <span className="text-[12.5px] text-fg">{value ? fullDate(value) : t("changelog.details.whenPublished")}</span>
      ) : (
        <div className="flex items-center gap-2">
          <DateField
            value={day}
            // A new day keeps the time it had, else takes the time of day it is now.
            onChange={(d) => onChange(d ? fromLocalParts(d, time || localParts(new Date().toISOString()).time) : null)}
            placeholder={t("changelog.details.whenPublished")}
            aria-label={t("changelog.details.date")}
            clearable
            size="sm"
            className="min-w-0 flex-1"
          />
          {day && <TimeField value={time} onChange={(tm) => onChange(fromLocalParts(day, tm))} size="sm" aria-label={t("changelog.details.time")} />}
        </div>
      )}
      <p className={cn("mt-2 text-xs leading-[18px]", future ? "text-tone-blue" : "text-fg-3")}>{hint}</p>
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

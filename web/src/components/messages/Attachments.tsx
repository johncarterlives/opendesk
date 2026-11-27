// A message's files, for tickets and Collab alike: pictures as thumbnails, recordings as players,
// other files as chips. A picture, a PDF or a text file opens in the preview, where the arrows
// step through the message's other previewable files. What is shown, and how safely, is decided
// in lib/attachmentPreview.ts.

import { Dialog as D } from "radix-ui";
import { ChevronLeft, ChevronRight, Download, FileText, X } from "lucide-react";
import { useEffect, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { fetchUrl, fromBytes, pdfViewerAvailable, previewable, previewKind, tooLarge, type PreviewFile, type PreviewKind } from "@/lib/attachmentPreview";
import { bytes } from "@/lib/format";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

export type { PreviewFile } from "@/lib/attachmentPreview";

const isAudio = (f: PreviewFile) => f.content_type.startsWith("audio/");

/** The download link of a file: saved under its name, never shown in place of the app. */
function DownloadLink({ file, className, label, children }: { file: PreviewFile; className?: string; label?: string; children: ReactNode }) {
  return (
    <a href={file.url} download={file.filename} target="_blank" rel="noopener noreferrer" aria-label={label} className={className}>
      {children}
    </a>
  );
}

export function AttachmentList({ files }: { files: PreviewFile[] }) {
  const { t } = useTranslation("ui");
  const [open, setOpen] = useState<number | null>(null);
  if (!files.length) return null;
  const shown = previewable(files);
  const preview = (f: PreviewFile) => setOpen(shown.indexOf(f));
  const images = files.filter((f) => previewKind(f.content_type, f.filename) === "image");
  const audio = files.filter(isAudio);
  const others = files.filter((f) => !images.includes(f) && !audio.includes(f));
  return (
    <div className="mt-3 flex flex-col gap-2">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => preview(f)}
              className="group relative h-[88px] w-[124px] overflow-hidden rounded-md border border-line bg-sunken outline-none focus-visible:shadow-[0_0_0_2px_var(--focus)]"
              aria-label={t("attachments.preview", { name: f.filename })}
            >
              <img
                src={f.imageUrl}
                alt=""
                loading="lazy"
                referrerPolicy="no-referrer"
                className="ph-no-capture size-full object-cover transition-transform duration-200 group-hover:scale-[1.03] motion-reduce:transition-none"
              />
              <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/55 to-transparent px-1.5 pb-1 pt-4 text-left text-[10.5px] text-white" data-ph-mask>
                {f.filename}
              </span>
            </button>
          ))}
        </div>
      )}
      {audio.map((f) => (
        <div key={f.id} className="flex max-w-[360px] items-center gap-2">
          <audio controls preload="metadata" src={f.url} aria-label={f.filename} className="ph-no-capture h-9 min-w-0 flex-1" />
          <DownloadLink file={f} label={t("attachments.download", { name: f.filename })} className="shrink-0 text-fg-4 hover:text-fg">
            <Download className="size-3.5" />
          </DownloadLink>
        </div>
      ))}
      {others.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {others.map((f) => (shown.includes(f) ? <PreviewChip key={f.id} file={f} onOpen={() => preview(f)} /> : <DownloadChip key={f.id} file={f} />))}
        </div>
      )}
      <AttachmentPreview files={shown} index={open} onIndexChange={setOpen} />
    </div>
  );
}

const chip = "flex h-10 max-w-[260px] items-center rounded-md border border-line bg-surface hover:border-line-strong";

function ChipLabel({ file }: { file: PreviewFile }) {
  return (
    <>
      <FileText className="size-4 shrink-0 text-fg-3" />
      <span className="min-w-0 text-left">
        <span className="block truncate text-[12.5px] text-fg" data-ph-mask>
          {file.filename}
        </span>
        <span className="mono block text-[10.5px] text-fg-4">{bytes(file.size)}</span>
      </span>
    </>
  );
}

function DownloadChip({ file }: { file: PreviewFile }) {
  const { t } = useTranslation("ui");
  return (
    <DownloadLink file={file} label={t("attachments.download", { name: file.filename })} className={cn(chip, "group gap-2.5 pl-2.5 pr-3")}>
      <ChipLabel file={file} />
      <Download className="ml-1 size-3.5 shrink-0 text-fg-4 group-hover:text-fg" />
    </DownloadLink>
  );
}

function PreviewChip({ file, onOpen }: { file: PreviewFile; onOpen: () => void }) {
  const { t } = useTranslation("ui");
  return (
    <div className={chip}>
      <button
        type="button"
        onClick={onOpen}
        aria-label={t("attachments.preview", { name: file.filename })}
        className="flex h-full min-w-0 items-center gap-2.5 rounded-l-md pl-2.5 pr-1.5 outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--focus)]"
      >
        <ChipLabel file={file} />
      </button>
      <DownloadLink
        file={file}
        label={t("attachments.download", { name: file.filename })}
        className="flex h-full shrink-0 items-center rounded-r-md pl-1.5 pr-3 text-fg-4 outline-none hover:text-fg focus-visible:shadow-[inset_0_0_0_2px_var(--focus)]"
      >
        <Download className="size-3.5" />
      </DownloadLink>
    </div>
  );
}

/**
 * The preview of a message's files: one at a time, with the arrows (and the arrow keys) to the
 * others. Escape, the close button or a click beside the file closes it.
 */
export function AttachmentPreview({ files, index, onIndexChange }: { files: PreviewFile[]; index: number | null; onIndexChange: (i: number | null) => void }) {
  const { t } = useTranslation("ui");
  const file = index === null ? undefined : files[index];
  const many = files.length > 1;
  const step = (by: number) => index !== null && onIndexChange((index + by + files.length) % files.length);
  const onKeyDown = (e: KeyboardEvent) => {
    if (!many || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "ArrowRight") step(1);
    else return;
    e.preventDefault();
  };
  // A click on the backdrop, not on the file or the controls, closes.
  const onClick = (e: MouseEvent) => {
    if (!(e.target as HTMLElement).closest("[data-preview-keep]")) onIndexChange(null);
  };
  return (
    <D.Root open={!!file} onOpenChange={(o) => !o && onIndexChange(null)}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-scrim backdrop-blur-[2px] data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out motion-reduce:animate-none" />
        {file && index !== null && (
          <D.Content
            aria-modal="true"
            tabIndex={-1}
            onOpenAutoFocus={(e) => {
              // Focus the preview itself, so the arrow keys work from the start.
              e.preventDefault();
              (e.currentTarget as HTMLElement | null)?.focus({ preventScroll: true });
            }}
            onKeyDown={onKeyDown}
            onClick={onClick}
            className="fixed inset-0 z-50 flex flex-col gap-3 p-3 outline-none sm:p-5 data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out motion-reduce:animate-none"
          >
            <div data-preview-keep className="mx-auto flex w-full max-w-[1100px] items-center gap-3 rounded-lg border border-line bg-raised py-1.5 pl-3 pr-1.5 shadow-float">
              <FileText className="size-4 shrink-0 text-fg-3" />
              <div className="min-w-0 flex-1">
                <D.Title className="truncate text-[13px] font-medium text-fg" data-ph-mask>
                  {file.filename}
                </D.Title>
                <D.Description className="mono text-[10.5px] text-fg-4">
                  {bytes(file.size)}
                  {many && ` · ${t("attachments.position", { n: index + 1, total: files.length })}`}
                </D.Description>
              </div>
              <Button asChild size="sm" variant="secondary">
                <DownloadLink file={file}>
                  <Download /> {t("attachments.downloadShort")}
                </DownloadLink>
              </Button>
              <D.Close aria-label={t("close")} className="flex size-7 shrink-0 items-center justify-center rounded-md text-fg-3 transition-colors hover:bg-hover hover:text-fg">
                <X className="size-4" />
              </D.Close>
            </div>
            <div className="relative flex min-h-0 flex-1 items-center justify-center">
              {many && <StepButton side="left" label={t("attachments.previous")} onClick={() => step(-1)} />}
              <Viewer key={file.id} file={file} />
              {many && <StepButton side="right" label={t("attachments.next")} onClick={() => step(1)} />}
            </div>
          </D.Content>
        )}
      </D.Portal>
    </D.Root>
  );
}

function StepButton({ side, label, onClick }: { side: "left" | "right"; label: string; onClick: () => void }) {
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      data-preview-keep
      aria-label={label}
      onClick={onClick}
      className={cn(
        "absolute top-1/2 z-10 flex size-9 -translate-y-1/2 items-center justify-center rounded-full border border-line bg-raised text-fg-2 shadow-float outline-none transition-colors hover:text-fg focus-visible:shadow-[0_0_0_2px_var(--focus)]",
        side === "left" ? "left-0 sm:left-2" : "right-0 sm:right-2",
      )}
    >
      <Icon className="size-4" />
    </button>
  );
}

type Shown = { status: "loading" } | { status: "pdf"; url: string } | { status: "text"; text: string } | { status: "failed" } | { status: "refused" };

/** Reads a PDF or text file for its preview, and lets go of it when the preview moves on. */
function useLoaded(file: PreviewFile, kind: "pdf" | "text", enabled: boolean): Shown {
  const [shown, setShown] = useState<Shown>({ status: "loading" });
  useEffect(() => {
    if (!enabled) return;
    const ctl = new AbortController();
    let url = "";
    fetch(fetchUrl(file.url), { credentials: "omit", cache: "no-store", signal: ctl.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const loaded = fromBytes(kind, new Uint8Array(await res.arrayBuffer()));
        if (ctl.signal.aborted) return;
        if (loaded.kind === "pdf") {
          url = URL.createObjectURL(loaded.blob);
          setShown({ status: "pdf", url });
        } else if (loaded.kind === "text") setShown({ status: "text", text: loaded.text });
        else setShown({ status: "refused" });
      })
      .catch(() => !ctl.signal.aborted && setShown({ status: "failed" }));
    return () => {
      ctl.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [file.url, kind, enabled]);
  return shown;
}

function Viewer({ file }: { file: PreviewFile }) {
  const kind = previewKind(file.content_type, file.filename) as PreviewKind;
  if (kind === "image") return <ImageView file={file} />;
  return <DocumentView file={file} kind={kind} />;
}

function ImageView({ file }: { file: PreviewFile }) {
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  if (state === "failed") return <Notice file={file} reason="failed" />;
  return (
    <>
      {state === "loading" && <Notice file={file} reason="loading" />}
      <img
        data-preview-keep
        src={file.imageUrl}
        alt={file.filename}
        referrerPolicy="no-referrer"
        onLoad={() => setState("ready")}
        onError={() => setState("failed")}
        className={cn("ph-no-capture max-h-full max-w-full rounded-md object-contain shadow-float animate-fade-in motion-reduce:animate-none", state === "loading" && "hidden")}
      />
    </>
  );
}

function DocumentView({ file, kind }: { file: PreviewFile; kind: "pdf" | "text" }) {
  const blocked = tooLarge(kind, file.size) ? "tooLarge" : kind === "pdf" && !pdfViewerAvailable() ? "noViewer" : null;
  const shown = useLoaded(file, kind, !blocked);
  if (blocked) return <Notice file={file} reason={blocked} />;
  switch (shown.status) {
    case "pdf":
      // The browser's own PDF viewer, from a blob typed application/pdf after its bytes were
      // checked. No sandbox attribute: browsers refuse to show a PDF in a sandboxed frame.
      return (
        <iframe
          data-preview-keep
          src={shown.url}
          title={file.filename}
          referrerPolicy="no-referrer"
          className="ph-no-capture size-full max-w-[1100px] rounded-lg border border-line bg-raised shadow-float animate-fade-in motion-reduce:animate-none"
        />
      );
    case "text":
      return (
        <div data-preview-keep className="max-h-full w-full max-w-[1100px] overflow-auto rounded-lg border border-line bg-raised shadow-float animate-fade-in motion-reduce:animate-none">
          <pre className="ph-no-capture whitespace-pre-wrap break-words p-4 font-mono text-[12.5px] leading-[1.6] text-fg" data-ph-mask>
            {shown.text}
          </pre>
        </div>
      );
    default:
      return <Notice file={file} reason={shown.status} />;
  }
}

function Notice({ file, reason }: { file: PreviewFile; reason: "loading" | "failed" | "refused" | "tooLarge" | "noViewer" }) {
  const { t } = useTranslation("ui");
  const why = {
    loading: "",
    failed: t("attachments.failed"),
    refused: t("attachments.refused"),
    tooLarge: t("attachments.tooLarge"),
    noViewer: t("attachments.noViewer"),
  }[reason];
  if (reason === "loading")
    return (
      <div data-preview-keep role="status" className="flex items-center gap-2 rounded-lg border border-line bg-raised px-4 py-3 text-[12.5px] text-fg-3 shadow-float">
        <Spinner className="size-3.5" /> {t("attachments.loading")}
      </div>
    );
  return (
    <div data-preview-keep className="flex max-w-[360px] flex-col items-center gap-3 rounded-lg border border-line bg-raised px-6 py-5 text-center shadow-float">
      <FileText className="size-6 text-fg-4" />
      <p className="text-[13px] text-fg-2">{why}</p>
      <Button asChild size="sm" variant="primary">
        <DownloadLink file={file}>
          <Download /> {t("attachments.downloadShort")}
        </DownloadLink>
      </Button>
    </div>
  );
}

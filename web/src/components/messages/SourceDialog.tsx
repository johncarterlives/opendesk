// A message's original source: its raw headers and body as the mail server delivered them,
// to read, copy or save as an .eml file. Tickets and Collab show it the same way.

import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Dialog } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { ApiError, errorMessage, type Download as DownloadedFile } from "@/lib/api/client";
import type { MailSource } from "@/lib/api/types";

/** The raw message split where the headers end: the first empty line. */
export function splitSource(source: string): { headers: string; body: string } {
  const at = source.search(/\r?\n\r?\n/);
  if (at < 0) return { headers: source, body: "" };
  return { headers: source.slice(0, at), body: source.slice(at).replace(/^\r?\n\r?\n/, "") };
}

export function SourceDialog({
  open,
  onOpenChange,
  title,
  queryKey,
  load,
  file,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The message's subject. */
  title: string;
  queryKey: readonly unknown[];
  load: () => Promise<MailSource>;
  file: () => Promise<DownloadedFile>;
}) {
  const { t } = useTranslation("inbox");
  const { data, isPending, isError, error } = useQuery({ queryKey, queryFn: load, enabled: open, staleTime: Infinity, retry: false });
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      const { blob, filename } = await file();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename ?? "message.eml";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      toast.error(e, t("source.downloadError"));
    } finally {
      setSaving(false);
    }
  };
  const parts = data ? splitSource(data.source) : null;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("source.title")}
      description={title}
      size="xl"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t("source.close")}</Button>
          <Button variant="primary" icon={<Download />} loading={saving} disabled={!data} onClick={() => void save()}>
            {t("source.download")}
          </Button>
        </>
      }
    >
      {isPending ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-3.5 w-2/3" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-5/6" />
        </div>
      ) : isError || !parts ? (
        <p className="text-[12.5px] text-fg-3">
          {error instanceof ApiError && error.status === 404 ? t("source.error") : errorMessage(error, t("source.loadError"))}
        </p>
      ) : (
        <div className="relative">
          <CopyButton value={data.source} label={t("source.copy")} className="absolute right-1.5 top-1.5 bg-surface" />
          <pre
            className="ph-no-capture max-h-[60vh] overflow-auto whitespace-pre-wrap break-all rounded-md border border-line bg-sunken p-3 pr-10 font-mono text-[11.5px] leading-[18px] text-fg-2"
            data-ph-mask
            data-testid="message-source"
          >
            <span className="text-fg">{parts.headers}</span>
            {parts.body && (
              <>
                {"\n\n"}
                {parts.body}
              </>
            )}
          </pre>
          {data.truncated && <p className="mt-2 text-[12px] text-fg-3">{t("source.truncated", { size: Math.round(data.size_bytes / 1024) })}</p>}
        </div>
      )}
    </Dialog>
  );
}

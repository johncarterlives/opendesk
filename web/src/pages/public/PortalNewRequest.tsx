// A signed-in customer starts a request from the portal: a subject, what they need and, when it helps,
// files. Priority, team and the rest are the team's to set when it arrives (contracts/customer-portal.md
// "Starting a request" and "Files"). Files go up as soon as they are added, from the picker, a drop or a paste.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { FileText, Paperclip, X } from "lucide-react";
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Notice } from "@/components/auth/parts";
import { Button } from "@/components/ui/button";
import { TextInput, Textarea } from "@/components/ui/input";
import { isApiError } from "@/lib/api/client";
import { customerPortal } from "@/lib/customerPortal/client";

const publicTextLink = "text-fg-2 underline underline-offset-4 hover:text-fg focus-visible:rounded-sm focus-visible:shadow-[0_0_0_3px_var(--focus)]";

/** The limits the server holds (contracts/customer-portal.md "Files"), checked here to answer before the upload. */
export const MAX_FILES = 5;
export const MAX_FILE_BYTES = 10 << 20;

type Item = { key: string; name: string; size: number; image: boolean; preview?: string; state: "uploading" | "done" | "error"; id?: string; problem?: "too_big" | "upload_failed" };

/** What a refused request says: the customer's own hourly limit, the help center's limit for everyone, or a
 * portal that was turned off while the form was open (contracts/customer-portal.md "Starting a request"). */
function failure(error: unknown) {
  if (isApiError(error, "rate_limited")) return "portal.new.limit" as const;
  if (isApiError(error, "portal_busy")) return "portal.new.busy" as const;
  if (isApiError(error, "not_found")) return "portal.unavailable" as const;
  return "portal.error" as const;
}

let seq = 0;
const size = (bytes: number) => (bytes < 1 << 20 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1 << 20)).toFixed(1)} MB`);

export function NewRequest({ slug }: { slug: string }) {
  const { t } = useTranslation("public");
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [full, setFull] = useState(false);
  const [over, setOver] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const live = useRef(items);
  live.current = items;
  useEffect(() => () => live.current.forEach((i) => i.preview && URL.revokeObjectURL(i.preview)), []);

  const patch = (key: string, p: Partial<Item>) => setItems((cur) => cur.map((i) => (i.key === key ? { ...i, ...p } : i)));
  const addFiles = (files: File[]) => {
    setFull(false);
    const room = MAX_FILES - live.current.filter((i) => i.state !== "error").length;
    if (files.length > room) setFull(true);
    for (const file of files.slice(0, Math.max(room, 0))) {
      const key = String(++seq);
      const image = file.type.startsWith("image/");
      const item: Item = { key, name: file.name || "file", size: file.size, image, preview: image ? URL.createObjectURL(file) : undefined, state: "uploading" };
      if (file.size > MAX_FILE_BYTES) {
        setItems((cur) => [...cur, { ...item, state: "error", problem: "too_big" }]);
        continue;
      }
      setItems((cur) => [...cur, item]);
      customerPortal.upload(slug, file).then((up) => patch(key, { state: "done", id: up.id }), () => patch(key, { state: "error", problem: "upload_failed" }));
    }
  };
  const remove = (item: Item) => {
    if (item.preview) URL.revokeObjectURL(item.preview);
    setFull(false);
    setItems((cur) => cur.filter((i) => i.key !== item.key));
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    addFiles([...e.dataTransfer.files]);
  };
  // A screenshot pasted into the message is a file on the clipboard; pasted text stays text.
  const onPaste = (e: ClipboardEvent) => {
    const files = [...e.clipboardData.files];
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  };

  const uploading = items.some((i) => i.state === "uploading");
  const ids = items.filter((i) => i.state === "done" && i.id).map((i) => i.id!);
  const create = useMutation({
    mutationFn: () => customerPortal.create(slug, subject.trim(), body.trim(), ids),
    onSuccess: (ticket) => {
      void qc.invalidateQueries({ queryKey: ["customerPortal", slug] });
      void navigate({ to: "/portal/$slug/tickets/$ticketId", params: { slug, ticketId: ticket.id } });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (subject.trim() && body.trim() && !uploading && !create.isPending) create.mutate();
  };
  return (
    <div className="mx-auto w-full max-w-xl">
      <Link to="/portal/$slug" params={{ slug }} className={`mb-5 inline-block text-sm ${publicTextLink}`}>{t("portal.back_requests")}</Link>
      <h1 className="text-pretty text-2xl font-semibold">{t("portal.new.title")}</h1>
      <form className="mt-6 flex flex-col gap-4" onSubmit={submit} onPaste={onPaste}>
        {create.isError && <Notice>{t(failure(create.error))}</Notice>}
        <label className="text-sm font-medium">
          {t("portal.new.subject")}
          <TextInput className="mt-1.5" name="subject" maxLength={200} required value={subject} onChange={(e) => setSubject(e.target.value)} />
        </label>
        <label className="text-sm font-medium">
          {t("portal.new.message")}
          <Textarea className="mt-1.5 min-h-40" name="body" maxLength={10000} required value={body} onChange={(e) => setBody(e.target.value)} />
        </label>
        <div
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
          data-over={over || undefined}
          className="rounded-md border border-dashed border-line-strong p-3 transition-colors data-[over]:border-fg-3 data-[over]:bg-hover"
        >
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-fg-3">{t("portal.new.drop")}</p>
            <Button type="button" variant="secondary" size="sm" icon={<Paperclip className="size-3.5" />} disabled={items.length >= MAX_FILES} onClick={() => picker.current?.click()}>
              {t("portal.new.attach")}
            </Button>
            <input ref={picker} type="file" multiple hidden onChange={(e) => { addFiles([...(e.target.files ?? [])]); e.target.value = ""; }} />
          </div>
          {full && <p className="mt-2 text-xs text-danger-fg" role="alert">{t("portal.new.max_files")}</p>}
          {items.length > 0 && (
            <ul className="mt-3 flex flex-col gap-2">
              {items.map((i) => (
                <li key={i.key} className="flex items-center gap-3 text-sm">
                  {i.preview ? <img src={i.preview} alt="" className="size-10 shrink-0 rounded-sm border border-line object-cover" /> : <span className="flex size-10 shrink-0 items-center justify-center rounded-sm border border-line text-fg-3"><FileText className="size-4" aria-hidden /></span>}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate"><bdi>{i.name}</bdi></span>
                    <span className={`block text-xs ${i.state === "error" ? "text-danger-fg" : "text-fg-4"}`} role={i.state === "error" ? "alert" : undefined}>
                      {i.state === "uploading" ? t("portal.new.uploading") : i.problem === "too_big" ? t("portal.new.too_big", { name: i.name }) : i.problem === "upload_failed" ? t("portal.new.upload_failed", { name: i.name }) : size(i.size)}
                    </span>
                  </span>
                  <button type="button" aria-label={t("portal.new.remove", { name: i.name })} onClick={() => remove(i)} className="flex size-7 items-center justify-center rounded-sm text-fg-4 hover:bg-hover hover:text-fg focus-visible:shadow-[0_0_0_3px_var(--focus)]">
                    <X className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <Button variant="primary" size="lg" type="submit" loading={create.isPending} disabled={!subject.trim() || !body.trim() || uploading || create.isPending}>
          {t("portal.new.send")}
        </Button>
      </form>
    </div>
  );
}

// Feedback on an AI draft (contracts/collab.md "AI draft outcomes"): on a sent message that
// began as one, or on one a person discarded, replaced or abandoned. What was wrong with the
// draft and, optionally, a better answer. The key that wrote the draft reads it back from
// its outcome feed; opendesk itself trains nothing.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MessageSquareText } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api/endpoints";
import type { AIDraftFeedbackReason, AIDraftRef, MailMessage } from "@/lib/api/types";
import { escapeHtml } from "@/lib/collab/html";
import { qk } from "@/lib/queries";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";

const reasons: AIDraftFeedbackReason[] = ["wrong_facts", "wrong_tone", "missing_info", "should_not_answer", "other"];
const noteMax = 1000;

const textHtml = (text: string) =>
  text
    .trim()
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");

/** The line under a sent message's header: which AI drafted it, and a way to say how it did. */
export function AIDraftFeedback({ m }: { m: MailMessage }) {
  const { t } = useTranslation("collab");
  const d = m.ai_draft;
  if (!d || m.draft) return null;
  const how = d.outcome === "sent_unchanged" ? t("aiFeedback.asWritten") : d.outcome === "sent_edited" ? t("aiFeedback.edited") : "";
  return <FeedbackLine draft={d} threadId={m.thread_id} how={how} />;
}

/**
 * A conversation's AI draft that was not used (discarded, replaced or abandoned) and is
 * gone: the same line, so feedback on it stays reachable (GH#437).
 */
export function UnusedAIDraft({ draft, threadId }: { draft: AIDraftRef; threadId: string }) {
  const { t } = useTranslation("collab");
  const how = draft.outcome === "discarded" ? t("aiFeedback.discarded") : draft.outcome === "replaced" ? t("aiFeedback.replaced") : t("aiFeedback.abandoned");
  return (
    <div className="flex min-h-7 items-center px-1 text-[11.5px]">
      <FeedbackLine draft={draft} threadId={threadId} how={how} />
    </div>
  );
}

function FeedbackLine({ draft, threadId, how }: { draft: AIDraftRef; threadId: string; how: string }) {
  const { t } = useTranslation("collab");
  const [open, setOpen] = useState(false);
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 text-fg-4">
      <span data-text className="cursor-text select-text truncate">
        {t("aiFeedback.from", { name: draft.client })}
        {how && ` · ${how}`}
      </span>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex shrink-0 items-center gap-1 rounded-sm px-1 text-fg-3 outline-none hover:bg-hover hover:text-fg focus-visible:shadow-[0_0_0_2px_var(--focus)]"
      >
        <MessageSquareText className="size-3" />
        {draft.has_feedback ? t("aiFeedback.edit") : t("aiFeedback.give")}
      </button>
      <AIDraftFeedbackDialog draft={draft} threadId={threadId} open={open} onOpenChange={setOpen} />
    </span>
  );
}

/** Feedback on one AI draft; `defaultReason` preselects a reason (a discard suggests "should not answer"). */
export function AIDraftFeedbackDialog({
  draft,
  threadId,
  open,
  onOpenChange,
  defaultReason,
}: {
  draft: AIDraftRef;
  threadId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  defaultReason?: AIDraftFeedbackReason;
}) {
  const { t } = useTranslation("collab");
  const qc = useQueryClient();
  const [reason, setReason] = useState<AIDraftFeedbackReason | undefined>();
  const [note, setNote] = useState("");
  const [better, setBetter] = useState("");
  useEffect(() => {
    if (!open) return;
    setReason(defaultReason);
    setNote("");
    setBetter("");
  }, [open, defaultReason]);

  const save = useMutation({
    mutationFn: (r: AIDraftFeedbackReason) =>
      api.collab.aiDraftFeedback(draft.id, {
        reason: r,
        note: note.trim() || undefined,
        better_answer_html: better.trim() ? textHtml(better) : undefined,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.mailThread(threadId) });
      toast.success(t("toast.aiFeedbackSaved"));
      onOpenChange(false);
    },
    onError: (e) => toast.error(e),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("aiFeedback.title")}
      description={t("aiFeedback.description", { name: draft.client })}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("comments.cancel")}
          </Button>
          <Button variant="primary" disabled={!reason} loading={save.isPending} onClick={() => reason && save.mutate(reason)}>
            {t("aiFeedback.save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 pb-2">
        <label className="flex flex-col gap-1.5 text-[12.5px] font-medium">
          {t("aiFeedback.reason")}
          <Select
            value={reason}
            onChange={setReason}
            placeholder={t("aiFeedback.reasonPlaceholder")}
            aria-label={t("aiFeedback.reason")}
            options={reasons.map((r) => ({ value: r, label: t(`aiFeedback.reasons.${r}`) }))}
          />
        </label>
        <label className="flex flex-col gap-1.5 text-[12.5px] font-medium">
          {t("aiFeedback.note")}
          <Textarea value={note} maxLength={noteMax} rows={3} onChange={(e) => setNote(e.target.value)} placeholder={t("aiFeedback.notePlaceholder")} />
        </label>
        <label className="flex flex-col gap-1.5 text-[12.5px] font-medium">
          {t("aiFeedback.better")}
          <Textarea value={better} rows={5} onChange={(e) => setBetter(e.target.value)} placeholder={t("aiFeedback.betterPlaceholder")} />
        </label>
        <p className="text-[11.5px] text-fg-4">{t("aiFeedback.privacy")}</p>
      </div>
    </Dialog>
  );
}

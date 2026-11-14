import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { format } from "date-fns";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { DateField, TimeField, parseTime } from "@/components/ui/date-picker";
import { toast } from "@/components/ui/toast";
import { api } from "@/lib/api/endpoints";
import type { ReplyDraft } from "@/lib/api/types";
import { fullDate } from "@/lib/format";
import { qk } from "@/lib/queries";

export function ScheduleReplyDialog({ open, onOpenChange, busy, onSchedule }: { open: boolean; onOpenChange: (open: boolean) => void; busy: boolean; onSchedule: (at: string) => void }) {
  const { t } = useTranslation("inbox");
  const [day, setDay] = useState(() => format(new Date(Date.now() + 3600000), "yyyy-MM-dd"));
  const [time, setTime] = useState(() => format(new Date(Date.now() + 3600000), "HH:mm"));
  const parts = parseTime(time);
  const at = day && parts ? new Date(`${day}T00:00:00`) : null;
  if (at && parts) at.setHours(parts[0], parts[1], 0, 0);
  const valid = at && Number.isFinite(at.getTime()) && at.getTime() > Date.now() + 60000 && at.getTime() <= Date.now() + 365 * 86400000;
  return <Dialog open={open} onOpenChange={onOpenChange} title={t("composer.sendLater")} description={t("composer.scheduleHint", { zone: Intl.DateTimeFormat().resolvedOptions().timeZone })} footer={<Button disabled={!valid || busy} onClick={() => valid && onSchedule(at.toISOString())}>{t("composer.scheduleReply")}</Button>}>
    <div className="flex gap-3"><DateField value={day} onChange={setDay} aria-label={t("composer.sendDate")} /><TimeField value={time} onChange={setTime} aria-label={t("composer.sendTime")} /></div>
  </Dialog>;
}

export function ScheduledReplyControls({ ticketId, draft, onSent }: { ticketId: string; draft: ReplyDraft | null | undefined; onSent: () => void }) {
  const { t } = useTranslation("inbox");
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const change = useMutation({
    mutationFn: async ({ action, at }: { action: "send" | "cancel" | "move"; at?: string }) => {
      if (action === "send") { await api.tickets.replyDraft.sendScheduled(ticketId); return null; }
      return (action === "cancel" ? await api.tickets.replyDraft.unschedule(ticketId) : await api.tickets.replyDraft.schedule(ticketId, at!)).draft;
    },
    onSuccess: (saved, { action }) => { if (action === "send") onSent(); qc.setQueryData(qk.replyDraft(ticketId), saved); void qc.invalidateQueries({ queryKey: qk.messages(ticketId) }); setOpen(false); },
    onError: (e) => toast.error(e),
  });
  if (!draft?.schedule) return draft?.send_error ? <p role="alert" className="mb-2 text-xs text-tone-amber">{t(`composer.scheduleError.${draft.send_error}`, { defaultValue: t("composer.scheduleFailed") })}</p> : null;
  return <div role="status" className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-line bg-sunken px-3 py-2 text-xs">
    <span className="mr-auto">{t("composer.scheduledFor", { time: fullDate(draft.schedule.send_at) })}</span>
    <Button size="xs" variant="secondary" disabled={change.isPending} onClick={() => change.mutate({ action: "send" })}>{t("composer.sendNow")}</Button>
    <Button size="xs" variant="ghost" disabled={change.isPending} onClick={() => setOpen(true)}>{t("composer.changeTime")}</Button>
    <Button size="xs" variant="ghost" disabled={change.isPending} onClick={() => change.mutate({ action: "cancel" })}>{t("composer.cancelSchedule")}</Button>
    <ScheduleReplyDialog open={open} onOpenChange={setOpen} busy={change.isPending} onSchedule={(at) => change.mutate({ action: "move", at })} />
  </div>;
}

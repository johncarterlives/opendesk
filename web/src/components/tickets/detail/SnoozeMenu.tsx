import { useQuery } from "@tanstack/react-query";
import { setHours, setMinutes, format } from "date-fns";
import { AlarmClock } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Popover } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { DateField, TimeField, parseDay, parseTime } from "@/components/ui/date-picker";
import { Tooltip } from "@/components/ui/tooltip";
import { weekdayClock } from "@/lib/format";
import { q } from "@/lib/queries";
import { snoozeAt, snoozeLabel, snoozePresets } from "./snooze";

export function SnoozeMenu({
  onSnooze,
  disabled,
  open: openProp,
  onOpenChange,
  unavailable,
  unavailableAction,
  trigger,
  note,
  heading,
  submitLabel,
}: {
  onSnooze: (at: Date) => void;
  disabled?: boolean;
  open?: boolean;
  onOpenChange?: (o: boolean) => void;
  /** Why Snooze cannot be used here: the button stays, greyed out, and opens on why instead of the choices. */
  unavailable?: string;
  /** Under the reason, e.g. a link to where it is turned on. */
  unavailableAction?: ReactNode;
  /** A trigger of the caller's own (a Tooltip around a button), e.g. a list row's hover button. */
  trigger?: ReactNode;
  /** A line under the choices, e.g. that a snooze set at the provider is not seen here. */
  note?: string;
  heading?: string;
  submitLabel?: string;
}) {
  const { t } = useTranslation("inbox");
  const [innerOpen, setInnerOpen] = useState(false);
  const open = openProp ?? innerOpen;
  const setOpen = (o: boolean) => {
    setInnerOpen(o);
    onOpenChange?.(o);
  };
  const [day, setDay] = useState("");
  const [time, setTime] = useState("09:00");
  const custom = (() => {
    const d = parseDay(day);
    const t = parseTime(time);
    return d && t ? setMinutes(setHours(d, t[0]), t[1]) : null;
  })();
  const valid = !!custom && custom.getTime() > Date.now();
  const { data: workspace } = useQuery(q.workspace());
  const now = new Date();
  const opts = snoozePresets(workspace?.settings).map((p) => ({ label: snoozeLabel(p, t), at: snoozeAt(p, now) }));
  if (unavailable) {
    // Greyed out but still a button: tap, click or keyboard opens the reason, which a tooltip alone would hide on touch.
    return (
      <Popover
        open={open}
        onOpenChange={setOpen}
        align="end"
        className="w-[248px] p-2.5"
        trigger={
          trigger ?? <Tooltip content={unavailable}>
            <Button variant="ghost" size="sm" square aria-disabled="true" aria-label={`${t("snooze.title")}: ${unavailable}`} icon={<AlarmClock className="size-3.5 opacity-40" />} />
          </Tooltip>
        }
      >
        <p className="text-[12px] leading-snug text-fg-2">{unavailable}</p>
        {unavailableAction && (
          <div className="mt-2 text-[12px]" onClick={() => setOpen(false)}>
            {unavailableAction}
          </div>
        )}
      </Popover>
    );
  }
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      className="w-[264px] p-1"
      trigger={
        trigger ?? (
          <Tooltip content={t("snooze.title")} shortcut="ticket.snooze">
            <Button variant="ghost" size="sm" square aria-label={t("snooze.title")} disabled={disabled} icon={<AlarmClock className="size-3.5" />} />
          </Tooltip>
        )
      }
    >
      <div className="label-caps px-2 pb-1 pt-1.5">{heading ?? t("snooze.until")}</div>
      {opts.map((o, i) => (
        <button
          key={i}
          type="button"
          onClick={() => {
            onSnooze(o.at);
            setOpen(false);
          }}
          className="flex h-8 w-full items-center justify-between rounded-md px-2 text-[12.5px] outline-none transition-colors hover:bg-hover focus-visible:bg-hover"
        >
          {o.label}
          <span className="mono text-[11px] text-fg-4">{weekdayClock(o.at)}</span>
        </button>
      ))}
      <div className="mt-1 border-t border-line p-1.5 pt-2">
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) {
              onSnooze(custom);
              setOpen(false);
            }
          }}
        >
          <DateField size="sm" value={day} onChange={setDay} min={format(new Date(), "yyyy-MM-dd")} placeholder={t("snooze.pickDay")} aria-label={t("snooze.until")} className="min-w-0 flex-1" />
          <TimeField size="sm" value={time} onChange={setTime} aria-label={t("snooze.time")} />
          <Button type="submit" size="sm" disabled={!valid}>
            {submitLabel ?? t("snooze.set")}
          </Button>
        </form>
      </div>
      {note && <p className="border-t border-line px-2 pb-1.5 pt-2 text-[11.5px] leading-snug text-fg-3">{note}</p>}
    </Popover>
  );
}

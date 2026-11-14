// The composer's send control: Send, a menu that sends and sets a status, and, where the
// workspace asks for it (settings.send_and_finish_button), sending and finishing on a segment
// of its own before Send ("Send and solve", "Send and close"). To keep that segment in view on
// a narrow reply box the formatting buttons fold into one first; only where even that leaves
// no room does it go back into the menu.

import { Check, ChevronDown, Loader2 } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DropdownMenu as M } from "radix-ui";
import { Morph } from "@/components/motion";
import { Button, buttonVariants } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { floatingPanel } from "@/components/ui/popover";
import { Tooltip } from "@/components/ui/tooltip";
import type { TicketStatus } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { StatusIcon } from "../bits";
import { useDisplay } from "../fields";
import { SideIncludeItems, useIncludeSummary, type SideInclude } from "./SideIncludes";

type Phase = "idle" | "sending" | "sent";

/**
 * Where the finish segment sits on the editor's toolbar: "wide" beside every formatting
 * button, "folded" with the formatting buttons folded into one, "menu" back in the send menu.
 */
export type SendLayout = "wide" | "folded" | "menu";

/**
 * What the send control offers besides Send: the statuses its menu sends with, and the
 * finishing one on a segment of its own when the workspace wants it there and it fits. A side
 * conversation only puts the ticket on hold; nothing offers the status the ticket is in.
 */
export function sendChoices(o: {
  side: boolean;
  current: TicketStatus;
  finish: ReturnType<typeof useDisplay>["finish"];
  hidden: (s: TicketStatus) => boolean;
  button: boolean;
  fits: boolean;
}): { button: TicketStatus | null; menu: TicketStatus[] } {
  const statuses: TicketStatus[] = o.side ? ["on_hold"] : ["pending", "on_hold", o.finish];
  const options = statuses.filter((s) => s !== o.current && !o.hidden(s));
  const own = o.button && o.fits && options.includes(o.finish) ? o.finish : null;
  return { button: own, menu: options.filter((s) => s !== own) };
}

/**
 * The layout to take from what the current one leaves free. `slack` is the room before the
 * toolbar's end slot, which stays 0 once the row is squeezed; `button` the finish segment's
 * width; `saved` what folding the formatting buttons frees. A squeezed layout steps down, and
 * `blocked` (layouts found squeezed at this very width) are not taken again, so it settles.
 */
export function nextLayout(cur: SendLayout, slack: number, button: number, saved: number, blocked: ReadonlySet<SendLayout> = new Set()): SendLayout {
  const ok = (l: SendLayout) => !blocked.has(l);
  // Squeezed: from wide try folded; with no segment the row is too narrow already.
  if (slack < 1) return cur === "wide" && saved > 0 && ok("folded") ? "folded" : "menu";
  // The room with every formatting button and no segment.
  const base = slack + (cur === "menu" ? 0 : button) - (cur === "folded" ? saved : 0);
  if (ok("wide") && base >= button + 1) return "wide";
  if (ok("folded") && saved > 0 && base + saved >= button + 1) return "folded";
  return "menu";
}

export function SendButton({
  note,
  sideTo,
  include,
  disabled,
  busy,
  onSend,
  onSchedule,
  current,
  phase,
  sentWith,
  folded = false,
  onFold,
}: {
  note: boolean;
  /** A side conversation's recipients: it goes to them only, and only "on hold" (waiting on a third party) rides along. */
  sideTo?: string[];
  /** Starting a side conversation: what of the customer's conversation can go along. */
  include?: SideInclude;
  disabled: boolean;
  busy: boolean;
  onSend: (s?: TicketStatus) => void;
  onSchedule?: () => void;
  current: TicketStatus;
  phase: Phase;
  /** The status the last send set, so its own segment shows the spinner and the check. */
  sentWith?: TicketStatus;
  /** The editor's formatting buttons are folded into one (RichEditor toolbarFolded). */
  folded?: boolean;
  /** Asks for the formatting buttons to fold, to make room for the finish segment. */
  onFold?: (fold: boolean) => void;
}) {
  const { t } = useTranslation("inbox");
  useTranslation("indicators");
  const side = !!sideTo;
  const label = note ? t("composer.addNote") : t("composer.send");
  const display = useDisplay();
  const finish = display.finish;
  const root = useRef<HTMLDivElement>(null);
  const ghost = useRef<HTMLSpanElement>(null);
  const choose = (fits: boolean) => sendChoices({ side, current, finish, hidden: display.hidden, button: display.finishButton, fits });
  const wanted = choose(true).button !== null;
  const layout = useSendLayout(root, ghost, wanted, folded);
  const fold = wanted && layout === "folded";
  useLayoutEffect(() => onFold?.(fold), [fold, onFold]);
  const { button: own, menu: options } = choose(layout !== "menu");
  const includes = !!include && (include.quoted > 0 || include.files.length > 0);
  const menu = options.length > 0 || includes || !!onSchedule;
  const along = useIncludeSummary(include);
  const status = (s: TicketStatus) => display.status(s).toLowerCase();
  // The header's words for finishing: "Send and solve", "Send and close", "Send and mark as Done".
  const words = display.finishWords;
  const finishText = note ? t(`composer.noteAndFinish.${words.verb}`, { status: display.status(finish) }) : words.sendTip();
  const ownPhase: Phase = own && sentWith === own ? phase : "idle";
  const hint = busy
    ? t("composer.waitUploads")
    : note
      ? t("composer.addNote")
      : side
        ? sideTo.length
          ? t("composer.sendTo", { to: sideTo.join(", ") }) + (along ? ` ${along}` : "")
          : t("composer.addRecipient")
        : t("composer.sendReply");
  return (
    <div ref={root} className="relative flex items-center">
      {own && (
        <Tooltip content={busy ? t("composer.waitUploads") : finishText} shortcut="mod shift enter">
          <Button
            data-send-finish=""
            variant="secondary"
            size="sm"
            disabled={disabled && phase === "idle"}
            onClick={() => onSend(own)}
            className="rounded-r-none border-r-0 shadow-none active:scale-[0.97]"
          >
            <PhaseLabel label={finishText} phase={ownPhase} />
          </Button>
        </Tooltip>
      )}
      {/* Measures the segment while it is in the menu, so it comes back once there is room. */}
      {wanted && (
        <span ref={ghost} aria-hidden className={cn(buttonVariants({ variant: "secondary", size: "sm" }), "pointer-events-none invisible absolute right-0 top-0 rounded-r-none border-r-0")}>
          {finishText}
        </span>
      )}
      <Tooltip content={hint} shortcut="mod enter">
        <Button
          variant="primary"
          size="sm"
          disabled={disabled && phase === "idle"}
          onClick={() => onSend()}
          className={cn(own && "rounded-l-none", menu && "rounded-r-none", "active:scale-[0.97]")}
        >
          <PhaseLabel label={label} phase={ownPhase === "idle" ? phase : "idle"} />
        </Button>
      </Tooltip>
      {menu && (
        <M.Root>
          {/* Choosing what goes along works before the draft can be sent. */}
          <Tooltip content={includes ? t("side.optionsHint") : undefined}>
            <M.Trigger asChild disabled={disabled && !includes}>
              <Button
                variant="primary"
                size="sm"
                square
                aria-label={includes ? t("side.options") : t("composer.andStatus", { label })}
                className="rounded-l-none border-l border-white/15 dark:border-black/15"
                icon={<ChevronDown className="size-3.5" />}
              />
            </M.Trigger>
          </Tooltip>
          <M.Portal>
            <M.Content side="top" align="end" sideOffset={6} className={cn(floatingPanel, includes ? "w-[300px]" : "min-w-[230px]", "p-1")}>
              {onSchedule && <M.Item disabled={disabled} onSelect={onSchedule} className="flex h-8 cursor-default items-center rounded-md px-2 text-[12.5px] outline-none data-[highlighted]:bg-hover">{t("composer.sendLater")}</M.Item>}
              {includes && <SideIncludeItems inc={include} />}
              {includes && options.length > 0 && <M.Separator className="-mx-1 my-1 h-px bg-line" />}
              {options.length > 0 && <div className="label-caps px-2 pb-1 pt-1.5">{t("composer.andStatus", { label })}</div>}
              {options.map((s) => (
                <M.Item key={s} disabled={disabled} onSelect={() => onSend(s)} className="flex h-8 cursor-default items-center gap-2 rounded-md px-2 text-[12.5px] outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-hover">
                  <StatusIcon status={s} />
                  <span className="flex-1 whitespace-nowrap">{t("composer.andMark", { label, status: status(s) })}</span>
                  {s === finish && <Kbd className="ml-3 shrink-0">mod shift enter</Kbd>}
                </M.Item>
              ))}
            </M.Content>
          </M.Portal>
        </M.Root>
      )}
    </div>
  );
}

/** A button's label; it keeps the width while the spinner and check swap in. */
function PhaseLabel({ label, phase }: { label: string; phase: Phase }) {
  const { t } = useTranslation("inbox");
  return (
    <span className="relative inline-grid place-items-center">
      <span className={cn("col-start-1 row-start-1 transition-opacity", phase !== "idle" && "opacity-0")}>{label}</span>
      <span className="col-start-1 row-start-1 flex">
        <Morph k={phase}>
          {phase === "sending" ? (
            <Loader2 className="size-3.5 animate-spin" aria-label={t("composer.sending")} />
          ) : phase === "sent" ? (
            <Check className="size-3.5" strokeWidth={2.5} aria-label={t("composer.sent")} />
          ) : null}
        </Morph>
      </span>
    </span>
  );
}

/**
 * The finish segment's layout on the editor's toolbar row (see nextLayout). The room is the
 * slack the row leaves before its end slot (its auto margin); the segment's width comes from
 * its invisible copy, and what folding saves from the formatting buttons' extent measured
 * both ways (one 28 px button until the folded one was seen).
 */
function useSendLayout(root: React.RefObject<HTMLDivElement | null>, ghost: React.RefObject<HTMLSpanElement | null>, wanted: boolean, folded: boolean): SendLayout {
  const [layout, setLayout] = useState<SendLayout>("wide");
  const seen = useRef({ full: 0, folded: 0, button: 0, blocked: new Map<SendLayout, number>() });
  useLayoutEffect(() => {
    const el = root.current;
    const end = el?.parentElement;
    const row = end?.parentElement;
    if (!wanted || !el || !end || !row || typeof ResizeObserver === "undefined") return;
    const px = (v: string) => parseFloat(v) || 0;
    const measure = () => {
      const g = ghost.current;
      if (!g) return;
      const m = seen.current;
      const rs = getComputedStyle(row);
      const left = row.getBoundingClientRect().left + px(rs.paddingLeft);
      const prev = end.previousElementSibling;
      const start = prev ? prev.getBoundingClientRect().right + px(rs.columnGap) : left;
      const slack = end.getBoundingClientRect().left - start;
      const cur: SendLayout = !el.querySelector("[data-send-finish]") ? "menu" : folded ? "folded" : "wide";
      if (folded) m.folded = start - left;
      else m.full = start - left;
      const button = g.getBoundingClientRect().width;
      const width = row.clientWidth;
      // A layout found squeezed stays off while the row keeps that width and the label its words.
      if (button !== m.button) m.blocked.clear();
      m.button = button;
      for (const [l, w] of m.blocked) if (width !== w) m.blocked.delete(l);
      if (slack < 1 && cur !== "menu") m.blocked.set(cur, width);
      const saved = Math.max(0, m.full - (m.folded || 28 + px(rs.columnGap)));
      setLayout(nextLayout(cur, slack, button, saved, new Set(m.blocked.keys())));
    };
    measure();
    const ro = new ResizeObserver(measure);
    for (const n of [row, end, el, ghost.current]) if (n) ro.observe(n);
    return () => ro.disconnect();
  }, [root, ghost, wanted, folded]);
  return layout;
}

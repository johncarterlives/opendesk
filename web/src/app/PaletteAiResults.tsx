import { Command } from "cmdk";
import { ArrowRight, FileText } from "lucide-react";
import { useTranslation } from "react-i18next";
import { AiIcon, useCostLabel } from "@/components/ai/bits";
import { StatusIcon } from "@/components/tickets/bits";
import { Requester } from "@/components/tickets/requester";
import { Kbd } from "@/components/ui/kbd";
import type { SearchResults } from "@/lib/api/types";
import type { AppHit } from "@/lib/appSearch";
import { cn } from "@/lib/cn";
import { relShort } from "@/lib/format";
import { AI_TONE, tone } from "@/lib/tones";
import { groupCls, HitItem, Item } from "./paletteItems";

/**
 * Ask AI: places in the app and docs sections that answer a question about opendesk (the
 * app's own search, no AI), Ollie's short answer from them on request (POST /v1/ai/app-help),
 * and tickets and articles related by meaning (GET /v1/ai/search).
 */
export function AiResults({
  query,
  pending,
  data,
  error,
  ticket,
  article,
  onExample,
  places,
  docs,
  hitLink,
  assistant,
  answer,
  onAnswer,
}: {
  query: string;
  onExample: (q: string) => void;
  pending: boolean;
  data: SearchResults | undefined;
  error: boolean;
  places: AppHit[];
  docs: AppHit[];
  hitLink: (h: AppHit) => { href?: string; onSelect: () => void };
  assistant: string;
  /** Ollie's answer to this query, once asked. */
  answer: { pending: boolean; text?: string; error: boolean } | null;
  onAnswer: () => void;
  /** A ticket's and an article's link (CommandPalette's link()). */
  ticket: (id: string) => { href: string; onSelect: () => void };
  article: (id: string) => { href: string; onSelect: () => void };
}) {
  const { t } = useTranslation("ai");
  const { t: tKb } = useTranslation("kb");
  const cost = useCostLabel()("app_help");
  const inApp = places.length + docs.length > 0;
  if (query.length < 2)
    return (
      <div className="animate-fade-in">
        <div className="flex items-center gap-2.5 px-2.5 pb-2 pt-2.5">
          <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-sm", tone[AI_TONE].soft)}>
            <AiIcon className="size-3.5" />
          </span>
          <p className="text-[12.5px] text-fg-3">{t("palette.start")}</p>
        </div>
        <Command.Group heading={t("palette.try")} className={groupCls}>
          {(["palette.example_1", "palette.example_2", "palette.example_3"] as const).map((k) => (
            <Item key={k} value={`ai example ${k}`} icon={<ArrowRight />} hint={<Kbd>enter</Kbd>} onSelect={() => onExample(t(k))}>
              <span className="truncate text-fg-2">{t(k)}</span>
            </Item>
          ))}
        </Command.Group>
      </div>
    );
  if (!data && pending && !inApp)
    return (
      <div className="flex flex-col gap-1 p-1" aria-live="polite" aria-label={t("palette.searching")}>
        <div className="px-1.5 pb-1.5 pt-2 text-[11.5px] font-medium text-fg-3">{t("palette.searching")}</div>
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex h-9 items-center gap-2.5 px-2.5">
            <span className="skeleton size-4 rounded-[3px]" />
            <span className="skeleton h-2.5" style={{ width: `${62 - i * 14}%` }} />
          </div>
        ))}
      </div>
    );
  const tickets = data?.tickets ?? [];
  const articles = data?.articles ?? [];
  if (!inApp && (error || (!tickets.length && !articles.length)))
    return <p className="px-6 py-10 text-center text-[13px] text-fg-3">{error ? t("palette.error") : t("palette.empty")}</p>;
  const heading = (label: string) => (
    <span className="flex items-center gap-1.5">
      <AiIcon className="size-3" />
      {label}
    </span>
  );
  return (
    <div className={pending ? "opacity-60 transition-opacity" : "transition-opacity"}>
      {answer && (
        <div className={cn("mx-1 mb-1 mt-1.5 rounded-lg px-3 py-2.5 animate-fade-in", tone[AI_TONE].soft)} aria-live="polite">
          <div className="mb-1 flex items-center gap-1.5 text-[11.5px] font-medium">
            <AiIcon className="size-3" />
            {assistant}
          </div>
          {answer.pending ? (
            <p className="text-[12.5px] text-fg-3">{t("palette.answering", { name: assistant })}</p>
          ) : answer.error || !answer.text ? (
            <p className="text-[12.5px] text-fg-3">{t("palette.answer_error")}</p>
          ) : (
            <p className="whitespace-pre-line text-[13px] leading-[19px] text-fg" data-ph-mask>
              {answer.text}
            </p>
          )}
        </div>
      )}
      {inApp && !answer && (
        <Command.Group className={groupCls}>
          <Item value="ai answer from the app" icon={<AiIcon />} hint={cost || <Kbd>enter</Kbd>} onSelect={onAnswer}>
            <span className="truncate">{t("palette.answer_item", { name: assistant })}</span>
          </Item>
        </Command.Group>
      )}
      {places.length > 0 && (
        <Command.Group heading={t("palette.inApp")} className={groupCls}>
          {places.map((h) => (
            <HitItem key={h.id} hit={h} query="" {...hitLink(h)} />
          ))}
        </Command.Group>
      )}
      {docs.length > 0 && (
        <Command.Group heading={t("palette.docs")} className={groupCls}>
          {docs.map((h) => (
            <HitItem key={h.id} hit={h} query="" {...hitLink(h)} />
          ))}
        </Command.Group>
      )}
      {tickets.length > 0 && (
        <Command.Group heading={heading(t("palette.tickets"))} className={groupCls}>
          {tickets.map((x) => (
            <Item
              key={x.id}
              value={`ai ticket ${x.id}`}
              icon={<StatusIcon status={x.status} />}
              hint={<span className="mono inline-block text-right sm:min-w-[12ch]">{relShort(x.last_message_at)}</span>}
              {...ticket(x.id)}
            >
              <span className="mono shrink-0 text-xs text-fg-3">#{x.number}</span>
              <span className="truncate" data-ph-mask>
                {x.subject}
              </span>
              <Requester contact={x.contact} className="ml-auto" />
            </Item>
          ))}
        </Command.Group>
      )}
      {articles.length > 0 && (
        <Command.Group heading={heading(t("palette.articles"))} className={groupCls}>
          {articles.map((a) => (
            <Item key={a.id} value={`ai article ${a.id}`} icon={<FileText />} hint={a.status === "draft" ? tKb("status.draft") : undefined} {...article(a.id)}>
              <span className="truncate">{a.title}</span>
              {a.excerpt && <span className="hidden min-w-0 truncate text-xs text-fg-3 sm:inline">{a.excerpt}</span>}
            </Item>
          ))}
        </Command.Group>
      )}
    </div>
  );
}

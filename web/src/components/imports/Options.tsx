// What an import brings and how: tickets, articles and files, from when, with which
// label and statuses, and the mailbox replies go out from.

import { useTranslation } from "react-i18next";
import { Row } from "@/components/layout";
import { Badge } from "@/components/ui/badge";
import { DateField } from "@/components/ui/date-picker";
import { TextInput } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Segmented } from "@/components/ui/tabs";
import type { ImportCheck, ImportOptions, ImportSource, Mailbox } from "@/lib/api/types";
import { number } from "@/lib/format";

const DEFAULT_MAILBOX = "__default";

export function defaultOptions(source: ImportSource, check: ImportCheck | null): ImportOptions {
  return {
    tickets: true,
    articles: source !== "csv" && !!check?.has_articles,
    attachments: true,
    since: null,
    mailbox_id: null,
    tag: `${source}-import`,
    statuses: "keep",
    articles_as_drafts: false,
  };
}

export function OptionsForm({
  source,
  check,
  value,
  onChange,
  mailboxes,
}: {
  source: ImportSource;
  check: ImportCheck;
  value: ImportOptions;
  onChange: (o: ImportOptions) => void;
  mailboxes: Mailbox[];
}) {
  const { t } = useTranslation("imports");
  const set = <K extends keyof ImportOptions>(k: K, v: ImportOptions[K]) => onChange({ ...value, [k]: v });
  const tickets = check.totals.tickets;
  const articles = check.totals.articles;
  const csv = source === "csv";
  return (
    <div className="flex flex-col gap-6">
      <section>
        <h3 className="mb-2 text-[13px] font-semibold tracking-[-0.01em]">{t("options.what")}</h3>
        <div className="overflow-hidden rounded-lg border border-line bg-surface px-4 py-0.5 shadow-xs">
          <Row
            label={t("options.tickets")}
            description={tickets !== null ? t("options.ticketsHint", { count: tickets, n: number(tickets) }) : t("options.ticketsHintUnknown")}
          >
            <Switch checked={value.tickets} onCheckedChange={(v) => set("tickets", v)} aria-label={t("options.tickets")} />
          </Row>
          {!csv && (
            <Row
              label={t("options.articles")}
              description={
                check.has_articles
                  ? articles !== null
                    ? t("options.articlesHint", { count: articles, n: number(articles) })
                    : t("options.articlesHintUnknown")
                  : source === "freescout"
                    ? t("options.articlesUnsupported")
                    : source === "helpscout"
                    ? t("options.articlesNoDocs")
                    : t("options.articlesNone")
              }
            >
              <Switch checked={value.articles} disabled={!check.has_articles} onCheckedChange={(v) => set("articles", v)} aria-label={t("options.articles")} />
            </Row>
          )}
          {value.articles && (
            <Row label={t("options.drafts")} description={t("options.draftsHint")}>
              <Switch checked={value.articles_as_drafts} onCheckedChange={(v) => set("articles_as_drafts", v)} aria-label={t("options.drafts")} />
            </Row>
          )}
          {!csv && value.tickets && (
            <Row label={t("options.attachments")} description={t("options.attachmentsHint")}>
              <Switch checked={value.attachments} onCheckedChange={(v) => set("attachments", v)} aria-label={t("options.attachments")} />
            </Row>
          )}
        </div>
      </section>

      {value.tickets && (
        <section>
          <h3 className="mb-2 text-[13px] font-semibold tracking-[-0.01em]">{t("options.how")}</h3>
          <div className="overflow-hidden rounded-lg border border-line bg-surface px-4 py-0.5 shadow-xs">
            <Row label={t("options.since")} description={t("options.sinceHint")}>
              <div className="flex flex-wrap items-center gap-2">
                <Segmented
                  value={value.since === null ? "all" : "from"}
                  onChange={(v) => {
                    if (v === "all") return set("since", null);
                    const d = new Date();
                    d.setFullYear(d.getFullYear() - 2);
                    set("since", d.toISOString().slice(0, 10));
                  }}
                  options={[
                    { value: "all", label: t("options.allHistory") },
                    { value: "from", label: t("options.fromDate") },
                  ]}
                />
                {value.since !== null && (
                  <DateField className="w-[150px]" size="sm" aria-label={t("options.since")} value={value.since} max={new Date().toISOString().slice(0, 10)} onChange={(v) => set("since", v || null)} />
                )}
              </div>
            </Row>
            <Row label={t("options.statuses")} description={value.statuses === "keep" ? t("options.keepHint") : t("options.closedHint")}>
              <Segmented
                value={value.statuses}
                onChange={(v) => set("statuses", v)}
                options={[
                  { value: "keep", label: t("options.keep") },
                  { value: "closed", label: t("options.closeAll") },
                ]}
              />
            </Row>
            <Row label={t("options.label")} description={t("options.labelHint")} htmlFor="import-tag">
              <div className="flex items-center gap-2">
                <TextInput
                  id="import-tag"
                  inputSize="sm"
                  className="w-[180px]"
                  maxLength={50}
                  spellCheck={false}
                  placeholder={t("options.noLabel")}
                  value={value.tag}
                  onChange={(e) => set("tag", e.target.value)}
                />
                {value.tag.trim() && <Badge tone="violet">{value.tag.trim()}</Badge>}
              </div>
            </Row>
            {mailboxes.length > 0 && (
              <Row label={t("options.mailbox")} description={t("options.mailboxHint")}>
                <div className="w-[220px]">
                  <Select
                    size="sm"
                    aria-label={t("options.mailbox")}
                    value={value.mailbox_id ?? DEFAULT_MAILBOX}
                    onChange={(v) => set("mailbox_id", v === DEFAULT_MAILBOX ? null : v)}
                    options={[{ value: DEFAULT_MAILBOX, label: t("options.noMailbox") }, ...mailboxes.map((m) => ({ value: m.id, label: m.name || m.email, hint: m.email }))]}
                  />
                </div>
              </Row>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

/** One sentence on what starting will do. */
export function StartSummary({ check, options }: { check: ImportCheck; options: ImportOptions }) {
  const { t } = useTranslation("imports");
  const parts: string[] = [];
  if (options.tickets) parts.push(check.totals.tickets !== null ? t("summary.tickets", { count: check.totals.tickets, n: number(check.totals.tickets) }) : t("summary.ticketsUnknown"));
  if (options.articles) parts.push(check.totals.articles !== null ? t("summary.articles", { count: check.totals.articles, n: number(check.totals.articles) }) : t("summary.articlesUnknown"));
  return (
    <div className="rounded-lg border border-line bg-sunken px-4 py-3 text-[12.5px] leading-[19px] text-fg-2">
      <p>
        <span className="font-medium text-fg">{t("summary.lead", { what: parts.join(t("summary.and")) })}</span> {t("summary.quiet")}
      </p>
      <p className="mt-1 text-fg-3">{t("summary.after")}</p>
    </div>
  );
}

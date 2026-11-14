// Starting an import, one step at a time: connect (or upload and map columns), review
// what the source has and who maps to whom, choose what comes over, start. Nothing is
// stored until the last step.

import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingsPage } from "@/components/layout";
import { UnsavedGuard } from "@/components/settings2/UnsavedGuard";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { toast } from "@/components/ui/toast";
import { api } from "@/lib/api/endpoints";
import { ApiError, errorMessage } from "@/lib/api/client";
import type { CsvMapping, CsvUpload, Import, ImportCheck, ImportOptions, ImportSource } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { dur, ease } from "@/lib/motion";
import { q } from "@/lib/queries";
import { CredentialsForm, credentialErrors, credentialsReady } from "./Connect";
import { CsvColumns, CsvDrop } from "./Csv";
import { OptionsForm, StartSummary, defaultOptions } from "./Options";
import { AccountCard, MappingTable, SamplePreview, suggestedMapping } from "./Review";
import { DOCS, SourceMark, defaultCredentials, sourceName } from "./sources";

type Step = "connect" | "upload" | "columns" | "review" | "options";

function Steps({ steps, at }: { steps: Step[]; at: number }) {
  const { t } = useTranslation("imports");
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {steps.map((s, i) => (
        <li key={s} className="flex items-center gap-2">
          {i > 0 && <span aria-hidden className={cn("h-px w-6 transition-colors duration-200", i <= at ? "bg-fg-3" : "bg-line")} />}
          <span className={cn("flex items-center gap-1.5 text-[12px] transition-colors duration-200", i === at ? "font-medium text-fg" : i < at ? "text-fg-2" : "text-fg-4")} aria-current={i === at ? "step" : undefined}>
            <span
              className={cn(
                "flex size-[18px] items-center justify-center rounded-full text-[10px] font-semibold tabular-nums transition-colors duration-200",
                i < at ? "bg-inverse text-inverse-fg" : i === at ? "border border-fg text-fg" : "border border-line-strong text-fg-4",
              )}
            >
              {i < at ? <Check className="size-2.5" strokeWidth={3.5} /> : i + 1}
            </span>
            {t(`steps.${s}`)}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function ImportWizard({ source, onClose, onStarted }: { source: ImportSource; onClose: () => void; onStarted: (x: Import) => void }) {
  const { t } = useTranslation("imports");
  const reduce = useReducedMotion();
  const csv = source === "csv";
  const steps: Step[] = csv ? ["upload", "columns", "review", "options"] : ["connect", "review", "options"];
  const [at, setAt] = useState(0);
  const step = steps[at]!;
  const name = sourceName[source];

  const [creds, setCreds] = useState<Record<string, string>>(() => defaultCredentials(source));
  const [credErr, setCredErr] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState<File | null>(null);
  const [upload, setUpload] = useState<CsvUpload | null>(null);
  const [columns, setColumns] = useState<CsvMapping>({});
  const [check, setCheck] = useState<ImportCheck | null>(null);
  const [agents, setAgents] = useState<Record<string, string | null>>({});
  const [groups, setGroups] = useState<Record<string, string | null>>({});
  const [options, setOptions] = useState<ImportOptions>(() => defaultOptions(source, null));
  const [started, setStarted] = useState(false);

  const { data: members = [] } = useQuery(q.members());
  const { data: teams = [] } = useQuery(q.teams());
  const { data: mailboxes = [] } = useQuery(q.mailboxes());

  const go = (n: number) => {
    setError(null);
    setAt(n);
  };

  const runCheck = useMutation({
    mutationFn: () => api.imports.check(csv ? { source, upload_id: upload!.upload_id, mapping: columns } : { source, credentials: creds }),
    onSuccess: (c) => {
      // A new check of the same account keeps the choices made; another account starts over.
      const same = check && check.account.name === c.account.name && check.account.url === c.account.url;
      setCheck(c);
      if (!same) {
        const m = suggestedMapping(c);
        setAgents(m.agents);
        setGroups(m.groups);
        setOptions(defaultOptions(source, c));
      }
      go(steps.indexOf("review"));
    },
    onError: (e) => {
      const fe = credentialErrors(e);
      setCredErr(fe);
      setError(Object.keys(fe).length ? null : errorMessage(e));
    },
  });

  const send = useMutation({
    mutationFn: (file: File) => api.imports.uploadCsv(file),
    onMutate: (f) => {
      setError(null);
      setUploading(f);
    },
    onSuccess: (u) => {
      setUpload(u);
      setColumns(u.suggested);
      go(1);
    },
    onError: (e) => setError(errorMessage(e)),
    onSettled: () => setUploading(null),
  });

  const start = useMutation({
    mutationFn: () =>
      api.imports.create({
        source,
        credentials: csv ? undefined : creds,
        upload_id: upload?.upload_id,
        options: { ...options, tag: options.tag.trim() },
        mapping: { agents, groups, csv: csv ? columns : undefined },
      }),
    onSuccess: (x) => {
      setStarted(true);
      toast.success(t("wizard.startedToast"));
      onStarted(x);
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === "import_running") {
        toast.error(e);
        onClose();
        return;
      }
      setError(errorMessage(e));
    },
  });

  const next = () => {
    setError(null);
    if (step === "connect") {
      if (!csv && credentialsReady(source, creds)) runCheck.mutate();
    } else if (step === "columns") {
      if (columns.body || columns.subject) runCheck.mutate();
    } else if (step === "review") go(at + 1);
    else if (step === "options") start.mutate();
  };

  const canNext =
    step === "connect"
      ? !csv && credentialsReady(source, creds)
      : step === "upload"
        ? false
        : step === "columns"
          ? !!(columns.body || columns.subject)
          : step === "options"
            ? options.tickets || options.articles
            : true;
  const busy = runCheck.isPending || start.isPending;
  const dirty = (!!check || !!upload) && !started;
  const confirm = useConfirm();
  const leave = () =>
    dirty ? confirm.show(t("wizard.leaveBody"), async () => onClose(), { title: t("wizard.leaveTitle"), confirmLabel: t("wizard.leave"), danger: true }) : onClose();

  return (
    <SettingsPage
      title={t("wizard.title", { name })}
      description={csv ? t("wizard.csvDescription") : t("wizard.description", { name })}
      back={
        <button type="button" onClick={leave} className="-ml-1 inline-flex h-6 items-center gap-0.5 rounded-md pl-0.5 pr-1.5 text-[12.5px] text-fg-3 transition-colors hover:bg-hover hover:text-fg">
          <ArrowLeft className="size-3.5" />
          {t("title")}
        </button>
      }
      actions={<SourceMark source={source} size="lg" />}
    >
      <UnsavedGuard when={dirty} allow={(path) => path === "/settings/import"} />
      <div className="flex flex-col gap-6">
        <Steps steps={steps} at={at} />
        <form
          className="flex flex-col gap-6"
          onSubmit={(e) => {
            e.preventDefault();
            if (canNext && !busy) next();
          }}
        >
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={step}
              initial={reduce ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: -4 }}
              transition={{ duration: dur.base, ease: ease.out }}
              className="flex flex-col gap-6"
            >
              {step === "connect" && source !== "csv" && (
                <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_240px]">
                  <CredentialsForm
                    source={source}
                    value={creds}
                    onChange={(v) => {
                      setCreds(v);
                      setCredErr({});
                    }}
                    errors={credErr}
                  />
                  <aside className="flex flex-col gap-3 text-[12px] leading-[18px] text-fg-3">
                    <p className="font-medium text-fg-2">{t("wizard.whatComes")}</p>
                    <ul className="flex flex-col gap-1.5">
                      {(["conversations", "people", "articles", "quiet"] as const).filter((k) => source !== "freescout" || k !== "articles").map((k) => (
                        <li key={k} className="flex gap-2">
                          <Check className="mt-0.5 size-3 shrink-0 text-tone-green" aria-hidden />
                          {t(`wizard.facts.${k}`)}
                        </li>
                      ))}
                    </ul>
                    <a href={DOCS} target="_blank" rel="noopener noreferrer" className="text-fg-2 underline decoration-line-strong underline-offset-2 hover:text-fg">
                      {t("wizard.guide")}
                    </a>
                  </aside>
                </div>
              )}
              {step === "upload" && <CsvDrop onFile={(f) => send.mutate(f)} uploading={uploading} error={error} />}
              {step === "columns" && upload && (
                <CsvColumns
                  upload={upload}
                  mapping={columns}
                  onChange={setColumns}
                  onReplace={() => {
                    setUpload(null);
                    setCheck(null);
                    go(0);
                  }}
                />
              )}
              {step === "review" && check && (
                <>
                  <AccountCard source={source} check={check} />
                  <SamplePreview samples={check.samples} />
                  {(check.agents.length > 0 || check.groups.length > 0) && (
                    <MappingTable check={check} members={members} teams={teams} agents={agents} groups={groups} onAgents={setAgents} onGroups={setGroups} />
                  )}
                </>
              )}
              {step === "options" && check && (
                <>
                  <OptionsForm source={source} check={check} value={options} onChange={setOptions} mailboxes={mailboxes} />
                  <StartSummary check={check} options={options} />
                </>
              )}
            </motion.div>
          </AnimatePresence>

          {step !== "upload" && (
            <div className="flex items-center gap-2 border-t border-line pt-4">
              {at > 0 ? (
                <Button type="button" variant="ghost" icon={<ArrowLeft />} disabled={busy} onClick={() => go(at - 1)}>
                  {t("wizard.back")}
                </Button>
              ) : (
                <Button type="button" variant="ghost" onClick={leave}>
                  {t("wizard.cancel")}
                </Button>
              )}
              {error && (
                <span role="alert" className="min-w-0 flex-1 truncate text-right text-xs text-danger-fg" title={error}>
                  {error}
                </span>
              )}
              <Button
                type="submit"
                variant="primary"
                size="md"
                className="ml-auto"
                loading={busy}
                disabled={!canNext}
                iconRight={step === "options" ? undefined : <ArrowRight />}
              >
                {step === "connect"
                  ? runCheck.isPending
                    ? t("wizard.checking", { name })
                    : t("wizard.connect")
                  : step === "columns"
                    ? t("wizard.preview")
                    : step === "options"
                      ? t("wizard.start")
                      : t("wizard.continue")}
              </Button>
            </div>
          )}
        </form>
      </div>
    </SettingsPage>
  );
}

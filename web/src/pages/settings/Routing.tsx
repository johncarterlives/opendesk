// Settings > Routing (contracts/teams.md "Routing"): how a new ticket gets its
// team. The address or widget decides first, then the first enabled rule that
// matches, then the team's assignment. Rules reorder by drag; a test panel
// shows where a sample email or chat would go, without creating anything.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowRight, Check, ChevronRight, CircleDashed, FlaskConical, Inbox, MessageCircle, Minus, MoreHorizontal, Plus, Route, Shuffle, Trash2, Workflow, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { NoAccess, Section, SettingsPage } from "@/components/layout";
import { ListSkeleton } from "@/components/settings2/bits";
import { useRoutingData, useRuleSummary } from "@/components/settings2/routing";
import { SettingsEmpty } from "@/components/settings2/SettingsEmpty";
import { SortableList } from "@/components/settings2/Sortable";
import { BrandMark, TeamChip, useTeams } from "@/components/settings2/teams";
import { TagChip } from "@/components/ui/badge";
import { SinglePick } from "@/components/settings2/pickers";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { Field, Textarea, TextInput } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Switch } from "@/components/ui/switch";
import { Segmented } from "@/components/ui/tabs";
import { toast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { api } from "@/lib/api/endpoints";
import type { RoutingRule, RoutingTest } from "@/lib/api/types";
import type { RoutingTestBody } from "@/lib/api/endpoints";
import { cn } from "@/lib/cn";
import { dur, springs } from "@/lib/motion";
import { q, qk, removeFromList, upsertInList } from "@/lib/queries";
import { atLeast, useRole } from "@/lib/session";
import { tone } from "@/lib/tones";

export default function Routing() {
  const { t } = useTranslation("settingsTeams");
  const admin = atLeast(useRole(), "admin");
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data: rules, isLoading } = useQuery({ ...q.routingRules(), enabled: admin });
  const sorted = [...(rules ?? [])].sort((a, b) => a.position - b.position);

  const reorder = useMutation({
    mutationFn: (ids: string[]) => api.routingRules.reorder(ids),
    onMutate: (ids) => {
      const prev = qc.getQueryData<RoutingRule[]>(qk.routingRules);
      if (prev) qc.setQueryData<RoutingRule[]>(qk.routingRules, ids.map((id, i) => ({ ...prev.find((r) => r.id === id)!, position: i })));
      return { prev };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.routingRules, ctx.prev);
      toast.error(e);
    },
  });
  const toggle = useMutation({
    mutationFn: (r: RoutingRule) => api.routingRules.update(r.id, { enabled: !r.enabled }),
    onMutate: (r) => upsertInList(qc, qk.routingRules, { ...r, enabled: !r.enabled }),
    onSuccess: (r) => upsertInList(qc, qk.routingRules, r),
    onError: (e, r) => {
      upsertInList(qc, qk.routingRules, r);
      toast.error(e);
    },
  });
  const remove = (r: RoutingRule) =>
    confirm.show(t("routing.deleteBody", { name: r.name }), async () => {
      await api.routingRules.remove(r.id);
      removeFromList(qc, qk.routingRules, r.id);
      toast.success(t("routing.deleted", { name: r.name }));
    }, { title: t("routing.deleteTitle"), confirmLabel: t("routing.delete"), danger: true });

  if (!admin)
    return (
      <SettingsPage title={t("routing.title")}>
        <NoAccess what="routing" />
      </SettingsPage>
    );

  const newButton = (variant: "primary" | "secondary") => (
    <Button variant={variant} size={variant === "secondary" ? "sm" : undefined} asChild icon={<Plus className="size-3.5" />}>
      <Link to="/settings/routing/$ruleId" params={{ ruleId: "new" }}>
        {t("routing.new")}
      </Link>
    </Button>
  );

  return (
    <SettingsPage wide title={t("routing.title")} description={t("routing.description")} actions={newButton("primary")}>
      <Flow />
      <div className="grid grid-cols-1 gap-8 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Section
          flush
          title={t("routing.rulesTitle")}
          description={t("routing.rulesHint")}
          actions={sorted.length > 0 && <span className="text-[12px] text-fg-3">{t("routing.firstMatch")}</span>}
        >
          {isLoading ? (
            <ListSkeleton rows={4} />
          ) : !sorted.length ? (
            <SettingsEmpty
              art="settings"
              title={t("routing.emptyTitle")}
              description={t("routing.emptyHint")}
              action={newButton("primary")}
              tips={[
                { label: t("routing.tips.address"), icon: <Inbox /> },
                { label: t("routing.tips.order"), icon: <Route /> },
              ]}
            />
          ) : (
            <SortableList
              items={sorted}
              onReorder={(ids) => reorder.mutate(ids)}
              handleLabel={(r) => t("routing.reorder", { name: r.name })}
              renderRow={(r, handle, i) => <RuleRow rule={r} index={i} handle={handle} onToggle={() => toggle.mutate(r)} onDelete={() => remove(r)} />}
            />
          )}
        </Section>
        <div className="xl:sticky xl:top-6 xl:self-start">
          <TestPanel />
        </div>
      </div>
    </SettingsPage>
  );
}

/** The steps a new ticket goes through (contracts/teams.md "Routing"), in order. */
function Flow() {
  const { t } = useTranslation("settingsTeams");
  const link = (to: "/settings/mailboxes" | "/settings/triage" | "/settings/automations" | "/settings/assignment", label: string) => (
    <Link to={to} className="underline decoration-line-strong underline-offset-2 hover:text-fg">
      {label}
    </Link>
  );
  const steps = [
    { icon: <Inbox />, hue: "blue" as const, title: t("routing.flow.address"), hint: t("routing.flow.addressHint"), links: [link("/settings/mailboxes", t("routing.flow.addressLink"))] },
    { icon: <Route />, hue: "violet" as const, title: t("routing.flow.rules"), hint: t("routing.flow.rulesHint") },
    {
      icon: <Workflow />,
      hue: "amber" as const,
      title: t("routing.flow.after"),
      hint: t("routing.flow.afterHint"),
      links: [link("/settings/triage", t("routing.flow.triageLink")), link("/settings/automations", t("routing.flow.automationsLink"))],
    },
    { icon: <Shuffle />, hue: "teal" as const, title: t("routing.flow.assign"), hint: t("routing.flow.assignHint"), links: [link("/settings/assignment", t("routing.flow.assignLink"))] },
  ];
  // Four across when the page has the room, else two by two, else stacked.
  return (
    <div className="@container">
      <ol className="grid gap-2 @md:grid-cols-2 @4xl:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr]" aria-label={t("routing.flow.label")}>
        {steps.map((s, i) => (
          <li key={i} className="contents">
            <div className="flex flex-col rounded-lg border border-line bg-surface px-3.5 py-3 shadow-xs">
              <div className="flex items-center gap-2">
                <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-md [&_svg]:size-3.5", tone[s.hue].chip)}>{s.icon}</span>
                <span className="mono text-[10.5px] text-fg-4">{i + 1}</span>
                <span className="min-w-0 truncate text-[12.5px] font-medium">{s.title}</span>
              </div>
              <p className="mt-2 text-[12px] leading-[17px] text-fg-3">{s.hint}</p>
              {s.links && <div className="mt-auto flex flex-wrap gap-x-3 pt-1.5 text-[12px] text-fg-3">{s.links.map((l, j) => <span key={j}>{l}</span>)}</div>}
            </div>
            {i < steps.length - 1 && (
              <span aria-hidden className="hidden items-center text-fg-4 @4xl:flex rtl:rotate-180">
                <ChevronRight className="size-4" />
              </span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

function RuleRow({ rule, index, handle, onToggle, onDelete }: { rule: RoutingRule; index: number; handle: React.ReactNode; onToggle: () => void; onDelete: () => void }) {
  const { t } = useTranslation("settingsTeams");
  const navigate = useNavigate();
  const { teams } = useTeams();
  const summary = useRuleSummary();
  const team = teams.find((x) => x.id === rule.team_id);
  return (
    <div className={cn("group relative flex min-h-[56px] items-center gap-3 py-2.5 pl-6 pr-3 transition-colors hover:bg-sunken", !rule.enabled && "opacity-60")}>
      {handle}
      <span className="mono w-5 shrink-0 text-right text-[11px] tabular-nums text-fg-4">{index + 1}</span>
      <Link to="/settings/routing/$ruleId" params={{ ruleId: rule.id }} className="min-w-0 flex-1 outline-none focus-visible:underline">
        <div className="truncate text-[13px] font-medium">{rule.name}</div>
        <div className="mt-0.5 flex min-w-0 items-baseline gap-1.5 text-[12px] text-fg-3">
          <span className="min-w-0 truncate">{summary(rule.conditions, rule.match)}</span>
          <Tooltip content={t("routing.runsHint")}>
            <span className="mono shrink-0 text-[11px] tabular-nums text-fg-4">· {t("routing.runs", { count: rule.run_count })}</span>
          </Tooltip>
        </div>
      </Link>
      <ArrowRight className="size-3.5 shrink-0 text-fg-4" aria-hidden />
      <span className="w-[120px] shrink-0">{team ? <TeamChip team={team} /> : <span className="text-[12px] text-danger-fg">{t("routing.noTeam")}</span>}</span>
      <Switch checked={rule.enabled} onCheckedChange={onToggle} aria-label={t("routing.enableNamed", { name: rule.name })} />
      <Menu>
        <MenuTrigger asChild>
          <Button size="sm" variant="ghost" square aria-label={t("routing.actionsFor", { name: rule.name })}>
            <MoreHorizontal className="size-4" />
          </Button>
        </MenuTrigger>
        <MenuContent align="end">
          <MenuItem icon={<Route />} onSelect={() => void navigate({ to: "/settings/routing/$ruleId", params: { ruleId: rule.id } })}>
            {t("routing.edit")}
          </MenuItem>
          <MenuSeparator />
          <MenuItem danger icon={<Trash2 />} onSelect={onDelete}>
            {t("routing.delete")}
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  );
}

type Sample = { channel: "email" | "chat"; to: string; from: string; subject: string; body: string; widget_id: string; topic: string; page_url: string };

function TestPanel() {
  const { t } = useTranslation("settingsTeams");
  const data = useRoutingData();
  const reduce = useReducedMotion();
  const addresses = data.mailboxes.flatMap((m) => [{ value: m.email, label: m.email, group: m.name }, ...m.aliases.map((a) => ({ value: a, label: a, group: m.name, hint: t("routing.test.alias") }))]);
  const [s, setS] = useState<Sample>({ channel: "email", to: data.mailboxes[0]?.email ?? "", from: "", subject: "", body: "", widget_id: "", topic: "", page_url: "" });
  const [result, setResult] = useState<RoutingTest | null>(null);
  const set = (p: Partial<Sample>) => {
    setS((x) => ({ ...x, ...p }));
    setResult(null);
  };
  const to = s.to || data.mailboxes[0]?.email || "";
  const widgetId = s.widget_id || data.widgets[0]?.id || "";
  const widget = data.widgets.find((w) => w.id === widgetId);

  const run = useMutation({
    mutationFn: () => {
      const b: RoutingTestBody =
        s.channel === "email"
          ? { channel: "email", to, from: s.from.trim() || undefined, subject: s.subject, body: s.body }
          : { channel: "chat", widget_id: widgetId, topic: s.topic || undefined, page_url: s.page_url.trim() || undefined, from: s.from.trim() || undefined, body: s.body };
      return api.routingRules.test(b);
    },
    onSuccess: setResult,
    onError: (e) => toast.error(e),
  });

  return (
    <Section
      title={
        <span className="flex items-center gap-1.5">
          <FlaskConical className="size-3.5 text-fg-3" aria-hidden />
          {t("routing.test.title")}
        </span>
      }
      description={t("routing.test.hint")}
    >
      <form
        className="flex flex-col gap-3 py-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          run.mutate();
        }}
      >
        <Segmented
          className="self-start"
          value={s.channel}
          onChange={(channel) => set({ channel })}
          options={[
            { value: "email", label: t("routing.test.email"), icon: <Inbox className="size-3" /> },
            { value: "chat", label: t("routing.test.chat"), icon: <MessageCircle className="size-3" /> },
          ]}
        />
        {s.channel === "email" ? (
          <Field label={t("routing.test.to")}>
            {() => <SinglePick className="w-full" items={addresses} value={to} onChange={(v) => set({ to: v })} placeholder={t("routing.pickAddress")} />}
          </Field>
        ) : (
          <>
            <Field label={t("routing.test.widget")}>
              {() => (
                <SinglePick
                  className="w-full"
                  items={data.widgets.map((w) => {
                    const b = data.brands.find((x) => x.id === w.brand_id);
                    return { value: w.id, label: w.name, icon: b ? <BrandMark brand={b} size="xs" /> : undefined };
                  })}
                  value={widgetId}
                  onChange={(v) => set({ widget_id: v, topic: "" })}
                  placeholder={t("routing.pickWidget")}
                />
              )}
            </Field>
            {widget && widget.settings.topics.length > 0 && (
              <Field label={t("routing.test.topic")}>
                {() => (
                  <SinglePick
                    className="w-full"
                    items={[{ value: "__none", label: t("routing.test.noTopic") }, ...widget.settings.topics.map((x) => ({ value: x.id, label: x.label }))]}
                    value={s.topic || "__none"}
                    onChange={(v) => set({ topic: v === "__none" ? "" : v })}
                    placeholder={t("routing.pickTopic")}
                  />
                )}
              </Field>
            )}
            <Field label={t("routing.test.page")}>
              {({ id }) => <TextInput id={id} inputSize="sm" className="mono" value={s.page_url} placeholder="https://margin.app/pricing" onChange={(e) => set({ page_url: e.target.value })} />}
            </Field>
          </>
        )}
        <Field label={t("routing.test.from")}>
          {({ id }) => <TextInput id={id} inputSize="sm" className="mono" value={s.from} placeholder="ada@example.com" onChange={(e) => set({ from: e.target.value })} />}
        </Field>
        {s.channel === "email" && (
          <Field label={t("routing.test.subject")}>
            {({ id }) => <TextInput id={id} inputSize="sm" value={s.subject} placeholder={t("routing.test.subjectPlaceholder")} onChange={(e) => set({ subject: e.target.value })} />}
          </Field>
        )}
        <Field label={s.channel === "email" ? t("routing.test.body") : t("routing.test.message")}>
          {({ id }) => <Textarea id={id} rows={3} value={s.body} placeholder={t("routing.test.bodyPlaceholder")} onChange={(e) => set({ body: e.target.value })} />}
        </Field>
        <Button type="submit" variant="primary" className="self-start" loading={run.isPending} icon={<FlaskConical className="size-3.5" />} disabled={s.channel === "email" ? !to : !widgetId}>
          {t("routing.test.run")}
        </Button>
      </form>
      <AnimatePresence initial={false}>
        {result && (
          <motion.div
            key="result"
            initial={reduce ? false : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, height: 0, transition: { duration: dur.fast } }}
            transition={springs.glide}
            className="-mx-4 overflow-hidden border-t border-line-soft"
          >
            <TestResult r={result} />
          </motion.div>
        )}
      </AnimatePresence>
    </Section>
  );
}

function TestResult({ r }: { r: RoutingTest }) {
  const { t } = useTranslation("settingsTeams");
  const { t: ti } = useTranslation("settingsInbox");
  const { teams } = useTeams();
  const data = useRoutingData();
  const team = teams.find((x) => x.id === r.team_id);
  const brand = data.brands.find((b) => b.id === r.brand_id);
  const mailbox = data.mailboxes.find((m) => m.id === r.mailbox_id);
  const decided = r.steps.findIndex((s) => s.matched === true);
  const via = r.routed?.via;
  return (
    <div className="flex flex-col gap-3 bg-sunken/50 px-4 py-3.5">
      <div className="label-caps">{t("routing.test.steps")}</div>
      <ol className="flex flex-col gap-1">
        <Step state={via === "address" || via === "widget" || via === "topic" ? "match" : "skip"}>
          {via === "address" || (via === "rule" && mailbox) ? t("routing.test.stepAddress") : via === "topic" ? t("routing.test.stepTopic") : via === "widget" ? t("routing.test.stepWidget") : t("routing.test.stepNoDefault")}
        </Step>
        {r.steps.map((s, i) => (
          <Step key={s.rule_id} state={s.matched === true ? "match" : s.matched === "unknown" ? "unknown" : decided >= 0 && i > decided ? "skip" : "miss"}>
            <Link to="/settings/routing/$ruleId" params={{ ruleId: s.rule_id }} className="hover:underline">
              {s.name}
            </Link>
            {s.matched === "unknown" && <span className="text-fg-4"> · {t("routing.test.unknown")}</span>}
            {decided >= 0 && i > decided && <span className="text-fg-4"> · {t("routing.test.notReached")}</span>}
          </Step>
        ))}
      </ol>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-md border border-line bg-surface px-3 py-2.5 text-[12.5px]">
        <dt className="text-fg-3">{t("routing.test.team")}</dt>
        <dd className="min-w-0">{team ? <TeamChip team={team} /> : <span className="text-fg-3">{t("routing.test.noTeam")}</span>}</dd>
        {data.multiBrand && brand && (
          <>
            <dt className="text-fg-3">{t("routing.test.brand")}</dt>
            <dd className="flex min-w-0 items-center gap-1.5">
              <BrandMark brand={brand} size="xs" />
              {brand.name}
            </dd>
          </>
        )}
        <dt className="text-fg-3">{t("routing.test.replyFrom")}</dt>
        <dd className="mono min-w-0 truncate text-[12px]">{mailbox?.email ?? <span className="font-sans text-fg-3">{t("routing.test.noAddress")}</span>}</dd>
        <dt className="text-fg-3">{t("routing.test.assign")}</dt>
        <dd>{ti(`assignment.modes.${r.assign_mode}.label`)}</dd>
        {r.required_skills.length > 0 && (
          <>
            <dt className="text-fg-3">{t("routing.test.requiredSkills")}</dt>
            <dd className="flex min-w-0 flex-wrap gap-1">{r.required_skills.map((skill) => <TagChip key={skill.id} name={skill.name} color="violet" />)}</dd>
          </>
        )}
        <dt className="text-fg-3">{t("routing.test.why")}</dt>
        <dd className="text-fg-2">{r.routed ? (r.routed.via === "rule" ? t("routing.test.viaRule", { name: r.routed.rule_name ?? "" }) : t(`routing.via.${r.routed.via}`)) : t("routing.test.viaNone")}</dd>
      </dl>
    </div>
  );
}

function Step({ state, children }: { state: "match" | "miss" | "skip" | "unknown"; children: React.ReactNode }) {
  const icon = state === "match" ? <Check /> : state === "unknown" ? <CircleDashed /> : state === "skip" ? <Minus /> : <X />;
  return (
    <li className={cn("flex items-center gap-2 text-[12.5px]", state === "skip" ? "text-fg-4" : state === "miss" ? "text-fg-3" : "text-fg")}>
      <span
        aria-hidden
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded-full [&_svg]:size-2.5",
          state === "match" ? tone.green.chip : state === "unknown" ? tone.violet.chip : "bg-hover text-fg-4",
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 truncate">{children}</span>
    </li>
  );
}

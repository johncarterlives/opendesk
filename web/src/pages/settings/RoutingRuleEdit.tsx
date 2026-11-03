// Settings > Routing > a rule (contracts/teams.md "Routing"): a name, all or
// any of up to 20 conditions, and the team matching tickets go to. "new"
// creates one at the end of the list.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowRight, Plus, Sparkles, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { BackLink, NoAccess, Row, Section, SettingsPage } from "@/components/layout";
import { SaveBar } from "@/components/settings/SaveBar";
import { ConditionValue, fieldMeta, newCondition, useFieldItems, useRoutingData } from "@/components/settings2/routing";
import { MultiPick, SinglePick } from "@/components/settings2/pickers";
import { Note, TeamPick } from "@/components/settings2/teams";
import { UnsavedGuard } from "@/components/settings2/UnsavedGuard";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { EmptyState } from "@/components/ui/empty";
import { TextInput } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Segmented } from "@/components/ui/tabs";
import { toast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { api } from "@/lib/api/endpoints";
import type { RoutingCondition, RoutingField, RoutingRule, Skill } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { dur, springs } from "@/lib/motion";
import { q, qk, removeFromList, upsertInList } from "@/lib/queries";
import { atLeast, useRole } from "@/lib/session";

const MAX_CONDITIONS = 20;
const MAX_AI = 3;

type Draft = Pick<RoutingRule, "name" | "enabled" | "match" | "conditions" | "skill_ids"> & { team_id: string | null };
const blank: Draft = { name: "", enabled: true, match: "any", conditions: [{ field: "subject", op: "contains", value: "" }], team_id: null, skill_ids: [] };
const toDraft = (r: RoutingRule, skills?: Skill[]): Draft => ({
  name: r.name,
  enabled: r.enabled,
  match: r.match,
  conditions: r.conditions.map((c) => ({ ...c })),
  team_id: r.team_id,
  // Archived skill requirements cannot be selected in the editor and are
  // omitted from the draft so unrelated edits do not submit stale IDs.
  skill_ids: skills ? r.skill_ids.filter((id) => skills.some((skill) => skill.id === id && !skill.archived)) : r.skill_ids,
});

export default function RoutingRuleEdit() {
  const { t } = useTranslation("settingsTeams");
  const { ruleId } = useParams({ from: "/app/settings/routing/$ruleId" });
  const admin = atLeast(useRole(), "admin");
  const { data, isLoading } = useQuery({ ...q.routingRules(), enabled: admin });
  const back = <BackLink to="/settings/routing">{t("routing.back")}</BackLink>;
  const isNew = ruleId === "new";
  const rule = data?.find((r) => r.id === ruleId);

  if (!admin)
    return (
      <SettingsPage title={t("routing.title")} back={back}>
        <NoAccess what="routing" />
      </SettingsPage>
    );
  if (!isNew && isLoading)
    return (
      <SettingsPage title={<Skeleton className="h-5 w-48" />} back={back}>
        <Skeleton className="h-32 w-full rounded-lg" />
        <Skeleton className="h-48 w-full rounded-lg" />
      </SettingsPage>
    );
  if (!isNew && !rule)
    return (
      <SettingsPage title={t("routing.title")} back={back}>
        <section>
          <EmptyState
            lit={3}
            title={t("routing.notFound")}
            description={t("routing.notFoundBody")}
            action={
              <Button size="sm" asChild>
                <Link to="/settings/routing">{t("routing.back")}</Link>
              </Button>
            }
          />
        </section>
      </SettingsPage>
    );
  return <RuleEditor key={rule?.id ?? "new"} rule={rule ?? null} back={back} />;
}

function RuleEditor({ rule, back }: { rule: RoutingRule | null; back: React.ReactNode }) {
  const { t } = useTranslation("settingsTeams");
  const qc = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const reduce = useReducedMotion();
  const data = useRoutingData();
  const { data: skills } = useQuery(q.skills());
  const fieldItems = useFieldItems(data.multiBrand, data.contactFields);
  const base = useMemo(() => (rule ? toDraft(rule, skills) : blank), [rule, skills]);
  const [draft, setDraft] = useState<Draft>(base);
  const [prevBase, setPrevBase] = useState(base);
  const [tried, setTried] = useState(false);
  useEffect(() => {
    if (JSON.stringify(draft) === JSON.stringify(prevBase)) setDraft(base);
    setPrevBase(base);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(base);
  const condBad = (c: RoutingCondition) => (c.field === "ai_decide" ? (c.question ?? "").trim().length < 3 : !c.value.trim());
  const aiCount = draft.conditions.filter((c) => c.field === "ai_decide").length;
  const problems = { name: !draft.name.trim(), team: !draft.team_id, conditions: draft.conditions.some(condBad) || !draft.conditions.length, ai: aiCount > MAX_AI };
  const invalid = Object.values(problems).some(Boolean);
  const setCond = (i: number, p: Partial<RoutingCondition>) => setDraft((d) => ({ ...d, conditions: d.conditions.map((c, j) => (j === i ? { ...c, ...p } : c)) }));

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: draft.name.trim(),
        enabled: draft.enabled,
        match: draft.match,
        team_id: draft.team_id!,
        skill_ids: draft.skill_ids.filter((id) => skills?.some((skill) => skill.id === id && !skill.archived)),
        conditions: draft.conditions.map((c) => ({ ...c, value: c.value.trim(), ...(c.field === "ai_decide" ? { question: (c.question ?? "").trim() } : {}) })),
      };
      return rule ? api.routingRules.update(rule.id, body) : api.routingRules.create(body);
    },
    onSuccess: (r) => {
      upsertInList(qc, qk.routingRules, r);
      setDraft(toDraft(r));
      toast.success(rule ? t("routing.saved") : t("routing.created", { name: r.name }));
      if (!rule) void navigate({ to: "/settings/routing/$ruleId", params: { ruleId: r.id }, replace: true });
    },
    onError: (e) => toast.error(e, t("routing.saveFailed")),
  });

  const remove = () =>
    rule &&
    confirm.show(t("routing.deleteBody", { name: rule.name }), async () => {
      await api.routingRules.remove(rule.id);
      removeFromList(qc, qk.routingRules, rule.id);
      toast.success(t("routing.deleted", { name: rule.name }));
      void navigate({ to: "/settings/routing" });
    }, { title: t("routing.deleteTitle"), confirmLabel: t("routing.delete"), danger: true });

  return (
    <SettingsPage
      back={back}
      title={rule ? rule.name : t("routing.new")}
      description={rule ? t("routing.ruleMeta", { position: rule.position + 1, count: rule.run_count }) : t("routing.newHint")}
    >
      <UnsavedGuard when={dirty && !save.isPending} />
      <Section>
        <Row label={t("routing.name")} htmlFor="rule-name">
          <TextInput
            id="rule-name"
            className="w-[320px]"
            maxLength={80}
            autoFocus={!rule}
            value={draft.name}
            invalid={tried && problems.name}
            placeholder={t("routing.namePlaceholder")}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          />
        </Row>
        <Row label={t("routing.enabled")} description={draft.enabled ? t("routing.enabledOn") : t("routing.enabledOff")}>
          <Switch checked={draft.enabled} onCheckedChange={(enabled) => setDraft((d) => ({ ...d, enabled }))} aria-label={t("routing.enabled")} />
        </Row>
      </Section>

      <Section
        flush
        title={t("routing.when")}
        description={t("routing.whenHint")}
        actions={
          <Segmented
            value={draft.match}
            onChange={(match) => setDraft((d) => ({ ...d, match }))}
            options={[
              { value: "any", label: t("routing.matchAny") },
              { value: "all", label: t("routing.matchAll") },
            ]}
          />
        }
      >
        <AnimatePresence initial={false}>
          {draft.conditions.map((c, i) => {
            const m = fieldMeta(c.field, data.contactFields);
            return (
              <motion.div
                key={i}
                layout={reduce ? false : "position"}
                initial={reduce ? false : { opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, transition: { duration: dur.fast } }}
                transition={springs.row}
                className={cn("flex flex-col gap-2 border-b border-line-soft px-4 py-3 last:border-0")}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="w-9 shrink-0 text-right text-[11.5px] font-medium text-fg-4">{i === 0 ? t("routing.if") : draft.match === "all" ? t("routing.and") : t("routing.or")}</span>
                  <SinglePick
                    className="w-[190px]"
                    items={fieldItems}
                    value={c.field}
                    onChange={(f) => setDraft((d) => ({ ...d, conditions: d.conditions.map((x, j) => (j === i ? newCondition(f as RoutingField, data.contactFields) : x)) }))}
                    placeholder={t("routing.field")}
                    searchPlaceholder={t("routing.searchFields")}
                  />
                  <Select
                    size="sm"
                    className="w-[150px]"
                    aria-label={t("routing.op")}
                    value={c.op}
                    onChange={(op) => setCond(i, { op })}
                    options={m.ops.map((o) => ({ value: o, label: c.field === "ai_decide" ? t(`routing.aiOps.${o as "gt" | "lt"}`) : t(`routing.ops.${o}`) }))}
                  />
                  <div className="min-w-[180px] flex-1">
                    <ConditionValue c={c} data={data} invalid={tried && condBad(c) && c.field !== "ai_decide"} onChange={(p) => setCond(i, p)} />
                  </div>
                  <Tooltip content={t("routing.removeCondition")}>
                    <Button
                      size="sm"
                      variant="ghost"
                      square
                      disabled={draft.conditions.length === 1}
                      aria-label={t("routing.removeConditionN", { n: i + 1 })}
                      onClick={() => setDraft((d) => ({ ...d, conditions: d.conditions.filter((_, j) => j !== i) }))}
                    >
                      <X className="size-3.5" />
                    </Button>
                  </Tooltip>
                </div>
                {c.field === "ai_decide" && (
                  <div className="flex flex-col gap-2 pl-11">
                    <TextInput
                      inputSize="sm"
                      aria-label={t("routing.question")}
                      value={c.question ?? ""}
                      maxLength={300}
                      invalid={tried && (c.question ?? "").trim().length < 3}
                      placeholder={t("routing.questionPlaceholder")}
                      onChange={(e) => setCond(i, { question: e.target.value })}
                    />
                    <Note tone="violet" icon={<Sparkles className="mt-0.5 size-3.5 shrink-0" aria-hidden />}>
                      {t("routing.aiNote")}{" "}
                      <Link to="/settings/automations" className="underline underline-offset-2">
                        {t("routing.aiNoteLink")}
                      </Link>
                    </Note>
                  </div>
                )}
              </motion.div>
            );
          })}
        </AnimatePresence>
        <div className="flex items-center justify-between gap-3 border-t border-line-soft bg-sunken/40 px-4 py-2.5">
          <Button
            size="sm"
            variant="ghost"
            icon={<Plus className="size-3.5" />}
            disabled={draft.conditions.length >= MAX_CONDITIONS}
            onClick={() => setDraft((d) => ({ ...d, conditions: [...d.conditions, newCondition("subject", data.contactFields)] }))}
          >
            {t("routing.addCondition")}
          </Button>
          <span className="text-[11.5px] text-fg-4">{t("routing.conditionCount", { n: draft.conditions.length, max: MAX_CONDITIONS })}</span>
        </div>
        {problems.ai && <div className="border-t border-line-soft px-4 py-2 text-[12px] text-danger-fg">{t("routing.tooManyAi", { max: MAX_AI })}</div>}
      </Section>

      <Section title={t("routing.then")} description={t("routing.thenHint")}>
        <Row
          label={
            <span className="flex items-center gap-1.5">
              <ArrowRight className="size-3.5 text-fg-3" aria-hidden />
              {t("routing.sendTo")}
            </span>
          }
          description={t("routing.sendToHint")}
        >
          <TeamPick className="w-[240px]" value={draft.team_id} invalid={tried && problems.team} onChange={(team_id) => setDraft((d) => ({ ...d, team_id }))} />
        </Row>
        <Row label={t("routing.skills.label")} description={t("routing.skills.hint")}>
          <MultiPick
            className="w-[240px]"
            items={(skills ?? []).filter((skill) => !skill.archived).map((skill) => ({ value: skill.id, label: skill.name, icon: <Sparkles className="size-3.5 text-tone-violet" /> }))}
            values={draft.skill_ids.filter((id) => skills?.some((skill) => skill.id === id && !skill.archived) ?? false)}
            onChange={(skill_ids) => setDraft((d) => ({ ...d, skill_ids }))}
            placeholder={t("routing.skills.placeholder")}
            searchPlaceholder={t("routing.skills.search")}
          />
        </Row>
      </Section>

      {rule && (
        <Section title={t("routing.danger")} danger>
          <Row label={t("routing.deleteTitle")} description={t("routing.deleteHint")}>
            <Button variant="danger" icon={<Trash2 className="size-3.5" />} onClick={remove}>
              {t("routing.delete")}
            </Button>
          </Row>
        </Section>
      )}

      <SaveBar
        dirty={dirty || !rule}
        saving={save.isPending}
        onSave={() => {
          setTried(true);
          if (invalid) return toast.error(problems.team ? t("routing.needTeam") : problems.name ? t("routing.needName") : t("routing.needValues"));
          if (!skills) return toast.error(t("routing.saveFailed"));
          save.mutate();
        }}
        onDiscard={() => (rule ? setDraft(base) : void navigate({ to: "/settings/routing" }))}
      />
    </SettingsPage>
  );
}

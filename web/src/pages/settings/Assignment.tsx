// Settings > Assignment: who new tickets go to. The workspace default mode,
// per team and per mailbox rules, auto-away, and the team's availability and
// load with an inline cap for admins (contracts/api.md "Assignment").

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { motion, useReducedMotion } from "motion/react";
import { Archive, ArchiveRestore, BellOff, CircleSlash, Crown, Inbox, Lock, Moon, Plus, Repeat, Scale, Shuffle, Sparkles, UsersRound, Wand2, X } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ListRow, Row, Section, SettingsPage } from "@/components/layout";
import { AvailabilityDot, AvailabilityMenuItems } from "@/components/presence/availability";
import { IconTile, ListSkeleton, RolePill, SummaryStrip } from "@/components/settings2/bits";
import { MotionList, MotionRow } from "@/components/settings2/motion";
import { SettingsEmpty } from "@/components/settings2/SettingsEmpty";
import { Stepper } from "@/components/settings2/Stepper";
import { Avatar } from "@/components/ui/avatar";
import { TagChip } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuTrigger } from "@/components/ui/menu";
import { Picker } from "@/components/ui/picker";
import { Popover } from "@/components/ui/popover";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Segmented } from "@/components/ui/tabs";
import { TeamDot, useTeams } from "@/components/settings2/teams";
import { toast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { api } from "@/lib/api/endpoints";
import type { Assignment as A, AssignMode, AssignmentRule, Member, NewTicketNotify, Skill } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { springs } from "@/lib/motion";
import { useSetAvailability } from "@/lib/pictures";
import { q, qk, upsertInList } from "@/lib/queries";
import { atLeast, useRole } from "@/lib/session";
import { tone, type Tone } from "@/lib/tones";

export const MODES: AssignMode[] = ["none", "round_robin", "load_balanced"];
const modeIcon: Record<AssignMode, ReactNode> = { none: <CircleSlash />, round_robin: <Repeat />, load_balanced: <Scale /> };
const modeTone: Record<AssignMode, Tone> = { none: "gray", round_robin: "blue", load_balanced: "violet" };
const AWAY_DEFAULT = 30;
export const NEW_TICKET_NOTIFY: NewTicketNotify[] = ["auto", "everyone", "leads", "off"];
const notifyIcon: Record<NewTicketNotify, ReactNode> = { auto: <Wand2 />, everyone: <UsersRound />, leads: <Crown />, off: <BellOff /> };

/** PATCH /v1/assignment with an optimistic cache write. */
function useAssignmentWrite() {
  const qc = useQueryClient();
  const { t } = useTranslation("settingsInbox");
  return useMutation({
    mutationFn: (b: Partial<A>) => api.assignment.update(b),
    onMutate: async (b) => {
      await qc.cancelQueries({ queryKey: qk.assignment });
      const prev = qc.getQueryData<A>(qk.assignment);
      if (prev) qc.setQueryData<A>(qk.assignment, { ...prev, ...b });
      return { prev };
    },
    onError: (e, _b, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.assignment, ctx.prev);
      toast.error(e, t("assignment.saveFailed"));
    },
    onSuccess: (a) => {
      qc.setQueryData(qk.assignment, a);
      void qc.invalidateQueries({ queryKey: qk.workspace });
      void qc.invalidateQueries({ queryKey: qk.onboarding });
    },
  });
}

export default function Assignment() {
  const { t } = useTranslation("settingsInbox");
  const canEdit = atLeast(useRole(), "admin");
  const { data: a, isLoading } = useQuery(q.assignment());
  const { data: members, isLoading: membersLoading } = useQuery(q.members());
  const { data: skills } = useQuery({ ...q.skills(), enabled: canEdit });
  const write = useAssignmentWrite();
  const { teams } = useTeams();
  const { t: tt } = useTranslation("settingsTeams");
  const [byTeam, setByTeam] = useState(true);

  const assignable = (members ?? []).filter((m) => m.role !== "viewer");
  const count = (p: Member["presence"]) => assignable.filter((m) => m.presence === p).length;
  const atCap = assignable.filter((m) => m.max_open_tickets != null && m.open_tickets >= m.max_open_tickets).length;
  const eligible = assignable.filter((m) => m.presence === "online" && (m.max_open_tickets == null || m.open_tickets < m.max_open_tickets)).length;

  return (
    <SettingsPage wide title={t("assignment.title")} description={t("assignment.description")}>
      {members && (
        <SummaryStrip
          items={[
            { label: t("assignment.stats.eligible"), value: eligible, hint: t("assignment.stats.eligibleHint"), tone: eligible ? "green" : "red" },
            { label: t("assignment.presence.online"), value: count("online"), tone: "green" },
            { label: t("assignment.presence.away"), value: count("away"), tone: "amber" },
            { label: t("assignment.presence.offline"), value: count("offline") },
            { label: t("assignment.stats.atCap"), value: atCap, tone: atCap ? "orange" : undefined },
          ]}
        />
      )}

      <Section flush title={t("assignment.defaultTitle")} description={t("assignment.defaultHint")}>
        {isLoading || !a ? (
          <div className="grid gap-2 p-2 md:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-[76px] rounded-md" />
            ))}
          </div>
        ) : (
          <ModeChoice value={a.mode} disabled={!canEdit} onChange={(mode) => write.mutate({ mode })} />
        )}
      </Section>

      {teams.length > 0 && <Precedence />}

      {canEdit && <SkillsSection skills={skills ?? []} members={assignable} loading={!skills} />}

      <RulesSection a={a} loading={isLoading} canEdit={canEdit} onRules={(rules) => write.mutate({ rules })} />

      <Section title={t("assignment.notifyTitle")} description={t("assignment.notifyHint")}>
        {a ? (
          <NotifyRow value={a.new_ticket_notify ?? "auto"} disabled={!canEdit} onChange={(new_ticket_notify) => write.mutate({ new_ticket_notify })} />
        ) : (
          <div className="py-4">
            <Skeleton className="h-5 w-1/2" />
          </div>
        )}
      </Section>

      <Section title={t("assignment.awayTitle")} description={t("assignment.awayHint")}>
        {a ? (
          <AwayRow minutes={a.auto_away_minutes} disabled={!canEdit} onChange={(auto_away_minutes) => write.mutate({ auto_away_minutes })} />
        ) : (
          <div className="py-4">
            <Skeleton className="h-5 w-1/2" />
          </div>
        )}
      </Section>

      <Section
        flush
        title={t("assignment.teamTitle")}
        description={t("assignment.teamHint")}
        actions={
          teams.length > 0 && (
            <Segmented
              size="xs"
              value={byTeam ? "team" : "all"}
              onChange={(v) => setByTeam(v === "team")}
              options={[
                { value: "team", label: tt("scoped.byTeam") },
                { value: "all", label: tt("scoped.everyone") },
              ]}
            />
          )
        }
      >
        {membersLoading ? (
          <ListSkeleton rows={4} />
        ) : !assignable.length ? (
          <SettingsEmpty
            art="contacts"
            ghost="people"
            title={t("assignment.teamEmpty.title")}
            description={t("assignment.teamEmpty.description")}
            action={
              <Button variant="primary" asChild>
                <Link to="/settings/members">{t("assignment.teamEmpty.action")}</Link>
              </Button>
            }
            tips={[
              { label: t("assignment.teamEmpty.tips.viewers"), icon: <UsersRound /> },
              { label: t("assignment.teamEmpty.tips.online"), icon: <Sparkles /> },
            ]}
          />
        ) : teams.length && byTeam ? (
          <TeamGroups assignable={assignable} canEdit={canEdit} mode={a?.mode ?? "none"} skills={skills} />
        ) : (
          <MotionList>
            {assignable.map((m) => (
              <MotionRow key={m.user.id}>
            <MemberLoad m={m} canEdit={canEdit} skills={skills} />
              </MotionRow>
            ))}
          </MotionList>
        )}
      </Section>
    </SettingsPage>
  );
}

/** Three radio cards; a sliding outline marks the chosen one. */
export function ModeChoice({ value, onChange, disabled }: { value: AssignMode; onChange: (m: AssignMode) => void; disabled?: boolean }) {
  const { t } = useTranslation("settingsInbox");
  const id = useId();
  const reduce = useReducedMotion();
  const move = (dir: 1 | -1) => {
    const i = MODES.indexOf(value);
    onChange(MODES[(i + dir + MODES.length) % MODES.length]);
  };
  return (
    <div role="radiogroup" aria-label={t("assignment.defaultTitle")} className="grid gap-1 p-1 md:grid-cols-3">
      {MODES.map((m) => {
        const on = m === value;
        return (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(m)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                e.preventDefault();
                move(1);
              } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                e.preventDefault();
                move(-1);
              }
            }}
            className={cn(
              "group relative flex items-start gap-3 rounded-md p-3 text-left outline-none transition-colors duration-150",
              "focus-visible:ring-2 focus-visible:ring-focus/30 disabled:cursor-default",
              !on && "enabled:hover:bg-sunken",
            )}
          >
            {on && (
              <motion.span
                layoutId={`${id}-mode`}
                aria-hidden
                transition={reduce ? { duration: 0 } : springs.glide}
                className="pointer-events-none absolute inset-0 rounded-md bg-sunken shadow-[inset_0_0_0_1px_var(--line)]"
              />
            )}
            <IconTile tone={on ? modeTone[m] : "gray"} className="relative">
              {modeIcon[m]}
            </IconTile>
            <span className="relative min-w-0 flex-1">
              <span className="flex items-center gap-2 text-[13px] font-medium">{t(`assignment.modes.${m}.label`)}</span>
              <span className="mt-0.5 block text-[12px] leading-[17px] text-fg-3">{t(`assignment.modes.${m}.hint`)}</span>
            </span>
            <span
              aria-hidden
              className={cn(
                "relative mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-full border transition-colors duration-150",
                on ? "border-fg bg-fg" : "border-line-strong bg-surface",
              )}
            >
              <span className={cn("size-1.5 rounded-full bg-surface transition-transform duration-150 motion-reduce:transition-none", on ? "scale-100" : "scale-0")} />
            </span>
          </button>
        );
      })}
    </div>
  );
}

function RulesSection({ a, loading, canEdit, onRules }: { a?: A; loading: boolean; canEdit: boolean; onRules: (r: AssignmentRule[]) => void }) {
  const { t } = useTranslation("settingsInbox");
  const { data: teams } = useQuery(q.teams());
  const { data: mailboxes } = useQuery(q.mailboxes());
  const rules = a?.rules ?? [];
  const key = (r: Pick<AssignmentRule, "target_type" | "target_id">) => `${r.target_type}:${r.target_id}`;
  const taken = new Set(rules.map(key));
  const nameOf = (r: AssignmentRule) =>
    r.target_type === "team" ? teams?.find((x) => x.id === r.target_id)?.name : mailboxes?.find((x) => x.id === r.target_id)?.name;
  const detailOf = (r: AssignmentRule) => {
    if (r.target_type === "team") {
      const n = teams?.find((x) => x.id === r.target_id)?.member_ids.length ?? 0;
      return t("assignment.rules.teamMeta", { count: n });
    }
    return mailboxes?.find((x) => x.id === r.target_id)?.email ?? "";
  };
  const items = [
    ...(teams ?? []).map((x) => ({ value: `team:${x.id}`, label: x.name, group: t("assignment.rules.teams"), icon: <UsersRound className="size-3.5 text-fg-3" /> })),
    ...(mailboxes ?? []).map((x) => ({
      value: `mailbox:${x.id}`,
      label: x.name,
      hint: x.email,
      group: t("assignment.rules.mailboxes"),
      icon: <Inbox className="size-3.5 text-fg-3" />,
    })),
  ].filter((i) => !taken.has(i.value));
  // Team rules first: they win over mailbox rules.
  const sorted = [...rules].sort((x, y) => (x.target_type === y.target_type ? 0 : x.target_type === "team" ? -1 : 1));

  const add = (v: string) => {
    const [target_type, target_id] = v.split(":") as [AssignmentRule["target_type"], string];
    onRules([...rules, { target_type, target_id, mode: a?.mode === "none" ? "round_robin" : (a?.mode ?? "round_robin") }]);
  };
  const remove = (r: AssignmentRule) => {
    const before = rules;
    onRules(rules.filter((x) => key(x) !== key(r)));
    toast.undo(t("assignment.rules.removed", { name: nameOf(r) ?? "" }), () => onRules(before));
  };
  const addButton = (variant: "secondary" | "primary") =>
    canEdit && (
      <Picker
        items={items}
        value={null}
        onSelect={add}
        placeholder={t("assignment.rules.search")}
        emptyText={t("assignment.rules.noTargets")}
        width={280}
        align="end"
        trigger={
          <Button variant={variant} size={variant === "secondary" ? "sm" : undefined} icon={<Plus className="size-3.5" />} disabled={!items.length}>
            {t("assignment.rules.add")}
          </Button>
        }
      />
    );

  return (
    <Section flush title={t("assignment.rules.title")} description={t("assignment.rules.hint")} actions={rules.length > 0 && addButton("secondary")}>
      {loading ? (
        <ListSkeleton rows={2} />
      ) : !rules.length ? (
        <SettingsEmpty
          className="min-h-[280px]"
          art="settings"
          title={t("assignment.rules.emptyTitle")}
          description={t("assignment.rules.emptyHint")}
          action={addButton("primary")}
          tips={[
            { label: t("assignment.rules.tips.order"), icon: <UsersRound /> },
            { label: t("assignment.rules.tips.pool"), icon: <Inbox /> },
          ]}
        />
      ) : (
        <MotionList>
          {sorted.map((r) => (
            <MotionRow key={key(r)}>
              <ListRow>
                <IconTile tone={r.target_type === "team" ? "teal" : "blue"}>{r.target_type === "team" ? <UsersRound /> : <Inbox />}</IconTile>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">{nameOf(r) ?? t("assignment.rules.missing")}</div>
                  <div className="mt-0.5 truncate text-[12px] text-fg-3">
                    {r.target_type === "team" ? t("assignment.rules.team") : t("assignment.rules.mailbox")}
                    {detailOf(r) && <span className="text-fg-4"> · {detailOf(r)}</span>}
                  </div>
                </div>
                <Select
                  size="sm"
                  className="w-[160px]"
                  aria-label={t("assignment.rules.modeFor", { name: nameOf(r) ?? "" })}
                  disabled={!canEdit}
                  value={r.mode}
                  onChange={(mode) => onRules(rules.map((x) => (key(x) === key(r) ? { ...x, mode } : x)))}
                  options={MODES.map((m) => ({ value: m, label: t(`assignment.modes.${m}.label`), icon: <span className={cn("flex", tone[modeTone[m]].text)}>{modeIcon[m]}</span> }))}
                />
                {canEdit && (
                  <Tooltip content={t("assignment.rules.remove")}>
                    <Button size="sm" variant="ghost" square aria-label={t("assignment.rules.removeFor", { name: nameOf(r) ?? "" })} onClick={() => remove(r)}>
                      <X className="size-3.5" />
                    </Button>
                  </Tooltip>
                )}
              </ListRow>
            </MotionRow>
          ))}
        </MotionList>
      )}
    </Section>
  );
}

/** Which assignment method a new ticket gets: its team's, else its address's, else the workspace's. */
function Precedence() {
  const { t } = useTranslation("settingsTeams");
  const steps = [
    { icon: <UsersRound />, hue: "teal" as const, label: t("scoped.precTeam"), hint: t("scoped.precTeamHint") },
    { icon: <Inbox />, hue: "blue" as const, label: t("scoped.precAddress"), hint: t("scoped.precAddressHint") },
    { icon: <Shuffle />, hue: "gray" as const, label: t("scoped.precWorkspace"), hint: t("scoped.precWorkspaceHint") },
  ];
  return (
    <section className="animate-rise-in">
      <div className="mb-3">
        <h2 className="text-[13px] font-semibold tracking-[-0.01em]">{t("scoped.precTitle")}</h2>
        <p className="mt-0.5 text-[12px] leading-[18px] text-fg-3">{t("scoped.precHint")}</p>
      </div>
      <ol className="grid gap-2 md:grid-cols-[1fr_auto_1fr_auto_1fr] md:items-stretch">
        {steps.map((s, i) => (
          <li key={i} className="contents">
            <div className="flex items-start gap-3 rounded-lg border border-line bg-surface px-3.5 py-3 shadow-xs">
              <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-md [&_svg]:size-3.5", tone[s.hue].chip)}>{s.icon}</span>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-[12.5px] font-medium">
                  <span className="mono text-[10.5px] text-fg-4">{i + 1}</span>
                  {s.label}
                </div>
                <p className="mt-0.5 text-[12px] leading-[17px] text-fg-3">{s.hint}</p>
              </div>
            </div>
            {i < steps.length - 1 && (
              <span aria-hidden className="hidden items-center text-[11px] text-fg-4 md:flex">
                {t("scoped.precElse")}
              </span>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Workspace expertise catalog. Skills are assigned here because they constrain automatic, not manual, assignment. */
function SkillsSection({ skills, members, loading }: { skills: Skill[]; members: Member[]; loading: boolean }) {
  const { t } = useTranslation("settingsInbox");
  const qc = useQueryClient();
  const write = (skill: Skill) => upsertInList(qc, qk.skills, skill);
  const create = useMutation({
    mutationFn: (name: string) => api.skills.create({ name }),
    onSuccess: (skill) => {
      write(skill);
      toast.success(t("assignment.skills.created", { name: skill.name }));
    },
    onError: (error) => toast.error(error, t("assignment.skills.saveFailed")),
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: { archived: boolean } }) => api.skills.update(id, body),
    onSuccess: write,
    onError: (error) => toast.error(error, t("assignment.skills.saveFailed")),
  });
  const replaceMembers = useMutation({
    mutationFn: ({ id, member_ids }: { id: string; member_ids: string[] }) => api.skills.replaceMembers(id, member_ids),
    onSuccess: write,
    onError: (error) => toast.error(error, t("assignment.skills.saveFailed")),
  });
  const memberItems = members.map((member) => ({ value: member.user.id, label: member.user.name, keywords: [member.user.email], icon: <Avatar name={member.user.name} src={member.user.avatar_url} size="xs" /> }));
  const active = skills.filter((skill) => !skill.archived);

  return (
    <Section
      flush
      title={t("assignment.skills.title")}
      description={t("assignment.skills.hint")}
      actions={
        <Picker
          value={null}
          items={[]}
          placeholder={t("assignment.skills.namePlaceholder")}
          emptyText={t("assignment.skills.createHint")}
          onSelect={() => {}}
          onCreate={(name) => create.mutate(name)}
          createLabel={t("assignment.skills.create")}
          trigger={<Button size="sm" variant="secondary" icon={<Plus className="size-3.5" />} loading={create.isPending}>{t("assignment.skills.add")}</Button>}
        />
      }
    >
      {loading ? (
        <ListSkeleton rows={2} />
      ) : !skills.length ? (
        <SettingsEmpty className="min-h-[220px]" art="settings" title={t("assignment.skills.emptyTitle")} description={t("assignment.skills.emptyHint")} />
      ) : (
        <MotionList>
          {skills.map((skill) => (
            <MotionRow key={skill.id}>
              <ListRow className={cn(skill.archived && "opacity-65")}>
                <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-md", skill.archived ? tone.gray.chip : tone.violet.chip)}>
                  {skill.archived ? <Archive className="size-3.5" /> : <Sparkles className="size-3.5" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-[13px] font-medium">
                    <span className="truncate">{skill.name}</span>
                    {skill.archived && <span className="rounded-sm bg-hover px-1.5 py-0.5 text-[10.5px] font-medium text-fg-3">{t("assignment.skills.archived")}</span>}
                  </div>
                  <div className="mt-0.5 text-[12px] text-fg-3">{t("assignment.skills.memberCount", { count: skill.member_ids.length })}</div>
                </div>
                {!skill.archived && (
                  <Picker
                    multi
                    values={skill.member_ids}
                    items={memberItems}
                    placeholder={t("assignment.skills.members")}
                    onChange={(member_ids) => replaceMembers.mutate({ id: skill.id, member_ids })}
                    trigger={<Button size="sm" variant="ghost" className="w-[140px] justify-start">{skill.member_ids.length ? t("assignment.skills.memberCount", { count: skill.member_ids.length }) : t("assignment.skills.members")}</Button>}
                  />
                )}
                <Tooltip content={skill.archived ? t("assignment.skills.restore") : t("assignment.skills.archive")}>
                  <Button
                    size="sm"
                    variant="ghost"
                    square
                    aria-label={skill.archived ? t("assignment.skills.restoreNamed", { name: skill.name }) : t("assignment.skills.archiveNamed", { name: skill.name })}
                    loading={update.isPending && update.variables?.id === skill.id}
                    onClick={() => update.mutate({ id: skill.id, body: { archived: !skill.archived } })}
                  >
                    {skill.archived ? <ArchiveRestore className="size-3.5" /> : <Archive className="size-3.5" />}
                  </Button>
                </Tooltip>
              </ListRow>
            </MotionRow>
          ))}
        </MotionList>
      )}
      {active.length > 0 && <p className="border-t border-line-soft px-4 py-2 text-[11.5px] text-fg-4">{t("assignment.skills.note")}</p>}
    </Section>
  );
}

/** Member load grouped by team (leads and members; observers are never assigned), then everyone not on a team. */
function TeamGroups({ assignable, canEdit, mode, skills }: { assignable: Member[]; canEdit: boolean; mode: AssignMode; skills?: Skill[] }) {
  const { t } = useTranslation("settingsTeams");
  const { t: ti } = useTranslation("settingsInbox");
  const { teams } = useTeams();
  const groups = teams.map((team) => ({
    team,
    people: assignable.filter((m) => team.members.some((x) => x.user_id === m.user.id && x.role !== "observer")),
  }));
  const loose = assignable.filter((m) => !teams.some((x) => x.members.some((y) => y.user_id === m.user.id && y.role !== "observer")));
  return (
    <div>
      {groups.map(({ team, people }) => {
        const tm = team.assign_mode ?? mode;
        return (
          <div key={team.id} className="border-b border-line-soft last:border-0">
            <div className="flex items-center gap-2.5 bg-sunken/60 px-4 py-2">
              <TeamDot team={team} />
              <Link to="/settings/teams/$teamId" params={{ teamId: team.id }} className="text-[12.5px] font-medium hover:underline">
                {team.name}
              </Link>
              {team.private && <Lock className="size-3 text-fg-4" aria-label={t("common.private")} />}
              <span className="text-[11.5px] text-fg-4">{t("list.membersCount", { count: people.length })}</span>
              <span className={cn("ml-auto inline-flex items-center gap-1 text-[11.5px]", team.assign_mode ? tone[modeTone[tm]].text : "text-fg-3")}>
                <span className="flex [&_svg]:size-3">{modeIcon[tm]}</span>
                {ti(`assignment.modes.${tm}.label`)}
                {!team.assign_mode && <span className="text-fg-4">{t("scoped.default")}</span>}
              </span>
            </div>
            {people.length ? (
              <MotionList>
                {people.map((m) => (
                  <MotionRow key={m.user.id}>
                    <MemberLoad m={m} canEdit={canEdit} skills={skills} />
                  </MotionRow>
                ))}
              </MotionList>
            ) : (
              <div className="px-4 py-3 text-[12px] text-fg-4">{t("scoped.noAssignable")}</div>
            )}
          </div>
        );
      })}
      {loose.length > 0 && (
        <div>
          <div className="flex items-center gap-2.5 bg-sunken/60 px-4 py-2 text-[12.5px] font-medium">
            <span aria-hidden className="size-2 rounded-[3px] border border-dashed border-line-strong" />
            {t("scoped.noTeamGroup")}
            <span className="text-[11.5px] font-normal text-fg-4">{t("list.membersCount", { count: loose.length })}</span>
          </div>
          <MotionList>
            {loose.map((m) => (
              <MotionRow key={m.user.id}>
                <MemberLoad m={m} canEdit={canEdit} skills={skills} />
              </MotionRow>
            ))}
          </MotionList>
        </div>
      )}
    </div>
  );
}

/** Who hears about a new ticket nobody is assigned to (settings.new_ticket_notify). */
function NotifyRow({ value, onChange, disabled }: { value: NewTicketNotify; onChange: (v: NewTicketNotify) => void; disabled?: boolean }) {
  const { t } = useTranslation("settingsInbox");
  return (
    <Row label={t("assignment.notify.label")} description={t(`assignment.notify.options.${value}.hint`)}>
      <Select
        size="sm"
        className="w-[200px]"
        aria-label={t("assignment.notify.label")}
        disabled={disabled}
        value={value}
        onChange={onChange}
        options={NEW_TICKET_NOTIFY.map((v) => ({ value: v, label: t(`assignment.notify.options.${v}.label`), icon: <span className="flex text-fg-3">{notifyIcon[v]}</span> }))}
      />
    </Row>
  );
}

function AwayRow({ minutes, onChange, disabled }: { minutes: number; onChange: (n: number) => void; disabled?: boolean }) {
  const { t } = useTranslation("settingsInbox");
  const on = minutes > 0;
  const [draft, setDraft] = useState(on ? minutes : AWAY_DEFAULT);
  const [prev, setPrev] = useState(minutes);
  if (prev !== minutes) {
    setPrev(minutes);
    if (minutes > 0) setDraft(minutes);
  }
  return (
    <>
      <Row label={t("assignment.away.label")} description={on ? t("assignment.away.on", { count: minutes }) : t("assignment.away.off")}>
        <Switch aria-label={t("assignment.away.label")} checked={on} disabled={disabled} onCheckedChange={(v) => onChange(v ? draft : 0)} />
      </Row>
      {on && (
        <Row label={t("assignment.away.after")} description={t("assignment.away.afterHint")}>
          <Moon className="size-3.5 text-tone-amber" aria-hidden />
          <Stepper
            aria-label={t("assignment.away.after")}
            value={draft}
            min={10}
            max={1440}
            step={5}
            suffix={t("assignment.away.min")}
            disabled={disabled}
            className="w-[132px]"
            onChange={(n) => {
              setDraft(n);
              onChange(n);
            }}
          />
        </Row>
      )}
    </>
  );
}

function loadTone(open: number, max: number | null): Tone {
  if (max == null) return "gray";
  const r = open / Math.max(1, max);
  return r >= 1 ? "red" : r >= 0.75 ? "amber" : "green";
}

function MemberLoad({ m, canEdit, skills }: { m: Member; canEdit: boolean; skills?: Skill[] }) {
  const { t } = useTranslation("settingsInbox");
  const setAvail = useSetAvailability();
  const reduce = useReducedMotion();
  const idle = m.availability === "online" && m.presence === "away";
  const cap = m.max_open_tickets;
  const pct = cap ? Math.min(1, m.open_tickets / Math.max(1, cap)) : 0;
  const lt = loadTone(m.open_tickets, cap);
  const memberSkills = (skills ?? []).filter((skill) => skill.member_ids.includes(m.user.id));
  const save = (v: { availability?: Member["availability"]; max_open_tickets?: number | null }) =>
    setAvail.mutate({ userId: m.user.id, ...v }, { onError: (e) => toast.error(e, t("assignment.member.saveFailed")) });

  const status = (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-fg-2">
      <AvailabilityDot value={m.presence} />
      {idle ? t("assignment.presence.idle") : t(`assignment.presence.${m.presence}`)}
    </span>
  );

  return (
    <ListRow className="gap-4">
      <Avatar name={m.user.name} src={m.user.avatar_url} size="md" presence={m.presence} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium">{m.user.name}</span>
          <RolePill role={m.role} />
        </div>
        <div className="mt-0.5 truncate text-[12px] text-fg-3">{m.user.email}</div>
        {memberSkills.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{memberSkills.map((skill) => <TagChip key={skill.id} name={skill.name} color={skill.archived ? "gray" : "violet"} />)}</div>}
      </div>
      <div className="hidden w-[120px] shrink-0 sm:block">
        {canEdit ? (
          <Menu>
            <MenuTrigger asChild>
              <button
                type="button"
                aria-label={t("assignment.member.setAvailability", { name: m.user.name })}
                className="-ml-1.5 inline-flex h-7 items-center rounded-md px-1.5 transition-colors hover:bg-hover"
              >
                {status}
              </button>
            </MenuTrigger>
            <MenuContent align="start" className="w-[200px]">
              <AvailabilityMenuItems value={m.availability} onChange={(availability) => save({ availability })} openTickets={m.open_tickets} maxOpenTickets={cap} />
            </MenuContent>
          </Menu>
        ) : (
          status
        )}
      </div>
      <div className="flex w-[150px] shrink-0 flex-col gap-1">
        <span className="flex items-baseline justify-between text-[12px] tabular-nums">
          <span className="text-fg-2">
            <span className="font-medium text-fg">{m.open_tickets}</span>
            {cap != null && <span className="text-fg-4"> / {cap}</span>}
          </span>
          <span className="text-[11px] text-fg-4">{cap == null ? t("assignment.member.noCap") : t("assignment.member.open")}</span>
        </span>
        <span className="h-1 overflow-hidden rounded-full bg-hover" aria-hidden>
          {cap != null && (
            <motion.span
              className={cn("block h-full rounded-full", tone[lt].solid)}
              initial={false}
              animate={{ width: `${Math.max(4, pct * 100)}%` }}
              transition={reduce ? { duration: 0 } : springs.glide}
            />
          )}
        </span>
      </div>
      {canEdit && <CapEditor m={m} onSave={(max_open_tickets) => save({ max_open_tickets })} />}
    </ListRow>
  );
}

function CapEditor({ m, onSave }: { m: Member; onSave: (n: number | null) => void }) {
  const { t } = useTranslation("settingsInbox");
  const [open, setOpen] = useState(false);
  const [limited, setLimited] = useState(m.max_open_tickets != null);
  const [n, setN] = useState(m.max_open_tickets ?? 10);
  const reset = () => {
    setLimited(m.max_open_tickets != null);
    setN(m.max_open_tickets ?? 10);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        if (o) reset();
        setOpen(o);
      }}
      align="end"
      className="w-[260px] p-3"
      trigger={
        <Button size="sm" variant="ghost" className="w-[84px] justify-center" aria-label={t("assignment.member.capFor", { name: m.user.name })}>
          {m.max_open_tickets == null ? t("assignment.member.setCap") : t("assignment.member.capShort", { count: m.max_open_tickets })}
        </Button>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(limited ? n : null);
          setOpen(false);
        }}
      >
        <div>
          <div className="text-[13px] font-medium">{t("assignment.member.capTitle")}</div>
          <p className="mt-0.5 text-[12px] leading-[17px] text-fg-3">{t("assignment.member.capHint", { name: m.user.name.split(" ")[0] })}</p>
        </div>
        <label className="flex items-center justify-between gap-3 text-[12.5px]">
          {t("assignment.member.limit")}
          <Switch checked={limited} onCheckedChange={setLimited} aria-label={t("assignment.member.limit")} />
        </label>
        {limited && (
          <Stepper
            aria-label={t("assignment.member.capTitle")}
            value={n}
            min={1}
            max={500}
            suffix={t("assignment.member.tickets")}
            className="w-full"
            onChange={setN}
          />
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" size="sm" variant="primary">
            {t("assignment.member.saveCap")}
          </Button>
        </div>
      </form>
    </Popover>
  );
}

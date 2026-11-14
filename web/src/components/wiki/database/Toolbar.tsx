// The controls above a database view (Notion's): filter with rules and and/or groups, sort
// by several properties, group, show and order properties, and search. They change the view's
// own settings, which every member shares; active filters and sorts show as chips.

import { ArrowDownUp, Eye, EyeOff, Filter, GripVertical, Layers, ListFilter, Plus, Settings2, Trash2, X } from "lucide-react";
import { Popover as P } from "radix-ui";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { floatingPanel } from "@/components/ui/popover";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { Database, DbFilterGroup, DbFilterRule, DbProperty, DbSort, DbView, DbViewSettings } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { disablePair, enablePair, FILTER_OPS, visibleProps } from "@/lib/wiki/db";
import { PropIcon } from "./cells";

/** A tool's word, shown once the database is wide enough for it; the icon stays. */
const toolLabel = "hidden @[46rem]/db:inline";

export const toolButton =
  "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-fg-3 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:shadow-[0_0_0_2px_var(--focus)] data-[state=open]:bg-hover data-[state=open]:text-fg [&_svg]:size-3.5";

function Pop({ trigger, children, width = 320, open, onOpenChange }: { trigger: ReactNode; children: ReactNode; width?: number; open?: boolean; onOpenChange?: (o: boolean) => void }) {
  return (
    <P.Root open={open} onOpenChange={onOpenChange}>
      <P.Trigger asChild>{trigger}</P.Trigger>
      <P.Portal>
        <P.Content align="end" sideOffset={6} collisionPadding={8} style={{ width }} className={cn(floatingPanel, "max-h-[min(480px,calc(var(--radix-popover-content-available-height)/var(--od-zoom,1)))] overflow-y-auto p-1.5")} onClick={(e) => e.stopPropagation()}>
          {children}
        </P.Content>
      </P.Portal>
    </P.Root>
  );
}

const isGroup = (r: DbFilterRule | DbFilterGroup): r is DbFilterGroup => "rules" in r;

/** The operators a property offers, with words, and whether they take a value. */
export function opsFor(prop: DbProperty) {
  return (FILTER_OPS[prop.type] ?? []) as readonly string[];
}
const NO_VALUE = new Set(["is_empty", "is_not_empty"]);

export function FilterMenu({ db, view, onChange, canEdit, open, onOpenChange }: { db: Database; view: DbView; onChange: (s: DbViewSettings) => void; canEdit: boolean; open?: boolean; onOpenChange?: (o: boolean) => void }) {
  const { t } = useTranslation("wiki");
  const group: DbFilterGroup = view.settings?.filter ?? { op: "and", rules: [] };
  const set = (g: DbFilterGroup) => onChange({ ...view.settings, filter: g.rules.length ? g : undefined });
  const count = group.rules.length;
  return (
    <Pop
      width={460}
      open={open}
      onOpenChange={onOpenChange}
      trigger={
        <button type="button" aria-label={t("db.filter")} className={cn(toolButton, count > 0 && "text-tone-blue")}>
          <ListFilter />
          <span className={toolLabel}>{t("db.filter")}</span>
          {count > 0 && <span className="mono text-[11px]">{count}</span>}
        </button>
      }
    >
      <FilterGroupEditor db={db} group={group} onChange={set} depth={0} canEdit={canEdit} />
    </Pop>
  );
}

function FilterGroupEditor({ db, group, onChange, depth, canEdit }: { db: Database; group: DbFilterGroup; onChange: (g: DbFilterGroup) => void; depth: number; canEdit: boolean }) {
  const { t } = useTranslation("wiki");
  const filterable = db.properties.filter((p) => opsFor(p).length);
  const addRule = () => {
    const p = filterable[0];
    if (p) onChange({ ...group, rules: [...group.rules, { property: p.id, op: opsFor(p)[0] }] });
  };
  return (
    <div className={cn("flex flex-col gap-1", depth > 0 && "rounded-lg border border-line bg-sunken p-1.5")}>
      {group.rules.length === 0 && <p className="px-1.5 py-2 text-[12.5px] text-fg-3">{t("db.noFilters")}</p>}
      {group.rules.map((r, i) => (
        <div key={i} className="flex items-start gap-1">
          <span className="w-[54px] shrink-0 pt-1.5 text-[12px] text-fg-3">
            {i === 0 ? (
              t("db.where")
            ) : i === 1 ? (
              <Select size="sm" className="h-7 w-[54px] px-1.5" aria-label={t("db.join")} value={group.op} onChange={(op) => onChange({ ...group, op })} options={[{ value: "and", label: t("db.and") }, { value: "or", label: t("db.or") }]} disabled={!canEdit} />
            ) : (
              t(`db.${group.op}`)
            )}
          </span>
          <div className="min-w-0 flex-1">
            {isGroup(r) ? (
              <FilterGroupEditor db={db} group={r} depth={depth + 1} canEdit={canEdit} onChange={(g) => onChange({ ...group, rules: group.rules.map((x, j) => (j === i ? g : x)) })} />
            ) : (
              <RuleEditor db={db} rule={r} canEdit={canEdit} onChange={(nr) => onChange({ ...group, rules: group.rules.map((x, j) => (j === i ? nr : x)) })} />
            )}
          </div>
          {canEdit && (
            <button type="button" aria-label={t("db.removeRule")} onClick={() => onChange({ ...group, rules: group.rules.filter((_, j) => j !== i) })} className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md text-fg-4 hover:bg-hover hover:text-fg">
              <Trash2 className="size-3.5" />
            </button>
          )}
        </div>
      ))}
      {canEdit && (
        <div className="flex gap-1 pt-0.5">
          <button type="button" onClick={addRule} className={toolButton}>
            <Plus />
            {t("db.addFilter")}
          </button>
          {depth < 2 && (
            <button type="button" onClick={() => onChange({ ...group, rules: [...group.rules, { op: group.op === "and" ? "or" : "and", rules: [] }] })} className={toolButton}>
              <Layers />
              {t("db.addGroup")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function RuleEditor({ db, rule, onChange, canEdit }: { db: Database; rule: DbFilterRule; onChange: (r: DbFilterRule) => void; canEdit: boolean }) {
  const { t } = useTranslation("wiki");
  const prop = db.properties.find((p) => p.id === rule.property);
  const ops = prop ? opsFor(prop) : [];
  const valueInput = () => {
    if (!prop || NO_VALUE.has(rule.op)) return null;
    const set = (value: unknown) => onChange({ ...rule, value });
    if (prop.type === "checkbox")
      return <Select size="sm" className="w-full" aria-label={t("db.value")} value={rule.value === false ? "false" : "true"} onChange={(v) => set(v === "true")} options={[{ value: "true", label: t("db.checked") }, { value: "false", label: t("db.unchecked") }]} />;
    if ((prop.type === "select" || prop.type === "status" || prop.type === "multi_select") && rule.op !== "group_is")
      return <Select size="sm" className="w-full" aria-label={t("db.value")} value={(rule.value as string) ?? undefined} onChange={set} options={(prop.options ?? []).map((o) => ({ value: o.id, label: o.name }))} />;
    if (rule.op === "group_is") return <Select size="sm" className="w-full" aria-label={t("db.value")} value={(rule.value as string) ?? undefined} onChange={set} options={(["todo", "doing", "done"] as const).map((g) => ({ value: g, label: t(`db.statusGroup.${g}`) }))} />;
    if (rule.op === "is_relative")
      return (
        <Select
          size="sm"
          className="w-full"
          aria-label={t("db.value")}
          value={(rule.value as string) ?? undefined}
          onChange={set}
          options={(["today", "tomorrow", "yesterday", "this_week", "past_week", "next_week", "this_month", "past_month", "next_month", "this_year"] as const).map((r) => ({ value: r, label: t(`db.relative.${r}`) }))}
        />
      );
    const date = ["date", "created_time", "edited_time"].includes(prop.type);
    return (
      <input
        type={date ? "date" : "text"}
        inputMode={prop.type === "number" ? "decimal" : undefined}
        defaultValue={rule.value === undefined ? "" : String(rule.value)}
        disabled={!canEdit}
        onBlur={(e) => set(prop.type === "number" ? Number(e.target.value) : e.target.value)}
        placeholder={t("db.value")}
        className="h-7 w-full rounded-md border border-line bg-surface px-2 text-[12.5px] text-fg outline-none focus:border-fg-3"
      />
    );
  };
  return (
    <div className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1.1fr)] gap-1">
      <Select
        size="sm"
        aria-label={t("db.property")}
        disabled={!canEdit}
        value={rule.property}
        onChange={(id) => {
          const p = db.properties.find((x) => x.id === id);
          onChange({ property: id, op: p ? opsFor(p)[0] : rule.op });
        }}
        options={db.properties.filter((p) => opsFor(p).length).map((p) => ({ value: p.id, label: p.name, icon: <PropIcon type={p.type} /> }))}
      />
      <Select size="sm" aria-label={t("db.operator")} disabled={!canEdit} value={rule.op} onChange={(op) => onChange({ ...rule, op })} options={ops.map((o) => ({ value: o, label: t(`db.op.${o}` as "db.op.is") }))} />
      {valueInput() ?? <span />}
    </div>
  );
}

export function SortMenu({ db, view, onChange, canEdit }: { db: Database; view: DbView; onChange: (s: DbViewSettings) => void; canEdit: boolean }) {
  const { t } = useTranslation("wiki");
  const sorts = view.settings?.sorts ?? [];
  const set = (next: DbSort[]) => onChange({ ...view.settings, sorts: next.length ? next : undefined });
  return (
    <Pop
      width={360}
      trigger={
        <button type="button" aria-label={t("db.sort")} className={cn(toolButton, sorts.length > 0 && "text-tone-blue")}>
          <ArrowDownUp />
          <span className={toolLabel}>{t("db.sort")}</span>
          {sorts.length > 0 && <span className="mono text-[11px]">{sorts.length}</span>}
        </button>
      }
    >
      {sorts.length === 0 && <p className="px-1.5 py-2 text-[12.5px] text-fg-3">{t("db.noSorts")}</p>}
      {sorts.map((s, i) => (
        <div key={i} className="flex items-center gap-1 py-0.5">
          <GripVertical className="size-3.5 shrink-0 text-fg-4" />
          <Select size="sm" className="min-w-0 flex-1" aria-label={t("db.property")} disabled={!canEdit} value={s.property} onChange={(property) => set(sorts.map((x, j) => (j === i ? { ...x, property } : x)))} options={db.properties.map((p) => ({ value: p.id, label: p.name, icon: <PropIcon type={p.type} /> }))} />
          <Select size="sm" className="w-[118px]" aria-label={t("db.direction")} disabled={!canEdit} value={s.dir} onChange={(dir) => set(sorts.map((x, j) => (j === i ? { ...x, dir } : x)))} options={[{ value: "asc", label: t("db.ascending") }, { value: "desc", label: t("db.descending") }]} />
          {canEdit && (
            <button type="button" aria-label={t("db.removeSort")} onClick={() => set(sorts.filter((_, j) => j !== i))} className="flex size-7 shrink-0 items-center justify-center rounded-md text-fg-4 hover:bg-hover hover:text-fg">
              <X className="size-3.5" />
            </button>
          )}
        </div>
      ))}
      {canEdit && (
        <button type="button" onClick={() => set([...sorts, { property: db.properties.find((p) => !sorts.some((s) => s.property === p.id))?.id ?? "title", dir: "asc" }])} className={cn(toolButton, "mt-0.5")}>
          <Plus />
          {t("db.addSort")}
        </button>
      )}
    </Pop>
  );
}

export function PropertiesMenu({ db, view, onChange }: { db: Database; view: DbView; onChange: (s: DbViewSettings) => void }) {
  const { t } = useTranslation("wiki");
  const [drag, setDrag] = useState<string | null>(null);
  const hidden = new Set(view.settings?.hidden ?? []);
  const order = [...visibleProps(db, view).map((p) => p.id), ...db.properties.filter((p) => hidden.has(p.id)).map((p) => p.id)];
  const ordered = order.map((id) => db.properties.find((p) => p.id === id)).filter((p): p is DbProperty => !!p);
  const toggle = (id: string) => onChange({ ...view.settings, hidden: hidden.has(id) ? [...hidden].filter((x) => x !== id) : [...hidden, id] });
  return (
    <Pop
      width={280}
      trigger={
        <button type="button" aria-label={t("db.properties")} className={toolButton}>
          <Eye />
          <span className={toolLabel}>{t("db.properties")}</span>
        </button>
      }
    >
      <div className="flex items-center justify-between px-1.5 pb-1 pt-0.5">
        <span className="label-caps">{t("db.shownInView")}</span>
        <button type="button" onClick={() => onChange({ ...view.settings, hidden: hidden.size ? [] : db.properties.filter((p) => p.type !== "title").map((p) => p.id) })} className="text-[11.5px] text-fg-3 hover:text-fg">
          {hidden.size ? t("db.showAll") : t("db.hideAll")}
        </button>
      </div>
      {ordered.map((p) => (
        <div
          key={p.id}
          draggable={p.type !== "title"}
          onDragStart={() => setDrag(p.id)}
          onDragEnd={() => setDrag(null)}
          onDragOver={(e) => {
            if (!drag || drag === p.id || p.type === "title") return;
            e.preventDefault();
            const ids = order.filter((x) => x !== drag);
            ids.splice(ids.indexOf(p.id), 0, drag);
            onChange({ ...view.settings, order: ids });
          }}
          className={cn("flex h-8 items-center gap-2 rounded-md px-1.5 hover:bg-hover", drag === p.id && "opacity-40")}
        >
          <GripVertical className={cn("size-3.5 text-fg-4", p.type === "title" ? "invisible" : "cursor-grab")} />
          <PropIcon type={p.type} />
          <span className={cn("min-w-0 flex-1 truncate text-[12.5px]", hidden.has(p.id) ? "text-fg-4" : "text-fg")}>{p.name}</span>
          {p.type !== "title" && (
            <button type="button" aria-label={hidden.has(p.id) ? t("db.show") : t("db.hide")} onClick={() => toggle(p.id)} className="flex size-6 items-center justify-center rounded text-fg-3 hover:bg-active hover:text-fg">
              {hidden.has(p.id) ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </button>
          )}
        </div>
      ))}
    </Pop>
  );
}

/** Which property a board's columns (or a table's groups) are made of. */
export function GroupMenu({ db, view, onChange, required }: { db: Database; view: DbView; onChange: (s: DbViewSettings) => void; required?: boolean }) {
  const { t } = useTranslation("wiki");
  const groupable = db.properties.filter((p) => ["select", "multi_select", "status", "person", "checkbox", "date", "created_by", "edited_by", "text", "number"].includes(p.type));
  const cur = view.settings?.group_by;
  return (
    <Pop
      width={260}
      trigger={
        <button type="button" aria-label={t("db.group")} className={cn(toolButton, cur && "text-tone-blue")}>
          <Layers />
          <span className={toolLabel}>{t("db.group")}</span>
        </button>
      }
    >
      <div className="label-caps px-1.5 pb-1 pt-0.5">{t("db.groupBy")}</div>
      {!required && (
        <button type="button" onClick={() => onChange({ ...view.settings, group_by: undefined })} className={cn("flex h-8 w-full items-center gap-2 rounded-md px-1.5 text-[12.5px] hover:bg-hover", !cur && "font-medium")}>
          <X className="size-3.5 text-fg-3" />
          {t("db.noGrouping")}
        </button>
      )}
      {groupable.map((p) => (
        <button key={p.id} type="button" onClick={() => onChange({ ...view.settings, group_by: p.id })} className={cn("flex h-8 w-full items-center gap-2 rounded-md px-1.5 text-[12.5px] hover:bg-hover", cur === p.id && "bg-hover font-medium")}>
          <PropIcon type={p.type} />
          {p.name}
        </button>
      ))}
      {cur && (
        <label className="mt-1 flex h-8 items-center justify-between border-t border-line px-1.5 pt-1 text-[12.5px] text-fg-2">
          {t("db.hideEmptyGroups")}
          <Switch checked={!!view.settings?.hide_empty_groups} onCheckedChange={(v) => onChange({ ...view.settings, hide_empty_groups: v })} />
        </label>
      )}
    </Pop>
  );
}

/** The active filters and sorts under the toolbar, as chips. */
export function ActiveChips({ db, view, onChange, onOpenFilter }: { db: Database; view: DbView; onChange: (s: DbViewSettings) => void; onOpenFilter: () => void }) {
  const { t } = useTranslation("wiki");
  const rules = view.settings?.filter?.rules ?? [];
  const sorts = view.settings?.sorts ?? [];
  if (!rules.length && !sorts.length) return null;
  const name = (id: string) => db.properties.find((p) => p.id === id)?.name ?? "?";
  return (
    <div className="flex flex-wrap items-center gap-1 pb-2">
      {sorts.map((s, i) => (
        <span key={`s${i}`} className="inline-flex h-6 items-center gap-1 rounded-full border border-line bg-surface px-2 text-[11.5px] text-fg-2">
          <ArrowDownUp className="size-3" />
          {name(s.property)}
          <span className="text-fg-4">{s.dir === "asc" ? "↑" : "↓"}</span>
        </span>
      ))}
      {rules.map((r, i) => (
        <button key={`f${i}`} type="button" onClick={onOpenFilter} className="inline-flex h-6 items-center gap-1 rounded-full border border-tone-blue-line bg-tone-blue-soft px-2 text-[11.5px] text-tone-blue">
          <Filter className="size-3" />
          {isGroup(r) ? t("db.filterGroup", { count: r.rules.length }) : `${name(r.property)} ${t(`db.op.${r.op}` as "db.op.is")}`}
        </button>
      ))}
      <button type="button" onClick={() => onChange({ ...view.settings, filter: undefined, sorts: undefined })} className="h-6 rounded-full px-2 text-[11.5px] text-fg-3 hover:bg-hover hover:text-fg">
        {t("db.reset")}
      </button>
    </div>
  );
}

/** A layout's own settings: the dates a calendar or timeline places rows by, a timeline's
 * scale, what cards show, a chart's kind and axes; then the database's own: sub-items and
 * dependencies. */
export function LayoutMenu({ db, view, databaseId, onChange, onSchema }: { db: Database; view: DbView; databaseId: string; onChange: (s: DbViewSettings) => void; onSchema: (db: Database) => void }) {
  const { t } = useTranslation("wiki");
  const s = view.settings ?? {};
  const set = (patch: Partial<DbViewSettings>) => onChange({ ...s, ...patch });
  const of = (types: string[]) => db.properties.filter((p) => types.includes(p.type)).map((p) => ({ value: p.id, label: p.name }));
  const dates = of(["date", "created_time", "edited_time", "formula"]);
  const row = (label: string, control: ReactNode) => (
    <div className="flex h-9 items-center justify-between gap-3 px-1.5 text-[12.5px] text-fg-2">
      <span className="shrink-0">{label}</span>
      {control}
    </div>
  );
  const sel = <V extends string>(label: string, value: V | undefined, options: { value: V; label: string }[], pick: (v: V) => void) =>
    row(label, <Select size="sm" className="w-40" aria-label={label} value={value} onChange={pick} options={options} placeholder={t("db.noValue")} />);
  const type = view.type;
  const own = type !== "table" && type !== "list" && type !== "form";
  const pair = (kind: "sub_items" | "dependencies", label: string, hint: string, names: { first: string; second: string }) => (
    <label className="flex cursor-pointer items-start justify-between gap-3 rounded-md px-1.5 py-2 hover:bg-hover">
      <span className="min-w-0">
        <span className="block text-[12.5px] text-fg">{label}</span>
        <span className="block text-[11.5px] leading-[16px] text-fg-3">{db[kind] ? `${hint} ${t("db.pairOffHint")}` : hint}</span>
      </span>
      <Switch checked={!!db[kind]} onCheckedChange={(on) => onSchema(on ? enablePair(db, databaseId, kind, names) : disablePair(db, kind))} />
    </label>
  );
  return (
    <Pop
      width={300}
      trigger={
        <button type="button" aria-label={t("db.layout")} className={toolButton}>
          <Settings2 />
        </button>
      }
    >
      {own && <div className="label-caps px-1.5 pb-1 pt-0.5">{t(`db.view.${type}`)}</div>}
      {(type === "calendar" || type === "timeline") && sel(t("db.dateProperty"), s.date_property, dates, (v) => set({ date_property: v }))}
      {type === "timeline" && sel(t("db.endProperty"), s.end_property, [{ value: "", label: t("db.noValue") }, ...dates], (v) => set({ end_property: v || undefined }))}
      {type === "timeline" &&
        sel(
          t("db.scale"),
          s.timeline_scale ?? "week",
          (["day", "week", "month", "quarter"] as const).map((v) => ({ value: v, label: t(`db.timeline.${v}`) })),
          (v) => set({ timeline_scale: v }),
        )}
      {(type === "board" || type === "gallery") && (
        <>
          {sel(t("db.cardPreview"), s.card_preview ?? (type === "gallery" ? "cover" : "none"), (["none", "cover", "content"] as const).map((v) => ({ value: v, label: t(`db.preview.${v}`) })), (v) => set({ card_preview: v }))}
          {sel(t("db.cardSize"), s.card_size ?? "medium", (["small", "medium", "large"] as const).map((v) => ({ value: v, label: t(`db.size.${v}`) })), (v) => set({ card_size: v }))}
          {row(t("db.fitImage"), <Switch checked={!!s.card_fit} onCheckedChange={(v) => set({ card_fit: v })} />)}
        </>
      )}
      {type === "chart" && (
        <>
          {sel(t("db.chartKind"), s.chart?.kind ?? "bar", (["bar", "column", "donut", "line"] as const).map((v) => ({ value: v, label: t(`db.chart.${v}`) })), (v) => set({ chart: { x: s.chart?.x ?? "", ...s.chart, kind: v } }))}
          {sel(t("db.chartX"), s.chart?.x, of(["select", "multi_select", "status", "person", "checkbox", "date", "created_time", "created_by", "text"]), (v) => set({ chart: { kind: s.chart?.kind ?? "bar", ...s.chart, x: v } }))}
          {sel(
            t("db.chartY"),
            s.chart?.y?.property ?? "",
            [{ value: "", label: t("db.count") }, ...of(["number", "formula", "rollup"])],
            (v) => set({ chart: { kind: s.chart?.kind ?? "bar", x: s.chart?.x ?? "", y: v ? { property: v, fn: s.chart?.y?.fn === "avg" ? "avg" : "sum" } : undefined } }),
          )}
          {s.chart?.y &&
            sel(
              t("db.calculate"),
              s.chart.y.fn,
              [
                { value: "sum" as const, label: t("db.sum") },
                { value: "avg" as const, label: t("db.average") },
              ],
              (v) => set({ chart: { ...s.chart!, y: { ...s.chart!.y!, fn: v } } }),
            )}
        </>
      )}
      <div className={cn("label-caps px-1.5 pb-1 pt-0.5", own && "mt-1 border-t border-line pt-2")}>{t("db.thisDatabase")}</div>
      {pair("sub_items", t("db.subItems.setting"), t("db.subItems.hint"), { first: t("db.subItems.parent"), second: t("db.subItems.children") })}
      {pair("dependencies", t("db.dependencies.setting"), t("db.dependencies.hint"), { first: t("db.dependencies.blockedBy"), second: t("db.dependencies.blocking") })}
    </Pop>
  );
}

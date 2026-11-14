// A property's menu, from its column header or the row page: its name, its type, what that
// type needs (options and their colours, a number format, the time of day, the related
// database, a rollup, a formula, an id's letters), then sort, filter, hide, insert,
// duplicate and delete. Every change replaces the schema, shown at once.

import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronRight, Copy, EyeOff, Filter, GripVertical, Plus, Trash2, X } from "lucide-react";
import { Popover as P } from "radix-ui";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useConfirm } from "@/components/ui/confirm";
import { floatingPanel } from "@/components/ui/popover";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { Database, DbNumberFormat, DbOption, DbProperty, DbPropType, DbRollupFn, DbStatusGroup, DbTone, DbView } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { q } from "@/lib/queries";
import { addProperty, changePropertyType, newOptionId, newPropId, pairsOf, parseFormula, removeProperty, TONE_ORDER } from "@/lib/wiki/db";
import { PageIcon } from "../PageTree";
import { PROP_ICONS, PropIcon } from "./cells";

export const TYPE_ORDER: DbPropType[] = [
  "text",
  "number",
  "select",
  "multi_select",
  "status",
  "date",
  "person",
  "files",
  "checkbox",
  "url",
  "email",
  "phone",
  "ticket",
  "relation",
  "rollup",
  "formula",
  "unique_id",
  "created_time",
  "created_by",
  "edited_time",
  "edited_by",
];

const FORMATS: DbNumberFormat[] = ["number", "comma", "percent", "usd", "eur", "gbp", "jpy", "chf", "cad", "aud", "inr", "brl", "huf", "pln"];
const ROLLUP_FNS: DbRollupFn[] = ["show_original", "count", "count_values", "count_unique", "count_empty", "count_not_empty", "percent_empty", "percent_not_empty", "sum", "avg", "median", "min", "max", "range", "earliest", "latest", "checked", "unchecked", "percent_checked"];

const row = "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px] text-fg outline-none transition-colors hover:bg-hover focus-visible:bg-hover [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-fg-3";

type Props = {
  db: Database;
  prop: DbProperty;
  view?: DbView;
  trigger: ReactNode;
  canEdit: boolean;
  onSave: (db: Database) => void;
  onSort?: (dir: "asc" | "desc") => void;
  onFilter?: () => void;
  onHide?: () => void;
  onInsert?: (side: "left" | "right", id: string) => void;
};

export function PropertyMenu({ db, prop, view, trigger, canEdit, onSave, onSort, onFilter, onHide, onInsert }: Props) {
  const { t } = useTranslation("wiki");
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [pane, setPane] = useState<"main" | "type">("main");
  const [name, setName] = useState(prop.name);
  const save = (next: Partial<DbProperty>) => onSave({ ...db, properties: db.properties.map((p) => (p.id === prop.id ? { ...p, ...next } : p)) });
  const title = prop.type === "title";

  return (
    <P.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          setPane("main");
          setName(prop.name);
        } else if (name.trim() && name.trim() !== prop.name) save({ name: name.trim() });
      }}
    >
      <P.Trigger asChild>{trigger}</P.Trigger>
      <P.Portal>
        <P.Content align="start" sideOffset={4} collisionPadding={8} className={cn(floatingPanel, "max-h-[min(560px,calc(var(--radix-popover-content-available-height)/var(--od-zoom,1)))] w-[272px] overflow-y-auto p-1")} onClick={(e) => e.stopPropagation()}>
          {pane === "type" ? (
            <>
              <button type="button" className={row} onClick={() => setPane("main")}>
                <ArrowLeft />
                <span className="font-medium">{t("db.prop.type")}</span>
              </button>
              <div className="my-1 h-px bg-line" />
              {TYPE_ORDER.map((ty) => {
                const Icon = PROP_ICONS[ty];
                return (
                  <button
                    key={ty}
                    type="button"
                    className={cn(row, ty === prop.type && "bg-hover")}
                    onClick={() => {
                      onSave(changePropertyType(db, prop.id, ty));
                      setPane("main");
                    }}
                  >
                    <Icon />
                    <span className="flex-1">{t(`db.type.${ty}`)}</span>
                  </button>
                );
              })}
            </>
          ) : (
            <>
              <div className="flex items-center gap-1.5 p-1">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-line">
                  <PropIcon type={prop.type} />
                </span>
                <input
                  autoFocus
                  disabled={!canEdit}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") setOpen(false);
                  }}
                  aria-label={t("db.prop.name")}
                  className="h-7 min-w-0 flex-1 rounded-md border border-line bg-surface px-2 text-[12.5px] text-fg outline-none focus:border-fg-3"
                />
              </div>
              {canEdit && !title && (
                <button type="button" className={row} onClick={() => setPane("type")}>
                  <PropIcon type={prop.type} />
                  <span className="flex-1">{t("db.prop.type")}</span>
                  <span className="text-fg-4">{t(`db.type.${prop.type}`)}</span>
                  <ChevronRight />
                </button>
              )}
              {canEdit && <TypeSettings db={db} prop={prop} save={save} />}
              <div className="my-1 h-px bg-line" />
              {onSort && (
                <>
                  <button type="button" className={row} onClick={() => (onSort("asc"), setOpen(false))}>
                    <ArrowUp />
                    {t("db.sortAsc")}
                  </button>
                  <button type="button" className={row} onClick={() => (onSort("desc"), setOpen(false))}>
                    <ArrowDown />
                    {t("db.sortDesc")}
                  </button>
                </>
              )}
              {onFilter && (
                <button type="button" className={row} onClick={() => (onFilter(), setOpen(false))}>
                  <Filter />
                  {t("db.filter")}
                </button>
              )}
              {onHide && !title && view && (
                <button type="button" className={row} onClick={() => (onHide(), setOpen(false))}>
                  <EyeOff />
                  {t("db.hideInView")}
                </button>
              )}
              {canEdit && onInsert && (
                <>
                  <div className="my-1 h-px bg-line" />
                  {(["left", "right"] as const).map((side) => (
                    <button
                      key={side}
                      type="button"
                      className={row}
                      onClick={() => {
                        const made = addProperty(db, "text", t("db.prop.newName"));
                        onSave(made.db);
                        onInsert(side, made.id);
                        setOpen(false);
                      }}
                    >
                      {side === "left" ? <ArrowLeft /> : <ArrowRight />}
                      {t(side === "left" ? "db.insertLeft" : "db.insertRight")}
                    </button>
                  ))}
                </>
              )}
              {canEdit && !title && (
                <>
                  <button
                    type="button"
                    className={row}
                    onClick={() => {
                      const id = newPropId(db);
                      const i = db.properties.findIndex((p) => p.id === prop.id);
                      const copy = { ...prop, id, name: t("db.prop.copyName", { name: prop.name }) };
                      onSave({ ...db, properties: [...db.properties.slice(0, i + 1), copy, ...db.properties.slice(i + 1)] });
                      setOpen(false);
                    }}
                  >
                    <Copy />
                    {t("db.prop.duplicate")}
                  </button>
                  <button
                    type="button"
                    className={cn(row, "text-danger-fg [&_svg]:text-danger-fg")}
                    onClick={() => {
                      setOpen(false);
                      confirm.show(t("db.prop.deleteBody"), async () => onSave(removeProperty(db, prop.id)), { title: t("db.prop.deleteTitle", { name: prop.name }), confirmLabel: t("db.prop.delete"), danger: true });
                    }}
                  >
                    <Trash2 />
                    {t("db.prop.delete")}
                  </button>
                </>
              )}
            </>
          )}
        </P.Content>
      </P.Portal>
    </P.Root>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <div className="label-caps px-2 pb-1 pt-2">{children}</div>;
}

function TypeSettings({ db, prop, save }: { db: Database; prop: DbProperty; save: (p: Partial<DbProperty>) => void }) {
  const { t } = useTranslation("wiki");
  switch (prop.type) {
    case "select":
    case "multi_select":
    case "status":
      return <OptionsEditor prop={prop} save={save} />;
    case "number":
      return (
        <>
          <Label>{t("db.prop.format")}</Label>
          <div className="grid grid-cols-2 gap-0.5 px-1">
            {FORMATS.map((f) => (
              <button key={f} type="button" onClick={() => save({ number_format: f })} className={cn("h-7 rounded-md px-2 text-left text-[12px] hover:bg-hover", (prop.number_format ?? "number") === f ? "bg-hover font-medium text-fg" : "text-fg-2")}>
                {t(`db.format.${f}`)}
              </button>
            ))}
          </div>
        </>
      );
    case "date":
      return (
        <label className={cn(row, "justify-between")}>
          {t("db.prop.includeTime")}
          <Switch checked={!!prop.date_time} onCheckedChange={(v) => save({ date_time: v })} />
        </label>
      );
    case "unique_id":
      return (
        <label className="flex items-center gap-2 px-2 py-1.5 text-[12.5px] text-fg-2">
          {t("db.prop.prefix")}
          <input defaultValue={prop.prefix ?? ""} maxLength={10} onBlur={(e) => save({ prefix: e.target.value.trim().toUpperCase() || undefined })} placeholder="TASK" className="h-7 min-w-0 flex-1 rounded-md border border-line bg-surface px-2 text-[12.5px] uppercase outline-none focus:border-fg-3" />
        </label>
      );
    case "relation": {
      // Sub-items and dependencies relate the database to itself, two properties in step.
      const partner = db.properties.find((p) => p.id === pairsOf(db).get(prop.id)?.partner);
      if (partner) return <p className="px-2 py-1.5 text-[12px] leading-[17px] text-fg-3">{t("db.pairedWith", { name: partner.name })}</p>;
      return <RelationTarget prop={prop} save={save} />;
    }
    case "rollup":
      return <RollupSettings db={db} prop={prop} save={save} />;
    case "formula":
      return <FormulaEditor prop={prop} save={save} db={db} />;
    default:
      return null;
  }
}

function OptionsEditor({ prop, save }: { prop: DbProperty; save: (p: Partial<DbProperty>) => void }) {
  const { t } = useTranslation("wiki");
  const [adding, setAdding] = useState("");
  const [drag, setDrag] = useState<string | null>(null);
  const options = prop.options ?? [];
  const groups = prop.groups ?? [];
  const groupOf = (id: string) => groups.find((g) => g.option_ids.includes(id))?.id;
  const setOptions = (next: DbOption[], nextGroups = groups) => save({ options: next, ...(prop.type === "status" ? { groups: nextGroups.map((g) => ({ ...g, option_ids: g.option_ids.filter((x) => next.some((o) => o.id === x)) })) } : {}) });
  const add = () => {
    const name = adding.trim();
    if (!name || options.some((o) => o.name.toLowerCase() === name.toLowerCase())) return;
    const o: DbOption = { id: newOptionId(prop), name, color: TONE_ORDER[options.length % TONE_ORDER.length] as DbTone };
        const base: DbStatusGroup[] = groups.length ? groups : [{ id: "todo", option_ids: [] }];
    setOptions([...options, o], prop.type === "status" ? base.map((g) => (g.id === "todo" ? { ...g, option_ids: [...g.option_ids, o.id] } : g)) : groups);
    setAdding("");
  };
  const optionRow = (o: DbOption) => (
    <div
      key={o.id}
      draggable
      onDragStart={() => setDrag(o.id)}
      onDragEnd={() => setDrag(null)}
      onDragOver={(e) => {
        if (!drag || drag === o.id) return;
        e.preventDefault();
        const list = options.filter((x) => x.id !== drag);
        list.splice(list.findIndex((x) => x.id === o.id), 0, options.find((x) => x.id === drag)!);
        setOptions(list);
      }}
      className={cn("group flex h-8 items-center gap-1.5 rounded-md px-1 hover:bg-hover", drag === o.id && "opacity-40")}
    >
      <GripVertical className="size-3.5 cursor-grab text-fg-4" />
      <OptionColor option={o} onChange={(color) => setOptions(options.map((x) => (x.id === o.id ? { ...x, color } : x)))} />
      <input
        defaultValue={o.name}
        onBlur={(e) => {
          const v = e.target.value.trim();
          if (v && v !== o.name) setOptions(options.map((x) => (x.id === o.id ? { ...x, name: v } : x)));
        }}
        className="h-6 min-w-0 flex-1 rounded bg-transparent px-1 text-[12.5px] text-fg outline-none focus:bg-surface focus:shadow-[0_0_0_1px_var(--line-strong)]"
      />
      {prop.type === "status" && (
        <Select
          size="sm"
          className="h-6 w-[92px] border-transparent bg-transparent px-1.5 text-[11px] shadow-none"
          value={groupOf(o.id) ?? "todo"}
          aria-label={t("db.prop.statusGroup")}
          options={(["todo", "doing", "done"] as const).map((g) => ({ value: g, label: t(`db.statusGroup.${g}`) }))}
          onChange={(gid0) => setOptions(options, (["todo", "doing", "done"] as const).map((gid) => ({ id: gid, option_ids: [...(groups.find((g) => g.id === gid)?.option_ids ?? []).filter((x) => x !== o.id), ...(gid === gid0 ? [o.id] : [])] })))}
        />
      )}
      <button type="button" aria-label={t("db.prop.removeOption")} onClick={() => setOptions(options.filter((x) => x.id !== o.id))} className="flex size-5 items-center justify-center rounded opacity-0 hover:bg-active group-hover:opacity-100">
        <X className="size-3 text-fg-3" />
      </button>
    </div>
  );
  return (
    <>
      <Label>{t("db.prop.options")}</Label>
      <div className="px-1">
        {options.map(optionRow)}
        <div className="flex h-8 items-center gap-1.5 px-1">
          <Plus className="size-3.5 text-fg-4" />
          <input
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            onBlur={add}
            placeholder={t("db.prop.addOption")}
            className="h-6 min-w-0 flex-1 bg-transparent text-[12.5px] text-fg outline-none placeholder:text-fg-4"
          />
        </div>
      </div>
    </>
  );
}

function OptionColor({ option, onChange }: { option: DbOption; onChange: (c: DbTone) => void }) {
  const { t } = useTranslation("wiki");
  return (
    <P.Root>
      <P.Trigger asChild>
        <button type="button" aria-label={t("db.prop.color")} className={cn("size-3.5 shrink-0 rounded-full", `db-dot-${option.color}`)} />
      </P.Trigger>
      <P.Portal>
        <P.Content side="right" sideOffset={8} className={cn(floatingPanel, "grid grid-cols-3 gap-1 p-1.5")} onClick={(e) => e.stopPropagation()}>
          {TONE_ORDER.map((c) => (
            <P.Close asChild key={c}>
              <button type="button" onClick={() => onChange(c as DbTone)} className={cn("flex h-7 items-center gap-1.5 rounded-md px-1.5 text-[12px] hover:bg-hover", c === option.color && "bg-hover")}>
                <span className={cn("size-3 rounded-full", `db-dot-${c}`)} />
                {t(`editor.tone.${c as DbTone}`)}
              </button>
            </P.Close>
          ))}
        </P.Content>
      </P.Portal>
    </P.Root>
  );
}

function RelationTarget({ prop, save }: { prop: DbProperty; save: (p: Partial<DbProperty>) => void }) {
  const { t } = useTranslation("wiki");
  const { data: nodes = [] } = useQuery(q.wikiTree());
  const databases = nodes.filter((n) => n.kind === "database");
  return (
    <>
      <Label>{t("db.prop.relatesTo")}</Label>
      <div className="max-h-48 overflow-y-auto px-1">
        {databases.map((n) => (
          <button key={n.id} type="button" onClick={() => save({ database_id: n.id })} className={cn(row, prop.database_id === n.id && "bg-hover font-medium")}>
            <PageIcon icon={n.icon} />
            <span className="truncate">{n.title.trim() || t("untitled")}</span>
          </button>
        ))}
      </div>
    </>
  );
}

function RollupSettings({ db, prop, save }: { db: Database; prop: DbProperty; save: (p: Partial<DbProperty>) => void }) {
  const { t } = useTranslation("wiki");
  const relations = db.properties.filter((p) => p.type === "relation");
  const rel = relations.find((p) => p.id === prop.rollup?.relation) ?? relations[0];
  const target = useQuery({ ...q.wikiPage(rel?.database_id ?? ""), enabled: !!rel?.database_id });
  const targetProps = target.data?.database?.properties ?? [];
  const cur = prop.rollup ?? { relation: rel?.id ?? "", property: "title", fn: "count" as DbRollupFn };
  if (!relations.length) return <p className="px-2 py-1.5 text-[12px] leading-[17px] text-fg-3">{t("db.prop.rollupNeedsRelation")}</p>;
  const pick = (label: string, value: string, options: { id: string; name: string }[], onPick: (v: string) => void) => (
    <div className="flex items-center gap-2 px-2 py-1 text-[12.5px] text-fg-2">
      <span className="w-20 shrink-0">{label}</span>
      <Select size="sm" className="min-w-0 flex-1" aria-label={label} value={value} onChange={onPick} options={options.map((o) => ({ value: o.id, label: o.name }))} />
    </div>
  );
  return (
    <>
      <Label>{t("db.type.rollup")}</Label>
      {pick(t("db.prop.relation"), cur.relation, relations, (v) => save({ rollup: { ...cur, relation: v } }))}
      {pick(t("db.prop.property"), cur.property, targetProps.map((p) => ({ id: p.id, name: p.name })), (v) => save({ rollup: { ...cur, property: v } }))}
      {pick(t("db.prop.calculate"), cur.fn, ROLLUP_FNS.map((f) => ({ id: f, name: t(`db.calc.${f}`) })), (v) => save({ rollup: { ...cur, fn: v as DbRollupFn } }))}
    </>
  );
}

function FormulaEditor({ prop, save, db }: { prop: DbProperty; save: (p: Partial<DbProperty>) => void; db: Database }) {
  const { t } = useTranslation("wiki");
  const [src, setSrc] = useState(prop.formula ?? "");
  const parsed = src.trim() ? parseFormula(src) : null;
  const insert = (s: string) => setSrc((x) => `${x}${s}`);
  return (
    <>
      <Label>{t("db.type.formula")}</Label>
      <div className="px-1.5">
        <textarea
          value={src}
          onChange={(e) => setSrc(e.target.value)}
          onBlur={() => (!parsed || parsed.ok) && src !== prop.formula && save({ formula: src })}
          rows={3}
          spellCheck={false}
          placeholder='prop("Points") * 2'
          className="mono w-full resize-y rounded-md border border-line bg-sunken px-2 py-1.5 text-[12px] leading-[18px] text-fg outline-none focus:border-fg-3"
        />
        <p className={cn("min-h-4 px-0.5 text-[11.5px]", parsed && !parsed.ok ? "text-danger-fg" : "text-fg-4")}>{parsed && !parsed.ok ? parsed.error : t("db.prop.formulaHint")}</p>
        <div className="mt-1 flex flex-wrap gap-1 pb-1">
          {db.properties
            .filter((p) => p.id !== prop.id)
            .map((p) => (
              <button key={p.id} type="button" onClick={() => insert(`prop("${p.name}")`)} className="inline-flex h-6 items-center gap-1 rounded-md bg-hover px-1.5 text-[11.5px] text-fg-2 hover:text-fg">
                <PropIcon type={p.type} className="size-3" />
                {p.name}
              </button>
            ))}
        </div>
      </div>
    </>
  );
}

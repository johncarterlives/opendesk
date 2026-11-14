// The filter and sort row of the People and Companies lists: a label, custom fields, a company and
// whether a person is blocked (People), and how the list is ordered. Each choice is a search
// parameter of the page, so a filtered list can be linked and survives a reload.

import { useQuery } from "@tanstack/react-query";
import { ArrowDownUp, Ban, Building2, ListFilter, Tag as TagIcon, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Menu, MenuCheckItem, MenuChoice, MenuContent, MenuLabel, MenuSub, MenuTrigger } from "@/components/ui/menu";
import { Picker } from "@/components/ui/picker";
import { CompanyGlyph } from "@/components/contacts/bits";
import { useDebounced } from "@/components/contacts/hooks";
import { useRecordFields } from "@/components/contacts/LabelsAndFields";
import { fieldText } from "@/components/tickets/fields";
import { TagSwatch } from "@/components/tickets/TagSwatch";
import { api } from "@/lib/api/endpoints";
import type { CompanySort, ContactSort } from "@/lib/api/endpoints";
import type { CustomField, LabelScope } from "@/lib/api/types";
import { COMPANY_SORTS, NO_COMPANY, PEOPLE_SORTS, filterValues, pickable, toggleFieldFilter, type CompanySearch, type PeopleSearch } from "@/lib/directorySort";
import { encodeFieldFilters, parseFieldFilters } from "@/lib/folders";
import { q, qk } from "@/lib/queries";

type Props =
  | { scope: "contacts"; search: PeopleSearch; onSearch: (s: PeopleSearch) => void }
  | { scope: "companies"; search: CompanySearch; onSearch: (s: CompanySearch) => void };

const chip =
  "inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-[12.5px] outline-none transition-colors focus-visible:shadow-[0_0_0_3px_var(--focus)]";
const idle = "border-line bg-surface text-fg-2 hover:border-line-strong hover:text-fg";
const active = "border-line-strong bg-hover text-fg";

function ClearButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="-mr-0.5 flex size-4 items-center justify-center rounded-sm text-fg-4 hover:bg-active hover:text-fg"
    >
      <X className="size-3" />
    </button>
  );
}

/** The row's controls. The default sort is not a filter, so choosing it clears the parameter. */
export function DirectoryFilters(props: Props) {
  const { t } = useTranslation("contacts");
  const { data: tags } = useQuery(q.tags());
  const { data: members } = useQuery(q.members());
  const people = props.scope === "contacts";
  const { data: fieldDefs } = useRecordFields(people ? "contact" : "company");
  const search = props.search as PeopleSearch;
  // Every control writes the whole search, keeping what it does not change.
  const set = (patch: Partial<PeopleSearch>) => (props.onSearch as (s: PeopleSearch) => void)({ ...search, ...patch });
  const scope: LabelScope = props.scope;
  const labels = (tags ?? []).filter((x) => !x.archived && x.applies_to.includes(scope));
  const sorts: (ContactSort | CompanySort)[] = people ? PEOPLE_SORTS : COMPANY_SORTS;
  const fallback = sorts[0];
  const sort: ContactSort | CompanySort = search.sort ?? fallback;
  const filters = parseFieldFilters(search.fields);
  const setFilters = (next: typeof filters) => set({ fields: encodeFieldFilters(next) });
  const fields = fieldDefs ?? [];
  const memberName = (id: string) => members?.find((m) => m.user.id === id)?.user.name;
  const valueText = (f: CustomField | undefined, v: string) =>
    v === "set" && (!f || !pickable(f)) ? t("filter.hasValue") : v === "not_set" && (!f || !pickable(f)) ? t("filter.isEmpty") : fieldText(f, f?.type === "checkbox" ? v === "true" : v, memberName);
  const filtered = !!(search.tag || search.blocked || search.company || filters.length);
  const words: Words = { yes: t("filter.yes"), no: t("filter.no"), hasValue: t("filter.hasValue"), isEmpty: t("filter.isEmpty") };

  return (
    <div className="flex min-h-10 flex-wrap items-center gap-2 border-b border-line-soft px-4 py-1.5 md:px-5">
      <Picker
        items={labels.map((l) => ({ value: l.name, label: l.name, icon: <TagSwatch name={l.name} color={l.color} /> }))}
        value={search.tag ?? null}
        width={240}
        placeholder={t("filter.searchLabels")}
        emptyText={t("filter.noLabels")}
        onSelect={(name) => set({ tag: name === search.tag ? undefined : name })}
        trigger={
          <button type="button" className={`${chip} ${search.tag ? active : idle}`}>
            <TagIcon className="size-3.5 text-fg-3" aria-hidden />
            {search.tag ? t("filter.label", { name: search.tag }) : t("filter.labels")}
            {search.tag && <ClearButton label={t("filter.clearLabel")} onClick={() => set({ tag: undefined })} />}
          </button>
        }
      />

      {people && <CompanyFilter value={search.company} onChange={(company) => set({ company })} />}

      {fields.length > 0 && (
        <Menu>
          <MenuTrigger asChild>
            <button type="button" className={`${chip} ${idle}`}>
              <ListFilter className="size-3.5 text-fg-3" aria-hidden />
              {t("filter.fields")}
            </button>
          </MenuTrigger>
          <MenuContent align="start">
            <MenuLabel>{t("filter.fieldsTitle")}</MenuLabel>
            {fields.map((f) => (
              <MenuSub key={f.id} label={f.name}>
                <div className="max-h-[260px] overflow-y-auto">
                  {fieldChoices(f, members ?? [], words).map((c) => (
                    <MenuCheckItem key={c.value} checked={filterValues(filters, f).includes(c.value)} onSelect={() => setFilters(toggleFieldFilter(filters, f, c.value))} icon={c.icon}>
                      {c.label}
                    </MenuCheckItem>
                  ))}
                </div>
              </MenuSub>
            ))}
          </MenuContent>
        </Menu>
      )}

      {people && (
        <Menu>
          <MenuTrigger asChild>
            <button type="button" className={`${chip} ${search.blocked ? active : idle}`}>
              <Ban className="size-3.5 text-fg-3" aria-hidden />
              {search.blocked === "true" ? t("filter.blockedOnly") : search.blocked === "false" ? t("filter.notBlocked") : t("filter.blockedAny")}
            </button>
          </MenuTrigger>
          <MenuContent align="start">
            <MenuLabel>{t("filter.blockedTitle")}</MenuLabel>
            <MenuChoice checked={!search.blocked} onSelect={() => set({ blocked: undefined })}>
              {t("filter.blockedAny")}
            </MenuChoice>
            <MenuChoice checked={search.blocked === "true"} onSelect={() => set({ blocked: "true" })}>
              {t("filter.blockedOnly")}
            </MenuChoice>
            <MenuChoice checked={search.blocked === "false"} onSelect={() => set({ blocked: "false" })}>
              {t("filter.notBlocked")}
            </MenuChoice>
          </MenuContent>
        </Menu>
      )}

      {filters.map((ff) => {
        const f = fields.find((x) => x.key === ff.key);
        const values = ff.op === "set" || ff.op === "not_set" ? [ff.op] : ff.value.split(",");
        return (
          <span key={ff.key} className={`${chip} ${active}`}>
            <span className="text-fg-3">{f?.name ?? ff.key}</span>
            <span className="max-w-[220px] truncate">{values.map((v) => valueText(f, v)).join(", ")}</span>
            <ClearButton label={t("filter.clearField", { name: f?.name ?? ff.key })} onClick={() => setFilters(filters.filter((x) => x.key !== ff.key))} />
          </span>
        );
      })}

      {filtered && (
        <Button size="xs" variant="ghost" onClick={() => set({ tag: undefined, blocked: undefined, company: undefined, fields: undefined })}>
          {t("clearFilters")}
        </Button>
      )}

      <div className="ml-auto">
        <Menu>
          <MenuTrigger asChild>
            <button type="button" className={`${chip} ${idle}`}>
              <ArrowDownUp className="size-3.5 text-fg-3" aria-hidden />
              {t("sort.label", { by: t(`sort.${sort}`) })}
            </button>
          </MenuTrigger>
          <MenuContent align="end">
            <MenuLabel>{t("sort.title")}</MenuLabel>
            {sorts.map((s) => (
              <MenuChoice key={s} checked={sort === s} onSelect={() => set({ sort: s === fallback ? undefined : (s as ContactSort) })}>
                {t(`sort.${s}`)}
              </MenuChoice>
            ))}
          </MenuContent>
        </Menu>
      </div>
    </div>
  );
}

type Choice = { value: string; label: string; icon?: ReactNode };
type Words = { yes: string; no: string; hasValue: string; isEmpty: string };

/** What a field's filter can be: its options, people, yes or no, or whether it has a value. */
function fieldChoices(f: CustomField, members: { user: { id: string; name: string } }[], w: Words): Choice[] {
  if (f.type === "checkbox") return [{ value: "true", label: w.yes }, { value: "false", label: w.no }];
  if (f.type === "user") return members.map((m) => ({ value: m.user.id, label: m.user.name }));
  if (f.type === "select" || f.type === "multi_select") return f.options.map((o) => ({ value: o.id, label: o.label, icon: <TagSwatch name={o.label} color={o.color} /> }));
  return [{ value: "set", label: w.hasValue }, { value: "not_set", label: w.isEmpty }];
}

/** People of one company, or of none, picked by searching the companies. */
function CompanyFilter({ value, onChange }: { value?: string; onChange: (id: string | undefined) => void }) {
  const { t } = useTranslation("contacts");
  const [query, setQuery] = useState("");
  const term = useDebounced(query, 200);
  const chosen = useQuery({ ...q.company(value ?? ""), enabled: !!value && value !== NO_COMPANY });
  const { data } = useQuery({ queryKey: qk.of("companies", "pick", term), queryFn: () => api.companies.search({ q: term || undefined, limit: 12 }) });
  const rows = data?.data ?? [];
  const label = value === NO_COMPANY ? t("filter.noCompany") : value ? (chosen.data?.name ?? t("company")) : t("filter.company");
  return (
    <Picker
      width={280}
      placeholder={t("filter.searchCompanies")}
      emptyText={t("filter.noCompanies")}
      value={value ?? null}
      onQueryChange={setQuery}
      items={[
        { value: NO_COMPANY, label: t("filter.noCompany"), icon: <span className="size-3.5" />, strict: true },
        ...rows.map((c) => ({ value: c.id, label: c.name, hint: c.domain, icon: <CompanyGlyph name={c.name} src={c.avatar_url} size="xs" /> })),
      ]}
      onSelect={(v) => onChange(v === value ? undefined : v)}
      trigger={
        <button type="button" className={`${chip} ${value ? active : idle}`}>
          {value && value !== NO_COMPANY && chosen.data ? (
            <CompanyGlyph name={chosen.data.name} src={chosen.data.avatar_url} size="xs" />
          ) : (
            <Building2 className="size-3.5 text-fg-3" aria-hidden />
          )}
          <span className="max-w-[180px] truncate">{label}</span>
          {value && <ClearButton label={t("clearCompany")} onClick={() => onChange(undefined)} />}
        </button>
      }
    />
  );
}

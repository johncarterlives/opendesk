import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { Building2, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { PageHeader, Stat, StatStrip } from "@/components/layout";
import { AvatarStack } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState, GhostList } from "@/components/ui/empty";
import { Field, SearchInput, TextInput } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { DirectoryBulkBar } from "@/components/contacts/DirectoryBulkBar";
import { DirectoryFilters } from "@/components/contacts/DirectoryFilters";
import { HeaderCheck, RowCheck } from "@/components/contacts/RowCheck";
import { useSelection } from "@/components/contacts/useSelection";
import { companyFilter, isFiltered } from "@/lib/directorySort";
import { DirectoryNav } from "@/components/contacts/DirectoryNav";
import { CompanyDrawer } from "@/components/contacts/CompanyDrawer";
import { CompanyGlyph, Labels, labelsOf } from "@/components/contacts/bits";
import { useDebounced, useSentinel } from "@/components/contacts/hooks";
import { AnimatedNumber, PresenceList, PresenceRow } from "@/components/motion";
import { api } from "@/lib/api/endpoints";
import { errorMessage } from "@/lib/api/client";
import type { Contact } from "@/lib/api/types";
import { fullDate, relShort, shortDate } from "@/lib/format";
import { q, qk } from "@/lib/queries";
import { atLeast, useRole } from "@/lib/session";

const route = getRouteApi("/app/companies/{-$companyId}");
const colsLabels =
  "grid items-center gap-4 grid-cols-[24px_minmax(0,1fr)_72px] md:grid-cols-[24px_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_72px_72px] xl:grid-cols-[24px_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_72px_88px_72px]";
const colsPlain =
  "grid items-center gap-4 grid-cols-[24px_minmax(0,1fr)_72px] md:grid-cols-[24px_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_72px_72px] xl:grid-cols-[24px_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_72px_88px_72px]";
const md = "hidden md:block";
const xl = "hidden xl:flex";
const xlLabels = (on: boolean) => (on ? "hidden xl:flex" : "hidden");

export default function CompaniesPage() {
  const { t } = useTranslation("contacts");
  const search = route.useSearch();
  const { companyId } = route.useParams();
  const navigate = route.useNavigate();
  const role = useRole();
  const [term, setTerm] = useState(search.q ?? "");
  const debounced = useDebounced(term, 250);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if ((debounced || undefined) === search.q) return;
    void navigate({ search: { ...search, q: debounced || undefined }, replace: true });
  }, [debounced, search, navigate]);

  const filter = companyFilter(search);
  const filtered = isFiltered(search);
  const list = useInfiniteQuery(q.companies({ ...filter, sort: search.sort }));
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];
  // A selection belongs to this list: another search or filter drops it.
  const selection = useSelection(JSON.stringify(filter));
  const allTicked = rows.length > 0 && rows.every((r) => selection.has(r.id));
  const sentinel = useSentinel(() => {
    if (list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage();
  }, !!list.hasNextPage);
  const open = (id: string | undefined) => navigate({ to: "/companies/{-$companyId}", params: { companyId: id }, search });

  // People and ticket totals per company, from the directory's first page of contacts.
  // Ticket totals only show when every contact is loaded, so they are never partial.
  const people = useInfiniteQuery(q.contacts({}));
  const peopleRows = people.data?.pages.flatMap((p) => p.data);
  const complete = !!peopleRows && !people.hasNextPage;
  const byCompany = useMemo(() => {
    const m = new Map<string, Contact[]>();
    for (const c of peopleRows ?? []) if (c.company) m.set(c.company.id, [...(m.get(c.company.id) ?? []), c]);
    return m;
  }, [peopleRows]);
  const ticketsFor = (id: string) => (byCompany.get(id) ?? []).reduce((a, c) => a + c.ticket_count, 0);

  const linked = rows.reduce((a, c) => a + c.contact_count, 0);
  const withDomain = rows.filter((c) => c.domain).length;
  const largest = rows.reduce<(typeof rows)[number] | null>((m, c) => (!m || c.contact_count > m.contact_count ? c : m), null);
  const canEdit = atLeast(role, "agent");
  const hasLabels = rows.some((r) => labelsOf(r).length > 0);
  const cols = hasLabels ? colsLabels : colsPlain;
  const newButton = canEdit ? (
    <Button variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setCreating(true)}>
      {t("newCompany")}
    </Button>
  ) : undefined;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <PageHeader title={t("title")} icon={<Building2 />} actions={newButton}>
        <DirectoryNav current="companies" />
        <div className="ml-auto hidden w-[280px] sm:block">
          <SearchInput value={term} onChange={setTerm} placeholder={t("searchCompanies")} />
        </div>
      </PageHeader>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <DirectoryFilters scope="companies" search={search} onSearch={(next) => void navigate({ search: next })} />

        {!list.isLoading && rows.length > 0 && (
          <StatStrip>
            <Stat label={t("stat.companies")} value={<><AnimatedNumber value={rows.length} />{list.hasNextPage ? "+" : ""}</>} sub={filtered ? t("stat.matching") : t("stat.inDirectory")} />
            <Stat label={t("stat.linkedPeople")} value={<AnimatedNumber value={linked} />} sub={t("stat.linkedHint")} />
            <Stat label={t("stat.withDomain")} value={<AnimatedNumber value={withDomain} />} sub={t("stat.withDomainHint")} />
            <Stat
              label={t("stat.largest")}
              value={<span className="block truncate text-[18px] leading-6">{largest?.name ?? "–"}</span>}
              sub={largest ? t("peopleCount", { count: largest.contact_count }) : undefined}
            />
          </StatStrip>
        )}

        <div className={`${cols} sticky top-0 z-10 h-9 border-b border-line bg-surface px-4 md:px-5`}>
          <span className="flex items-center">
            {canEdit && <HeaderCheck checked={allTicked ? true : selection.ids.length > 0 ? "indeterminate" : false} onChange={() => selection.togglePage(rows.map((r) => r.id))} />}
          </span>
          <span className="label-caps">{t("col.company")}</span>
          <span className={`label-caps ${md}`}>{t("col.domain")}</span>
          <span className={`label-caps ${md}`}>{t("col.people")}</span>
          <span className={`label-caps ${xlLabels(hasLabels)}`}>{t("col.labels")}</span>
          <span className="label-caps text-right">{t("col.tickets")}</span>
          <span className={`label-caps justify-end ${xl}`}>{t("col.created")}</span>
          <span className={`label-caps text-right ${md}`}>{t("col.updated")}</span>
        </div>
        {list.isLoading ? (
          <TableSkeleton />
        ) : list.error ? (
          <EmptyState lit={3} title={t("error.companiesTitle")} description={errorMessage(list.error)} action={<Button onClick={() => void list.refetch()}>{t("retry")}</Button>} />
        ) : rows.length === 0 ? (
          filtered ? (
            <EmptyState
              art="search"
              ghost={<GhostList variant="table" />}
              title={t("empty.noCompanyMatch")}
              description={search.q ? t("empty.noMatchFor", { q: search.q }) : t("empty.noMatchHint")}
              action={
                <Button
                  onClick={() => {
                    setTerm("");
                    void navigate({ search: { sort: search.sort } });
                  }}
                >
                  {search.tag || search.fields ? t("clearFilters") : t("clearSearch")}
                </Button>
              }
              tips={[{ label: t("tips.spelling") }, { label: t("tips.tryDomain") }]}
            />
          ) : (
            <EmptyState
              art="contacts"
              ghost={<GhostList variant="table" />}
              title={t("empty.companiesTitle")}
              description={t("empty.companiesDescription")}
              action={newButton}
              tips={[{ label: t("tips.domains") }]}
            />
          )
        ) : (
          <div role="list">
            <PresenceList>
              {rows.map((c) => {
                const members = byCompany.get(c.id) ?? [];
                return (
                  <PresenceRow key={c.id}>
                  <div role="listitem">
                    <Link
                      to="/companies/{-$companyId}"
                      params={{ companyId: c.id }}
                      search={search}
                      data-active={companyId === c.id || undefined}
                      className={`${cols} h-11 border-b border-line-soft px-4 text-[13px] transition-colors duration-100 hover:bg-sunken data-[active]:bg-hover md:px-5`}
                    >
                      <span className="flex items-center">{canEdit && <RowCheck checked={selection.allMatching || selection.has(c.id)} onChange={() => selection.toggle(c.id)} name={c.name} />}</span>
                      <span className="flex min-w-0 items-center gap-2.5">
                        <CompanyGlyph name={c.name} src={c.avatar_url} />
                        <span className="truncate font-medium">{c.name}</span>
                      </span>
                      <span className={`mono truncate text-xs text-fg-2 ${md}`}>{c.domain || <span className="text-fg-4">–</span>}</span>
                      <span className={`min-w-0 ${md}`}>
                        <span className="flex items-center gap-2">
                          {members.length > 0 && (
                            <AvatarStack people={members.map((m) => ({ id: m.id, name: m.name || m.email || "?", avatar: m.avatar_url }))} size="sm" max={3} />
                          )}
                          <span className="mono text-xs tabular-nums text-fg-3">{t("peopleCount", { count: c.contact_count })}</span>
                        </span>
                      </span>
                      <span className={`min-w-0 ${xlLabels(hasLabels)}`}>
                        <Labels labels={labelsOf(c)} />
                      </span>
                      <span className="mono text-right text-xs tabular-nums text-fg-2">{complete ? ticketsFor(c.id) : <span className="text-fg-4">–</span>}</span>
                      <span className={`mono justify-end text-[11px] text-fg-3 ${xl}`} title={fullDate(c.created_at)}>
                        {shortDate(c.created_at)}
                      </span>
                      <span className={`mono text-right text-[11px] text-fg-3 ${md}`} title={fullDate(c.updated_at)}>
                        {relShort(c.updated_at)}
                      </span>
                    </Link>
                  </div>
                  </PresenceRow>
                );
              })}
            </PresenceList>
          </div>
        )}
        <div ref={sentinel} className="flex h-12 items-center justify-center">
          {list.isFetchingNextPage && <Spinner className="size-3.5 text-fg-4" />}
        </div>
      </div>

      {canEdit && (
        <DirectoryBulkBar scope="companies" selection={selection} query={filter} canSelectMore={allTicked && (!!list.hasNextPage || filtered)} matching={list.hasNextPage ? undefined : rows.length} />
      )}

      <CompanyDrawer companyId={companyId ?? null} onClose={() => void open(undefined)} />
      <NewCompanyDialog open={creating} onOpenChange={setCreating} onCreated={(id) => void open(id)} />
    </div>
  );
}

function TableSkeleton({ rows = 10 }: { rows?: number }) {
  const { t: ui } = useTranslation("ui");
  return (
    <div aria-busy="true" aria-label={ui("loading")}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className={`${colsPlain} h-11 border-b border-line-soft px-4 md:px-5`} style={{ opacity: 1 - i * (0.75 / rows) }}>
          <span className="flex items-center gap-2.5">
            <Skeleton className="size-6 rounded-sm" />
            <Skeleton className="h-2.5" style={{ width: `${40 + ((i * 17) % 35)}%` }} />
          </span>
          <Skeleton className={`h-2.5 ${md}`} style={{ width: `${45 + ((i * 13) % 30)}%` }} />
          <Skeleton className={`h-2.5 w-20 ${md}`} />
                    <Skeleton className="ml-auto h-2.5 w-5" />
          <Skeleton className={`ml-auto h-2.5 w-12 ${xl}`} />
          <Skeleton className={`ml-auto h-2.5 w-8 ${md}`} />
        </div>
      ))}
    </div>
  );
}

function NewCompanyDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (id: string) => void }) {
  const { t } = useTranslation("contacts");
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setName("");
      setDomain("");
      setError(null);
    }
  }, [open]);
  const create = useMutation({
    mutationFn: () => api.companies.create({ name: name.trim(), domain: domain.trim().toLowerCase(), notes: "" }),
    onSuccess: (c) => {
      qc.setQueryData(qk.company(c.id), c);
      void qc.invalidateQueries({ queryKey: qk.companyLists });
      toast.success(t("toast.companyCreated"));
      onOpenChange(false);
      onCreated(c.id);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("newCompany")}
      size="sm"
      footer={
        <>
          {error && (
            <p role="alert" className="mr-auto text-xs text-danger-fg">
              {error}
            </p>
          )}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button variant="primary" type="submit" form="new-company" loading={create.isPending}>
            {t("createCompany")}
          </Button>
        </>
      }
    >
      <form
        id="new-company"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return setError(t("error.addName"));
          setError(null);
          create.mutate();
        }}
      >
        <Field label={t("field.name")}>{(p) => <TextInput {...p} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Northwind" />}</Field>
        <Field label={t("field.domain")} optional hint={t("field.domainHint")}>
          {(p) => <TextInput {...p} className="mono" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="northwind.com" />}
        </Field>
      </form>
    </Dialog>
  );
}

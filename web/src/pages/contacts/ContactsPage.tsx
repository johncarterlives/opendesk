import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { Plus, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { PageHeader, Stat, StatStrip } from "@/components/layout";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState, GhostList } from "@/components/ui/empty";
import { Field, SearchInput, TextInput } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { Badge } from "@/components/ui/badge";
import { DirectoryBulkBar } from "@/components/contacts/DirectoryBulkBar";
import { DirectoryFilters } from "@/components/contacts/DirectoryFilters";
import { HeaderCheck, RowCheck } from "@/components/contacts/RowCheck";
import { useSelection } from "@/components/contacts/useSelection";
import { isFiltered, NO_COMPANY, peopleFilter } from "@/lib/directorySort";
import { DirectoryNav } from "@/components/contacts/DirectoryNav";
import { ContactDrawer } from "@/components/contacts/ContactDrawer";
import { CompanyPicker } from "@/components/contacts/CompanyPicker";
import { CompanyGlyph, Labels, labelsOf } from "@/components/contacts/bits";
import { useDebounced, useSentinel } from "@/components/contacts/hooks";
import { AnimatedNumber, PresenceList, PresenceRow } from "@/components/motion";
import { api } from "@/lib/api/endpoints";
import { errorMessage } from "@/lib/api/client";
import type { CompanyRef } from "@/lib/api/types";
import { fullDate, relShort, shortDate } from "@/lib/format";
import { q, qk } from "@/lib/queries";
import { atLeast, useRole } from "@/lib/session";

const route = getRouteApi("/app/contacts/{-$contactId}");

// Name and tickets always; email, company and updated from md; labels and created from xl.
const colsLabels =
  "grid items-center gap-4 grid-cols-[24px_minmax(0,1fr)_64px] md:grid-cols-[24px_minmax(0,1.3fr)_minmax(0,1.3fr)_minmax(0,1fr)_64px_72px] xl:grid-cols-[24px_minmax(0,1.3fr)_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_64px_88px_72px]";
const colsPlain =
  "grid items-center gap-4 grid-cols-[24px_minmax(0,1fr)_64px] md:grid-cols-[24px_minmax(0,1.3fr)_minmax(0,1.3fr)_minmax(0,1fr)_64px_72px] xl:grid-cols-[24px_minmax(0,1.3fr)_minmax(0,1.3fr)_minmax(0,1fr)_64px_88px_72px]";
const md = "hidden md:block";
const xl = "hidden xl:flex";
const xlLabels = (on: boolean) => (on ? "hidden xl:flex" : "hidden");

export default function ContactsPage() {
  const { t } = useTranslation("contacts");
  const search = route.useSearch();
  const { contactId } = route.useParams();
  const navigate = route.useNavigate();
  const role = useRole();
  const [term, setTerm] = useState(search.q ?? "");
  const debounced = useDebounced(term, 250);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if ((debounced || undefined) === search.q) return;
    void navigate({ search: { ...search, q: debounced || undefined }, replace: true });
  }, [debounced, search, navigate]);

  const filter = peopleFilter(search);
  const list = useInfiniteQuery(q.contacts({ ...filter, sort: search.sort }));
  const company = useQuery({ ...q.company(search.company ?? ""), enabled: !!search.company && search.company !== NO_COMPANY });
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];
  // A selection belongs to this list: other filters or another search drop it.
  const selection = useSelection(JSON.stringify(filter));
  const allTicked = rows.length > 0 && rows.every((r) => selection.has(r.id));
  const sentinel = useSentinel(() => {
    if (list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage();
  }, !!list.hasNextPage);

  const filtered = isFiltered(search);
  const open = (id: string | undefined) => navigate({ to: "/contacts/{-$contactId}", params: { contactId: id }, search });

  const companies = new Set(rows.map((c) => c.company?.id).filter(Boolean)).size;
  const tickets = rows.reduce((a, c) => a + c.ticket_count, 0);
  const blocked = rows.filter((c) => c.blocked).length;
  const more = list.hasNextPage ? "+" : "";
  const canEdit = atLeast(role, "agent");
  const hasLabels = rows.some((r) => labelsOf(r).length > 0);
  const cols = hasLabels ? colsLabels : colsPlain;

  const newButton = canEdit ? (
    <Button variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setCreating(true)}>
      {t("newContact")}
    </Button>
  ) : undefined;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <PageHeader title={t("title")} icon={<Users />} actions={newButton}>
        <DirectoryNav current="contacts" />
        <div className="ml-auto hidden w-[280px] sm:block">
          <SearchInput value={term} onChange={setTerm} placeholder={t("searchPeople")} />
        </div>
      </PageHeader>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <DirectoryFilters scope="contacts" search={search} onSearch={(next) => void navigate({ search: next })} />

        {!list.isLoading && rows.length > 0 && (
          <StatStrip>
            <Stat label={t("stat.people")} value={<><AnimatedNumber value={rows.length} flash />{more}</>} sub={filtered ? t("stat.matching") : t("stat.inDirectory")} />
            <Stat label={t("stat.companies")} value={<AnimatedNumber value={companies} />} sub={t("stat.represented")} />
            <Stat label={t("stat.tickets")} value={<AnimatedNumber value={tickets} />} sub={t("stat.fromThesePeople")} />
            <Stat label={t("stat.blocked")} value={<AnimatedNumber value={blocked} />} sub={t("stat.blockedHint")} />
          </StatStrip>
        )}

        <div className={`${cols} sticky top-0 z-10 h-9 border-b border-line bg-surface px-4 md:px-5`}>
          <span className="flex items-center">
            {canEdit && <HeaderCheck checked={allTicked ? true : selection.ids.length > 0 ? "indeterminate" : false} onChange={() => selection.togglePage(rows.map((r) => r.id))} />}
          </span>
          <span className="label-caps">{t("col.name")}</span>
          <span className={`label-caps ${md}`}>{t("col.email")}</span>
          <span className={`label-caps ${md}`}>{t("col.company")}</span>
          <span className={`label-caps ${xlLabels(hasLabels)}`}>{t("col.labels")}</span>
          <span className="label-caps text-right">{t("col.tickets")}</span>
          <span className={`label-caps text-right ${xl} justify-end`}>{t("col.created")}</span>
          <span className={`label-caps text-right ${md}`}>{t("col.updated")}</span>
        </div>

        {list.isLoading ? (
          <TableSkeleton />
        ) : list.error ? (
          <EmptyState lit={3} title={t("error.listTitle")} description={errorMessage(list.error)} action={<Button onClick={() => void list.refetch()}>{t("retry")}</Button>} />
        ) : rows.length === 0 ? (
          filtered ? (
            <EmptyState
              art="search"
              ghost={<GhostList variant="people" />}
              title={t("empty.noMatch")}
              description={search.q ? t("empty.noMatchFor", { q: search.q }) : t("empty.noMatchHint")}
              action={
                <Button
                  onClick={() => {
                    setTerm("");
                    void navigate({ search: { sort: search.sort } });
                  }}
                >
                  {t("clearFilters")}
                </Button>
              }
              tips={[{ label: t("tips.spelling") }, { label: t("tips.emailOrDomain") }]}
            />
          ) : (
            <EmptyState
              art="contacts"
              ghost={<GhostList variant="people" />}
              title={t("empty.title")}
              description={t("empty.description")}
              action={newButton}
              tips={[{ label: t("tips.automatic") }, { kbd: "mod k", label: t("tips.search") }]}
            />
          )
        ) : (
          <div role="list">
            <PresenceList>
              {rows.map((c) => (
                <PresenceRow key={c.id}>
                  <div role="listitem">
                  <Link
                    to="/contacts/{-$contactId}"
                    params={{ contactId: c.id }}
                    search={search}
                    data-active={contactId === c.id || undefined}
                    className={`${cols} h-11 border-b border-line-soft px-4 text-[13px] transition-colors duration-100 hover:bg-sunken data-[active]:bg-hover md:px-5`}
                  >
                    <span className="flex items-center">{canEdit && <RowCheck checked={selection.allMatching || selection.has(c.id)} onChange={() => selection.toggle(c.id)} name={c.name || c.email || ""} />}</span>
                    <span className="flex min-w-0 items-center gap-2.5">
                      <Avatar name={c.name || c.email || "?"} src={c.avatar_url} size="md" />
                      <span className="truncate font-medium" data-ph-mask>
                        {c.name || <span className="font-normal text-fg-4">{t("unnamed")}</span>}
                      </span>
                      {c.blocked && <Badge tone="danger">{t("blocked")}</Badge>}
                    </span>
                    <span className={`mono truncate text-xs text-fg-2 ${md}`} data-ph-mask>
                      {c.email ?? <span className="text-fg-4">–</span>}
                    </span>
                    <span className={`min-w-0 ${md}`}>
                      {c.company ? (
                        <span className="flex min-w-0 items-center gap-2">
                          <CompanyGlyph name={c.company.name} src={c.company.avatar_url} size="xs" />
                          <span className="truncate text-fg-2">{c.company.name}</span>
                        </span>
                      ) : (
                        <span className="text-fg-4">–</span>
                      )}
                    </span>
                    <span className={`min-w-0 ${xlLabels(hasLabels)}`}>
                      <Labels labels={labelsOf(c)} />
                    </span>
                    <span className="mono text-right text-xs tabular-nums text-fg-2">{c.ticket_count}</span>
                    <span className={`mono justify-end text-right text-[11px] text-fg-3 ${xl}`} title={fullDate(c.created_at)}>
                      {shortDate(c.created_at)}
                    </span>
                    <span className={`mono text-right text-[11px] text-fg-3 ${md}`} title={fullDate(c.updated_at)}>
                      {relShort(c.updated_at)}
                    </span>
                  </Link>
                  </div>
                </PresenceRow>
              ))}
            </PresenceList>
          </div>
        )}
        <div ref={sentinel} className="flex h-12 items-center justify-center">
          {list.isFetchingNextPage && <Spinner className="size-3.5 text-fg-4" />}
        </div>
      </div>

      {canEdit && (
        <DirectoryBulkBar
          scope="contacts"
          selection={selection}
          query={filter}
          canSelectMore={allTicked && (!!list.hasNextPage || filtered)}
          matching={list.hasNextPage ? undefined : rows.length}
        />
      )}

      <ContactDrawer contactId={contactId ?? null} onClose={() => void open(undefined)} />
      <NewContactDialog open={creating} onOpenChange={setCreating} onCreated={(id) => void open(id)} defaultCompany={company.data ?? null} />
    </div>
  );
}

/** Rows shaped like the table, so nothing shifts when data lands. */
function TableSkeleton({ rows = 12 }: { rows?: number }) {
  const { t: ui } = useTranslation("ui");
  return (
    <div aria-busy="true" aria-label={ui("loading")}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className={`${colsPlain} h-11 border-b border-line-soft px-4 md:px-5`} style={{ opacity: 1 - i * (0.75 / rows) }}>
          <span className="flex items-center gap-2.5">
            <Skeleton className="size-6 rounded-sm" />
            <Skeleton className="h-2.5" style={{ width: `${40 + ((i * 17) % 35)}%` }} />
          </span>
          <Skeleton className={`h-2.5 ${md}`} style={{ width: `${50 + ((i * 13) % 30)}%` }} />
          <Skeleton className={`h-2.5 ${md}`} style={{ width: `${35 + ((i * 11) % 30)}%` }} />
                    <Skeleton className="ml-auto h-2.5 w-5" />
          <Skeleton className={`ml-auto h-2.5 w-12 ${xl}`} />
          <Skeleton className={`ml-auto h-2.5 w-8 ${md}`} />
        </div>
      ))}
    </div>
  );
}

function NewContactDialog({
  open,
  onOpenChange,
  onCreated,
  defaultCompany,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (id: string) => void;
  defaultCompany: CompanyRef | null;
}) {
  const { t } = useTranslation("contacts");
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [company, setCompany] = useState<CompanyRef | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName("");
      setEmail("");
      setPhone("");
      setError(null);
      setCompany(defaultCompany ? { id: defaultCompany.id, name: defaultCompany.name, domain: defaultCompany.domain } : null);
    }
  }, [open, defaultCompany]);

  const create = useMutation({
    mutationFn: () => api.contacts.create({ name: name.trim(), email: email.trim() || null, phone: phone.trim(), company_id: company?.id ?? null }),
    onSuccess: (c) => {
      qc.setQueryData(qk.contact(c.id), c);
      void qc.invalidateQueries({ queryKey: qk.contactLists });
      toast.success(t("toast.created"));
      onOpenChange(false);
      onCreated(c.id);
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() && !email.trim()) return setError(t("error.addNameOrEmail"));
    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setError(t("error.badEmail"));
    setError(null);
    create.mutate();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("newContact")}
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
          <Button variant="primary" type="submit" form="new-contact" loading={create.isPending}>
            {t("createContact")}
          </Button>
        </>
      }
    >
      <form id="new-contact" onSubmit={submit} className="flex flex-col gap-4">
        <Field label={t("field.name")}>{(p) => <TextInput {...p} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada Lovelace" />}</Field>
        <Field label={t("field.email")}>
          {(p) => <TextInput {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ada@example.com" className="mono" />}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("field.phone")} optional>
            {(p) => <TextInput {...p} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+44 20 7946 0000" />}
          </Field>
          <Field label={t("field.company")} optional>
            {({ id }) => <CompanyPicker id={id} value={company} onChange={setCompany} />}
          </Field>
        </div>
      </form>
    </Dialog>
  );
}

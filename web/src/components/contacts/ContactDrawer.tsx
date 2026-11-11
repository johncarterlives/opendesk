import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { FileText, GitMerge, MessageCircle, Pencil, Ticket as TicketIcon, TicketPlus, Trash2, UserRound } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { dur, ease, springs } from "@/lib/motion";
import { Drawer } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Avatar } from "@/components/ui/avatar";
import { ImageUpload } from "@/components/ui/image-upload";
import { Badge } from "@/components/ui/badge";
import { PhoneNumber } from "./PhoneNumber";
import { Button } from "@/components/ui/button";
import { Field, Textarea, TextInput } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { EmptyState } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { CopyButton } from "@/components/ui/copy-button";
import { useConfirm } from "@/components/ui/confirm";
import { toast } from "@/components/ui/toast";
import { PriorityIcon, StatusIcon, priorityLabel, statusLabel } from "@/components/indicators";
import { TicketNumber } from "@/components/tickets/bits";
import { Tooltip } from "@/components/ui/tooltip";
import { PresenceList, PresenceRow } from "@/components/motion";
import { api } from "@/lib/api/endpoints";
import { errorMessage } from "@/lib/api/client";
import type { CompanyRef, Contact } from "@/lib/api/types";
import { fullDate, relShort, shortDate } from "@/lib/format";
import { useContactAvatar } from "@/lib/pictures";
import { q, qk } from "@/lib/queries";
import { atLeast, useRole } from "@/lib/session";
import { useProducts } from "@/lib/products";
import { useNewTicketFor, useStartChat } from "@/components/tickets/useNewTicket";
import { CompanyPicker } from "./CompanyPicker";
import { ContactEmails } from "./ContactEmails";
import { MergeContactDialog } from "./MergeContactDialog";
import { PortalAccessSection } from "./PortalAccess";
import { CompanyGlyph, Detail, fieldLabel, fieldsOf, fieldText, MiniStat, none } from "./bits";
import { RecordFields, RecordLabels, useRecordFields } from "./LabelsAndFields";
import { dropContact, patchContact, restore, snapshot } from "./cache";

type Tab = "overview" | "tickets";

const swap = { initial: { opacity: 0, y: 4 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: -4, transition: { duration: dur.fast, ease: ease.out } }, transition: springs.row };

export function ContactDrawer({ contactId, onClose }: { contactId: string | null; onClose: () => void }) {
  const { t } = useTranslation("contacts");
  const confirm = useConfirm();
  const reduce = useReducedMotion();
  const canEdit = atLeast(useRole(), "agent");
  const { tickets: ticketsOn } = useProducts();
  const startChat = useStartChat();
  const newTicket = useNewTicketFor();
  const [tab, setTab] = useState<Tab>("overview");
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const { data: c, isLoading, error } = useQuery({ ...q.contact(contactId ?? ""), enabled: !!contactId });
  const picture = useContactAvatar();

  useEffect(() => {
    setTab("overview");
    setEditing(false);
    setDirty(false);
  }, [contactId]);

  const requestClose = () => {
    if (!dirty) return onClose();
    confirm.show(t("drawer.discardBody"), onClose, { title: t("drawer.discardTitle"), confirmLabel: t("drawer.discard"), danger: true });
  };
  const display = c ? c.name || c.email || t("unnamedContact") : "";

  return (
    <Drawer
      open={!!contactId}
      onOpenChange={(o) => !o && requestClose()}
      title={c?.name || t("contact")}
      width={560}
      onEscapeKeyDown={(e) => {
        if (dirty) {
          e.preventDefault();
          requestClose();
        }
      }}
      onInteractOutside={(e) => {
        if (dirty) {
          e.preventDefault();
          requestClose();
        }
      }}
      header={
        c ? (
          <div className="flex min-w-0 items-center gap-2 text-[12.5px] text-fg-3">
            <UserRound className="size-3.5" />
            <span>{t("contact")}</span>
          </div>
        ) : (
          <Skeleton className="h-3 w-24" />
        )
      }
    >
      {error ? (
        <EmptyState lit={3} title={t("drawer.notFound")} description={errorMessage(error)} />
      ) : isLoading || !c ? (
        <DrawerSkeleton />
      ) : (
        <div className="flex min-h-full flex-col">
          <div className="flex items-start gap-3.5 px-5 pb-4 pt-5">
            {canEdit ? (
              <ImageUpload
                compact
                size="md"
                shape="round"
                name={c.name || c.email || "?"}
                value={c.avatar_url}
                source={c.avatar_source}
                onChange={async (file) => {
                  await picture.upload.mutateAsync({ id: c.id, file });
                }}
                onRemove={async () => {
                  await picture.remove.mutateAsync(c.id);
                }}
                onRefresh={async () => {
                  await picture.refresh.mutateAsync(c.id);
                  toast.info(t("drawer.pictureRefresh"));
                }}
              />
            ) : (
              <Avatar name={c.name || c.email || "?"} src={c.avatar_url} size="xl" />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <h2 className="truncate text-[16px] font-semibold tracking-[-0.015em]" data-ph-mask>
                  {display}
                </h2>
                {c.blocked && <Badge tone="danger">{t("blocked")}</Badge>}
              </div>
              <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-fg-3">
                {c.email && (
                  <span className="mono flex min-w-0 items-center gap-0.5 text-xs" data-ph-mask>
                    <span className="truncate">{c.email}</span>
                    <CopyButton value={c.email} label={t("drawer.copyEmail")} className="size-5" />
                  </span>
                )}
                {c.emails.map((extra) => (
                  <span key={extra} className="mono flex min-w-0 items-center gap-0.5 text-xs text-fg-3" data-ph-mask>
                    <span className="truncate">{extra}</span>
                    <CopyButton value={extra} label={t("drawer.copyEmail")} className="size-5" />
                  </span>
                ))}
                {c.company && (
                  <Link
                    to="/companies/{-$companyId}"
                    params={{ companyId: c.company.id }}
                    search={{ q: undefined }}
                    className="flex items-center gap-1.5 rounded-sm text-fg-2 hover:text-fg"
                  >
                    <CompanyGlyph name={c.company.name} src={c.company.avatar_url} size="xs" />
                    {c.company.name}
                  </Link>
                )}
              </div>
              <div className="mt-2.5">
                <RecordLabels kind="contact" record={c} />
              </div>
            </div>
            {canEdit && !editing && ticketsOn && (
              <Button size="sm" variant="secondary" icon={<TicketPlus className="size-3.5" />} onClick={() => newTicket(c)}>
                {t("drawer.newTicket")}
              </Button>
            )}
            {canEdit && !editing && ticketsOn && c.chat_reachable && (
              <Button size="sm" variant="secondary" icon={<MessageCircle className="size-3.5" />} onClick={() => startChat(c)}>
                {t("drawer.startChat")}
              </Button>
            )}
            {canEdit && !editing && (
              <Button size="sm" variant="secondary" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(true)}>
                {t("drawer.edit")}
              </Button>
            )}
          </div>

          <div className="grid grid-cols-3 divide-x divide-line-soft border-y border-line-soft">
            <MiniStat label={t("col.tickets")} value={c.ticket_count.toLocaleString()} />
            <MiniStat label={t("col.created")} value={<span title={fullDate(c.created_at)}>{shortDate(c.created_at)}</span>} />
            <MiniStat label={t("col.updated")} value={<span title={fullDate(c.updated_at)}>{relShort(c.updated_at)}</span>} />
          </div>

          <AnimatePresence mode="wait" initial={false}>
            {editing ? (
              <motion.div key="edit" {...(reduce ? {} : swap)}>
                {/* Each change here is saved at once, apart from the form's Save. Extras sit beside a primary address. */}
                {c.email && (
                  <div className="border-b border-line-soft px-5 py-4">
                    <ContactEmails c={c} />
                  </div>
                )}
                <EditContact
                  key={c.id}
                  c={c}
                  onDirty={setDirty}
                  onDeleted={onClose}
                  onDone={() => {
                    setDirty(false);
                    setEditing(false);
                  }}
                />
              </motion.div>
            ) : (
              <motion.div key="view" className="flex flex-1 flex-col" {...(reduce ? {} : swap)}>
                <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="flex flex-1 flex-col">
                  <TabsList className="sticky top-0 z-10 bg-surface px-4">
                    <TabsTrigger value="overview" icon={<UserRound />}>
                      {t("drawer.overview")}
                    </TabsTrigger>
                    <TabsTrigger value="tickets" icon={<TicketIcon />} count={c.ticket_count}>
                      {t("drawer.tickets")}
                    </TabsTrigger>
                  </TabsList>
                  <TabsContent value="overview" className="outline-none">
                    <Overview c={c} onEdit={canEdit ? () => setEditing(true) : undefined} />
                  </TabsContent>
                  <TabsContent value="tickets" className="flex-1 outline-none">
                    <Tickets contactId={c.id} onNew={canEdit && ticketsOn ? () => newTicket(c) : undefined} />
                  </TabsContent>
                </Tabs>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </Drawer>
  );
}

export function DrawerSkeleton() {
  return (
    <div className="flex flex-col" aria-busy="true">
      <div className="flex items-center gap-3.5 px-5 pb-4 pt-5">
        <Skeleton className="size-10 rounded-lg" />
        <div className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-3.5 w-40" />
          <Skeleton className="h-2.5 w-56 opacity-60" />
        </div>
      </div>
      <div className="grid grid-cols-3 border-y border-line-soft">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex flex-col gap-2 px-5 py-3">
            <Skeleton className="h-2 w-12" />
            <Skeleton className="h-3.5 w-16" />
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-4 p-5">
        <Skeleton className="h-3 w-1/2" />
        <Skeleton className="h-3 w-2/3" />
        <Skeleton className="h-3 w-1/3" />
      </div>
    </div>
  );
}

function Overview({ c, onEdit }: { c: Contact; onEdit?: () => void }) {
  const { t } = useTranslation("contacts");
  const { data: defs } = useRecordFields("contact");
  const fields = fieldsOf(c, new Set((defs ?? []).map((f) => f.key)));
  // The customer portal is ticket work: it is offered only while Tickets is on.
  const { tickets: ticketsOn } = useProducts();
  return (
    <div className="flex flex-col gap-6 px-5 py-4">
      <RecordFields kind="contact" record={c} />
      <dl className="divide-y divide-line-soft">
        <Detail label={t("field.phone")} mono>
          {c.phone ? <PhoneNumber phone={c.phone} /> : <span>{none}</span>}
        </Detail>
        <Detail label={t("field.externalId")} mono>
          {c.external_id || none}
        </Detail>
        <Detail label={t("field.status")}>{c.blocked ? <Badge tone="danger">{t("blocked")}</Badge> : <Badge tone="ok">{t("active")}</Badge>}</Detail>
        {fields.map(([k, v]) => (
          <Detail key={k} label={fieldLabel(k)} mono>
            {fieldText(v)}
          </Detail>
        ))}
      </dl>

      {ticketsOn && <PortalAccessSection contact={c} canEdit={!!onEdit} />}

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="label-caps">{t("field.notes")}</h3>
          {onEdit && c.notes && (
            <button type="button" onClick={onEdit} className="rounded-sm px-1.5 text-xs text-fg-3 transition-colors hover:bg-hover hover:text-fg">
              {t("drawer.editNotes")}
            </button>
          )}
        </div>
        {c.notes ? (
          <p className="whitespace-pre-wrap rounded-lg bg-sunken px-3.5 py-3 text-[13px] leading-5 text-fg-2" data-ph-mask>
            {c.notes}
          </p>
        ) : onEdit ? (
          <button
            type="button"
            onClick={onEdit}
            className="flex w-full items-center gap-2 rounded-lg border border-dashed border-line px-3.5 py-3 text-left text-[12.5px] text-fg-4 transition-colors hover:border-line-strong hover:text-fg-3"
          >
            <FileText className="size-3.5" />
            {t("drawer.addNote")}
          </button>
        ) : (
          <p className="text-[12.5px] text-fg-4">{t("drawer.noNotes")}</p>
        )}
      </section>
    </div>
  );
}

function Tickets({ contactId, onNew }: { contactId: string; onNew?: () => void }) {
  const { t } = useTranslation("contacts");
  useTranslation("indicators");
  const { data, isLoading } = useQuery(q.contactTickets(contactId));
  if (isLoading)
    return (
      <div className="flex flex-col gap-3 p-5">
        <Skeleton className="h-3 w-3/4" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    );
  if (!data?.length)
    return (
      <EmptyState
        compact
        lit={0}
        title={t("drawer.noTickets")}
        description={t("drawer.noTicketsHint")}
        action={
          onNew && (
            <Button size="sm" variant="secondary" icon={<TicketPlus className="size-3.5" />} onClick={onNew}>
              {t("drawer.newTicket")}
            </Button>
          )
        }
      />
    );
  return (
    <div role="list" className="py-1">
      <PresenceList>
      {data.map((tk) => (
        <PresenceRow key={tk.id}>
        <div role="listitem">
          <Link
            to="/inbox/$folder/{-$ticketId}"
            params={{ folder: "open", ticketId: tk.id }}
            className="flex items-center gap-3 border-b border-line-soft px-5 py-2.5 transition-colors hover:bg-sunken"
          >
            {/* Fixed icon slots so priority and status line up down the list. */}
            <span className="flex shrink-0 items-center gap-2">
              <Tooltip content={priorityLabel(tk.priority)}>
                <span className="flex size-4 items-center justify-center">
                  <PriorityIcon priority={tk.priority} />
                </span>
              </Tooltip>
              <Tooltip content={statusLabel(tk.status)}>
                <span className="flex size-4 items-center justify-center">
                  <StatusIcon status={tk.status} />
                </span>
              </Tooltip>
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium" data-ph-mask>
                {tk.subject}
              </span>
              <span className="mt-1 flex items-center gap-2 text-xs text-fg-3">
                <TicketNumber n={tk.number} />
                <span>{statusLabel(tk.status)}</span>
                {tk.assignee && <span className="truncate">{tk.assignee.name}</span>}
              </span>
            </span>
            <span className="mono w-8 shrink-0 text-right text-[11px] text-fg-4">{relShort(tk.last_message_at)}</span>
          </Link>
        </div>
        </PresenceRow>
      ))}
      </PresenceList>
    </div>
  );
}

function EditContact({ c, onDirty, onDeleted, onDone }: { c: Contact; onDirty: (d: boolean) => void; onDeleted: () => void; onDone: () => void }) {
  const { t } = useTranslation("contacts");
  const qc = useQueryClient();
  const confirm = useConfirm();
  const isAdmin = atLeast(useRole(), "admin");
  const [merging, setMerging] = useState(false);
  const [name, setName] = useState(c.name);
  const [email, setEmail] = useState(c.email ?? "");
  const [phone, setPhone] = useState(c.phone);
  const [notes, setNotes] = useState(c.notes);
  const [company, setCompany] = useState<CompanyRef | null>(c.company);
  const [blocked, setBlocked] = useState(c.blocked);
  const [error, setError] = useState<string | null>(null);

  // Another address made the primary one (ContactEmails) changes the email field under the form.
  useEffect(() => setEmail(c.email ?? ""), [c.email]);

  const dirty =
    name !== c.name || email !== (c.email ?? "") || phone !== c.phone || notes !== c.notes || company?.id !== c.company?.id || blocked !== c.blocked;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);

  const save = useMutation({
    mutationFn: () =>
      api.contacts.update(c.id, {
        name: name.trim(),
        email: email.trim() || null,
        phone: phone.trim(),
        notes,
        company_id: company?.id ?? null,
        blocked,
      }),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: qk.contact(c.id) });
      const snap = snapshot(qc, [qk.contact(c.id), qk.contactLists]);
      patchContact(qc, { ...c, name: name.trim(), email: email.trim() || null, phone: phone.trim(), notes, company, blocked });
      return { snap };
    },
    onError: (e, _v, ctx) => {
      if (ctx) restore(qc, ctx.snap);
      setError(errorMessage(e));
    },
    onSuccess: (updated) => {
      patchContact(qc, updated);
      onDirty(false);
      toast.success(t("toast.saved"));
      onDone();
    },
  });

  const remove = useMutation({
    mutationFn: () => api.contacts.remove(c.id),
    onSuccess: () => {
      dropContact(qc, c.id);
      qc.removeQueries({ queryKey: qk.contact(c.id) });
      toast.success(t("toast.deleted"));
      onDeleted();
    },
  });

  return (
    <>
      <form
        className="flex flex-col gap-4 px-5 py-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim() && !email.trim()) return setError(t("error.nameOrEmail"));
          setError(null);
          save.mutate();
        }}
      >
        <Field label={t("field.name")}>{(p) => <TextInput {...p} data-autofocus autoFocus value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("field.email")}>{(p) => <TextInput {...p} type="email" className="mono" value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
          <Field label={t("field.phone")}>{(p) => <TextInput {...p} value={phone} onChange={(e) => setPhone(e.target.value)} />}</Field>
        </div>
        <Field label={t("field.company")}>{({ id }) => <CompanyPicker id={id} value={company} onChange={setCompany} />}</Field>
        <Field label={t("field.notes")} hint={t("field.notesHint")}>
          {(p) => <Textarea {...p} rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} />}
        </Field>
        <div className="flex items-center justify-between gap-4 rounded-lg border border-line px-3.5 py-3">
          <div>
            <div className="text-[13px] font-medium">{t("field.block")}</div>
            <div className="text-xs text-fg-3">{t("field.blockHint")}</div>
          </div>
          <Switch checked={blocked} onCheckedChange={setBlocked} aria-label={t("field.block")} />
        </div>
        {error && (
          <p role="alert" className="text-xs text-danger-fg">
            {error}
          </p>
        )}
        <div className="flex items-center gap-2 border-t border-line-soft pt-4">
          <Button
            variant="danger"
            icon={<Trash2 className="size-3.5" />}
            onClick={() =>
              confirm.show(t("confirm.deleteBody"), () => remove.mutateAsync(), {
                title: t("confirm.deleteTitle", { name: c.name || c.email || t("thisContact") }),
                confirmLabel: t("confirm.deleteConfirm"),
                danger: true,
              })
            }
          >
            {t("drawer.delete")}
          </Button>
          {isAdmin && (
            <Button variant="secondary" icon={<GitMerge className="size-3.5" />} onClick={() => setMerging(true)}>
              {t("drawer.merge")}
            </Button>
          )}
          <Button variant="ghost" className="ml-auto" onClick={onDone}>
            {t("cancel")}
          </Button>
          <Button variant="primary" type="submit" loading={save.isPending} disabled={!dirty}>
            {t("drawer.save")}
          </Button>
        </div>
      </form>
      <MergeContactDialog contact={c} open={merging} onOpenChange={setMerging} onMerged={onDeleted} />
    </>
  );
}

// The bar over a selection on the People and Companies lists: add or remove a label, set or
// clear a custom field, set a company (People), invite to the customer portal (People) and delete. A selection of rows goes by id, in requests of 100; "everyone who
// matches" goes by the list's own filters, which the server applies to at most 1000 records.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { Building2, ListFilter, Send, Tag as TagIcon, Trash2, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AnimatedNumber } from "@/components/motion";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { Dialog } from "@/components/ui/dialog";
import { Picker } from "@/components/ui/picker";
import { toast } from "@/components/ui/toast";
import { useDebounced } from "@/components/contacts/hooks";
import { CompanyGlyph } from "@/components/contacts/bits";
import { useRecordFields } from "@/components/contacts/LabelsAndFields";
import { FieldsSection } from "@/components/tickets/detail/FieldsSection";
import type { BulkResult, CompanyBulkQuery, ContactBulkQuery, DirectoryBulkPatch } from "@/lib/api/endpoints";
import { api } from "@/lib/api/endpoints";
import type { CustomField, FieldValue, LabelScope } from "@/lib/api/types";
import { springs } from "@/lib/motion";
import { q, qk } from "@/lib/queries";
import type { Selection } from "./useSelection";

const CHUNK = 100;

type Patch = DirectoryBulkPatch & { company_id?: string | null };

/** `matching` is how many records the filters match, when the list has loaded them all. */
type Common = { selection: Selection; canSelectMore: boolean; matching?: number };
type Props = (Common & { scope: "contacts"; query: ContactBulkQuery }) | (Common & { scope: "companies"; query: CompanyBulkQuery });

/** Runs one action over the selection: by filter in one request, or by id in chunks. */
async function run(props: Props, action: { delete: true } | { patch: Patch }): Promise<BulkResult> {
  const { selection } = props;
  const total: BulkResult = { updated: 0, deleted: 0 };
  const add = (r: BulkResult) => {
    total.updated += r.updated;
    total.deleted += r.deleted;
  };
  if (selection.allMatching) {
    if (props.scope === "contacts") add(await api.contacts.bulk({ query: props.query, ...action } as Parameters<typeof api.contacts.bulk>[0]));
    else add(await api.companies.bulk({ query: props.query, ...action } as Parameters<typeof api.companies.bulk>[0]));
    return total;
  }
  for (let i = 0; i < selection.ids.length; i += CHUNK) {
    const ids = selection.ids.slice(i, i + CHUNK);
    if (props.scope === "contacts") add(await api.contacts.bulk({ ids, ...action } as Parameters<typeof api.contacts.bulk>[0]));
    else add(await api.companies.bulk({ ids, ...action } as Parameters<typeof api.companies.bulk>[0]));
  }
  return total;
}

export function DirectoryBulkBar(props: Props) {
  const { scope, selection } = props;
  const { t } = useTranslation("contacts");
  const confirm = useConfirm();
  const qc = useQueryClient();
  const { data: tags } = useQuery(q.tags());
  const labelScope: LabelScope = scope;
  const labels = (tags ?? []).filter((x) => !x.archived && x.applies_to.includes(labelScope));
  const n = selection.ids.length;
  const shown = n > 0 || selection.allMatching;
  const [settingField, setSettingField] = useState(false);

  const apply = useMutation({
    mutationFn: (action: { delete: true } | { patch: Patch }) => run(props, action),
    onSuccess: (r) => {
      toast.success(r.deleted > 0 ? t("bulk.deleted", { count: r.deleted }) : t("bulk.updated", { count: r.updated }));
      selection.clear();
      void qc.invalidateQueries({ queryKey: qk.of("contacts") });
      void qc.invalidateQueries({ queryKey: qk.of("companies") });
    },
    onError: (e) => toast.error(e, t("bulk.failed")),
  });

  const remove = () => {
    // Everyone who matches has a number once the list has loaded them all.
    const count = selection.allMatching ? props.matching : n;
    confirm.show(
      count === undefined ? t(`bulk.deleteAllBody.${scope}`) : t(`bulk.deleteBody.${scope}`, { count }),
      () => apply.mutateAsync({ delete: true }),
      { title: count === undefined ? t("bulk.deleteAllTitle") : t(`bulk.deleteTitle.${scope}`, { count }), confirmLabel: t("bulk.delete"), danger: true },
    );
  };

  return (
    <>
      <AnimatePresence>
        {shown && (
          <motion.div
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={springs.pop}
            role="toolbar"
            aria-label={t("bulk.toolbar")}
            className="absolute bottom-5 left-1/2 z-20 flex max-w-[calc(100%-24px)] -translate-x-1/2 items-center gap-0.5 overflow-x-auto rounded-lg border border-line bg-raised p-1 pl-3 shadow-float"
          >
            <span className="mr-2 whitespace-nowrap text-[12px] text-fg-2">
              {selection.allMatching ? t("bulk.allMatching") : <><AnimatedNumber value={n} className="font-medium text-fg" /> {t("bulk.selectedWord", { count: n })}</>}
            </span>
            {!selection.allMatching && props.canSelectMore && (
              <Button variant="ghost" size="xs" onClick={selection.selectAllMatching}>
                {t("bulk.selectAll")}
              </Button>
            )}
            <span className="mx-1 h-5 w-px bg-line" />
            <Picker
              side="top"
              placeholder={t("bulk.addLabel")}
              value={null}
              items={labels.map((l) => ({ value: l.name, label: l.name }))}
              emptyText={t("filter.noLabels")}
              onSelect={(name) => apply.mutate({ patch: { add_tags: [name] } })}
              trigger={
                <Button variant="ghost" size="sm" icon={<TagIcon className="size-3.5" />}>
                  {t("bulk.addLabel")}
                </Button>
              }
            />
            <Picker
              side="top"
              placeholder={t("bulk.removeLabel")}
              value={null}
              items={labels.map((l) => ({ value: l.name, label: l.name }))}
              emptyText={t("filter.noLabels")}
              onSelect={(name) => apply.mutate({ patch: { remove_tags: [name] } })}
              trigger={
                <Button variant="ghost" size="sm" icon={<TagIcon className="size-3.5" />}>
                  {t("bulk.removeLabel")}
                </Button>
              }
            />
            <Button variant="ghost" size="sm" icon={<ListFilter className="size-3.5" />} onClick={() => setSettingField(true)}>
              {t("bulk.setField")}
            </Button>
            {scope === "contacts" && <CompanyAction onPick={(company_id) => apply.mutate({ patch: { company_id } })} />}
            {scope === "contacts" && !selection.allMatching && <InviteAction ids={selection.ids} onDone={selection.clear} />}
            <Button variant="ghost" size="sm" icon={<Trash2 className="size-3.5" />} onClick={remove} className="text-danger-fg">
              {t("bulk.delete")}
            </Button>
            <span className="mx-1 h-5 w-px bg-line" />
            <Button variant="ghost" size="sm" square aria-label={t("bulk.clear")} icon={<X className="size-3.5" />} onClick={selection.clear} />
          </motion.div>
        )}
      </AnimatePresence>
      <SetFieldDialog
        key={settingField ? "open" : "closed"}
        kind={scope === "contacts" ? "contact" : "company"}
        open={settingField}
        onOpenChange={setSettingField}
        count={selection.allMatching ? props.matching : n}
        onApply={async (key, value) => {
          await apply.mutateAsync({ patch: { fields: { [key]: value } } });
          setSettingField(false);
        }}
      />
    </>
  );
}

/** Sets one custom field to one value on everything selected, or clears it. */
function SetFieldDialog({
  kind,
  open,
  onOpenChange,
  count,
  onApply,
}: {
  kind: "contact" | "company";
  open: boolean;
  onOpenChange: (o: boolean) => void;
  count?: number;
  onApply: (key: string, value: FieldValue | null) => Promise<void>;
}) {
  const { t } = useTranslation("contacts");
  const { data: fields } = useRecordFields(kind);
  const [field, setField] = useState<CustomField | null>(null);
  const [value, setValue] = useState<FieldValue | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (v: FieldValue | null) => {
    if (!field) return;
    setBusy(true);
    try {
      await onApply(field.key, v);
    } catch {
      // The bar's toast says what went wrong; the dialog stays for another try.
    } finally {
      setBusy(false);
    }
  };
  const target = count === undefined ? t("bulk.everyoneMatching") : t("bulk.records", { count });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title={t("bulk.setFieldTitle")}
      description={t("bulk.setFieldBody", { target })}
      footer={
        <>
          <Button variant="ghost" className="mr-auto" disabled={!field || busy} onClick={() => void run(null)}>
            {t("bulk.clearField")}
          </Button>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button variant="primary" disabled={!field || value === null || busy} onClick={() => void run(value)}>
            {t("bulk.applyField")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 px-5 pb-4 pt-1">
        <Picker
          width={300}
          placeholder={t("bulk.findField")}
          emptyText={t("bulk.noFields")}
          value={field?.key ?? null}
          items={(fields ?? []).map((f) => ({ value: f.key, label: f.name }))}
          onSelect={(key) => {
            setField(fields?.find((f) => f.key === key) ?? null);
            setValue(null);
          }}
          trigger={
            <Button variant="secondary" icon={<ListFilter className="size-3.5" />} className="self-start">
              {field?.name ?? t("bulk.chooseField")}
            </Button>
          }
        />
        {field && (
          <FieldsSection
            key={field.key}
            fields={[field]}
            values={value === null ? {} : { [field.key]: value }}
            disabled={busy}
            labelWidth="w-[120px]"
            className="-mx-1.5"
            onChange={(_, v) => setValue(v)}
          />
        )}
      </div>
    </Dialog>
  );
}

/** Sets one company on everyone selected, or clears it. */
function CompanyAction({ onPick }: { onPick: (id: string | null) => void }) {
  const { t } = useTranslation("contacts");
  const [query, setQuery] = useState("");
  const term = useDebounced(query, 200);
  const { data } = useQuery({ queryKey: qk.of("companies", "pick", term), queryFn: () => api.companies.search({ q: term || undefined, limit: 12 }) });
  const rows = data?.data ?? [];
  return (
    <Picker
      side="top"
      width={300}
      placeholder={t("bulk.setCompany")}
      value={null}
      onQueryChange={setQuery}
      items={[
        { value: "__none", label: t("bulk.noCompany"), icon: <span className="size-3.5" /> },
        ...rows.map((c) => ({ value: c.id, label: c.name, hint: c.domain, icon: <CompanyGlyph name={c.name} src={c.avatar_url} size="xs" /> })),
      ]}
      onSelect={(v) => onPick(v === "__none" ? null : v)}
      trigger={
        <Button variant="ghost" size="sm" icon={<Building2 className="size-3.5" />}>
          {t("bulk.setCompany")}
        </Button>
      }
    />
  );
}

/** Invites the selected people to the customer portal, from a brand whose help center is on. */
function InviteAction({ ids, onDone }: { ids: string[]; onDone: () => void }) {
  const { t } = useTranslation("contacts");
  const qc = useQueryClient();
  const { data: brands } = useQuery(q.brands());
  const from = (brands ?? []).filter((b) => b.help_center.enabled && b.portal_auth.mode !== "oidc");
  const send = useMutation({
    mutationFn: async (brandId?: string) => {
      const total = { sent: 0, skipped: 0 };
      for (let i = 0; i < ids.length; i += CHUNK) {
        const r = await api.contacts.invitePortalBulk(ids.slice(i, i + CHUNK), brandId);
        total.sent += r.sent;
        total.skipped += Object.values(r.skipped).reduce((a, b) => a + (b ?? 0), 0);
      }
      return total;
    },
    onSuccess: (r) => {
      toast.success(r.skipped > 0 ? t("bulk.invitedSome", { count: r.sent, skipped: r.skipped }) : t("bulk.invited", { count: r.sent }));
      onDone();
      void qc.invalidateQueries({ queryKey: qk.of("contacts", "portal") });
    },
    onError: (e) => toast.error(e, t("bulk.inviteFailed")),
  });
  if (from.length === 0) return null;
  const button = (
    <Button variant="ghost" size="sm" icon={<Send className="size-3.5" />} loading={send.isPending} onClick={from.length === 1 ? () => send.mutate(from[0].id) : undefined}>
      {t("bulk.invite")}
    </Button>
  );
  if (from.length === 1) return button;
  return (
    <Picker
      side="top"
      placeholder={t("bulk.inviteFrom")}
      value={null}
      items={from.map((b) => ({ value: b.id, label: b.name }))}
      onSelect={(id) => send.mutate(id)}
      trigger={button}
    />
  );
}

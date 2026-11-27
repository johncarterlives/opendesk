// The fields a new ticket starts from, the same in the dialog and on the page:
// email, chat, log the customer's request or log internally, who it goes to (the
// contact, and on an email anyone else, with Cc and Bcc), and the address or widget it
// goes from.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Segmented } from "@/components/ui/tabs";
import { Picker } from "@/components/ui/picker";
import { Avatar } from "@/components/ui/avatar";
import { api } from "@/lib/api/endpoints";
import { q, qk } from "@/lib/queries";
import { addressLabel, TeamDot } from "./teams";
import { EmailChips } from "./detail/composerParts";
import { allTo, isEmailed, toAddress, type NewTicketTo as Recipient } from "./newTicket";
import type { NewTicketState } from "./useNewTicket";

const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** The most an email's To takes (POST /v1/tickets: the contact and 19 more). */
const MAX_TO = 20;

export function NewTicketKind({ s }: { s: NewTicketState }) {
  const { t: tr } = useTranslation("inbox");
  const { data: widgets } = useQuery(q.widgets());
  // Chat is offered once the workspace has a widget to open it in.
  const hasWidget = (widgets ?? []).some((w) => w.settings.enabled !== false);
  const value = s.draft.kind === "note" ? "note" : s.chat ? "chat" : s.log ? "log" : "email";
  return (
    <Segmented
      value={value}
      onChange={(v) => s.set(v === "note" ? { kind: "note" } : { kind: "reply", channel: v })}
      options={[
        { value: "email", label: tr("newTicket.email") },
        ...(hasWidget || s.chat ? [{ value: "chat" as const, label: tr("newTicket.chat") }] : []),
        { value: "log" as const, label: tr("newTicket.log") },
        { value: "note", label: tr("newTicket.internal") },
      ]}
    />
  );
}

export function NewTicketTo({ s }: { s: NewTicketState }) {
  const { t: tr } = useTranslation("inbox");
  const { to, moreTo } = s.draft;
  const chat = s.chat;
  const unreachable = chat && !!to && !to.contact?.chat_reachable;
  // An email goes to the contact and anyone else; a chat, a logged request and a note have the contact alone.
  const several = isEmailed(s.draft);
  const people = allTo(s.draft);
  const add = (r: Recipient) => {
    if (!to) return s.set({ to: r });
    if (!people.some((p) => toAddress(p) === toAddress(r))) s.set({ moreTo: [...moreTo, r] });
  };
  // The contact leaving hands the ticket to the next one.
  const remove = (i: number) => (i === 0 ? s.set({ to: moreTo[0] ?? null, moreTo: moreTo.slice(1) }) : s.set({ moreTo: moreTo.filter((_, j) => j !== i - 1) }));
  return (
    <Field label={tr("newTicket.to")} error={unreachable ? tr("newTicket.notOnChat") : undefined}>
      {({ id }) =>
        to && several ? (
          <div className="flex min-h-8 flex-wrap items-center gap-1 rounded-md border border-line bg-surface px-1 py-1 text-sm">
            {people.map((r, i) => (
              <RecipientChip key={toAddress(r) || i} r={r} onRemove={() => remove(i)} />
            ))}
            {people.length < MAX_TO && (
            <ContactPicker
              s={s}
              exclude={people}
              onPick={add}
              trigger={
                <button
                  id={id}
                  type="button"
                  className="flex h-6 items-center gap-1 rounded-sm px-1.5 text-xs text-fg-3 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:shadow-[0_0_0_2px_var(--focus)]"
                >
                  <Plus className="size-3" />
                  {tr("newTicket.addTo")}
                </button>
              }
            />
            )}
          </div>
        ) : to ? (
          <div className="flex h-8 items-center gap-2 rounded-md border border-line bg-surface pl-2 pr-1 text-sm">
            <Avatar name={to.contact?.name || to.email || "?"} size="xs" />
            <span className="min-w-0 flex-1 truncate" data-ph-mask>
              {to.contact ? `${to.contact.name} ` : ""}
              <span className="text-fg-3">{to.contact?.email ?? to.email}</span>
            </span>
            <Button size="xs" variant="ghost" onClick={() => s.set({ to: null })}>
              {tr("newTicket.change")}
            </Button>
          </div>
        ) : (
          <ContactPicker
            s={s}
            exclude={people}
            onPick={add}
            trigger={
              <button
                id={id}
                type="button"
                className="flex h-8 w-full items-center rounded-md border border-line bg-surface px-2.5 text-left text-sm text-fg-4 outline-none transition-colors hover:border-line-strong focus-visible:border-fg-4 focus-visible:shadow-[0_0_0_3px_var(--focus)]"
              >
                {chat ? tr("newTicket.toPlaceholderChat") : tr("newTicket.toPlaceholder")}
              </button>
            }
          />
        )
      }
    </Field>
  );
}

/** Contacts as you type, or a full address typed (not for a chat, which reaches contacts it knows). */
function ContactPicker({ s, exclude, onPick, trigger }: { s: NewTicketState; exclude: Recipient[]; onPick: (r: Recipient) => void; trigger: ReactNode }) {
  const { t: tr } = useTranslation("inbox");
  const qc = useQueryClient();
  const [toQuery, setToQuery] = useState("");
  const contacts = useQuery({
    queryKey: qk.of("contacts", "pick", toQuery),
    queryFn: () => api.contacts.search({ q: toQuery, limit: 8 }),
    enabled: toQuery.trim().length > 0,
  });
  const chat = s.chat;
  const taken = new Set(exclude.map(toAddress));
  // A chat reaches only contacts the widget knows; the others say why and take an email instead.
  const toItems = (contacts.data?.data ?? [])
    .filter((c) => !c.email || !taken.has(c.email.toLowerCase()))
    .map((c) => ({
      value: c.id,
      label: c.name || c.email || tr("newTicket.unnamed"),
      hint: chat && !c.chat_reachable ? tr("newTicket.notOnChatShort") : (c.email ?? undefined),
      icon: <Avatar name={c.name || c.email || "?"} src={c.avatar_url} size="xs" />,
    }));
  return (
    <Picker
      items={toItems}
      value={null}
      width={380}
      placeholder={chat ? tr("newTicket.toPlaceholderChat") : tr("newTicket.toPlaceholder")}
      emptyText={toQuery ? (chat ? tr("newTicket.noContactsChat") : tr("newTicket.noContacts")) : tr("newTicket.startTyping")}
      onSelect={(v) => {
        const contact = contacts.data?.data.find((c) => c.id === v);
        // The page's contact card shows them at once, before its own fetch answers.
        if (contact && !qc.getQueryData(qk.contact(v))) qc.setQueryData(qk.contact(v), contact);
        if (contact) onPick({ contact });
      }}
      onCreate={chat ? undefined : (v) => emailRe.test(v.trim()) && onPick({ email: v.trim() })}
      createLabel={chat ? undefined : tr("newTicket.use")}
      trigger={trigger}
      onQueryChange={setToQuery}
    />
  );
}

function RecipientChip({ r, onRemove }: { r: Recipient; onRemove: () => void }) {
  const { t } = useTranslation("indicators");
  const email = r.contact?.email ?? r.email ?? "";
  const name = r.contact?.name;
  return (
    <span className="inline-flex h-6 min-w-0 max-w-full items-center gap-1.5 rounded-sm bg-hover pl-1 pr-0.5 text-[12.5px] animate-pop-in motion-reduce:animate-none" data-ph-mask>
      <Avatar name={name || email || "?"} src={r.contact?.avatar_url} size="xs" />
      <span className="min-w-0 truncate">
        {name ? `${name} ` : ""}
        <span className={cn(name && "text-fg-3")}>{email}</span>
      </span>
      <button
        type="button"
        aria-label={t("tickets.remove", { name: name || email })}
        onClick={onRemove}
        className="flex size-5 shrink-0 items-center justify-center rounded-xs text-fg-4 transition-colors hover:text-fg"
      >
        <X className="size-3" />
      </button>
    </span>
  );
}

/**
 * The dialog's Cc and Bcc, shown on an email once asked for (the page has them above its
 * message). They go with the first email only.
 */
export function NewTicketCopies({ s }: { s: NewTicketState }) {
  const { t: tr } = useTranslation("inbox");
  if (!isEmailed(s.draft)) return null;
  const { draft, set } = s;
  const open = draft.showCc || draft.cc.length > 0 || draft.bcc.length > 0;
  if (!open)
    return (
      <button type="button" onClick={() => set({ showCc: true })} className="-mt-2 self-start rounded-sm px-1 py-0.5 text-xs text-fg-3 transition-colors hover:bg-hover hover:text-fg">
        {tr("newTicket.addCopies")}
      </button>
    );
  return (
    <div className="overflow-hidden rounded-md border border-line bg-surface animate-fade-in motion-reduce:animate-none [&>div:last-child]:border-b-0">
      <EmailChips label={tr("composer.cc")} values={draft.cc} onChange={(cc) => set({ cc })} />
      <EmailChips label={tr("composer.bcc")} values={draft.bcc} onChange={(bcc) => set({ bcc })} />
    </div>
  );
}

export function NewTicketFrom({ s }: { s: NewTicketState }) {
  const { t: tr } = useTranslation("inbox");
  if (s.chat) return <NewTicketWidget s={s} />;
  return (
    <Field label={tr("newTicket.from")} hint={s.log ? tr("newTicket.logHint") : undefined} error={s.noSender ? tr("newTicket.cannotSend") : undefined}>
      {({ id }) => (
        <Select
          id={id}
          value={s.draft.mailbox}
          onChange={(mailbox) => s.set({ mailbox })}
          disabled={s.draft.kind === "note" || !s.fromChoices.length}
          placeholder={tr("newTicket.noMailbox")}
          options={s.fromChoices.map((m) => ({ value: m.id, label: addressLabel(m), icon: <TeamDot team={s.teams.team(m.team_id)} /> }))}
        />
      )}
    </Field>
  );
}

const LATEST = "__latest";

/** The widget a chat opens in: the contact's latest by default, or one of the brand's. */
function NewTicketWidget({ s }: { s: NewTicketState }) {
  const { t: tr } = useTranslation("inbox");
  const { data: widgets } = useQuery(q.widgets());
  const choices = (widgets ?? []).filter((w) => w.settings.enabled !== false && (!s.teams.multiBrand || !s.brand || w.brand_id === s.brand));
  return (
    // "Reachable" means in some brand's widget; another brand's says what it needs.
    <Field label={tr("newTicket.widget")} hint={s.teams.multiBrand ? tr("newTicket.widgetHint") : undefined}>
      {({ id }) => (
        <Select
          id={id}
          value={s.draft.widgetId ?? LATEST}
          onChange={(v) => s.set({ widgetId: v === LATEST ? undefined : v })}
          options={[{ value: LATEST, label: tr("newTicket.widgetLatest") }, ...choices.map((w) => ({ value: w.id, label: w.name }))]}
        />
      )}
    </Field>
  );
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "@/components/ui/toast";
import { api } from "@/lib/api/endpoints";
import { errorMessage } from "@/lib/api/client";
import { q, qk } from "@/lib/queries";
import { patchTicketEverywhere } from "@/lib/ticketCache";
import { beforeSignOut, useSession } from "@/lib/session";
import type { Contact } from "@/lib/api/types";
import { shell } from "@/app/shellStore";
import { useTeamsCtx } from "./teams";
import { createTicketBody, draftKey, isChat, isDirty, isLog, newTicketDrafts, newTicketProblem, useNewTicketDraft, type NewTicketDraft } from "./newTicket";

// A person signing out takes their unsent new tickets out of this browser.
beforeSignOut(async () => {
  const uid = useSession.getState().user?.id;
  if (uid) newTicketDrafts.forget(uid);
});

/**
 * Writing a new ticket, in the dialog or on its page: the workspace's draft, the
 * addresses it can go from, its team, and creating it. `onCreated` runs before
 * the created ticket opens.
 */
export function useNewTicket({ onCreated }: { onCreated?: () => void } = {}) {
  const { t: tr } = useTranslation("inbox");
  const qc = useQueryClient();
  const navigate = useNavigate();
  const me = useSession((s) => s.user!.id);
  const wid = useSession((s) => s.workspaceId!);
  const key = draftKey(me, wid);
  const draft = useNewTicketDraft(key);
  const set = useCallback((p: Partial<NewTicketDraft>) => newTicketDrafts.patch(key, p), [key]);
  const { data: mailboxes } = useQuery(q.mailboxes());
  const teams = useTeamsCtx();
  const [error, setError] = useState<string | null>(null);

  // The brand's addresses the caller may send from; the default brand first.
  const defaultBrand = teams.brands.find((b) => b.is_default)?.id;
  const brand = draft.brandId ?? defaultBrand;
  const sendable = (mailboxes ?? []).filter((m) => m.status !== "disabled" && teams.canSendFrom(m));
  const brandRow = teams.brand(brand);
  const fromChoices = teams.multiBrand && brand ? sendable.filter((m) => m.brand_id === brand) : sendable;
  const mailbox = draft.mailbox;
  useEffect(() => {
    if (mailbox && fromChoices.some((m) => m.id === mailbox)) return;
    const next = fromChoices.find((m) => m.status === "active" && m.sending !== "system_off") ?? fromChoices.find((m) => m.status === "active") ?? fromChoices[0];
    if (next?.id !== mailbox) set({ mailbox: next?.id });
  }, [fromChoices.map((m) => m.id).join(), mailbox]); // eslint-disable-line react-hooks/exhaustive-deps
  const chat = isChat(draft);
  const log = isLog(draft);
  // The team follows the address's default team until someone picks one; a chat's comes from routing.
  const teamId = draft.team !== undefined ? draft.team : chat ? null : (teams.mailbox(mailbox)?.team_id ?? null);
  const teamRow = teams.team(teamId);
  // An address with no way to send cannot email the first message (mailbox_cannot_send); a logged request sends nothing.
  const noSender = draft.kind === "reply" && !chat && !log && teams.mailbox(mailbox)?.sending === "system_off";
  const assignee = draft.assignee === undefined ? me : draft.assignee;

  const create = useMutation({
    mutationFn: (attachmentIds?: string[]) => api.tickets.create(createTicketBody(draft, { me, teamId, hasTeams: teams.hasTeams, attachmentIds })),
    onSuccess: (t) => {
      patchTicketEverywhere(qc, t, me);
      void qc.invalidateQueries({ queryKey: qk.counts });
      toast.success(tr("newTicket.created", { number: t.number }));
      newTicketDrafts.clear(key);
      onCreated?.();
      void navigate({ to: "/inbox/$folder/{-$ticketId}", params: { folder: t.assignee?.id === me ? "mine" : "open", ticketId: t.id } });
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const submit = (attachmentIds?: string[]) => {
    setError(null);
    const problem = newTicketProblem(draft, noSender);
    if (problem) return setError(tr(`newTicket.${problem}`));
    create.mutate(attachmentIds);
  };

  return {
    key,
    me,
    draft,
    chat,
    log,
    set,
    discard: () => newTicketDrafts.clear(key),
    dirty: isDirty(draft),
    teams,
    brand,
    brandRow,
    fromChoices,
    teamId,
    teamRow,
    noSender,
    assignee,
    error,
    setError,
    create,
    submit,
  };
}

export type NewTicketState = ReturnType<typeof useNewTicket>;

/** Opens the new ticket dialog set to email or to chat, with the contact when given. */
function useOpenNewTicket(channel: "email" | "chat") {
  const me = useSession((s) => s.user!.id);
  const wid = useSession((s) => s.workspaceId!);
  return useCallback(
    (contact?: Contact) => {
      newTicketDrafts.patch(draftKey(me, wid), { kind: "reply", channel, ...(contact ? { to: { contact } } : {}) });
      shell.newTicket();
    },
    [me, wid, channel],
  );
}

/** Opens the new ticket dialog set to start a chat, with the contact when given. */
export const useStartChat = () => useOpenNewTicket("chat");

/** Opens the new ticket dialog set to email, as the New ticket button does, with the contact when given. */
export const useNewTicketFor = () => useOpenNewTicket("email");

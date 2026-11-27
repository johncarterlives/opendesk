// Who else was on the customer's latest email, for Reply all in a ticket's reply box, and the
// recipients an inbound email lists under its header. A reply goes to the contact (or the To the
// agent chose); Reply all adds everyone else the latest inbound email named (its sender when that
// is not the contact, its To and its Cc) to the reply's Cc, without our own addresses.

import type { Mailbox, Message } from "@/lib/api/types";
import { dedupe, isEmail, normEmail } from "@/lib/collab/recipients";

/**
 * Every address of ours: each mailbox's own, its aliases and its forwarding address (all of the
 * workspace's), and the writer's. Reply all never Cc's an address our own mail arrives at.
 */
export function ownAddresses(
  mailboxes: readonly (Pick<Mailbox, "email" | "aliases"> & { forwarding_address?: string | null })[] | undefined,
  userEmail?: string | null,
): Set<string> {
  const own = new Set<string>();
  for (const mb of mailboxes ?? []) {
    if (mb.email) own.add(normEmail(mb.email));
    for (const a of mb.aliases ?? []) own.add(normEmail(a));
    if (mb.forwarding_address) own.add(normEmail(mb.forwarding_address));
  }
  if (userEmail) own.add(normEmail(userEmail));
  return own;
}

/**
 * The ticket's latest email from the customer's side: not a note, a side conversation, a deleted
 * or a held copy, and not one that failed sender authentication (`auth_failed`). As with the
 * server's reply recipient (internal/domain/replyto.go), such mail never changes who a reply reaches.
 */
export function latestInbound(messages: readonly Message[] | undefined): Message | undefined {
  const list = messages ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m.kind !== "reply" || m.direction !== "inbound" || m.thread_id || m.deleted_at || m.auth_failed || m.id.startsWith("tmp-")) continue;
    return m;
  }
  return undefined;
}

/**
 * The addresses Reply all adds: the message's sender (where the server says replies to it go,
 * `reply_address`: a Reply-To at the sender's own organisation, else from_email, as
 * internal/domain/replyto.go decides), To and Cc, without our own, the contact's, the ones the
 * reply already goes to (To) or hides (Bcc), deduplicated case-insensitively, in the message's
 * order. A message that failed sender authentication adds nobody.
 */
export function replyAllExtras(
  m: Pick<Message, "from_email" | "reply_address" | "auth_failed" | "to" | "cc"> | undefined,
  opts: { own: ReadonlySet<string>; contactEmail?: string; to?: readonly string[]; bcc?: readonly string[] },
): string[] {
  if (!m || m.auth_failed) return [];
  const skip = new Set(opts.own);
  if (opts.contactEmail) skip.add(normEmail(opts.contactEmail));
  for (const a of opts.to ?? []) skip.add(normEmail(a));
  for (const a of opts.bcc ?? []) skip.add(normEmail(a));
  const sender = m.reply_address || m.from_email;
  return dedupe([sender, ...m.to, ...m.cc].filter((a) => !!a && isEmail(a) && !skip.has(normEmail(a))));
}

/** Whether Reply all is on: some address it added is still in the Cc. */
export function replyAllOn(cc: readonly string[], added: readonly string[] | undefined): boolean {
  if (!added?.length) return false;
  const inCc = new Set(cc.map(normEmail));
  return added.some((a) => inCc.has(normEmail(a)));
}

/** Reply all: the extras the Cc does not have yet go in after it; `added` is exactly those. */
export function addReplyAll(cc: readonly string[], extras: readonly string[]): { cc: string[]; added: string[] } {
  const inCc = new Set(cc.map(normEmail));
  const added = extras.filter((a) => !inCc.has(normEmail(a)));
  return { cc: [...cc, ...added], added };
}

/** Back to Reply: what Reply all added leaves the Cc, what the agent typed stays. */
export function removeReplyAll(cc: readonly string[], added: readonly string[] | undefined): string[] {
  const out = new Set((added ?? []).map(normEmail));
  return cc.filter((a) => !out.has(normEmail(a)));
}

/** An inbound email's header lists its recipients when it had more than one (To and Cc). */
export function inboundRecipients(m: Pick<Message, "to" | "cc">): { to: string[]; cc: string[] } | null {
  const to = m.to ?? [];
  const cc = m.cc ?? [];
  return to.length + cc.length > 1 ? { to, cc } : null;
}

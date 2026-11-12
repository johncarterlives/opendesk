import type { Message } from "@/lib/api/types";

/**
 * Where an email to the customer goes: the reply address of their latest email, when it named
 * one at their own organisation, else their address (contracts/api.md "Inbound email").
 */
export function replyRecipient(contactEmail: string, messages: Message[] | undefined): string {
  const last = [...(messages ?? [])].reverse().find((m) => m.direction === "inbound" && m.kind === "reply" && !m.auth_failed);
  if (!last?.reply_address || last.from_email.toLowerCase() !== contactEmail.toLowerCase()) return contactEmail;
  return last.reply_address;
}

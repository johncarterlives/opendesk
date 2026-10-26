import type { Message } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { tone } from "@/lib/tones";

/**
 * Who a timeline message is from, as its frame tells it at a glance: the customer, the
 * team (agents, the AI agent, automations, the API), an internal note the customer never
 * sees, or a side conversation with someone outside the team.
 */
export type MessageAuthor = "customer" | "team" | "note" | "thread";

export function messageAuthor(m: Pick<Message, "kind" | "direction" | "author" | "thread_id">): MessageAuthor {
  // A thread message is stored as a note, but it is email to or from a third party.
  if (m.thread_id) return "thread";
  if (m.kind === "note") return "note";
  if (m.direction === "outbound" || m.author.type === "user") return "team";
  return "customer";
}

/** The border and surface of a message: a neutral card for the customer, the reply tint for the team, the note tint for notes. */
export function messageFrame(author: MessageAuthor, failed: boolean): string {
  if (author === "note") return "border-dashed border-note-line bg-note";
  const surface = author === "team" ? "bg-reply" : "bg-surface";
  if (failed) return cn(tone.red.line, surface);
  if (author === "thread") return cn(tone.cyan.line, surface);
  return author === "team" ? "border-reply-line bg-reply" : "border-line bg-surface";
}

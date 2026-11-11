// A link to a ticket in a view (/views/<view>/<ticket>) is often copied from the address bar and
// sent to a colleague. When the view is someone else's personal view, or a private team's, or it
// was deleted, the reader can't load it and got an error page, though they can read the ticket.
// Such a link opens the ticket in its inbox folder instead.

import type { QueryClient } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";
import { isApiError } from "./api/client";
import type { Ticket } from "./api/types";
import type { FolderId } from "./folders";
import { q } from "./queries";

/** The inbox folder that lists a ticket, by its status (lib/folders.ts). */
export function ticketFolder(t: Pick<Ticket, "status" | "spam">): FolderId {
  if (t.spam) return "spam";
  switch (t.status) {
    case "pending":
    case "on_hold":
      return "pending";
    case "solved":
    case "closed":
      return "solved";
    default:
      return "open";
  }
}

/** The view can't be loaded for this reader: missing, or a view they may not see. */
export function isViewUnavailable(e: unknown): boolean {
  return isApiError(e) && (e.status === 404 || (e.status === 422 && /view/i.test(e.detail || e.message)));
}

/** Loads a view's list. When the view can't be loaded but the link names a ticket the reader can
 * read, throws the redirect to that ticket in its inbox folder; any other failure is passed on. */
export async function viewOrTicket<T>(qc: QueryClient, ticketId: string | undefined, load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (e) {
    if (!ticketId || !isViewUnavailable(e)) throw e;
    let t: Ticket;
    try {
      t = await qc.ensureQueryData(q.ticket(ticketId));
    } catch {
      throw e;
    }
    throw redirect({ to: "/inbox/$folder/{-$ticketId}", params: { folder: ticketFolder(t), ticketId }, replace: true });
  }
}

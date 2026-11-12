import { redirect } from "@tanstack/react-router";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import type { Workspace } from "@/lib/api/types";
import { q } from "@/lib/queries";

export type Products = { tickets: boolean; mail: boolean; pages: boolean };

/**
 * Effective product availability: Tickets and Pages are the workspace's flags, Mail adds
 * instance and plan (Workspace.mail_available).
 */
export function productsOf(ws: Workspace | null | undefined): Products {
  return { tickets: ws?.settings.tickets_enabled !== false, mail: ws ? ws.mail_available !== false : true, pages: ws?.settings.pages_enabled !== false };
}

/** What the open workspace offers. All on until the workspace has loaded. */
export function useProducts(): Products {
  const { data } = useQuery(q.workspace());
  return productsOf(data);
}

/** Where a member lands, and where a page of a disabled product sends them. */
export async function productHome(qc: QueryClient) {
  const p = productsOf(await qc.ensureQueryData(q.workspace()));
  if (p.tickets) return redirect({ to: "/inbox/$folder/{-$ticketId}", params: { folder: "unassigned", ticketId: undefined }, replace: true });
  if (p.mail) return redirect({ to: "/mail/$box/{-$threadId}", params: { box: "inbox", threadId: undefined }, search: {}, replace: true });
  if (p.pages) return redirect({ to: "/pages", replace: true });
  return redirect({ to: "/settings/workspace", replace: true });
}

/** Throws the way home while the workspace has Tickets off. */
export async function requireTickets(qc: QueryClient) {
  const p = productsOf(await qc.ensureQueryData(q.workspace()));
  if (!p.tickets) throw await productHome(qc);
}

/** Settings that only shape tickets: not listed, not offered in the command menu and not opened by a link while Tickets is off. */
export const TICKET_SETTINGS: ReadonlySet<string> = new Set([
  "/settings/tags", "/settings/custom-fields", "/settings/assignment", "/settings/triage", "/settings/business-hours",
  "/settings/saved-replies", "/settings/views", "/settings/sla", "/settings/automations", "/settings/mailboxes", "/settings/phone",
  "/settings/support-channels", "/settings/routing", "/settings/brands", "/settings/email-design", "/settings/trash",
]);

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { TicketListQuery } from "@/lib/api/endpoints";
import type { Ticket } from "@/lib/api/types";
import { folderById, type FolderId } from "@/lib/folders";
import { useProducts } from "@/lib/products";
import { ticketMatches } from "@/lib/ticketCache";
import { q } from "@/lib/queries";
import { realtime } from "@/lib/realtime/manager";
import { useRealtime } from "@/lib/realtime/store";
import { useSession } from "@/lib/session";
import { useTeamsCtx } from "./teams";
import { chatWait, handlerOf, OLLIE_GRACE_MS, useAgentOn, type ChatWait } from "./waiting";

// Live chat visitors waiting with nobody on it, for the whole app: the sidebar, the
// alerts and the tab title read the same list, longest wait first. Presence on every
// waiting chat is followed, so one a teammate (or you) picked up drops out at once.
// The list changes with time only when Ollie's grace on a chat runs out, so it wakes for
// that moment alone: the whole app reads it, and a clock ticking here would redraw the
// whole app every second. Live durations run their own clock (`useNow`) where they show.

const QUERY = { status: ["open", "pending"], assignee: "none", channel: "chat" } as const;

export type UrgentChat = { ticket: Ticket; wait: ChatWait };

/** `watch`: follow presence on the waiting chats; only the app-wide alerts hook sets it. */
export function useUrgentChats(on = true, watch = false) {
  const agentOn = useAgentOn();
  // A workspace with Tickets off has no chats waiting.
  const ticketsOn = useProducts().tickets;
  const enabled = on && ticketsOn;
  const list = useInfiniteQuery({ ...q.tickets({ ...QUERY, status: [...QUERY.status] }), enabled });
  const tickets = useMemo(() => list.data?.pages.flatMap((p) => p.data) ?? [], [list.data]);
  // Bumped to re-read the time when a grace runs out; the time itself is always read fresh.
  const [wake, setWake] = useState(0);
  const presence = useRealtime((s) => s.presence);
  const active = useRealtime((s) => s.active);
  const me = useSession((s) => s.user?.id);

  const waitingIds = useMemo(() => tickets.filter((x) => !x.assignee && x.channel === "chat").map((x) => x.id).join(","), [tickets]);
  useEffect(() => {
    if (!enabled || !watch) return;
    realtime()?.setWatched(waitingIds ? waitingIds.split(",") : [], "waiting");
    return () => realtime()?.setWatched([], "waiting");
  }, [waitingIds, enabled, watch]);

  // Wake when the next chat's grace with Ollie runs out (it then waits for the team).
  useEffect(() => {
    const due = tickets
      .map((x) => chatWait(x, agentOn, Date.now()))
      .filter((w): w is ChatWait => w?.state === "ollie")
      .map((w) => w.since + OLLIE_GRACE_MS);
    if (!due.length) return;
    const id = setTimeout(() => setWake((n) => n + 1), Math.max(0, Math.min(...due) - Date.now()) + 50);
    return () => clearTimeout(id);
  }, [tickets, agentOn, wake]);

  const urgent = useMemo(() => {
    const now = Date.now();
    return tickets
        .filter((x) => !x.assignee)
        .map((x) => ({ ticket: x, wait: chatWait(x, agentOn, now, handlerOf(x, presence[x.id], me, active)) }))
        .filter((x): x is UrgentChat => x.wait?.state === "urgent")
        .sort((a, b) => a.wait.since - b.wait.since);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `wake` re-reads the time
  }, [tickets, agentOn, wake, presence, me, active]);
  return { urgent, ready: list.isSuccess };
}

/** A sidebar row that lists tickets: an inbox folder, a team ("mine": the caller's teams) or a view. */
export type WaitingScope = { kind: "ticket_folder"; id: FolderId } | { kind: "team"; id: string } | { kind: "view"; id: string };

/**
 * How many waiting chats each row would list, by the same rules the lists use, so a team,
 * a view or a favorite shows its own red count, not only Unassigned.
 */
export function useWaitingFor(): (scope: WaitingScope) => number {
  const { urgent } = useUrgentChats();
  const { data: views } = useQuery(q.views());
  const teams = useTeamsCtx();
  const me = useSession((s) => s.user?.id) ?? "";
  return useCallback(
    (scope: WaitingScope) => {
      if (!urgent.length) return 0;
      const mine = [...teams.myTeams];
      const query: TicketListQuery | null =
        scope.kind === "ticket_folder"
          ? (folderById(scope.id)?.query ?? null)
          : scope.kind === "team"
            ? { team_id: scope.id === "mine" ? "mine" : scope.id }
            : { view_id: scope.id };
      if (!query) return 0;
      return urgent.filter((x) => ticketMatches(query, x.ticket, me, views, mine) === true).length;
    },
    [urgent, views, teams.myTeams, me],
  );
}

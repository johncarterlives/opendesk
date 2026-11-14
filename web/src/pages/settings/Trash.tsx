// Settings › Admin › Trash: the workspace's deleted tickets, newest first, with who deleted each
// and when, and Restore (contracts/api.md "Trash"). Admins only: agents delete, admins can undo it.

import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { KeyRound, MessageSquare, RotateCcw, Trash2, UserRound, Workflow } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { NoAccess, SettingsPage } from "@/components/layout";
import { SettingsEmpty } from "@/components/settings2/SettingsEmpty";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { isApiError } from "@/lib/api/client";
import { api } from "@/lib/api/endpoints";
import type { DeletedTicket } from "@/lib/api/types";
import { fullDate } from "@/lib/format";
import { q } from "@/lib/queries";
import { atLeast, useRole } from "@/lib/session";

export default function Trash() {
  const { t } = useTranslation("settingsDev");
  const admin = atLeast(useRole(), "admin");
  const [term, setTerm] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const h = setTimeout(() => setSearch(term.trim()), 250);
    return () => clearTimeout(h);
  }, [term]);
  const list = useInfiniteQuery({ ...q.deletedTickets(search), enabled: admin });
  const rows = (list.data?.pages ?? []).flatMap((p) => p.data);
  const sentinel = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = list;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage) return;
    const io = new IntersectionObserver((es) => {
      if (es.some((x) => x.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
    }, { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  if (!admin)
    return (
      <SettingsPage title={t("trash.title")}>
        <NoAccess what={t("trash.what")} />
      </SettingsPage>
    );

  return (
    <SettingsPage wide title={t("trash.title")} description={t("trash.description")}>
      <div className="-mb-3 flex items-center">
        <SearchInput value={term} onChange={setTerm} placeholder={t("trash.search")} className="ml-auto w-full sm:w-[260px]" />
      </div>
      {list.isLoading ? (
        <div className="overflow-hidden rounded-lg border border-line bg-surface shadow-xs">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex h-12 items-center gap-3 border-b border-line-soft px-4 last:border-0">
              <div className="skeleton h-2.5" style={{ width: `${30 + ((i * 17) % 35)}%` }} />
              <div className="skeleton ml-auto h-6 w-20 rounded-md" />
            </div>
          ))}
        </div>
      ) : !rows.length ? (
        <div className="overflow-hidden rounded-lg border border-line bg-surface shadow-xs">
          <SettingsEmpty art="inbox" title={search ? t("trash.emptyFiltered") : t("trash.empty")} description={search ? undefined : t("trash.emptyHint")} />
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-line bg-surface shadow-xs" role="list" aria-label={t("trash.title")}>
          {rows.map((r) => (
            <Row key={r.id} r={r} />
          ))}
        </div>
      )}
      <div ref={sentinel} className="flex h-10 items-center justify-center text-[12px] text-fg-4">
        {isFetchingNextPage ? <Spinner className="size-3.5" /> : null}
      </div>
    </SettingsPage>
  );
}

function Row({ r }: { r: DeletedTicket }) {
  const { t } = useTranslation("settingsDev");
  const qc = useQueryClient();
  const navigate = useNavigate();
  const restore = useMutation({
    mutationFn: () => api.tickets.restore(r.id),
    onSuccess: (tk) => {
      // The lists pick the ticket up from its ticket.updated event; the trash drops it.
      void qc.invalidateQueries({ queryKey: q.deletedTickets("").queryKey.slice(0, -1) });
      toast.success(t("trash.restored", { number: tk.number }), {
        action: { label: t("trash.open"), onClick: () => void navigate({ to: "/inbox/$folder/{-$ticketId}", params: { folder: "open", ticketId: tk.id } }) },
      });
    },
    onError: (e) => toast.error(isApiError(e) && e.detail ? e.detail : t("trash.failed")),
  });
  const who = r.deleted_by ? (
    <span className="inline-flex items-center gap-1">
      <UserRound className="size-3" aria-hidden />
      {t("trash.byMember", { name: r.deleted_by.name || r.deleted_by.email })}
    </span>
  ) : r.deleted_by_api_key ? (
    <span className="inline-flex items-center gap-1">
      <KeyRound className="size-3" aria-hidden />
      {t("trash.byKey", { name: r.deleted_by_api_key.name })}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-fg-4">
      <Workflow className="size-3" aria-hidden />
      {t("trash.byUnknown")}
    </span>
  );
  return (
    <div role="listitem" className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line-soft px-4 py-2 last:border-0">
      <Trash2 className="size-3.5 shrink-0 text-fg-4" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2 text-[13px]">
          <span className="mono shrink-0 tabular-nums text-fg-3">#{r.number}</span>
          <span className="truncate text-fg">{r.subject || t("trash.noSubject")}</span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-fg-3">
          {r.contact && <span className="truncate">{r.contact.name || r.contact.email}</span>}
          <span className="inline-flex items-center gap-1 tabular-nums" aria-label={t("trash.messages", { n: r.message_count })}>
            <MessageSquare className="size-3" aria-hidden />
            {r.message_count}
          </span>
          <span>{t("trash.deletedAt", { when: fullDate(r.deleted_at) })}</span>
          {who}
        </div>
      </div>
      {r.merged_into_number != null ? (
        <span className="text-[11.5px] text-fg-3">{t("trash.merged", { number: r.merged_into_number })}</span>
      ) : (
        <Tooltip content={t("trash.restoreHint")}>
          <Button size="sm" icon={<RotateCcw className="size-3.5" />} loading={restore.isPending} onClick={() => restore.mutate()}>
            {t("trash.restore")}
          </Button>
        </Tooltip>
      )}
    </div>
  );
}

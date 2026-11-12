// Collab mail: a box (or folder) across accounts or one, the conversation list
// beside the open conversation. Every action shows at once and is undone if the
// API refuses; archive, trash, spam, moves, labels and Done / Needs action offer
// Undo. Keyboard first; a row's right click opens its menu, and rows drag onto the
// sidebar's mail rows and the folder bar's tabs (GH#455).

import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { AnimatePresence } from "motion/react";
import {
  AlarmClock,
  Archive,
  AtSign,
  CircleCheck,
  CircleDot,
  ExternalLink,
  Folder,
  Forward,
  Inbox,
  Mail,
  MailOpen,
  PenSquare,
  RefreshCw,
  Reply,
  ReplyAll,
  ShieldAlert,
  ShieldCheck,
  Star,
  Tag,
  Trash2,
  UserPlus,
  UserRound,
  Users,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { MailFolder, MailThread, MailThreadAction } from "@/lib/api/types";
import { api } from "@/lib/api/endpoints";
import { inverseAction, leavesList, listPlace, UNDOABLE } from "@/lib/collab/actions";
import { accountName, boxForRole, isMailBox, mailListQuery, type MailSearch } from "@/lib/collab/boxes";
import { cachedFolders } from "@/lib/collab/cache";
import { compose } from "@/lib/collab/compose";
import { addressNumbers } from "@/lib/collab/badges";
import { accountCategories, categoryTabs, PRIMARY, ruleSender } from "@/lib/collab/categories";
import { assignChanges, useAllFolders, useAssignThreads, useCanAct, useMailAccounts, useSidebarPrefs, useThreadAction } from "@/lib/collab/hooks";
import { type ComposeMode } from "@/lib/collab/recipients";
import { identitiesOf, ownEmails as ownEmailsOf } from "@/lib/collab/identities";
import { startThreadDrag, takeThreadDrops, type ThreadDropTarget } from "@/lib/collab/threadDrag";
import { isTypingTarget } from "@/lib/hotkeys";
import { openInNewTab, useHref } from "@/lib/links";
import { useSession } from "@/lib/session";
import { useShortcuts } from "@/lib/shortcuts";
import { cn } from "@/lib/cn";
import { qk, q } from "@/lib/queries";
import { useDocumentTitle } from "@/app/RootLayout";
import { usePageCrumb } from "@/app/useBreadcrumbs";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty";
import { SearchInput } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SkeletonRows } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { AccountDot, boxIcon, FolderGlyph } from "@/components/collab/bits";
import { canOfferCategories, CategoryOffer, CategoryTabs, useCategorySettingsTarget } from "@/components/collab/CategoryTabs";
import { FolderBar } from "@/components/collab/FolderBar";
import { SearchCoverage, SpamBesideWork, StorageFullBanner } from "@/components/collab/MailNotices";
import { AssignPicker, LabelsPicker, MovePicker, type MoveTarget } from "@/components/collab/pickers";
import { ListShareDialog, SnoozeItems } from "@/components/collab/ThreadMenu";
import { ThreadRow, type AIDraftAction } from "@/components/collab/ThreadRow";
import { SnoozeMenu } from "@/components/tickets/detail/SnoozeMenu";
import { useConfirm } from "@/components/ui/confirm";
import { ContextMenuItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuSub } from "@/components/ui/context-menu";
import { ThreadView, type ThreadViewHandle } from "@/components/collab/ThreadView";

const NO_LABELS: MailFolder[] = [];

type ActOpts = { folderId?: string; category?: string; label?: string; silent?: boolean; until?: string };

const toastKey: Partial<Record<MailThreadAction, "archived" | "trashed" | "spammed" | "moved" | "inboxed" | "notSpam" | "snoozed" | "done" | "needsAction" | "labeled" | "starred">> = {
  snooze: "snoozed",
  done: "done",
  needs_action: "needsAction",
  label: "labeled",
  archive: "archived",
  trash: "trashed",
  spam: "spammed",
  move: "moved",
  inbox: "inboxed",
  not_spam: "notSpam",
  // Only a drop on Starred says so: the star button and s are silent.
  star: "starred",
};

function BulkButton({ label, shortcut, onClick, children }: { label: string; shortcut?: string; onClick?: () => void; children: ReactNode }) {
  return (
    <Tooltip content={label} shortcut={shortcut}>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className="flex size-7 items-center justify-center rounded-md text-fg-2 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:shadow-[0_0_0_2px_var(--focus)] data-[state=open]:bg-hover [&_svg]:size-[15px]"
      >
        {children}
      </button>
    </Tooltip>
  );
}

function usePhone() {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia("(max-width: 767px)");
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia("(max-width: 767px)").matches,
    () => false,
  );
}

export default function MailPage() {
  const { t } = useTranslation("collab");
  const params = useParams({ strict: false }) as { box?: string; threadId?: string };
  const search = useSearch({ strict: false }) as MailSearch;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const canAct = useCanAct();
  const box = params.box ?? "inbox";
  const openId = params.threadId;
  const { data: accounts } = useMailAccounts();
  const { data: counts } = useQuery(q.mailCounts());
  const prefs = useSidebarPrefs();
  const folderMap = useAllFolders(accounts);
  const action = useThreadAction();
  const confirm = useConfirm();

  const account = search.account ? accounts?.find((a) => a.id === search.account) : undefined;
  const folder: MailFolder | undefined = search.folder ? Object.values(folderMap).flatMap((f) => f ?? []).find((f) => f.id === search.folder) : undefined;
  const folderAccount = folder ? accounts?.find((a) => a.id === folder.account_id) : undefined;
  const spans = !account && !folder && (accounts?.length ?? 0) > 1;
  const ownEmails = useMemo(() => new Set((accounts ?? []).flatMap((a) => ownEmailsOf(a))), [accounts]);
  const accountsById = useMemo(() => new Map((accounts ?? []).map((a) => [a.id, a])), [accounts]);

  // An inbox (no folder, no search) whose accounts are split shows its tabs; Primary when none is chosen.
  const tabbed = box === "inbox" && !search.folder && !search.q;
  const tabAccounts = useMemo(() => (!tabbed || !accounts ? [] : account ? [account] : accounts), [tabbed, accounts, account]);
  const tabs = useMemo(() => categoryTabs(tabAccounts, counts), [tabAccounts, counts]);
  const category = tabs.length ? (tabs.some((c) => c.key === search.category) ? search.category : PRIMARY) : undefined;
  const settingsTarget = useCategorySettingsTarget(tabAccounts);
  const offer = !tabs.length && canAct ? tabAccounts.find(canOfferCategories) : undefined;
  const query = useMemo(() => mailListQuery(box, { ...search, category }), [box, search.account, search.folder, search.q, search.to, search.with, category]); // eslint-disable-line react-hooks/exhaustive-deps
  const listKey = JSON.stringify(query);
  // The inbox waits for the accounts, which say whether it opens on a tab.
  const list = useInfiniteQuery({ ...q.mailThreads(query), enabled: !tabbed || !!accounts });
  const threads = useMemo(() => list.data?.pages.flatMap((p) => p.data) ?? [], [list.data]);

  const boxLabel = isMailBox(box) ? (box === "inbox" && !account ? t("nav.allInboxes") : t(`box.${box}`)) : t("box.folder");
  const title = folder ? folder.name : account ? `${boxLabel} · ${accountName(account)}` : boxLabel;
  useDocumentTitle(openId ? null : title);
  usePageCrumb(openId ? null : title);
  const count = folder
    ? (counts?.folders[folder.id] ?? folder.unread)
    : account && box === "inbox" && search.to
      ? addressNumbers(account.id, search.to, counts).unread
      : account && box === "inbox"
        ? (counts?.accounts[account.id] ?? account.unread)
        : !account && isMailBox(box) && box in (counts?.boxes ?? {})
          ? counts?.boxes[box as "inbox"]
          : undefined;

  // ── Selection and keyboard focus ────────────────────────────────────────
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focusIdx, setFocusIdx] = useState(0);
  const lastToggled = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const threadRef = useRef<ThreadViewHandle>(null);
  const [intent, setIntent] = useState<{ id: string; mode: ComposeMode } | null>(null);
  const [pickMove, setPickMove] = useState(false);
  const [pickLabels, setPickLabels] = useState(false);
  const [q2, setQ2] = useState(search.q ?? "");

  useEffect(() => {
    setSelected(new Set());
    setFocusIdx(0);
  }, [listKey]);
  useEffect(() => setQ2(search.q ?? ""), [search.q]);

  useEffect(() => {
    setSelected((s) => {
      if (!s.size) return s;
      const ids = new Set(threads.map((x) => x.id));
      const next = new Set([...s].filter((id) => ids.has(id)));
      return next.size === s.size ? s : next;
    });
    setFocusIdx((i) => Math.max(0, Math.min(i, threads.length - 1)));
  }, [threads]);

  useEffect(() => {
    if (!openId) return;
    const i = threads.findIndex((x) => x.id === openId);
    if (i >= 0) setFocusIdx(i);
  }, [openId, threads]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-thread-id="${threads[focusIdx]?.id}"]`)?.scrollIntoView({ block: "nearest" });
  }, [focusIdx, threads]);

  const go = useCallback(
    (threadId: string | undefined, s: MailSearch | true = true, replace?: boolean) =>
      void navigate({ to: "/mail/$box/{-$threadId}", params: { box, threadId }, search: s === true ? (prev: MailSearch) => prev : s, replace }),
    [navigate, box],
  );
  const open = useCallback((x: MailThread | undefined) => x && go(x.id), [go]);
  const close = useCallback(() => go(undefined), [go]);

  const setQuery = (v: string) => {
    const next: MailSearch = { ...search, q: v.trim() || undefined };
    go(undefined, next, true);
  };
  // One account's mail written to one of its addresses (an alias): GET /v1/collab/threads?to=.
  const scopeAccount = account ?? folderAccount;
  const addresses = scopeAccount ? identitiesOf(scopeAccount) : [];
  const setTo = (v: string) => go(undefined, { ...search, to: v || undefined }, true);

  const toggle = useCallback(
    (x: MailThread, shift: boolean) => {
      setSelected((s) => {
        const next = new Set(s);
        if (shift && lastToggled.current) {
          const a = threads.findIndex((y) => y.id === lastToggled.current);
          const b = threads.findIndex((y) => y.id === x.id);
          if (a >= 0 && b >= 0) {
            for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(threads[i].id);
            return next;
          }
        }
        if (next.has(x.id)) next.delete(x.id);
        else next.add(x.id);
        lastToggled.current = x.id;
        return next;
      });
    },
    [threads],
  );

  const move = (d: 1 | -1) => {
    const i = Math.max(0, Math.min(threads.length - 1, focusIdx + d));
    setFocusIdx(i);
    if (openId) open(threads[i]);
    if (d === 1 && i >= threads.length - 5 && list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage();
  };

  /** What a key acts on: the selection, else the open conversation, else the focused one. */
  const targets = (): MailThread[] => {
    if (selected.size) return threads.filter((x) => selected.has(x.id));
    if (openId) {
      const open = threads.find((x) => x.id === openId) ?? qc.getQueryData<{ thread: MailThread }>(qk.mailThread(openId))?.thread;
      return open ? [open] : [];
    }
    return threads[focusIdx] ? [threads[focusIdx]] : [];
  };

  // ── Actions ─────────────────────────────────────────────────────────────
  /**
   * Moved to a category: undo puts them back where they were, and when they are all from one
   * sender of an account the caller manages, Always makes it a rule for that sender's mail.
   */
  const categorized = useCallback(
    (items: MailThread[], key: string, name: string) => {
      const ids = items.map((x) => x.id);
      const before = new Set(items.map((x) => x.category ?? PRIMARY));
      const back = before.size === 1 ? [...before][0] : null;
      const undo = back
        ? () =>
            action.mutate(
              { ids, action: "categorize", category: back },
              { onSuccess: () => void qc.invalidateQueries({ queryKey: qk.mailThreadLists }), onError: (e) => toast.error(e, t("toast.failed")) },
            )
        : null;
      const acc = accountsById.get(items[0].account_id);
      const senders = new Set(items.map((x) => ruleSender(x.participants, ownEmails)));
      const sender = senders.size === 1 ? [...senders][0] : null;
      const msg = t("categories.moved", { count: ids.length, name });
      if (!acc?.can_manage || acc.categories.engine === "gmail" || !sender || items.some((x) => x.account_id !== acc.id)) {
        if (undo) toast.undo(msg, undo, t("toast.undo"));
        else toast.success(msg);
        return;
      }
      const always = () =>
        void api.collab.categories.addRule(acc.id, { sender, category: key }).then(
          () => {
            void qc.invalidateQueries({ queryKey: qk.mailCategoryRules(acc.id) });
            toast.success(t("categories.ruleSaved", { sender, name }));
          },
          (e) => toast.error(e, t("toast.failed")),
        );
      toast.success(msg, {
        description: t("categories.alwaysHint", { sender }),
        action: { label: t("categories.always"), onClick: always },
        cancel: undo ? { label: t("toast.undo"), onClick: undo } : undefined,
      });
    },
    [accountsById, ownEmails, action, qc, t],
  );

  const act = useCallback(
    (all: MailThread[], a: MailThreadAction, opts: ActOpts = {}) => {
      // Done and Needs action touch only conversations they change, so Undo puts back exactly those.
      const items = a === "done" ? all.filter((x) => x.needs_action || x.snoozed_until) : a === "needs_action" ? all.filter((x) => !x.needs_action) : all;
      if (!canAct || !items.length) return;
      const ids = items.map((x) => x.id);
      const place = listPlace(query, cachedFolders(qc));
      // The open conversation leaving the list: the next one opens (or the list comes back).
      if (openId && ids.includes(openId) && leavesList(a, place, opts.folderId, opts.category)) {
        const i = threads.findIndex((x) => x.id === openId);
        const rest = threads.filter((x) => !ids.includes(x.id));
        const next = rest[Math.min(Math.max(i, 0), rest.length - 1)];
        if (next) go(next.id, true, true);
        else close();
      }
      setSelected((s) => (s.size ? new Set() : s));
      action.mutate(
        { ids, action: a, folderId: opts.folderId, category: opts.category, until: opts.until },
        {
          onError: (e) => toast.error(e, t("toast.failed")),
        },
      );
      if (a === "categorize" && opts.category && !opts.silent) return categorized(items, opts.category, opts.label ?? "");
      const key = toastKey[a];
      if (opts.silent || !key) return;
      const msg = t(`toast.${key}`, { count: ids.length, folder: opts.label ?? "" });
      const back = UNDOABLE.has(a) ? inverseAction(a, place, opts.folderId) : null;
      if (back)
        toast.undo(
          msg,
          () =>
            action.mutate(
              { ids, action: back.action, folderId: back.folderId },
              { onSuccess: () => void qc.invalidateQueries({ queryKey: qk.mailThreadLists }), onError: (e) => toast.error(e, t("toast.failed")) },
            ),
          t("toast.undo"),
        );
      else toast.success(msg);
    },
    [canAct, query, qc, openId, threads, go, close, action, t, categorized],
  );

  // The rows' callbacks read the latest act through a ref: act changes on every render, and
  // a new callback would redraw every memoized row as the focus moves.
  const actRef = useRef(act);
  actRef.current = act;
  const onRowAction = useCallback(
    (x: MailThread, a: MailThreadAction) => actRef.current([x], a, { silent: a !== "archive" && a !== "trash" && a !== "done" && a !== "needs_action" }),
    [],
  );

  // ── AI drafts in place (Ready for review and Needs action, GH#430) ─────────
  // Send goes as saved; Edit opens the conversation with the draft in the composer;
  // Discard asks first, as the composer does, since the draft is deleted at the provider too.
  const draftsInRows = canAct && (box === "ai_review" || box === "needs_action");
  const [editAI, setEditAI] = useState<string | null>(null);
  // Only the conversation Edit opened takes the draft into its composer, once.
  useEffect(() => setEditAI((id) => (id && id !== openId ? null : id)), [openId]);
  const [draftBusy, setDraftBusy] = useState<Set<string>>(new Set());
  const busyDraft = useCallback((id: string, on: boolean) => setDraftBusy((s) => {
    const next = new Set(s);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  }), []);
  const onRowDraft = useCallback(
    (x: MailThread, a: AIDraftAction) => {
      const d = x.ai_draft;
      if (!d) return;
      if (a === "edit") {
        setEditAI(x.id);
        return open(x);
      }
      const run = (call: () => Promise<unknown>, done: () => void, failed: string) => {
        busyDraft(x.id, true);
        call().then(
          () => {
            busyDraft(x.id, false);
            void qc.invalidateQueries({ queryKey: qk.mailThreadLists });
            void qc.invalidateQueries({ queryKey: qk.mailThread(x.id) });
            void qc.invalidateQueries({ queryKey: qk.mailCounts });
            done();
          },
          (e) => {
            busyDraft(x.id, false);
            toast.error(e, failed);
          },
        );
      };
      if (a === "send") return run(() => api.collab.drafts.send(d.draft_id), () => toast.success(t("toast.sent", { email: accountsById.get(x.account_id)?.email ?? "" })), t("composer.sendFailed"));
      confirm.show(t("composer.discardDraftConfirm"), () => run(() => api.collab.drafts.remove(d.draft_id), () => undefined, t("composer.discardFailed")), {
        title: t("composer.discardDraftTitle"),
        confirmLabel: t("composer.discard"),
        danger: true,
      });
    },
    [open, qc, t, accountsById, confirm, busyDraft],
  );
  const onThreadAction = useCallback(
    (a: MailThreadAction, opts?: ActOpts) => {
      if (!openId) return;
      const x = threads.find((y) => y.id === openId) ?? qc.getQueryData<{ thread: MailThread }>(qk.mailThread(openId))?.thread;
      if (x) act([x], a, opts);
    },
    [openId, threads, qc, act],
  );

  const star = () => {
    const ts = targets();
    if (ts.length) act(ts, ts.every((x) => x.starred) ? "unstar" : "star", { silent: true });
  };
  const answer = (mode: ComposeMode) => {
    if (!canAct) return;
    if (openId) return threadRef.current?.reply(mode);
    const x = threads[focusIdx];
    if (!x) return;
    setIntent({ id: x.id, mode });
    open(x);
  };
  // What the pickers act on: the conversations a row's menu picked them for, else the selection, else the focused one.
  const [pickIds, setPickIds] = useState<string[] | null>(null);
  // Where that menu opened: its picker shows there.
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const pickTargets = () =>
    pickIds ? threads.filter((x) => pickIds.includes(x.id)) : selected.size ? threads.filter((x) => selected.has(x.id)) : threads[focusIdx] ? [threads[focusIdx]] : [];
  // Move and labels act within one account.
  const targetAccount = (() => {
    const ids = new Set(pickTargets().map((x) => x.account_id));
    return ids.size === 1 ? [...ids][0] : null;
  })();
  const targetFolders = targetAccount ? (folderMap[targetAccount] ?? []) : [];
  const targetProvider = targetAccount ? accountsById.get(targetAccount)?.provider : undefined;
  // Labels: Gmail labels and Outlook categories (IMAP has folders only); moving to a label is Gmail's.
  const targetLabels = !!targetProvider && targetProvider !== "imap";
  const moveFolders = targetProvider === "google" ? targetFolders : targetFolders.filter((f) => f.kind !== "label");
  const appliedLabels = (() => {
    const ts = pickTargets();
    if (!ts.length) return [];
    return targetFolders.filter((f) => f.kind === "label" && !f.role && ts.every((x) => x.folder_ids.includes(f.id))).map((f) => f.id);
  })();

  // ── Triage from the list: Handling, assignees, the row menu and drops (GH#455) ──
  /** Done, Needs action and Snooze are for shared accounts with Handling on (contracts/collab.md "Conversations"). */
  const handlingOn = useCallback(
    (x: MailThread) => {
      const a = accountsById.get(x.account_id);
      return !!a?.handling_enabled && a.visibility === "shared";
    },
    [accountsById],
  );
  const roles = useMemo(() => new Map(Object.values(folderMap).flatMap((fs) => (fs ?? []).map((f) => [f.id, f.role] as const))), [folderMap]);
  const inRole = (x: MailThread, role: string) => x.folder_ids.some((id) => roles.get(id) === role);
  const me = useSession((s) => s.user?.id);
  const assign = useAssignThreads();
  const assignFailed = (e: unknown) => toast.error(e, t("toast.failed"));
  const commonAssignees = (ts: MailThread[]) => (ts.length ? ts[0].assignees.map((a) => a.id).filter((id) => ts.every((x) => x.assignees.some((a) => a.id === id))) : []);
  /** The picker's choice for several conversations: who it added joins each, who it took off leaves each; the rest stay. */
  const setAssignees = (ts: MailThread[], ids: string[]) => {
    const before = commonAssignees(ts);
    const added = ids.filter((id) => !before.includes(id));
    const removed = before.filter((id) => !ids.includes(id));
    const changes = assignChanges(ts, (cur) => [...cur.filter((id) => !removed.includes(id)), ...added.filter((id) => !cur.includes(id))]);
    if (changes.length) assign.mutate(changes, { onError: assignFailed });
  };
  /** Dropped on Assigned to me: the member joins each conversation's assignees, with Undo. */
  const assignMe = (ts: MailThread[]) => {
    if (!me) return;
    const changes = assignChanges(ts, (cur) => (cur.includes(me) ? cur : [...cur, me]));
    if (!changes.length) return;
    assign.mutate(changes, {
      onError: assignFailed,
      onSuccess: () =>
        toast.undo(
          t("toast.assignedToYou", { count: changes.length }),
          () => assign.mutate(changes.map((c) => ({ id: c.id, before: c.ids, ids: c.before })), { onError: assignFailed }),
          t("toast.undo"),
        ),
    });
  };

  // A picker or dialog opened from the row menu keeps the focus the menu would give back to the row.
  const keepFocus = useRef(false);
  const onMenuCloseFocus = useCallback((e: Event) => {
    if (!keepFocus.current) return;
    keepFocus.current = false;
    e.preventDefault();
  }, []);
  const [assignOpen, setAssignOpen] = useState(false);
  const [shareId, setShareId] = useState<string | null>(null);
  const pickFor = (ts: MailThread[], open: () => void) => {
    keepFocus.current = true;
    setPickIds(ts.map((x) => x.id));
    open();
  };
  /** A picker closed: the next one acts on the selection or the focused conversation again. */
  const picked = (setOpen: (o: boolean) => void) => (o: boolean) => {
    setOpen(o);
    if (!o) {
      setPickIds(null);
      setAnchor(null);
    }
  };
  const href = useHref();
  const onPoint = useCallback((x: number, y: number) => setAnchor({ x, y }), []);

  /** The row menu: the selection when the row is in it, else the row alone. */
  const rowMenu = (row: MailThread) => {
    const ts = selected.has(row.id) ? threads.filter((x) => selected.has(x.id)) : [row];
    const one = ts.length === 1;
    const accs = new Set(ts.map((x) => x.account_id));
    const provider = accs.size === 1 ? accountsById.get(row.account_id)?.provider : undefined;
    const anyInbox = ts.some((x) => inRole(x, "inbox"));
    const allSpam = ts.every((x) => inRole(x, "spam"));
    const handling = ts.every(handlingOn);
    const item = (a: MailThreadAction, opts?: ActOpts) => () => act(ts, a, opts);
    const reply = (mode: ComposeMode) => () => {
      if (openId === row.id) return threadRef.current?.reply(mode);
      setIntent({ id: row.id, mode });
      open(row);
    };
    return (
      <>
        {!one && <ContextMenuLabel>{t("list.selected", { count: ts.length })}</ContextMenuLabel>}
        {canAct && one && (
          <>
            <ContextMenuItem icon={<Reply />} onSelect={reply("reply")}>
              {t("action.reply")}
            </ContextMenuItem>
            <ContextMenuItem icon={<ReplyAll />} onSelect={reply("reply_all")}>
              {t("action.replyAll")}
            </ContextMenuItem>
            <ContextMenuItem icon={<Forward />} onSelect={reply("forward")}>
              {t("action.forward")}
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        {canAct && (
          <>
            {(anyInbox || !allSpam) && (
              <ContextMenuItem icon={<Archive />} onSelect={item("archive")}>
                {t("action.archive")}
              </ContextMenuItem>
            )}
            {!anyInbox && (
              <ContextMenuItem icon={<Inbox />} onSelect={item("inbox")}>
                {t("action.inbox")}
              </ContextMenuItem>
            )}
            <ContextMenuItem icon={<Trash2 />} onSelect={item("trash")}>
              {t("action.trash")}
            </ContextMenuItem>
            {allSpam ? (
              <ContextMenuItem icon={<ShieldCheck />} onSelect={item("not_spam")}>
                {t("action.notSpam")}
              </ContextMenuItem>
            ) : (
              <ContextMenuItem icon={<ShieldAlert />} onSelect={item("spam")}>
                {t("action.spam")}
              </ContextMenuItem>
            )}
            <ContextMenuSeparator />
            {ts.some((x) => x.unread) ? (
              <ContextMenuItem icon={<MailOpen />} onSelect={item("read", { silent: true })}>
                {t("action.read")}
              </ContextMenuItem>
            ) : (
              <ContextMenuItem icon={<Mail />} onSelect={item("unread", { silent: true })}>
                {t("action.unread")}
              </ContextMenuItem>
            )}
            {ts.every((x) => x.starred) ? (
              <ContextMenuItem icon={<Star />} onSelect={item("unstar", { silent: true })}>
                {t("action.unstar")}
              </ContextMenuItem>
            ) : (
              <ContextMenuItem icon={<Star />} onSelect={item("star", { silent: true })}>
                {t("action.star")}
              </ContextMenuItem>
            )}
            {handling && (
              <>
                {ts.every((x) => x.needs_action) ? (
                  <ContextMenuItem icon={<CircleCheck />} onSelect={item("done")}>
                    {t("action.done")}
                  </ContextMenuItem>
                ) : (
                  <ContextMenuItem icon={<CircleDot />} onSelect={item("needs_action")}>
                    {t("action.needsAction")}
                  </ContextMenuItem>
                )}
                <ContextMenuSub label={t("action.snooze")} icon={<AlarmClock />}>
                  <SnoozeItems onSnooze={(at) => act(ts, "snooze", { until: at.toISOString() })} />
                </ContextMenuSub>
              </>
            )}
            <ContextMenuSeparator />
            <ContextMenuItem icon={<UserPlus />} onSelect={() => pickFor(ts, () => setAssignOpen(true))}>
              {t("action.assignTo")}
            </ContextMenuItem>
            {one && (
              <ContextMenuItem
                icon={<Users />}
                onSelect={() => {
                  keepFocus.current = true;
                  setShareId(row.id);
                }}
              >
                {t("action.shareWith")}
              </ContextMenuItem>
            )}
            {provider && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem icon={<Folder />} onSelect={() => pickFor(ts, () => setPickMove(true))}>
                  {t("action.moveTo")}
                </ContextMenuItem>
                {provider !== "imap" && (
                  <ContextMenuItem icon={<Tag />} onSelect={() => pickFor(ts, () => setPickLabels(true))}>
                    {t("action.labelAs")}
                  </ContextMenuItem>
                )}
              </>
            )}
          </>
        )}
        {one && (
          <>
            {canAct && <ContextMenuSeparator />}
            <ContextMenuItem icon={<ExternalLink />} onSelect={() => openInNewTab(href({ to: "/mail/$box/{-$threadId}", params: { box, threadId: row.id }, search: (prev: MailSearch) => prev }))}>
              {t("action.newTab")}
            </ContextMenuItem>
          </>
        )}
      </>
    );
  };

  // The rows get one callback for the life of the page, reading the latest menu when it opens,
  // so moving the focus does not redraw every row (ThreadRow is memoized).
  const rowMenuRef = useRef(rowMenu);
  rowMenuRef.current = rowMenu;
  const renderRowMenu = useCallback((row: MailThread) => rowMenuRef.current(row), []);

  // The context-menu key and Shift+F10 open the focused conversation's menu where it is.
  const menuKeyAt = useRef(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !(e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey))) return;
      const el = e.target as Element | null;
      if (isTypingTarget(el) || (el && el !== document.body && !listRef.current?.contains(el))) return;
      const id = threads[focusIdx]?.id;
      const row = id ? listRef.current?.querySelector<HTMLElement>(`[data-thread-id="${id}"]`) : null;
      if (!row) return;
      e.preventDefault();
      menuKeyAt.current = Date.now();
      const r = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + Math.min(64, r.width / 2), clientY: r.top + r.height / 2 }));
    };
    // The browser's own menu that the key also opens stays shut.
    const onMenu = (e: MouseEvent) => {
      if (e.isTrusted && Date.now() - menuKeyAt.current < 600) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("contextmenu", onMenu, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("contextmenu", onMenu, true);
    };
  }, [threads, focusIdx]);

  /** Dragging a row: the selection when the row is in it, else the row alone. */
  const onDragOut = useCallback(
    (x: MailThread, e: DragEvent) => {
      const ids = selected.has(x.id) ? threads.filter((y) => selected.has(y.id)).map((y) => y.id) : [x.id];
      startThreadDrag(e, ids, t("list.dragging", { count: ids.length }));
    },
    [selected, threads, t],
  );

  /** Conversations dropped on a sidebar row or a tab (lib/collab/threadDrag.ts): what that row's button or key would do. */
  const dropRef = useRef<(ids: string[], to: ThreadDropTarget) => void>(() => {});
  dropRef.current = (ids, to) => {
    const items = threads.filter((x) => ids.includes(x.id));
    if (!items.length) return;
    const folderTo = to.box === "folder" && to.folder ? Object.values(folderMap).flatMap((fs) => fs ?? []).find((f) => f.id === to.folder) : undefined;
    const accountId = folderTo?.account_id ?? to.account;
    const its = accountId ? items.filter((x) => x.account_id === accountId) : items;
    if (!its.length) return void toast.error(t("drop.otherAccount"));
    if (to.box === "folder") {
      if (!folderTo) return;
      const box = boxForRole(folderTo.role);
      if (box) return dropRef.current(ids, { box, account: folderTo.account_id });
      const provider = accountsById.get(folderTo.account_id)?.provider;
      // Gmail moves to a label as to a folder; an Outlook category is a label only.
      if (folderTo.kind === "label" && provider !== "google") return act(its, "label", { folderId: folderTo.id, label: folderTo.name });
      return act(its, "move", { folderId: folderTo.id, label: folderTo.name });
    }
    switch (to.box) {
      case "inbox":
      case "archive":
      case "spam":
      case "trash":
        return act(its, to.box);
      case "starred": {
        // Only those it stars, so Undo unstars exactly those.
        const ok = its.filter((x) => !x.starred);
        return ok.length ? act(ok, "star") : undefined;
      }
      case "needs_action": {
        const ok = its.filter(handlingOn);
        if (!ok.length) return void toast.error(t("drop.noHandling"));
        return act(ok, "needs_action");
      }
      case "assigned":
        return assignMe(its);
    }
  };
  useEffect(() => (canAct ? takeThreadDrops((ids, to) => dropRef.current(ids, to)) : undefined), [canAct]);

  useShortcuts({
    "mail.next": () => move(1),
    "mail.previous": () => move(-1),
    // With a conversation open, the arrows and Enter are its own: they scroll it and press its buttons.
    ...(openId
      ? {}
      : {
          "mail.down": () => move(1),
          "mail.up": () => move(-1),
          "mail.enter": () => open(threads[focusIdx]),
        }),
    "mail.open": () => open(threads[focusIdx]),
    "mail.select": () => threads[focusIdx] && toggle(threads[focusIdx], false),
    "mail.archive": () => act(targets(), "archive"),
    "mail.trash": () => act(targets(), "trash"),
    "mail.spam": () => act(targets(), "spam"),
    "mail.star": () => star(),
    "mail.unread": () => act(targets(), "unread", { silent: true }),
    "mail.read": () => act(targets(), "read", { silent: true }),
    "mail.move": () => (openId && !selected.size ? threadRef.current?.move() : canAct && targetAccount && setPickMove(true)),
    "mail.label": () => (openId && !selected.size ? threadRef.current?.labels() : canAct && targetLabels && setPickLabels(true)),
    "mail.reply": () => answer("reply"),
    "mail.replyAll": () => answer("reply_all"),
    "mail.forward": () => answer("forward"),
    "global.new": () => compose.open({ accountId: account?.id ?? folderAccount?.id }),
    "mail.comment": () => openId && threadRef.current?.comment(),
    "mail.people": () => openId && threadRef.current?.people(),
    "mail.search": () => searchRef.current?.focus(),
    "mail.escape": () => {
      if (selected.size) setSelected(new Set());
      else if (openId) close();
    },
    "mail.selectAll": () => !openId && setSelected(new Set(threads.map((x) => x.id))),
  });

  // Infinite scroll.
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => {
      if (e[0]?.isIntersecting && list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [list]);

  const prefetch = useCallback((x: MailThread) => void qc.prefetchQuery(q.mailThread(x.id)), [qc]);
  useEffect(() => {
    [focusIdx, focusIdx + 1].forEach((i) => threads[i] && prefetch(threads[i]));
  }, [focusIdx, threads, prefetch]);

  const selecting = selected.size > 0;
  const selectedThreads = selecting ? threads.filter((x) => selected.has(x.id)) : [];
  const selectionHandling = selecting && selectedThreads.every(handlingOn);
  const idx = threads.findIndex((x) => x.id === openId);
  const phone = usePhone();
  const split = !!openId;
  const compact = split || phone;
  const noAccounts = accounts && accounts.length === 0;

  // Off the inbox's tabs (a search, another box), a conversation sorted out of Primary says where to.
  const categoryOf = (x: MailThread) => (x.category && x.category !== PRIMARY ? accountCategories(accountsById.get(x.account_id)).find((c) => c.key === x.category) : undefined);
  // Each row's labels kept between renders while nothing they come from changes, so the row's memo holds.
  const rowLabels = useMemo(() => {
    const out = new Map<string, MailFolder[]>();
    for (const x of threads) {
      const fs = folderMap[x.account_id]?.filter((f) => f.kind === "label" && !f.role && f.id !== search.folder && x.folder_ids.includes(f.id));
      if (fs?.length) out.set(x.id, fs);
    }
    return out;
  }, [threads, folderMap, search.folder]);
  const labelsFor = (x: MailThread): MailFolder[] => rowLabels.get(x.id) ?? NO_LABELS;

  const empty = (() => {
    if (search.q)
      return (
        <EmptyState
          art="search"
          title={t("list.empty.search")}
          description={t("list.empty.searchHint")}
          action={
            <Button variant="secondary" onClick={() => setQuery("")}>
              {t("list.empty.clearSearch")}
            </Button>
          }
        />
      );
    if (box === "inbox" && !folder) return <EmptyState art="solved" title={t("list.empty.inbox")} description={t("list.empty.inboxHint")} />;
    if (box === "shared") return <EmptyState art="inbox" title={t("list.empty.shared")} description={t("list.empty.sharedHint")} />;
    if (box === "assigned") return <EmptyState art="mine" title={t("list.empty.assigned")} description={t("list.empty.assignedHint")} />;
    if (box === "ai_review") return <EmptyState art="solved" title={t("list.empty.aiReview")} description={t("list.empty.aiReviewHint")} />;
    if (box === "starred") return <EmptyState art="generic" title={t("list.empty.starred")} description={t("list.empty.starredHint")} tips={[{ label: t("shortcuts.star"), kbd: "s" }]} />;
    return <EmptyState art="generic" title={t("list.empty.generic")} description={t("list.empty.genericHint")} />;
  })();

  const titleIcon = folder ? <FolderGlyph folder={folder} /> : account ? <AccountDot color={account.color} className="size-2.5" /> : isMailBox(box) ? boxIcon[box] : <Mail />;

  return (
    <div className="relative flex h-full min-h-0">
      <section
        aria-label={title}
        className={cn("relative flex min-h-0 flex-col", split ? "hidden w-[340px] shrink-0 border-r border-line lg:flex xl:w-[380px] 2xl:w-[420px]" : "min-w-0 flex-1")}
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
          <span className="flex size-4 shrink-0 items-center justify-center text-fg-3 [&_svg]:size-4">{titleIcon}</span>
          <h1 className="min-w-0 truncate text-[13.5px] font-semibold tracking-[-0.015em]">{title}</h1>
          {!!count && <span className="mono shrink-0 text-[11px] tabular-nums text-fg-4">{count}</span>}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {!compact && (
              <SearchInput
                inputRef={searchRef}
                value={q2}
                onChange={(v) => {
                  setQ2(v);
                  if (!v) setQuery("");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") setQuery(q2);
                  if (e.key === "Escape") searchRef.current?.blur();
                }}
                placeholder={t("list.search")}
                className="w-[220px]"
              />
            )}
            {account && (
              <Tooltip content={t("list.refresh")}>
                <Button
                  size="sm"
                  variant="ghost"
                  square
                  aria-label={t("list.refresh")}
                  icon={<RefreshCw />}
                  onClick={() =>
                    void api.collab.accounts.sync(account.id).then(
                      () => toast.info(t("toast.syncing", { name: accountName(account) })),
                      (e) => toast.error(e),
                    )
                  }
                />
              </Tooltip>
            )}
            {canAct && !noAccounts && (
              <Tooltip content={t("list.compose")} shortcut="c">
                <Button size="sm" variant={compact ? "ghost" : "secondary"} square={compact} icon={<PenSquare />} onClick={() => compose.open({ accountId: account?.id ?? folderAccount?.id })} aria-label={t("list.compose")}>
                  {compact ? null : t("list.compose")}
                </Button>
              </Tooltip>
            )}
          </div>
        </div>
        {!noAccounts && accounts && box !== "shared" && box !== "assigned" && (
          <FolderBar
            box={box}
            account={account}
            folder={folder}
            accounts={accounts}
            folderMap={folderMap}
            counts={counts}
            prefs={prefs}
          />
        )}
        {tabs.length > 0 && category && <CategoryTabs tabs={tabs} active={category} search={search} settings={settingsTarget} />}
        {offer && <CategoryOffer account={offer} />}
        {!noAccounts && <StorageFullBanner />}
        {(box === "needs_action" || box === "ai_review") && accounts && <SpamBesideWork accounts={account ? [account] : accounts} counts={counts} />}
        {search.q && !noAccounts && <SearchCoverage accounts={scopeAccount ? [scopeAccount] : (accounts ?? [])} />}
        {(addresses.length > 1 || search.to) && (
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line-soft px-4 text-[11.5px] text-fg-3">
            <AtSign className="size-3.5 shrink-0 text-fg-4" />
            <span className="shrink-0">{t("list.writtenTo")}</span>
            {addresses.length > 1 ? (
              <Select
                size="sm"
                value={search.to ?? "*"}
                onChange={(v) => setTo(v === "*" ? "" : v)}
                aria-label={t("list.writtenTo")}
                className="h-7 max-w-[280px] border-transparent px-1.5 shadow-none hover:border-line"
                options={[
                  { value: "*", label: t("list.anyAddress") },
                  ...addresses.map((i) => {
                    const n = scopeAccount ? addressNumbers(scopeAccount.id, i.email, counts).unread : undefined;
                    return { value: i.email, label: i.email, hint: n || undefined };
                  }),
                ]}
              />
            ) : (
              <span className="mono min-w-0 truncate text-fg-2">{search.to}</span>
            )}
            {search.to && (
              <Button size="sm" variant="ghost" icon={<X />} onClick={() => setTo("")} className="ml-auto">
                {t("list.anyAddress")}
              </Button>
            )}
          </div>
        )}
        {search.with && (
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line-soft px-4 text-[11.5px] text-fg-3">
            <UserRound className="size-3.5 shrink-0 text-fg-4" />
            <span className="shrink-0">{t("list.with")}</span>
            <span className="mono min-w-0 truncate text-fg-2" data-ph-mask>
              {search.with}
            </span>
            <Button size="sm" variant="ghost" icon={<X />} onClick={() => go(undefined, { ...search, with: undefined }, true)} className="ml-auto">
              {t("list.anyone")}
            </Button>
          </div>
        )}
        {compact && (
          <div className="border-b border-line-soft px-3 py-2">
            <SearchInput
              inputRef={searchRef}
              value={q2}
              onChange={(v) => {
                setQ2(v);
                if (!v) setQuery("");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") setQuery(q2);
                if (e.key === "Escape") searchRef.current?.blur();
              }}
              placeholder={t("list.search")}
            />
          </div>
        )}

        {/* The pickers m, l and the row menu open: by the list's title, or where the menu was. */}
        {canAct && (targetAccount || assignOpen) && (
          <div
            className={cn("pointer-events-none h-0 w-0", pickIds && anchor ? "fixed z-10" : "absolute left-4 top-12")}
            style={pickIds && anchor ? { left: anchor.x, top: anchor.y } : undefined}
          >
            {targetAccount && (
              <MovePicker
                accountId={targetAccount}
                folders={moveFolders}
                categories={accountCategories(accountsById.get(targetAccount))}
                current={category}
                open={pickMove}
                onOpenChange={picked(setPickMove)}
                onMove={(m: MoveTarget) => act(pickTargets(), m.action, { folderId: m.folderId, category: m.category, label: m.label })}
                trigger={<span aria-hidden className="block h-0 w-0" />}
              />
            )}
            {targetAccount && targetLabels && (
              <LabelsPicker
                accountId={targetAccount}
                folders={targetFolders}
                applied={appliedLabels}
                open={pickLabels}
                onOpenChange={picked(setPickLabels)}
                onToggle={(id, on) => act(pickTargets(), on ? "label" : "unlabel", { folderId: id, silent: true })}
                trigger={<span aria-hidden className="block h-0 w-0" />}
              />
            )}
            {assignOpen && (
              <AssignPicker
                align="start"
                value={commonAssignees(pickTargets())}
                onChange={(ids) => setAssignees(pickTargets(), ids)}
                open
                onOpenChange={picked(setAssignOpen)}
                trigger={<span aria-hidden className="block h-0 w-0" />}
              />
            )}
          </div>
        )}
        {shareId && <ListShareDialog threadId={shareId} onClose={() => setShareId(null)} />}

        <div ref={listRef} role="listbox" aria-label={t("list.label")} aria-multiselectable className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {noAccounts ? (
            <EmptyState
              art="inbox"
              title={t("list.noAccounts.title")}
              description={t("list.noAccounts.description")}
              action={
                <Button variant="primary" onClick={() => void navigate({ to: "/settings/mail-accounts", search: {} })}>
                  {t("list.noAccounts.action")}
                </Button>
              }
              tips={[{ label: t("list.noAccounts.tipPrivate") }, { label: t("list.noAccounts.tipMirror") }]}
            />
          ) : list.isPending ? (
            <SkeletonRows rows={compact ? 7 : 12} />
          ) : list.isError ? (
            <EmptyState lit={3} title={t("list.error.title")} description={t("list.error.description")} action={<Button onClick={() => void list.refetch()}>{t("list.error.retry")}</Button>} />
          ) : !threads.length ? (
            empty
          ) : (
            <div className="relative shrink-0">
              <AnimatePresence initial={false} key={listKey}>
                {threads.map((x, i) => {
                  const acc = accountsById.get(x.account_id);
                  return (
                    <ThreadRow
                      key={x.id}
                      thread={x}
                      active={x.id === openId}
                      focused={i === focusIdx}
                      selected={selected.has(x.id)}
                      selecting={selecting}
                      compact={compact}
                      accountColor={spans ? acc?.color : undefined}
                      accountName={acc ? accountName(acc) : undefined}
                      labels={labelsFor(x)}
                      category={category ? undefined : categoryOf(x)}
                      ownEmails={ownEmails}
                      onOpen={open}
                      onToggle={toggle}
                      onHover={prefetch}
                      onAction={canAct ? onRowAction : undefined}
                      handling={handlingOn(x)}
                      onDragOut={canAct ? onDragOut : undefined}
                      onDraft={draftsInRows ? onRowDraft : undefined}
                      draftBusy={draftBusy.has(x.id)}
                      menu={renderRowMenu}
                      onMenuPoint={onPoint}
                      onMenuCloseFocus={onMenuCloseFocus}
                    />
                  );
                })}
              </AnimatePresence>
            </div>
          )}
          {threads.length > 0 && (
            <div ref={sentinel} className="shrink-0">
              {list.isFetchingNextPage ? <SkeletonRows rows={2} /> : <div className="h-14" />}
            </div>
          )}
        </div>

        {selecting && canAct && (
          <div className="absolute inset-x-3 bottom-3 z-10 flex items-center gap-0.5 rounded-lg border border-line bg-raised px-2 py-1 shadow-float animate-rise-in motion-reduce:animate-none">
            <span className="mono px-1.5 text-[11.5px] tabular-nums text-fg-2">{t("list.selected", { count: selected.size })}</span>
            <span aria-hidden className="mx-1 h-4 w-px bg-line" />
            <BulkButton label={t("action.archive")} shortcut="e" onClick={() => act(targets(), "archive")}>
              <Archive />
            </BulkButton>
            <BulkButton label={t("action.trash")} shortcut="#" onClick={() => act(targets(), "trash")}>
              <Trash2 />
            </BulkButton>
            <BulkButton label={t("action.spam")} shortcut="!" onClick={() => act(targets(), "spam")}>
              <ShieldAlert />
            </BulkButton>
            <BulkButton label={t("action.read")} shortcut="shift i" onClick={() => act(targets(), "read", { silent: true })}>
              <MailOpen />
            </BulkButton>
            <BulkButton label={t("action.unread")} shortcut="shift u" onClick={() => act(targets(), "unread", { silent: true })}>
              <Mail />
            </BulkButton>
            <BulkButton label={t("action.star")} shortcut="s" onClick={star}>
              <Star />
            </BulkButton>
            {selectionHandling && (
              <>
                <span aria-hidden className="mx-1 h-4 w-px bg-line" />
                {selectedThreads.every((x) => x.needs_action) ? (
                  <BulkButton label={t("action.done")} onClick={() => act(targets(), "done")}>
                    <CircleCheck />
                  </BulkButton>
                ) : (
                  <BulkButton label={t("action.needsAction")} onClick={() => act(targets(), "needs_action")}>
                    <CircleDot />
                  </BulkButton>
                )}
                <SnoozeMenu onSnooze={(at) => act(targets(), "snooze", { until: at.toISOString() })} />
              </>
            )}
            <AssignPicker
              align="start"
              value={commonAssignees(selectedThreads)}
              onChange={(ids) => setAssignees(selectedThreads, ids)}
              trigger={
                <span className="flex">
                  <BulkButton label={t("action.assignTo")}>
                    <UserPlus />
                  </BulkButton>
                </span>
              }
            />
            <span aria-hidden className="mx-1 h-4 w-px bg-line" />
            {targetAccount && (
              <BulkButton label={t("action.move")} shortcut="m" onClick={() => setPickMove(true)}>
                <Folder />
              </BulkButton>
            )}
            {targetLabels && (
              <BulkButton label={t("action.label")} shortcut="l" onClick={() => setPickLabels(true)}>
                <Tag />
              </BulkButton>
            )}
            <span className="flex-1" />
            <BulkButton label={t("list.clear")} shortcut="escape" onClick={() => setSelected(new Set())}>
              <X />
            </BulkButton>
          </div>
        )}
      </section>

      {openId && (
        <section aria-label={t("thread.label")} className="flex min-w-0 flex-1 flex-col">
          <ThreadView
            key={openId}
            ref={threadRef}
            threadId={openId}
            onClose={close}
            onPrev={idx > 0 ? () => open(threads[idx - 1]) : undefined}
            onNext={idx >= 0 && idx < threads.length - 1 ? () => open(threads[idx + 1]) : undefined}
            position={idx >= 0 ? { index: idx + 1, total: threads.length } : undefined}
            onAction={onThreadAction}
            markReadOnOpen={prefs.mark_read_on_open}
            intent={intent?.id === openId ? intent.mode : null}
            openDraft={box === "drafts" || editAI === openId}
            onOpenThread={(id) => go(id)}
            onShowPerson={(email) =>
              void navigate({ to: "/mail/$box/{-$threadId}", params: { box: "all", threadId: openId }, search: { with: email } })
            }
          />
        </section>
      )}
    </div>
  );
}

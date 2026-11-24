// Inbox categories above the mail list (contracts/collab.md "Categories"): the tabs of
// an inbox that is split, and, while none in view is, a quiet offer to split one. A
// conversation dragged from the list onto a tab moves to its category (lib/collab/threadDrag.ts).
// Whoever may change the set the tabs show reorders them by dragging a tab along the row, or with
// the keys that move a sidebar row, sideways (mod+Shift+Left and Right); Primary stays first (useCategoryReorder, useTabDrag.ts).

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { SlidersHorizontal, X } from "lucide-react";
import { motion, type MotionValue } from "motion/react";
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api/endpoints";
import type { MailAccount, MailCategory, MailCategorySettings } from "@/lib/api/types";
import type { MailSearch } from "@/lib/collab/boxes";
import { categoryOrderSet, categoryTone, inKeyOrder, moveCategory, PRIMARY, showsOrderSet, type CategoryOrderSet, type CategoryTab } from "@/lib/collab/categories";
import { storeAccount } from "@/lib/collab/hooks";
import { cn } from "@/lib/cn";
import { dropOverCls, useThreadDrop } from "@/lib/collab/threadDrag";
import { keyName } from "@/lib/hotkeys";
import { springs } from "@/lib/motion";
import { qk } from "@/lib/queries";
import { bindingOf, useShortcutLabel } from "@/lib/shortcuts";
import { atLeast, useRole, useSession } from "@/lib/session";
import { AI_TONE, tone } from "@/lib/tones";
import { OllieMark } from "@/components/assistant/OllieMark";
import { Button } from "@/components/ui/button";
import { modKey } from "@/components/ui/kbd";
import { toast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { useCategoriesSaved } from "./CategoryEditor";
import { CategorySetupDialog } from "./CategorySetup";
import { useTabDrag } from "./useTabDrag";

/** Saves the tabs in a new order (their keys, Primary first); none when the caller cannot reorder them. */
export type CategoryReorder = (keys: string[]) => Promise<unknown>;

/**
 * The tabs of the inbox in view; Primary carries no search key, so it is the inbox's plain link.
 * With `reorder`, every tab but Primary moves along the row.
 */
export function CategoryTabs({
  tabs,
  active,
  search,
  settings,
  reorder,
}: {
  tabs: CategoryTab[];
  active: string;
  search: MailSearch;
  settings: MailAccount | "workspace" | null;
  reorder?: CategoryReorder | null;
}) {
  const { t } = useTranslation("collab");
  const hint = useId();
  const [said, setSaid] = useState("");
  const byKey = new Map(tabs.map((c) => [c.key, c]));
  const drag = useTabDrag({ keys: tabs.map((c) => c.key), fixed: 1, onDrop: (keys) => reorder?.(keys) ?? Promise.resolve() });
  const shown = reorder ? drag.order.flatMap((k) => byKey.get(k) ?? []) : tabs;
  const move = drag.reduce ? false : ("position" as const);

  // The sidebar's own keys for moving a row, sideways (mail.tabLeft and mail.tabRight, which people may rebind).
  const leftKeys = useShortcutLabel("mail.tabLeft");
  const rightKeys = useShortcutLabel("mail.tabRight");
  const step = (e: KeyboardEvent, key: string) => {
    const name = keyName(e.nativeEvent);
    const dir = name === bindingOf("mail.tabLeft") ? -1 : name === bindingOf("mail.tabRight") ? 1 : 0;
    if (!reorder || !dir) return;
    e.preventDefault();
    const next = moveCategory(shown.map((c) => c.key), key, dir);
    if (!next) return;
    drag.save(next);
    setSaid(t("categories.reorder.moved", { name: byKey.get(key)?.name ?? key, position: next.indexOf(key) + 1, count: next.length }));
    // The tab keeps the focus in its new place.
    const tab = e.currentTarget.querySelector<HTMLElement>("a");
    requestAnimationFrame(() => tab?.focus());
  };
  const keys = (label: string) => label.replace("mod", modKey());

  return (
    <nav aria-label={t("categories.tabs")} className="relative flex h-10 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line-soft px-3 [scrollbar-width:none]">
      {shown.map((c) => {
        const movable = !!reorder && c.key !== PRIMARY;
        const dragged = drag.dragging === c.key;
        return (
          <motion.div
            key={c.key}
            ref={drag.slot(c.key)}
            layout={dragged ? false : move}
            transition={springs.row}
            style={dragged ? { x: drag.x as MotionValue<number> } : undefined}
            data-category-tab={c.key}
            className={cn("relative shrink-0", dragged && "z-10")}
            {...(movable ? drag.pressable(c.key) : {})}
            onKeyDown={movable ? (e) => step(e, c.key) : undefined}
          >
            <CategoryTabLink tab={c} on={c.key === active} search={search} lifted={dragged} describedBy={movable ? hint : undefined} />
          </motion.div>
        );
      })}
      {reorder && (
        <>
          <span id={hint} hidden>
            {leftKeys && rightKeys ? t("categories.reorder.hint", { left: keys(leftKeys), right: keys(rightKeys) }) : t("categories.reorder.hintDrag")}
          </span>
          <span role="status" aria-live="polite" className="sr-only">
            {said}
          </span>
        </>
      )}
      {settings && (
        <Tooltip content={t("categories.settings")}>
          {settings === "workspace" ? (
            <Link to="/settings/mail-categories" aria-label={t("categories.settings")} className={gearCls}>
              <SlidersHorizontal />
            </Link>
          ) : (
            <Link to="/settings/mail-accounts/$accountId" params={{ accountId: settings.id }} hash="categories" aria-label={t("categories.settings")} className={gearCls}>
              <SlidersHorizontal />
            </Link>
          )}
        </Tooltip>
      )}
    </nav>
  );
}

/**
 * One tab; conversations dragged from the list drop on it, except on the tab in view, where they already are. Those whose
 * account lacks its category (an inbox spanning accounts shows every account's categories) cannot: the tab says why.
 */
function CategoryTabLink({ tab: c, on, search, lifted, describedBy }: { tab: CategoryTab; on: boolean; search: MailSearch; lifted: boolean; describedBy?: string }) {
  const { t } = useTranslation("collab");
  const drop = useThreadDrop(on ? null : { box: "inbox", category: c.key });
  const ref = useRef<HTMLAnchorElement>(null);
  return (
    <>
      <Link
        {...drop.props}
        ref={ref}
        to="/mail/$box/{-$threadId}"
        params={{ box: "inbox", threadId: undefined }}
        search={{ ...search, category: c.key === PRIMARY ? undefined : c.key }}
        aria-current={on ? "page" : undefined}
        aria-describedby={describedBy}
        title={c.description || undefined}
        className={cn(
          "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] outline-none transition-[background-color,color,box-shadow] duration-100 focus-visible:shadow-[0_0_0_2px_var(--focus)] motion-reduce:transition-none",
          on ? "bg-active font-medium text-fg" : "text-fg-3 hover:bg-hover hover:text-fg-2",
          drop.over && cn(dropOverCls, "text-fg"),
          lifted && "bg-surface text-fg shadow-[0_0_0_1px_var(--line),0_2px_8px_rgb(0_0_0/0.08)]",
        )}
      >
        <span aria-hidden className={cn("size-2 shrink-0 rounded-full", tone[categoryTone(c)].solid)} />
        <span className="max-w-[160px] truncate">{c.name}</span>
        {c.unread > 0 && <span className={cn("mono rounded-sm px-1 text-[10.5px] tabular-nums", on ? "text-fg-3" : tone[categoryTone(c)].chip)}>{c.unread > 999 ? "999+" : c.unread}</span>}
      </Link>
      {drop.refused > 0 && <DropRefused anchor={ref} text={t("categories.dropRefused", { count: drop.refused, name: c.name })} />}
    </>
  );
}

/** Why a tab does not take the conversations over it, under the tab as its tooltip would show (the row scrolls, so it is not inside it). */
function DropRefused({ anchor, text }: { anchor: RefObject<HTMLElement | null>; text: string }) {
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const r = anchor.current?.getBoundingClientRect();
    setAt(r ? { left: r.left + r.width / 2, top: r.bottom + 6 } : null);
  }, [anchor]);
  if (!at) return null;
  return createPortal(
    <div
      role="status"
      style={{ left: at.left, top: at.top }}
      className="pointer-events-none fixed z-[60] max-w-[260px] -translate-x-1/2 animate-fade-in rounded-md bg-inverse px-2 py-1 text-center text-xs font-medium text-inverse-fg shadow-pop motion-reduce:animate-none"
    >
      {text}
    </div>,
    document.body,
  );
}

const gearCls =
  "ml-auto flex size-7 shrink-0 items-center justify-center rounded-md text-fg-4 outline-none transition-colors hover:bg-hover hover:text-fg-2 focus-visible:shadow-[0_0_0_2px_var(--focus)] [&_svg]:size-3.5";

/** Where the tabs' settings live for the caller: the one account in view they manage, else the workspace's for an admin. */
export function useCategorySettingsTarget(accounts: MailAccount[]): MailAccount | "workspace" | null {
  const admin = atLeast(useRole(), "admin");
  const own = accounts.filter((a) => a.can_manage);
  if (accounts.length === 1 && own.length === 1) return own[0];
  if (admin) return "workspace";
  return own.length === 1 ? own[0] : null;
}

type Reorder = { set: CategoryOrderSet; categories: MailCategory[] };
type Snapshot = { key: readonly unknown[]; data: unknown }[];

/**
 * Saves a new order of the tabs as the settings behind their gear would (categoryOrderSet), through the
 * same endpoint: the account's own categories (custom, as choosing Custom in its settings does), the
 * workspace default or a team's set. Every account showing that set takes the order at once and goes
 * back if the save fails; other viewers get it through the accounts' own events. Null when the caller
 * cannot change the set the tabs show, so the tabs do not move.
 */
export function useCategoryReorder(accounts: MailAccount[], target: MailAccount | "workspace" | null): CategoryReorder | null {
  const { t } = useTranslation("collab");
  const qc = useQueryClient();
  const saved = useCategoriesSaved();
  const write = atLeast(useRole(), "agent");
  const save = useMutation({
    // The settings page's own saves; the workspace's lock is left as it is.
    mutationFn: async ({ set, categories }: Reorder): Promise<MailAccount | MailCategorySettings> => {
      if (set.kind === "account") return api.collab.categories.setAccount(set.account.id, { mode: "custom", categories });
      if (set.kind === "team") return api.collab.categories.setTeam(set.team, { enabled: true, categories });
      return api.collab.categories.setWorkspace({ enabled: true, categories });
    },
    onMutate: async ({ set, categories }: Reorder) => {
      const keys = [qk.mailAccounts, qk.mailAccountsManage, qk.mailCategories];
      await Promise.all(keys.map((queryKey) => qc.cancelQueries({ queryKey })));
      const before: Snapshot = keys.map((key) => ({ key, data: qc.getQueryData(key) }));
      const order = categories.map((c) => c.key);
      const ordered = (a: MailAccount): MailAccount => {
        if (!showsOrderSet(a, set)) return a;
        const c = { ...a.categories, categories: inKeyOrder(a.categories.categories, order) ?? a.categories.categories };
        return { ...a, categories: set.kind === "account" ? { ...c, mode: "custom", source: "account", team: null, own: categories } : c };
      };
      for (const key of [qk.mailAccounts, qk.mailAccountsManage]) qc.setQueryData<MailAccount[]>(key, (list) => list?.map(ordered));
      if (set.kind !== "account")
        qc.setQueryData<MailCategorySettings>(qk.mailCategories, (s) =>
          !s ? s : set.kind === "workspace" ? { ...s, workspace: s.workspace && { ...s.workspace, categories } } : { ...s, teams: s.teams.map((x) => (x.team_id === set.team ? { ...x, categories } : x)) },
        );
      return before;
    },
    onError: (e, _v, before) => {
      for (const { key, data } of before ?? []) qc.setQueryData(key, data);
      toast.error(e, t("categories.reorder.failed"));
    },
    onSuccess: (out) => {
      if ("id" in out) {
        storeAccount(qc, out);
        saved();
      } else saved(out);
    },
  });
  const set = write ? categoryOrderSet(accounts, target) : null;
  if (!set) return null;
  return (keys) => {
    const categories = inKeyOrder(set.categories, keys);
    return categories ? save.mutateAsync({ set, categories }).catch(() => undefined) : Promise.resolve();
  };
}

/** An account that could be split and never was: no default reaches it and its owner has not chosen. */
export const canOfferCategories = (a: MailAccount) => a.can_manage && !a.categories.enabled && !a.categories.locked && a.categories.mode === "follow" && a.categories.source === "none";

function dismissedKey(wid: string | null) {
  return `od-mail-categories-offer:${wid ?? ""}`;
}

function wasDismissed(key: string) {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

/** The offer to split an inbox: Ollie suggests categories from the account's own mail. */
export function CategoryOffer({ account }: { account: MailAccount }) {
  const { t } = useTranslation("collab");
  const wid = useSession((s) => s.workspaceId);
  const key = dismissedKey(wid);
  const [hidden, setHidden] = useState(() => wasDismissed(key));
  const [open, setOpen] = useState(false);
  if (hidden && !open) return null;
  const dismiss = () => {
    setHidden(true);
    try {
      localStorage.setItem(key, "1");
    } catch {
      /* private mode: hidden until reload */
    }
  };
  const hue = tone[AI_TONE];
  return (
    <>
      {!hidden && (
        <div role="status" className={cn("flex shrink-0 animate-rise-in items-center gap-3 border-b px-4 py-2 motion-reduce:animate-none", hue.soft, hue.line)}>
          <OllieMark size={18} />
          <p className="min-w-0 flex-1 text-[12.5px] leading-[18px]">
            <span className="font-medium">{t("categories.offer.title")}</span> <span className="text-fg-3">{t("categories.offer.body")}</span>
          </p>
          <Button size="xs" variant="primary" onClick={() => setOpen(true)}>
            {t("categories.offer.action")}
          </Button>
          <Tooltip content={t("categories.offer.dismiss")}>
            <Button size="xs" variant="ghost" square icon={<X />} aria-label={t("categories.offer.dismiss")} onClick={dismiss} />
          </Tooltip>
        </div>
      )}
      {/* Once saved, the account is split and the tabs take this place. */}
      <CategorySetupDialog account={account} open={open} onOpenChange={setOpen} />
    </>
  );
}

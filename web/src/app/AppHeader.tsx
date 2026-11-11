// The top bar, one continuous line across the chrome:
//
//   [mark opendesk]  [workspace ▾] › Inbox › Unassigned        [● ⌁ 🔔  Search ⌘K  New ticket]
//
// The brand zone spans the sidebar column and narrows with the rail, so the
// crumbs always start where the work panel does.

import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, FileText, FileUp, Mail, Menu as MenuIcon, Search, SquarePen } from "lucide-react";
import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { Mark } from "@/components/brand";
import { OllieButton } from "@/components/assistant/OllieButton";
import { Kbd } from "@/components/ui/kbd";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { compose } from "@/lib/collab/compose";
import { useCollab } from "@/lib/collab/hooks";
import { desktop } from "@/lib/desktop";
import { useProducts } from "@/lib/products";
import { atLeast, useRole, useWorkspace } from "@/lib/session";
import { useSpaces } from "@/lib/spaces/hooks";
import { pickedSpace } from "@/lib/spaces/model";
import { usePickedSpaceId } from "@/lib/spaces/store";
import { ConnectionIndicator } from "./ConnectionIndicator";
import { NotificationsButton } from "./Notifications";
import { WorkspaceSwitcher } from "./Sidebar";
import { WorkspaceBadge } from "@/components/workspaces/WorkspaceBadge";
import { openImport, quickAdd } from "./quickAdd";
import { shell, useNav } from "./shellStore";
import { foldCrumbs, useBreadcrumbs, type Crumb } from "./useBreadcrumbs";

function FoldedCrumbs({ crumbs }: { crumbs: Crumb[] }) {
  const { t } = useTranslation("shell");
  const navigate = useNavigate();
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" aria-label={t("crumbs.more", { count: crumbs.length })} className="flex h-5 items-center rounded px-1 text-[12.5px] text-fg-3 transition-colors hover:bg-chrome-hover hover:text-fg">
          …
        </button>
      </MenuTrigger>
      <MenuContent align="start">
        {crumbs.map((c, i) => (
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          <MenuItem key={`${c.label}-${i}`} disabled={!c.to} onSelect={() => c.to && void navigate({ to: c.to as any, params: c.params as any })}>
            {c.label}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

export function AppHeader() {
  const crumbs = useBreadcrumbs();
  // With a Space picked the switcher names the Space; the open page's workspace comes first here.
  const { spaces } = useSpaces();
  const space = pickedSpace(spaces, usePickedSpaceId());
  const ws = useWorkspace();
  const collapsed = useNav((s) => s.collapsed);
  const role = useRole();
  const { t } = useTranslation("shell");
  const collab = useCollab();
  const { tickets: ticketsOn } = useProducts();
  const onMailPage = useRouterState({ select: (s) => s.location.pathname.split("/")[1] === "mail" });
  // Mail pages, and a workspace that keeps mail but not tickets, write mail first (GH#430).
  const primary: "mail" | "tickets" | "page" = collab.enabled && (onMailPage || !ticketsOn) ? "mail" : ticketsOn ? "tickets" : "page";
  const primaryLabel = primary === "mail" ? t("compose") : primary === "tickets" ? t("newTicket") : t("newPage");
  const createPrimary = primary === "mail" ? () => compose.open() : primary === "tickets" ? () => shell.newTicket() : () => quickAdd.page();

  return (
    // In the desktop app the header is the window's title bar: it drags the
    // window, and keeps clear of the window controls.
    <header className="window-drag flex h-12 shrink-0 items-center pr-(--window-inset-right)">
      <button
        type="button"
        aria-label={t("nav.open")}
        onClick={() => shell.sidebar(true)}
        className="ml-1.5 flex size-8 shrink-0 items-center justify-center rounded-md text-fg-2 hover:bg-chrome-hover md:hidden"
      >
        <MenuIcon className="size-4" />
      </button>
      {desktop?.platform === "darwin" && (
        // The traffic lights sit here, over the sidebar column; full screen hides them.
        <div aria-hidden className={cn("hidden h-full shrink-0 md:block md:transition-[width] md:duration-200 md:ease-out window-full:hidden!", collapsed ? "w-[max(3.5rem,var(--window-inset-left))]" : "w-[var(--pane-nav-live,var(--pane-nav,15rem))]")} />
      )}
      <Link
        to="/inbox/$folder/{-$ticketId}"
        params={{ folder: "unassigned", ticketId: undefined }}
        aria-label="opendesk"
        className={cn(
          "group flex h-full shrink-0 items-center gap-2 pl-2 pr-3 outline-none md:transition-[width,padding] md:duration-200 md:ease-out",
          collapsed ? "md:w-14 md:justify-center md:px-0" : "md:w-[var(--pane-nav-live,var(--pane-nav,15rem))] md:px-[18px]",
          desktop?.platform === "darwin" && "hidden window-full:flex!",
        )}
      >
        <Mark turn className="size-[18px] text-fg" />
        <span className={cn("text-[15px] font-semibold tracking-[-0.035em] text-fg", collapsed ? "hidden" : "hidden md:inline")}>opendesk</span>
      </Link>

      <div className="flex min-w-0 flex-1 items-center gap-1.5 pr-2">
        <WorkspaceSwitcher />
        <nav aria-label={t("breadcrumb")} className="hidden min-w-0 md:block">
          <ol className="flex min-w-0 items-center gap-1.5">
            {space && ws && (
              <>
                <li aria-hidden>
                  <ChevronRight className="size-3.5 shrink-0 text-fg-4" />
                </li>
                <li className="flex min-w-0 items-center gap-1.5 animate-label-in motion-reduce:animate-none">
                  <WorkspaceBadge name={ws.name} logo={ws.avatar_url} size="sm" decorative />
                  <span className="truncate text-[12.5px] text-fg-3">{ws.name}</span>
                </li>
              </>
            )}
            {foldCrumbs(crumbs).map((c, i, all) => {
              const last = i === all.length - 1;
              if ("fold" in c)
                return (
                  <Fragment key={`fold-${i}`}>
                    <li aria-hidden>
                      <ChevronRight className="size-3.5 shrink-0 text-fg-4" />
                    </li>
                    <li className="shrink-0">
                      <FoldedCrumbs crumbs={c.fold} />
                    </li>
                  </Fragment>
                );
              return (
                <Fragment key={`${c.label}-${i}`}>
                  <li aria-hidden>
                    <ChevronRight className="size-3.5 shrink-0 text-fg-4" />
                  </li>
                  <li className="min-w-0 animate-label-in motion-reduce:animate-none">
                    {last || !c.to ? (
                      <span
                        aria-current={last ? "page" : undefined}
                        title={c.label}
                        className={cn("block truncate text-[12.5px]", last ? "font-medium text-fg" : "text-fg-3")}
                        data-ph-mask={last || undefined}
                      >
                        {c.label}
                      </span>
                    ) : (
                      <Link
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        to={c.to as any}
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        params={c.params as any}
                        className="block truncate rounded px-0.5 text-[12.5px] text-fg-3 transition-colors hover:text-fg"
                      >
                        {c.label}
                      </Link>
                    )}
                  </li>
                </Fragment>
              );
            })}
          </ol>
        </nav>
      </div>

      <div className="flex shrink-0 items-center gap-1 px-2 sm:px-3">
        <ConnectionIndicator />
        <NotificationsButton />
        <OllieButton />
        <button
          type="button"
          onClick={() => shell.palette()}
          aria-label={t("search.open")}
          className="flex h-7 items-center gap-2 rounded-md px-2 text-[12.5px] text-fg-3 transition-colors hover:bg-chrome-hover hover:text-fg"
        >
          <Search className="size-3.5" />
          <span className="hidden lg:inline">{t("search.label")}</span>
          <Kbd className="hidden lg:inline-flex">mod k</Kbd>
        </button>
        {atLeast(role, "agent") && (
          // The page's own "new" (Compose on the mail pages or without Tickets, else New ticket),
          // and beside it what else can be made in place: a ticket or email, a page and an import.
          <div className="ml-1 flex h-7 items-stretch rounded-md bg-inverse text-inverse-fg">
            {/* c makes a ticket or an email; without either there is no shortcut to show. */}
            <Tooltip content={primaryLabel} shortcut={primary !== "page" ? "c" : undefined}>
              <button
                type="button"
                aria-label={primaryLabel}
                onClick={createPrimary}
                className="flex items-center gap-1.5 rounded-l-md pl-2.5 pr-2 text-[12.5px] font-medium transition-[background-color,transform] hover:bg-inverse-hover active:scale-[0.97] max-sm:w-7 max-sm:justify-center max-sm:px-0"
              >
                <SquarePen className="size-3.5" />
                <span className="hidden sm:inline">{primaryLabel}</span>
              </button>
            </Tooltip>
            <Menu>
              <Tooltip content={t("newMore")}>
                <MenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={t("newMore")}
                    className="flex w-6 items-center justify-center rounded-r-md border-l border-inverse-fg/15 transition-colors hover:bg-inverse-hover data-[state=open]:bg-inverse-hover"
                  >
                    <ChevronDown className="size-3.5" />
                  </button>
                </MenuTrigger>
              </Tooltip>
              <MenuContent align="end" className="w-[200px]">
                {/* The page's own first (with c), then the other. */}
                {(primary === "mail" ? ["mail", "tickets"] : ["tickets", "mail"]).map((kind) =>
                  kind === "mail"
                    ? collab.enabled && (
                        <MenuItem key="mail" icon={<Mail />} shortcut={primary === "mail" ? "c" : undefined} onSelect={() => compose.open()}>
                          {t("compose")}
                        </MenuItem>
                      )
                    : ticketsOn && (
                        <MenuItem key="tickets" icon={<SquarePen />} shortcut={primary === "tickets" ? "c" : undefined} onSelect={() => shell.newTicket()}>
                          {t("newTicket")}
                        </MenuItem>
                      ),
                )}
                {/* With neither, New page is already the button. */}
                {primary !== "page" && (
                  <MenuItem icon={<FileText />} onSelect={() => quickAdd.page()}>
                    {t("newPage")}
                  </MenuItem>
                )}
                <MenuItem icon={<FileUp />} onSelect={() => openImport()}>
                  {t("importPages")}
                </MenuItem>
              </MenuContent>
            </Menu>
          </div>
        )}
      </div>
    </header>
  );
}

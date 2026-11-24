import { useTranslation } from "react-i18next";
// Page scaffolding shared by every screen, so headers, sections and rows line
// up across the app.

import { Link } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** The 48px bar at the top of a main panel: title, an optional subtitle, actions. */
export function PageHeader({
  title,
  icon,
  subtitle,
  children,
  actions,
  className,
}: {
  title: ReactNode;
  icon?: ReactNode;
  subtitle?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("flex h-12 shrink-0 items-center gap-3 border-b border-line bg-surface px-4 md:px-5", className)}>
      <div className="flex min-w-0 items-center gap-2">
        {icon && <span className="flex text-fg-3 [&_svg]:size-4">{icon}</span>}
        <h1 className="truncate text-[13.5px] font-semibold tracking-[-0.015em]">{title}</h1>
        {subtitle && (
          <>
            <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-line" />
            <span className="truncate text-[12.5px] text-fg-3">{subtitle}</span>
          </>
        )}
      </div>
      {children && <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>}
      {actions && <div className={cn("flex shrink-0 items-center gap-1.5", !children && "ml-auto")}>{actions}</div>}
    </header>
  );
}

/** Full-width strip of figures with vertical hairlines between cells. */
export function StatStrip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("grid grid-cols-2 border-b border-line md:auto-cols-fr md:grid-flow-col md:grid-cols-none [&>*:not(:last-child)]:md:border-r [&>*]:border-line", className)}>
      {children}
    </div>
  );
}

export function Stat({ label, value, sub, extra }: { label: ReactNode; value: ReactNode; sub?: ReactNode; extra?: ReactNode }) {
  return (
    <div className="min-w-0 px-5 py-3.5 max-md:border-b max-md:odd:border-r">
      <div className="flex items-center justify-between gap-2">
        <span className="label-caps truncate">{label}</span>
        {extra}
      </div>
      <div className="mt-1.5 text-[24px] font-light leading-none tracking-[-0.02em] tabular-nums text-fg">{value}</div>
      {sub && <div className="mono mt-1.5 truncate text-[10.5px] text-fg-4">{sub}</div>}
    </div>
  );
}

/** A slim 36px toolbar inside a page body: an eyebrow, a count, actions. */
export function SectionBar({ label, count, children, className }: { label: ReactNode; count?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-h-9 shrink-0 items-center gap-2.5 border-b border-line-soft px-5 py-1", className)}>
      <span className="label-caps">{label}</span>
      {count !== undefined && <span className="mono text-[10.5px] tabular-nums text-fg-4">{count}</span>}
      {children && <div className="ml-auto flex min-w-0 items-center gap-1.5">{children}</div>}
    </div>
  );
}

/** "← Section" above a detail page title; always present on detail pages. */
export function BackLink({ children, ...link }: { children: ReactNode } & React.ComponentProps<typeof Link>) {
  return (
    <Link
      {...link}
      className="-ml-1 inline-flex h-6 items-center gap-0.5 rounded-md pl-0.5 pr-1.5 text-[12.5px] text-fg-3 transition-colors hover:bg-hover hover:text-fg"
    >
      <ChevronLeft className="size-3.5" />
      {children}
    </Link>
  );
}

/**
 * A settings page: a continuous document. A title block, then sections
 * separated by hairlines; rows inside a section sit in one bordered group.
 */
export function SettingsPage({
  title,
  description,
  actions,
  children,
  back,
  wide,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  back?: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="w-full pb-24">
      <div className="border-b border-line">
        <div className={cn("mx-auto flex flex-wrap items-start gap-4 px-5 pb-5 pt-6 md:px-8 md:pt-7", wide ? "max-w-[1120px]" : "max-w-[880px]")}>
          <div className="min-w-0 flex-1 basis-60">
            {back && <div className="mb-2">{back}</div>}
            <h1 data-find-label className="text-[17px] font-semibold leading-6 tracking-[-0.025em]">{title}</h1>
            {description && <p className="mt-1 max-w-[600px] text-[12.5px] leading-[19px] text-fg-3">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
        </div>
      </div>
      <div className={cn("mx-auto flex flex-col gap-9 px-5 pt-7 md:px-8", wide ? "max-w-[1120px]" : "max-w-[880px]")}>{children}</div>
    </div>
  );
}

/** A titled group with a hairline card. */
export function Section({
  title,
  description,
  actions,
  children,
  className,
  flush,
  danger,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** No inner padding: for lists and tables that run edge to edge. */
  flush?: boolean;
  danger?: boolean;
}) {
  return (
    <section data-find className={cn("animate-rise-in", className)}>
      {(title || actions) && (
        <div className="mb-3 flex items-end justify-between gap-4">
          <div className="min-w-0">
            {title && <h2 data-find-label className={cn("text-[13px] font-semibold tracking-[-0.01em]", danger && "text-danger-fg")}>{title}</h2>}
            {description && <p className="mt-0.5 text-[12px] leading-[18px] text-fg-3">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
        </div>
      )}
      <div
        className={cn(
          "overflow-hidden rounded-lg border border-line bg-surface shadow-xs",
          !flush && "px-4 py-0.5",
          danger && "border-[color-mix(in_srgb,var(--danger)_28%,var(--line))]",
        )}
      >
        {children}
      </div>
    </section>
  );
}

/** Label and description on the left, the control on the right. */
export function Row({
  label,
  description,
  children,
  className,
  htmlFor,
  stack,
}: {
  label: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
  htmlFor?: string;
  /** Put the control under the label (wide inputs, editors). */
  stack?: boolean;
}) {
  return (
    <div
      data-find
      className={cn(
        "flex gap-4 border-b border-line-soft py-3.5 last:border-0",
        stack ? "flex-col gap-2.5" : "flex-col sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
    >
      <div className="min-w-0">
        {htmlFor ? (
          <label data-find-label htmlFor={htmlFor} className="text-[12.5px] font-medium text-fg">
            {label}
          </label>
        ) : (
          <div data-find-label className="text-[12.5px] font-medium text-fg">{label}</div>
        )}
        {description && <div className="mt-0.5 text-[12px] leading-[18px] text-fg-3">{description}</div>}
      </div>
      {children && <div className={cn(stack ? "w-full" : "flex shrink-0 items-center gap-2")}>{children}</div>}
    </div>
  );
}

/** A dense list row in a flush Section. */
export function ListRow({
  children,
  onClick,
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <div
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={(e) => {
        if (onClick && (e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
          e.preventDefault();
          onClick();
        }
      }}
      className={cn(
        "group flex min-h-12 items-center gap-3 border-b border-line-soft px-4 py-2.5 last:border-0",
        onClick && "cursor-pointer transition-colors hover:bg-sunken",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Shown in place of a settings page to roles that can't manage it. */
export function NoAccess({ what }: { what?: string }) {
  const { t: ui } = useTranslation("ui");
  return (
    <div className="rounded-lg border border-dashed border-line px-6 py-12 text-center">
      <p className="text-[13px] font-medium">{ui("adminsOnly")}</p>
      <p className="mt-1 text-[12.5px] text-fg-3">{ui("askAWorkspaceAdminIfYouNeedToChange")} {what ?? ui("theseSettings")}.</p>
    </div>
  );
}

import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";

const item =
  "relative inline-flex h-6 items-center rounded-md px-2 text-xs font-medium text-fg-3 transition-colors duration-100 hover:text-fg data-[status=active]:bg-surface data-[status=active]:text-fg data-[status=active]:shadow-[0_0_0_1px_var(--line),0_1px_2px_rgb(0_0_0/0.06)] dark:data-[status=active]:bg-white/[0.11] dark:data-[status=active]:shadow-[0_0_0_1px_rgb(255_255_255/0.08),0_1px_2px_rgb(0_0_0/0.3)]";

/** Articles or changelog: the two halves of the knowledge base, as links (the router marks the current one). */
export function KbSwitch({ className }: { className?: string }) {
  const { t } = useTranslation("kb");
  return (
    <nav
      aria-label={t("title")}
      className={cn("inline-flex items-center rounded-md bg-hover p-0.5 dark:bg-white/[0.07] dark:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.05)]", className)}
    >
      <Link to="/kb" activeOptions={{ exact: true, includeSearch: false }} className={item}>
        {t("switch.articles")}
      </Link>
      <Link to="/kb/changelog" activeOptions={{ includeSearch: false }} className={item}>
        {t("switch.changelog")}
      </Link>
    </nav>
  );
}

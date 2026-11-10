import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import { cn } from "@/lib/cn";
import type { Workspace } from "@/lib/api/types";

/**
 * Whether first run asks what the workspace is for: only where the instance and plan offer
 * Mail (it may since have been switched off by that answer).
 */
export function offersProducts(ws: Pick<Workspace, "mail_available" | "mail_disabled_reason"> | null | undefined): boolean {
  return !!ws && (ws.mail_available || ws.mail_disabled_reason === "workspace_disabled");
}

/** Progress for onboarding: Workspace, then Products where Mail is offered, then Mailbox. */
export function OnboardingSteps({ current, withProducts = false }: { current: 1 | 2 | 3; withProducts?: boolean }) {
  const { t: a } = useTranslation("auth");
  const steps = withProducts ? [a("workspace"), a("products.step"), a("mailbox")] : [a("workspace"), a("mailbox")];
  return (
    <ol className="mb-8 flex items-center gap-2" aria-label={a("setupProgress")}>
      {steps.map((label, i) => {
        const n = i + 1;
        const done = n < current;
        const active = n === current;
        return (
          <li key={label} className="flex items-center gap-2" aria-current={active ? "step" : undefined}>
            {i > 0 && <span className={cn("h-px w-8", done || active ? "bg-fg-3" : "bg-line")} aria-hidden />}
            <span
              className={cn(
                "mono flex size-5 items-center justify-center rounded-[5px] text-[10.5px] font-medium",
                done ? "bg-inverse text-inverse-fg" : active ? "border border-fg text-fg" : "border border-line text-fg-4",
              )}
            >
              {done ? <Check className="size-3" strokeWidth={3} /> : n}
            </span>
            <span className={cn("text-[12.5px]", active ? "font-medium text-fg" : "text-fg-3")}>{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

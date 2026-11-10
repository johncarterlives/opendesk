// First run, after the workspace is created: what is it for? The answer only sets the
// existing Products switches (contracts/api.md "Onboarding"); workspace settings change it later.

import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Inbox, LifeBuoy, Layers, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AuthHeading } from "@/app/AuthLayout";
import { Notice } from "@/components/auth/parts";
import { OnboardingSteps } from "@/components/auth/OnboardingSteps";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api/endpoints";
import { errorMessage } from "@/lib/api/client";
import { cn } from "@/lib/cn";
import { reloadSession, useWorkspace } from "@/lib/session";
import { tone } from "@/lib/tones";
import type { WorkspaceSettings } from "@/lib/api/types";

export type ProductsChoice = "mail" | "tickets" | "both";

/** The switches each answer sets; "both" leaves today's defaults. */
export function settingsFor(choice: ProductsChoice): WorkspaceSettings | null {
  if (choice === "mail") return { tickets_enabled: false };
  if (choice === "tickets") return { mail_enabled: false };
  return null;
}

const OPTIONS: { id: ProductsChoice; icon: LucideIcon; tint: keyof typeof tone }[] = [
  { id: "mail", icon: Inbox, tint: "blue" },
  { id: "tickets", icon: LifeBuoy, tint: "green" },
  { id: "both", icon: Layers, tint: "violet" },
];

export default function Products() {
  const { t: a } = useTranslation("auth");
  const navigate = useNavigate();
  const qc = useQueryClient();
  const ws = useWorkspace();
  const [choice, setChoice] = useState<ProductsChoice>("both");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const settings = settingsFor(choice);
      if (settings) {
        await api.workspaces.update({ settings });
        await reloadSession(ws?.id);
        qc.clear();
      }
      if (choice === "mail") void navigate({ to: "/settings/mail-accounts", search: { connect: "1" } });
      else void navigate({ to: "/onboarding/mailbox" });
    } catch (err) {
      setBusy(false);
      setError(errorMessage(err));
    }
  };

  return (
    <div>
      <OnboardingSteps current={2} withProducts />
      <AuthHeading title={a("whatAreYouSettingUp")} subtitle={a("productsChoiceSubtitle")} />
      {error && <Notice className="mb-4">{error}</Notice>}
      <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">{a("whatAreYouSettingUp")}</legend>
          {OPTIONS.map((o) => {
            const on = choice === o.id;
            const Icon = o.icon;
            return (
              <label
                key={o.id}
                className={cn(
                  "relative flex cursor-pointer items-start gap-3 rounded-lg border bg-surface p-3.5 text-left transition-[border-color,box-shadow,background-color] duration-150 has-[:focus-visible]:shadow-[0_0_0_3px_var(--focus)]",
                  on ? "border-fg-2 shadow-[0_0_0_1px_var(--fg-2)]" : "border-line hover:border-line-strong hover:bg-sunken/60",
                )}
              >
                <input type="radio" name="products" value={o.id} checked={on} onChange={() => setChoice(o.id)} className="sr-only" />
                <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-md", tone[o.tint].chip)}>
                  <Icon className="size-[18px]" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium">{a(`products.${o.id}`)}</span>
                  <span className="mt-0.5 block text-xs leading-[18px] text-fg-3">{a(`products.${o.id}Body`)}</span>
                </span>
                <span
                  aria-hidden
                  className={cn(
                    "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors",
                    on ? "border-inverse bg-inverse text-inverse-fg" : "border-line-strong",
                  )}
                >
                  {on && <Check className="size-2.5" strokeWidth={3.5} />}
                </span>
              </label>
            );
          })}
        </fieldset>
        <Button type="submit" variant="primary" size="lg" className="mt-1 w-full" loading={busy}>
          {a("continue")}
        </Button>
      </form>
    </div>
  );
}

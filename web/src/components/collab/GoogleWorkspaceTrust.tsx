// Before a Google account connects: a Google Workspace admin marks opendesk's Collab
// client Trusted once per domain, which is what lets the domain's accounts sign in
// (contracts/collab.md "Google Workspace"). A personal Gmail address takes an app
// password instead.

import { ChevronRight, KeyRound, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { ExternalButton, Steps } from "@/components/mailboxes/connect";
import { CopyField } from "@/components/ui/copy-button";

/** Admin console > Security > API controls > App access control, on the configured apps tab. */
export const GOOGLE_APP_ACCESS_URL = "https://admin.google.com/ac/owl/list?tab=configuredApps";

const PERSONAL_GMAIL = /@(gmail|googlemail)\.com$/i;

export const isPersonalGmail = (email: string) => PERSONAL_GMAIL.test(email.trim());

/** The Admin console steps that mark opendesk Trusted for a Google Workspace domain. */
export function TrustedAppSteps({ clientId }: { clientId: string | null }) {
  const { t } = useTranslation("collab");
  const b = <b />;
  return (
    <div className="flex flex-col gap-3">
      <Steps
        items={[
          <span key="s1" className="flex flex-col items-start gap-1.5">
            <span>
              <Trans t={t} i18nKey="connect.workspace.s1" components={{ b }} />
            </span>
            <ExternalButton href={GOOGLE_APP_ACCESS_URL}>{t("connect.workspace.open")}</ExternalButton>
          </span>,
          <Trans key="s2" t={t} i18nKey="connect.workspace.s2" components={{ b }} />,
          <span key="s3" className="flex flex-col gap-1.5">
            <span>{t("connect.workspace.s3")}</span>
            {clientId ? <CopyField value={clientId} /> : <span className="text-[12px] text-fg-3">{t("connect.workspace.noClientId")}</span>}
          </span>,
          <Trans key="s4" t={t} i18nKey="connect.workspace.s4" components={{ b }} />,
        ]}
      />
    </div>
  );
}

/** The Workspace admin's one-time step, folded until asked for. */
export function GoogleWorkspaceTrust({ clientId, defaultOpen = false }: { clientId: string | null; defaultOpen?: boolean }) {
  const { t } = useTranslation("collab");
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-lg border border-line bg-sunken/50">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-start gap-2.5 rounded-lg px-3 py-2.5 text-left outline-none focus-visible:shadow-[0_0_0_3px_var(--focus)]"
      >
        <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-fg-3" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-[12.5px] font-medium">{t("connect.workspace.title")}</span>
          <span className="block text-[12px] leading-[18px] text-fg-3">{t("connect.workspace.hint")}</span>
        </span>
        <ChevronRight className={cn("mt-0.5 size-3.5 shrink-0 text-fg-3 transition-transform duration-150 motion-reduce:transition-none", open && "rotate-90")} aria-hidden />
      </button>
      {open && (
        <div className="px-3 pb-3 pt-0.5 animate-rise-in motion-reduce:animate-none">
          <TrustedAppSteps clientId={clientId} />
        </div>
      )}
    </div>
  );
}

/** A personal Gmail address: an app password connects it without Google sign-in. */
export function PersonalGmailNote({ onUseAppPassword }: { onUseAppPassword: () => void }) {
  const { t } = useTranslation("collab");
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-line bg-sunken/50 px-3 py-2.5">
      <KeyRound className="mt-0.5 size-3.5 shrink-0 text-fg-3" aria-hidden />
      <div className="min-w-0 flex-1 text-[12px] leading-[18px] text-fg-2">
        {t("connect.personalGmail")}
        <button type="button" onClick={onUseAppPassword} className="ml-1 font-medium text-fg underline-offset-2 hover:underline">
          {t("connect.useAppPassword")}
        </button>
      </div>
    </div>
  );
}

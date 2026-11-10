import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AuthHeading } from "@/app/AuthLayout";
import { Button } from "@/components/ui/button";
import { TextInput } from "@/components/ui/input";
import { AuthField, Notice } from "@/components/auth/parts";
import { OnboardingSteps, offersProducts } from "@/components/auth/OnboardingSteps";
import { api } from "@/lib/api/endpoints";
import { errorMessage } from "@/lib/api/client";
import { reloadSession, selectWorkspace, useSession, useWorkspace } from "@/lib/session";
import { DeleteAccountDialog } from "@/components/account/DeleteAccountDialog";
import { track } from "@/lib/analytics";
import { Trans, useTranslation } from "react-i18next";
import { useAccountActions, useSwitcherEntries } from "@/app/useAccounts";

export default function Workspace() {
  const { t: a } = useTranslation("auth");
  const navigate = useNavigate();
  const qc = useQueryClient();
  const current = useWorkspace();
  const hasWorkspaces = useSession((s) => s.memberships.length > 0);
  const email = useSession((s) => s.user?.email);
  const meId = useSession((s) => s.user?.id);
  const { t } = useTranslation("shell");
  const { logOut, switchTo } = useAccountActions();
  // Another account signed in here, to go back to.
  const other = useSwitcherEntries().find((e) => e.account.user.id !== meId);
  const [deleting, setDeleting] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError(a("giveYourWorkspaceAName"));
    setBusy(true);
    setError(null);
    try {
      const ws = await api.workspaces.create(name.trim());
      await reloadSession(ws.id);
      selectWorkspace(ws.id);
      qc.clear();
      track("workspace_created");
      // Where Mail is offered, ask what the workspace is for before the first mailbox.
      void navigate({ to: offersProducts(ws) ? "/onboarding/products" : "/onboarding/mailbox" });
    } catch (err) {
      setBusy(false);
      setError(errorMessage(err));
    }
  };

  return (
    <div>
      {hasWorkspaces && current && (
        <Link to="/" className="-ml-1 mb-6 inline-flex h-6 items-center gap-0.5 rounded-md pl-0.5 pr-1.5 text-[12.5px] text-fg-3 hover:bg-hover hover:text-fg">
          <ChevronLeft className="size-3.5" />
          {a("backTo", { name: current.name })}
        </Link>
      )}
      <OnboardingSteps current={1} />
      <AuthHeading title={a("createYourWorkspace")} subtitle={a("aWorkspaceHoldsYourTeamsInboxesContactsAnd")} />
      {error && <Notice className="mb-4">{error}</Notice>}
      <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <AuthField label={a("workspaceName")}>
          {(id) => <TextInput id={id} className="h-9" autoFocus value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder={a("acmeSupport")} />}
        </AuthField>
        <Button type="submit" variant="primary" size="lg" className="mt-1 w-full" loading={busy}>
          {a("continue")}
        </Button>
      </form>
      {!hasWorkspaces && (
        // Without a workspace the app's account menu and settings are out of reach.
        <p className="mt-8 text-center text-[12px] text-fg-3">
          <Trans ns="auth" i18nKey="signedInAs" values={{ email }} components={{ email: <span className="text-fg-2" /> }} /> ·{" "}
          <button
            type="button"
            className="underline-offset-2 hover:text-fg hover:underline"
            onClick={() => void logOut()}
          >
            {a("logOut")}
          </button>{" "}
          {other && (
            <>
              ·{" "}
              <button
                type="button"
                className="underline-offset-2 hover:text-fg hover:underline"
                onClick={() => void switchTo(other.account.user.id, other.membership.workspace.id)}
              >
                {t("accounts.back", { name: other.membership.workspace.name })}
              </button>{" "}
            </>
          )}
          ·{" "}
          <button type="button" className="underline-offset-2 hover:text-fg hover:underline" onClick={() => setDeleting(true)}>
            {a("deleteAccount")}
          </button>
        </p>
      )}
      {deleting && <DeleteAccountDialog onClose={() => setDeleting(false)} />}
    </div>
  );
}

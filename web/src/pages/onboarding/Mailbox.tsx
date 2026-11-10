import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "@tanstack/react-router";
import { AuthHeading } from "@/app/AuthLayout";
import { OnboardingSteps, offersProducts } from "@/components/auth/OnboardingSteps";
import { AddMailboxWizard } from "@/components/mailboxes/AddMailboxWizard";
import { useWorkspace } from "@/lib/session";

export default function Mailbox() {
  const { t: a } = useTranslation("auth");
  const navigate = useNavigate();
  const withProducts = offersProducts(useWorkspace());
  const toInbox = () => void navigate({ to: "/inbox/$folder/{-$ticketId}", params: { folder: "unassigned", ticketId: undefined } });
  return (
    <div>
      <OnboardingSteps current={withProducts ? 3 : 2} withProducts={withProducts} />
      <AuthHeading title={a("connectYourFirstMailbox")} subtitle={a("mailSentToThisAddressBecomesTicketsYour")} />
      <AddMailboxWizard
        compact
        onDone={toInbox}
        extraFooter={
          <Link
            to="/inbox/$folder/{-$ticketId}"
            params={{ folder: "unassigned", ticketId: undefined }}
            className="rounded-md px-2 py-1 text-[12.5px] text-fg-3 hover:bg-hover hover:text-fg"
          >
            {a("skipForNow")}
          </Link>
        }
      />
    </div>
  );
}

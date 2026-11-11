// A contact's customer portal access (contracts/customer-portal.md "Invitations"): whether
// they can sign in, an invitation from one of the brands whose help center is on, and taking
// access away.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Send, UserX } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { api } from "@/lib/api/endpoints";
import type { Contact, PortalAccess, PortalBrand } from "@/lib/api/types";
import { fullDate, relLong } from "@/lib/format";
import { q, qk } from "@/lib/queries";

/** Brands an invitation can come from: their customers choose a password. */
export const invitable = (brands: PortalBrand[]) => brands.filter((b) => b.auth_mode !== "oidc");

const tones = { none: "neutral", invited: "amber", active: "ok" } as const;

export function PortalAccessSection({ contact, canEdit }: { contact: Contact; canEdit: boolean }) {
  const { t } = useTranslation("contacts");
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data, isLoading } = useQuery(q.contactPortal(contact.id));
  const brands = invitable(data?.brands ?? []);
  const [brandId, setBrandId] = useState<string | undefined>(undefined);
  const brand = brands.find((b) => b.id === brandId) ?? brands.find((b) => b.default) ?? brands[0];

  const set = (a: PortalAccess) => qc.setQueryData(qk.contactPortal(contact.id), a);
  const invite = useMutation({
    mutationFn: () => api.contacts.invitePortal(contact.id, brand?.id),
    onSuccess: (a) => {
      set(a);
      toast.success(t("portal.sent", { email: contact.email }));
    },
    onError: (e) => toast.error(e, t("portal.sendFailed")),
  });
  const remove = useMutation({
    mutationFn: () => api.contacts.removePortal(contact.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.contactPortal(contact.id) });
      toast.success(t("portal.removed"));
    },
    onError: (e) => toast.error(e, t("portal.removeFailed")),
  });

  if (isLoading) return <Skeleton className="h-16 w-full" />;
  if (!data) return null;
  // Nothing to show where no help center is on and the contact never had access.
  if (data.brands.length === 0 && data.status === "none") return null;

  const why = !contact.email ? t("portal.needsEmail") : contact.blocked ? t("portal.isBlocked") : brands.length === 0 ? t("portal.ssoOnly") : undefined;
  const detail =
    data.status === "active"
      ? data.last_sign_in_at
        ? t("portal.lastSignIn", { when: relLong(data.last_sign_in_at) })
        : t("portal.noRecentSignIn")
      : data.status === "invited" && data.invite_expires_at
        ? t("portal.linkOpen", { date: fullDate(data.invite_expires_at) })
        : t("portal.noAccessHint");
  const how = data.status === "active" ? [data.password && t("portal.withPassword"), data.sso && t("portal.withSso")].filter(Boolean).join(" · ") : "";

  return (
    <section aria-labelledby="portal-access">
      <div className="mb-2 flex items-center justify-between">
        <h3 id="portal-access" className="label-caps">
          {t("portal.title")}
        </h3>
        <Badge tone={tones[data.status]}>{t(`portal.status.${data.status}`)}</Badge>
      </div>
      <div className="rounded-lg border border-line-soft px-3.5 py-3">
        <p className="text-[12.5px] leading-5 text-fg-2">{detail}</p>
        {how && <p className="mt-0.5 text-xs text-fg-3">{how}</p>}
        {canEdit && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {brands.length > 1 && (
              <Select
                size="sm"
                className="w-40"
                value={brand?.id}
                onChange={setBrandId}
                options={brands.map((b) => ({ value: b.id, label: b.name }))}
                aria-label={t("portal.brand")}
              />
            )}
            <Tooltip content={why}>
              <span className="inline-flex">
                <Button
                  size="sm"
                  variant={data.status === "none" ? "primary" : "secondary"}
                  icon={data.status === "none" ? <Send className="size-3.5" /> : <KeyRound className="size-3.5" />}
                  loading={invite.isPending}
                  disabled={!!why}
                  onClick={() => invite.mutate()}
                >
                  {data.status === "none" ? t("portal.invite") : t("portal.newLink")}
                </Button>
              </span>
            </Tooltip>
            {data.status !== "none" && (
              <Button
                size="sm"
                variant="ghost"
                icon={<UserX className="size-3.5" />}
                loading={remove.isPending}
                onClick={() =>
                  confirm.show(t("portal.removeBody", { name: contact.name }), () => remove.mutateAsync(), {
                    title: t("portal.removeTitle"),
                    confirmLabel: t("portal.remove"),
                    danger: true,
                  })
                }
              >
                {t("portal.remove")}
              </Button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

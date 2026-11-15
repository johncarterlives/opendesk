// A brand's customer portal sign-in (contracts/customer-portal.md "Provider sign-in"):
// a password, the company's own OIDC or SAML 2.0 identity provider, or either. The provider is checked
// when the settings are saved, so they save on their own button, not with the brand's bar.
// A customer whose provider account changed can be allowed one new link, for 15 minutes.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Row, Section } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Textarea, TextInput } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { api } from "@/lib/api/endpoints";
import { errorMessage, isApiError } from "@/lib/api/client";
import type { Brand, PortalAuthMode, PortalAuthSettings, PortalSsoProtocol } from "@/lib/api/types";
import { config } from "@/lib/config";
import { qk, upsertInList } from "@/lib/queries";

type Draft = {
  mode: PortalAuthMode;
  protocol: PortalSsoProtocol;
  issuer: string;
  clientId: string;
  secret: string;
  create: boolean;
  samlEntity: string;
  samlUrl: string;
  samlCerts: string;
  samlEmail: string;
  samlName: string;
};

const toDraft = (s: PortalAuthSettings): Draft => ({
  mode: s.mode,
  protocol: s.protocol,
  issuer: s.issuer,
  clientId: s.client_id,
  secret: "",
  create: s.create_contacts,
  samlEntity: s.saml.idp_entity_id,
  samlUrl: s.saml.idp_sso_url,
  samlCerts: s.saml.idp_certificates,
  samlEmail: s.saml.email_attribute,
  samlName: s.saml.name_attribute,
});

/** Where the provider sends the customer back to: the API's callback for this brand. */
export const portalCallbackUrl = (slug: string) => `${config.apiUrl}/v1/public/help/${encodeURIComponent(slug)}/portal/sso/callback`;

export function PortalSignInSection({ brand }: { brand: Brand }) {
  const { t } = useTranslation("settingsTeams");
  const { data } = useQuery({ queryKey: qk.brandPortalAuth(brand.id), queryFn: () => api.brands.portalAuth(brand.id) });
  return (
    <Section title={t("portalAuth.title")} description={t("portalAuth.hint", { name: brand.name })}>
      {data ? <Form key={`${data.mode}:${data.protocol}:${data.issuer}:${data.client_id}:${data.create_contacts}:${data.saml.idp_entity_id}:${data.saml.idp_sso_url}:${data.saml.idp_certificates}:${data.saml.email_attribute}:${data.saml.name_attribute}`} brand={brand} saved={data} /> : null}
      {data && data.mode !== "local" && <RelinkRow brand={brand} />}
    </Section>
  );
}

function Form({ brand, saved }: { brand: Brand; saved: PortalAuthSettings }) {
  const { t } = useTranslation("settingsTeams");
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft>(toDraft(saved));
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<Draft>) => {
    setError(null);
    setDraft((d) => ({ ...d, ...patch }));
  };
  const provider = draft.mode !== "local";
  const base = toDraft(saved);
  const saml = provider && draft.protocol === "saml";
  const keys = ["protocol", "issuer", "clientId", "create", "samlEntity", "samlUrl", "samlCerts", "samlEmail", "samlName"] as const;
  const dirty = draft.mode !== base.mode || (provider && (draft.secret !== "" || keys.some((k) => draft[k] !== base[k])));
  const needsSecret = provider && !saml && (draft.protocol !== base.protocol || !saved.secret_configured) && !draft.secret.trim();
  const ready = !provider || (saml
    ? !!draft.samlEntity.trim() && /^https:\/\/\S+$/.test(draft.samlUrl.trim()) && !!draft.samlCerts.trim()
    : /^https:\/\/\S+$/.test(draft.issuer.trim()) && !!draft.clientId.trim() && !needsSecret);

  const save = useMutation({
    mutationFn: () =>
      api.brands.update(brand.id, {
        portal_auth: !provider
          ? { mode: "local" }
          : saml
            ? {
                mode: draft.mode,
                protocol: "saml",
                create_contacts: draft.create,
                saml: {
                  idp_entity_id: draft.samlEntity.trim(),
                  idp_sso_url: draft.samlUrl.trim(),
                  idp_certificates: draft.samlCerts.trim(),
                  email_attribute: draft.samlEmail.trim(),
                  name_attribute: draft.samlName.trim(),
                },
              }
            : {
                mode: draft.mode,
                protocol: "oidc",
                issuer: draft.issuer.trim(),
                client_id: draft.clientId.trim(),
                ...(draft.secret.trim() ? { client_secret: draft.secret } : {}),
                create_contacts: draft.create,
              },
      }),
    onSuccess: (b) => {
      upsertInList(qc, qk.brands, b);
      void qc.invalidateQueries({ queryKey: qk.brandPortalAuth(brand.id) });
      toast.success(t("portalAuth.saved"));
    },
    onError: (e) => {
      if (isApiError(e, "invalid_oidc_config")) return setError(t("portalAuth.invalid"));
      if (isApiError(e, "invalid_saml_config")) return setError(t("portalAuth.samlInvalid"));
      if (isApiError(e, "oidc_secret_required")) return setError(t("portalAuth.secretRequired"));
      toast.error(e, t("portalAuth.saveFailed"));
    },
  });

  return (
    <>
      <Row label={t("portalAuth.mode")} description={t("portalAuth.modeHint")}>
        <Select
          className="w-[280px]"
          aria-label={t("portalAuth.mode")}
          value={draft.mode}
          onChange={(mode) => set({ mode })}
          options={(["local", "local_and_oidc", "oidc"] as const).map((m) => ({ value: m, label: t(`portalAuth.modes.${m}`) }))}
        />
      </Row>
      {provider && (
        <>
          <Row label={t("portalAuth.protocol")} description={t("portalAuth.protocolHint")}>
            <Select
              className="w-[280px]"
              aria-label={t("portalAuth.protocol")}
              value={draft.protocol}
              onChange={(protocol) => set({ protocol })}
              options={(["oidc", "saml"] as const).map((p) => ({ value: p, label: t(`portalAuth.protocols.${p}`) }))}
            />
          </Row>
          {saml ? (
            <>
              <Row label={t("portalAuth.spEntity")} description={t("portalAuth.spEntityHint")}>
                <span className="mono max-w-[300px] truncate text-[12px] text-fg-2">{saved.saml.sp_entity_id}</span>
                <CopyButton value={saved.saml.sp_entity_id} label={t("portalAuth.copyEntity")} />
              </Row>
              <Row label={t("portalAuth.acs")} description={t("portalAuth.acsHint")}>
                <span className="mono max-w-[300px] truncate text-[12px] text-fg-2">{saved.saml.acs_url}</span>
                <CopyButton value={saved.saml.acs_url} label={t("portalAuth.copyAcs")} />
              </Row>
              <Row label={t("portalAuth.idpEntity")} description={t("portalAuth.idpEntityHint")} htmlFor="portal-idp-entity">
                <TextInput id="portal-idp-entity" className="mono w-[320px]" spellCheck={false} value={draft.samlEntity} onChange={(e) => set({ samlEntity: e.target.value })} />
              </Row>
              <Row label={t("portalAuth.idpUrl")} description={t("portalAuth.idpUrlHint")} htmlFor="portal-idp-url">
                <TextInput id="portal-idp-url" className="mono w-[320px]" spellCheck={false} placeholder="https://login.acme.com/saml/sso" value={draft.samlUrl} onChange={(e) => set({ samlUrl: e.target.value })} />
              </Row>
              <Row label={t("portalAuth.certs")} description={t("portalAuth.certsHint")} htmlFor="portal-idp-certs" stack>
                <Textarea id="portal-idp-certs" className="mono h-[120px] w-full max-w-[520px] text-[11px]" spellCheck={false} placeholder="-----BEGIN CERTIFICATE-----" value={draft.samlCerts} onChange={(e) => set({ samlCerts: e.target.value })} />
              </Row>
              <Row label={t("portalAuth.emailAttr")} description={t("portalAuth.emailAttrHint")} htmlFor="portal-email-attr">
                <TextInput id="portal-email-attr" className="mono w-[320px]" spellCheck={false} placeholder="email" value={draft.samlEmail} onChange={(e) => set({ samlEmail: e.target.value })} />
              </Row>
              <Row label={t("portalAuth.nameAttr")} htmlFor="portal-name-attr">
                <TextInput id="portal-name-attr" className="mono w-[320px]" spellCheck={false} placeholder="name" value={draft.samlName} onChange={(e) => set({ samlName: e.target.value })} />
              </Row>
            </>
          ) : (
            <>
              <Row label={t("portalAuth.issuer")} description={t("portalAuth.issuerHint")} htmlFor="portal-issuer">
                <TextInput id="portal-issuer" className="mono w-[320px]" spellCheck={false} placeholder="https://login.acme.com" value={draft.issuer} onChange={(e) => set({ issuer: e.target.value })} />
              </Row>
              <Row label={t("portalAuth.clientId")} htmlFor="portal-client-id">
                <TextInput id="portal-client-id" className="mono w-[320px]" spellCheck={false} autoComplete="off" value={draft.clientId} onChange={(e) => set({ clientId: e.target.value })} />
              </Row>
              <Row label={t("portalAuth.secret")} description={t("portalAuth.secretHint")} htmlFor="portal-secret">
                <TextInput
                  id="portal-secret"
                  className="mono w-[320px]"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={saved.secret_configured ? t("portalAuth.secretSaved") : ""}
                  value={draft.secret}
                  onChange={(e) => set({ secret: e.target.value })}
                />
              </Row>
              <Row label={t("portalAuth.callback")} description={t("portalAuth.callbackHint")}>
                <span className="mono max-w-[300px] truncate text-[12px] text-fg-2">{portalCallbackUrl(brand.slug)}</span>
                <CopyButton value={portalCallbackUrl(brand.slug)} label={t("portalAuth.copy")} />
              </Row>
            </>
          )}
          <Row label={t("portalAuth.create")} description={draft.create ? t("portalAuth.createOn") : t("portalAuth.createOff")}>
            <Switch aria-label={t("portalAuth.create")} checked={draft.create} onCheckedChange={(create) => set({ create })} />
          </Row>
        </>
      )}
      <Row label={error ? <span className="text-danger-fg">{error}</span> : ""} className="justify-end">
        <Button variant="primary" loading={save.isPending} disabled={!dirty || !ready || save.isPending} onClick={() => save.mutate()}>
          {t("portalAuth.save")}
        </Button>
      </Row>
    </>
  );
}

/** Allows one contact's next provider sign-in to replace their old link. */
function RelinkRow({ brand }: { brand: Brand }) {
  const { t } = useTranslation("settingsTeams");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const allow = useMutation({
    mutationFn: async () => {
      const wanted = email.trim().toLowerCase();
      const found = await api.contacts.search({ q: wanted, limit: 20 });
      const contact = found.data.find((c) => c.email?.toLowerCase() === wanted);
      if (!contact) throw new Error("no_contact");
      return api.brands.authorizeRelink(brand.id, contact.id);
    },
    onSuccess: () => {
      toast.success(t("portalAuth.relinkDone", { email: email.trim() }));
      setEmail("");
    },
    onError: (e) => {
      if (e instanceof Error && e.message === "no_contact") return setError(t("portalAuth.relinkNone"));
      if (isApiError(e, "reauth_required")) return setError(t("portalAuth.relinkReauth"));
      setError(errorMessage(e, t("portalAuth.relinkFailed")));
    },
  });
  return (
    <Row label={t("portalAuth.relink")} description={error ?? t("portalAuth.relinkHint")} htmlFor="portal-relink" stack>
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          allow.mutate();
        }}
      >
        <TextInput id="portal-relink" type="email" className="w-[280px]" placeholder={t("portalAuth.relinkEmail")} spellCheck={false} value={email} onChange={(e) => { setError(null); setEmail(e.target.value); }} />
        <Button type="submit" variant="secondary" loading={allow.isPending} disabled={!email.trim() || allow.isPending}>
          {t("portalAuth.relinkAction")}
        </Button>
      </form>
    </Row>
  );
}

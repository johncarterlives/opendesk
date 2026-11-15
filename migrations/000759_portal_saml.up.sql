-- A brand's single sign-in is OIDC or SAML 2.0 (contracts/customer-portal.md "SAML"). The mode
-- keeps saying whether passwords stay (local_and_oidc) or the identity provider is the only
-- way in (oidc); the protocol says which kind of provider it is. A SAML provider is
-- configured by public data only (its entity id, sign-in URL and signing certificates), so
-- there is no secret to seal.
ALTER TABLE brands
    ADD COLUMN portal_sso_protocol text NOT NULL DEFAULT 'oidc' CHECK (portal_sso_protocol IN ('oidc', 'saml')),
    ADD COLUMN portal_saml_idp_entity_id text NOT NULL DEFAULT '',
    ADD COLUMN portal_saml_idp_sso_url text NOT NULL DEFAULT '',
    ADD COLUMN portal_saml_idp_certificates text NOT NULL DEFAULT '',
    ADD COLUMN portal_saml_email_attribute text NOT NULL DEFAULT '',
    ADD COLUMN portal_saml_name_attribute text NOT NULL DEFAULT '';

ALTER TABLE brands DROP CONSTRAINT brands_portal_oidc_config;
ALTER TABLE brands ADD CONSTRAINT brands_portal_sso_config CHECK (portal_auth_mode = 'local' OR
    (portal_sso_protocol = 'oidc' AND portal_oidc_issuer <> '' AND portal_oidc_client_id <> '' AND portal_oidc_client_secret_enc IS NOT NULL) OR
    (portal_sso_protocol = 'saml' AND portal_saml_idp_entity_id <> '' AND portal_saml_idp_sso_url <> '' AND portal_saml_idp_certificates <> ''));

ALTER TABLE customer_sessions DROP CONSTRAINT customer_sessions_method_check;
ALTER TABLE customer_sessions ADD CONSTRAINT customer_sessions_method_check CHECK (method IN ('password', 'oidc', 'saml'));

-- Assertions already accepted, so a captured response cannot be replayed within its validity.
CREATE TABLE customer_saml_assertions (
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    assertion_id text NOT NULL,
    expires_at   timestamptz NOT NULL,
    PRIMARY KEY (workspace_id, assertion_id)
);
CREATE INDEX customer_saml_assertions_expiry_idx ON customer_saml_assertions(expires_at);

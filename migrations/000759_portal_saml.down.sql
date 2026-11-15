DROP TABLE IF EXISTS customer_saml_assertions;
DELETE FROM customer_sessions WHERE method = 'saml';
ALTER TABLE customer_sessions DROP CONSTRAINT customer_sessions_method_check;
ALTER TABLE customer_sessions ADD CONSTRAINT customer_sessions_method_check CHECK (method IN ('password', 'oidc'));
UPDATE brands SET portal_auth_mode = 'local' WHERE portal_sso_protocol = 'saml';
ALTER TABLE brands DROP CONSTRAINT brands_portal_sso_config;
ALTER TABLE brands ADD CONSTRAINT brands_portal_oidc_config CHECK (portal_auth_mode = 'local' OR
    (portal_oidc_issuer <> '' AND portal_oidc_client_id <> '' AND portal_oidc_client_secret_enc IS NOT NULL));
ALTER TABLE brands
    DROP COLUMN portal_saml_name_attribute,
    DROP COLUMN portal_saml_email_attribute,
    DROP COLUMN portal_saml_idp_certificates,
    DROP COLUMN portal_saml_idp_sso_url,
    DROP COLUMN portal_saml_idp_entity_id,
    DROP COLUMN portal_sso_protocol;

-- A customer identity belongs to exactly one contact in the same workspace.
ALTER TABLE contacts ADD CONSTRAINT contacts_workspace_id_id_key UNIQUE (workspace_id, id);
CREATE TABLE customer_credentials (
    workspace_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    email citext NOT NULL,
    password_hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, contact_id),
    FOREIGN KEY (workspace_id, contact_id) REFERENCES contacts(workspace_id, id) ON DELETE CASCADE
);
CREATE TABLE customer_sessions (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    email citext NOT NULL,
    refresh_hash bytea NOT NULL UNIQUE,
    ip text NOT NULL DEFAULT '',
    user_agent text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    FOREIGN KEY (workspace_id, contact_id) REFERENCES customer_credentials(workspace_id, contact_id) ON DELETE CASCADE
);
CREATE INDEX customer_sessions_contact_idx ON customer_sessions(workspace_id, contact_id);
CREATE INDEX customer_sessions_expiry_idx ON customer_sessions(expires_at);
CREATE TABLE customer_password_resets (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    email citext NOT NULL,
    token_hash bytea NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    FOREIGN KEY (workspace_id, contact_id) REFERENCES contacts(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX customer_password_resets_contact_idx ON customer_password_resets(workspace_id, contact_id);
CREATE INDEX customer_password_resets_expiry_idx ON customer_password_resets(expires_at);

-- Every contact writer preserves the identity boundary, including imports and merges.
CREATE FUNCTION invalidate_customer_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.blocked OR NEW.email IS DISTINCT FROM OLD.email THEN
        DELETE FROM customer_credentials WHERE workspace_id = OLD.workspace_id AND contact_id = OLD.id;
        DELETE FROM customer_password_resets WHERE workspace_id = OLD.workspace_id AND contact_id = OLD.id;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER contacts_customer_identity AFTER UPDATE OF email, blocked ON contacts
    FOR EACH ROW EXECUTE FUNCTION invalidate_customer_identity();

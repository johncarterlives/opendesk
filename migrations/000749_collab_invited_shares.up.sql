-- Shared mail accounts given to someone invited to the workspace (GH#447): kept on the
-- invitation and turned into a share of the account (collab_shares.user_id) when they accept.
CREATE TABLE collab_invited_shares (
    account_id    uuid NOT NULL REFERENCES collab_accounts(id) ON DELETE CASCADE,
    invitation_id uuid NOT NULL REFERENCES invitations(id) ON DELETE CASCADE,
    workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    shared_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, invitation_id)
);
CREATE INDEX collab_invited_shares_invitation_idx ON collab_invited_shares(invitation_id);

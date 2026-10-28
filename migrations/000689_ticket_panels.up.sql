-- Ticket panels (contracts/integrations.md "Ticket panels"): read-only data about a ticket's
-- contact, from another product, shown beside the ticket. `target` is the Shopify shop domain
-- or the panel's https URL. `secret_enc` (d.Box) is, for shopify, the app's client secret when
-- `client_id` is set (OpenDesk asks Shopify for a 24-hour Admin API token with both, the client
-- credentials grant) or else an Admin API access token pasted once; for http, the signing secret
-- OpenDesk sends the URL's requests with.
CREATE TABLE ticket_panels (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('shopify', 'http')),
    name text NOT NULL,
    target text NOT NULL,
    client_id text NOT NULL DEFAULT '',
    secret_enc bytea NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    position integer NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'error')),
    last_error text NOT NULL DEFAULT '',
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ticket_panels_workspace_idx ON ticket_panels(workspace_id, position);
CREATE INDEX ticket_panels_created_by_idx ON ticket_panels(created_by) WHERE created_by IS NOT NULL;

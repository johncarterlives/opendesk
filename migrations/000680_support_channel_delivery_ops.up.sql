CREATE TABLE support_channel_dispatches (
    workspace_id uuid NOT NULL,
    event_seq bigint NOT NULL,
    status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'retrying', 'delivered', 'failed')),
    attempts integer NOT NULL DEFAULT 0,
    last_error text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    delivered_at timestamptz,
    PRIMARY KEY (workspace_id, event_seq),
    FOREIGN KEY (workspace_id, event_seq) REFERENCES events(workspace_id, seq) ON DELETE CASCADE
);

CREATE INDEX support_channel_dispatches_workspace_idx
    ON support_channel_dispatches(workspace_id, created_at DESC, event_seq DESC);

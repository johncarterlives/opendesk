ALTER TABLE collab_category_sets DROP CONSTRAINT collab_category_sets_mode_check;
ALTER TABLE collab_category_sets ADD CONSTRAINT collab_category_sets_mode_check
    CHECK (mode IN ('on', 'off', 'follow') OR (mode = 'gmail' AND scope = 'account'));
ALTER TABLE collab_accounts
    ADD COLUMN category_engine text NOT NULL DEFAULT 'off' CHECK (category_engine IN ('off', 'local', 'gmail')),
    ADD COLUMN category_epoch bigint NOT NULL DEFAULT 0,
    ADD COLUMN category_refresh jsonb;
ALTER TABLE collab_messages
    ADD COLUMN gmail_category_mask integer CHECK (gmail_category_mask BETWEEN 0 AND 31),
    ADD COLUMN gmail_category_version numeric CHECK (gmail_category_version >= 0);
ALTER TABLE collab_accounts ADD CONSTRAINT collab_accounts_category_owner UNIQUE (workspace_id, id);
ALTER TABLE collab_threads ADD CONSTRAINT collab_threads_category_owner UNIQUE (workspace_id, account_id, id);
CREATE TABLE collab_category_intents (
    thread_id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL,
    account_id uuid NOT NULL,
    id uuid NOT NULL UNIQUE,
    epoch bigint NOT NULL,
    desired text NOT NULL CHECK (desired IN ('primary', 'social', 'promotions', 'updates', 'forums')),
    state text NOT NULL CHECK (state IN ('pending', 'confirming', 'blocked', 'failed', 'applied', 'canceled')),
    error_code text NOT NULL DEFAULT '',
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (workspace_id, account_id) REFERENCES collab_accounts(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, account_id, thread_id) REFERENCES collab_threads(workspace_id, account_id, id) ON DELETE CASCADE
);
CREATE INDEX collab_category_intents_due ON collab_category_intents(account_id, updated_at)
    WHERE state IN ('pending', 'confirming', 'blocked');

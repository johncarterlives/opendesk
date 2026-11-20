-- Conversations a member moved to an inbox category by hand (contracts/collab.md "Categories",
-- "Learning from moves"): what Ollie is shown when it sorts that account's new mail. One per
-- conversation (the latest move), a bounded recent set per account and category; they go with the
-- conversation, the account and the workspace, and with a category the account no longer has.
CREATE TABLE collab_category_examples (
    thread_id     uuid PRIMARY KEY REFERENCES collab_threads(id) ON DELETE CASCADE,
    workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    account_id    uuid NOT NULL REFERENCES collab_accounts(id) ON DELETE CASCADE,
    -- The latest sender who is not the account, lower case, and their name.
    sender        text NOT NULL,
    sender_name   text NOT NULL DEFAULT '',
    subject       text NOT NULL DEFAULT '',
    snippet       text NOT NULL DEFAULT '',
    signals       text[] NOT NULL DEFAULT '{}',
    from_category text,
    category      text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX collab_category_examples_account_idx ON collab_category_examples(account_id, created_at DESC);
CREATE INDEX collab_category_examples_workspace_idx ON collab_category_examples(workspace_id);

ALTER TABLE collab_accounts ADD COLUMN handling_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE collab_threads ADD COLUMN needs_action boolean NOT NULL DEFAULT false;
CREATE INDEX collab_threads_needs_action_idx ON collab_threads(account_id, last_message_at DESC, id DESC) WHERE needs_action;

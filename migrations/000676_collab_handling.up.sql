-- Handling state (contracts/collab.md "Handling"): whether a person still has to act on a
-- conversation, kept in opendesk apart from its read state, for accounts that turn it on.

-- When the account turned handling on; NULL is off. Only mail from then on needs action.
ALTER TABLE collab_accounts ADD COLUMN handling_since timestamptz;

ALTER TABLE collab_threads
    ADD COLUMN needs_action     boolean NOT NULL DEFAULT false,
    -- Its newest message from someone else, and from the account (kept by the store).
    ADD COLUMN last_inbound_at  timestamptz,
    ADD COLUMN last_outbound_at timestamptz,
    -- Who last marked it done or needing action, and when.
    ADD COLUMN handled_at       timestamptz,
    ADD COLUMN handled_by       uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX collab_threads_needs_action_idx ON collab_threads(account_id, last_message_at DESC) WHERE needs_action;

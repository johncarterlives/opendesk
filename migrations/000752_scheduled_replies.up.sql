-- A member's reply draft can be scheduled to go out later (contracts/api.md "Reply drafts"):
-- send_at is when, send_request the rest of the reply (recipients, address, status) as the send
-- button gives it, and send_error why a scheduled send did not go out (the draft is kept).
ALTER TABLE ticket_reply_drafts
    ADD COLUMN send_at timestamptz,
    ADD COLUMN send_request jsonb,
    ADD COLUMN send_error text NOT NULL DEFAULT '';
CREATE INDEX ticket_reply_drafts_send_at_idx ON ticket_reply_drafts (send_at) WHERE send_at IS NOT NULL;

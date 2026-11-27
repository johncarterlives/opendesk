-- A member's reply draft keeps who it goes to and the address it goes from, so a refresh or
-- another device brings them back with its words (contracts/api.md "Reply drafts").
-- to_addresses NULL: the customer's reply address. mailbox_id and from_account are read back
-- only while the address is still there and the member still sees the account.
ALTER TABLE ticket_reply_drafts
    ADD COLUMN to_addresses text[],
    ADD COLUMN cc text[] NOT NULL DEFAULT '{}',
    ADD COLUMN bcc text[] NOT NULL DEFAULT '{}',
    ADD COLUMN mailbox_id uuid,
    ADD COLUMN from_account jsonb;

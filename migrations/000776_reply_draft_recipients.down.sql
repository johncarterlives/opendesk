ALTER TABLE ticket_reply_drafts
    DROP COLUMN to_addresses,
    DROP COLUMN cc,
    DROP COLUMN bcc,
    DROP COLUMN mailbox_id,
    DROP COLUMN from_account;

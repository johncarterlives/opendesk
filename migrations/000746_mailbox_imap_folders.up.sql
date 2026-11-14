-- The IMAP folders a mailbox that reads over IMAP takes mail from (contracts/api.md
-- "Mailboxes"). Empty reads INBOX alone, as before.
ALTER TABLE mailboxes ADD COLUMN imap_folders text[] NOT NULL DEFAULT '{}';

-- How far each folder other than INBOX was read. INBOX keeps imap_uid_validity and
-- imap_last_uid on the mailbox.
CREATE TABLE mailbox_imap_folders (
    mailbox_id   uuid NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name         text NOT NULL,
    uid_validity bigint NOT NULL DEFAULT 0,
    last_uid     bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (mailbox_id, name)
);
CREATE INDEX mailbox_imap_folders_workspace_idx ON mailbox_imap_folders (workspace_id);

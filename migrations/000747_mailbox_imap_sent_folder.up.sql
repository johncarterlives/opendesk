-- The IMAP folder a mailbox that reads over IMAP keeps a copy of each email it sends in
-- (contracts/api.md "Mailboxes"), through IMAP APPEND. Empty keeps none.
ALTER TABLE mailboxes ADD COLUMN imap_sent_folder text NOT NULL DEFAULT '';

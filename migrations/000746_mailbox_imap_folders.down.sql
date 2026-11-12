DROP TABLE IF EXISTS mailbox_imap_folders;
ALTER TABLE mailboxes DROP COLUMN IF EXISTS imap_folders;

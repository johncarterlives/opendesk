DROP INDEX IF EXISTS attachments_changelog_entry_idx;
DROP INDEX IF EXISTS attachments_kb_article_idx;
ALTER TABLE attachments DROP COLUMN IF EXISTS changelog_entry_id;
ALTER TABLE attachments DROP COLUMN IF EXISTS kb_article_id;

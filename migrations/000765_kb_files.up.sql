-- Files a knowledge base article or changelog entry shows (contracts/api.md "Knowledge base"):
-- an upload its body names becomes the article's or entry's own as it is saved. It is kept
-- while the article or entry is, and a published one serves it from its help center
-- (/_help/files/<id>). Deleting the article or entry hands its files to another one whose
-- body names them; the hourly sweep of unattached uploads removes those nobody names.
ALTER TABLE attachments ADD COLUMN kb_article_id uuid REFERENCES kb_articles(id) ON DELETE SET NULL;
ALTER TABLE attachments ADD COLUMN changelog_entry_id uuid REFERENCES changelog_entries(id) ON DELETE SET NULL;
CREATE INDEX attachments_kb_article_idx ON attachments(kb_article_id) WHERE kb_article_id IS NOT NULL;
CREATE INDEX attachments_changelog_entry_idx ON attachments(changelog_entry_id) WHERE changelog_entry_id IS NOT NULL;

-- Uploads still kept that an article names and that nothing else holds (no message, wiki
-- page or unsent reply draft): one such article of the same workspace holds each, a published
-- one first, then the oldest.
UPDATE attachments a SET kb_article_id = x.owner
FROM (
    SELECT DISTINCT ON (f.id) f.id, k.id AS owner
    FROM kb_articles k
    CROSS JOIN LATERAL regexp_matches(k.body_html, '/v1/attachments/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})', 'g') m
    JOIN attachments f ON f.workspace_id = k.workspace_id AND f.id = lower(m[1])::uuid
    WHERE k.body_html LIKE '%/v1/attachments/%' AND f.message_id IS NULL AND f.wiki_page_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM ticket_reply_drafts rd WHERE rd.workspace_id = f.workspace_id AND f.id = ANY(rd.attachment_ids))
    ORDER BY f.id, (k.status = 'published') DESC, k.created_at, k.id
) x
WHERE a.id = x.id AND a.kb_article_id IS NULL;

-- The same for changelog entries (one the help center shows first), among the uploads no
-- article holds.
UPDATE attachments a SET changelog_entry_id = x.owner
FROM (
    SELECT DISTINCT ON (f.id) f.id, e.id AS owner
    FROM changelog_entries e
    CROSS JOIN LATERAL regexp_matches(e.body_html, '/v1/attachments/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})', 'g') m
    JOIN attachments f ON f.workspace_id = e.workspace_id AND f.id = lower(m[1])::uuid
    WHERE e.body_html LIKE '%/v1/attachments/%' AND f.message_id IS NULL AND f.wiki_page_id IS NULL AND f.kb_article_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM ticket_reply_drafts rd WHERE rd.workspace_id = f.workspace_id AND f.id = ANY(rd.attachment_ids))
    ORDER BY f.id, (e.status = 'published' AND e.published_at <= now()) DESC, e.created_at, e.id
) x
WHERE a.id = x.id AND a.changelog_entry_id IS NULL;

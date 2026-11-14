DROP TABLE IF EXISTS kb_redirects;
DROP INDEX IF EXISTS kb_articles_slug_idx;
DROP INDEX IF EXISTS kb_articles_collection_slug_uq;
-- Fails while two collections hold articles with the same slug; rename them first.
ALTER TABLE kb_articles ADD CONSTRAINT kb_articles_workspace_id_slug_key UNIQUE (workspace_id, slug);

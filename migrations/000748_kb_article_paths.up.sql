-- An article's help-center address is /c/<collection slug>/<article slug>, or /a/<slug> for one
-- in no collection (contracts/api.md "Knowledge base"), so its slug needs to be unique only
-- among the articles of its collection.
ALTER TABLE kb_articles DROP CONSTRAINT kb_articles_workspace_id_slug_key;
CREATE UNIQUE INDEX kb_articles_collection_slug_uq ON kb_articles
    (workspace_id, COALESCE(collection_id, '00000000-0000-0000-0000-000000000000'::uuid), slug);
CREATE INDEX kb_articles_slug_idx ON kb_articles (workspace_id, slug);

-- Help-center addresses that moved: an article's old path after its slug or collection
-- changed, a collection's old /c/<slug>. They answer 301 to where it is now.
CREATE TABLE kb_redirects (
    workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    path          text NOT NULL,
    article_id    uuid REFERENCES kb_articles(id) ON DELETE CASCADE,
    collection_id uuid REFERENCES kb_collections(id) ON DELETE CASCADE,
    created_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, path),
    CHECK ((article_id IS NULL) <> (collection_id IS NULL))
);
CREATE INDEX kb_redirects_article_idx ON kb_redirects (article_id) WHERE article_id IS NOT NULL;
CREATE INDEX kb_redirects_collection_idx ON kb_redirects (collection_id) WHERE collection_id IS NOT NULL;

-- Articles in a collection lived at /a/<slug> until now: that address keeps leading to them.
INSERT INTO kb_redirects (workspace_id, path, article_id)
SELECT workspace_id, '/a/' || slug, id FROM kb_articles WHERE collection_id IS NOT NULL
ON CONFLICT (workspace_id, path) DO NOTHING;

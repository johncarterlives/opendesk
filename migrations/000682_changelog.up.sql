-- Changelog entries: product updates a workspace publishes on its help centers and through
-- the public API (contracts/api.md "Changelog"). A published entry shows from published_at,
-- so one dated in the future is scheduled.
CREATE TABLE changelog_entries (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    brand_id     uuid REFERENCES brands(id) ON DELETE CASCADE,
    title        text NOT NULL,
    slug         text NOT NULL,
    excerpt      text NOT NULL DEFAULT '',
    body_html    text NOT NULL DEFAULT '',
    categories   text[] NOT NULL DEFAULT '{}',
    status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
    author_id    uuid REFERENCES users(id) ON DELETE SET NULL,
    published_at timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    search       tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('simple', coalesce(excerpt, '')), 'B') ||
        setweight(to_tsvector('simple', regexp_replace(coalesce(body_html, ''), '<[^>]+>', ' ', 'g')), 'C')
    ) STORED,
    UNIQUE (workspace_id, slug)
);
CREATE INDEX changelog_entries_ws_published_idx ON changelog_entries(workspace_id, published_at DESC, id DESC) WHERE status = 'published';
CREATE INDEX changelog_entries_ws_updated_idx ON changelog_entries(workspace_id, updated_at DESC);
CREATE INDEX changelog_entries_search_idx ON changelog_entries USING gin(search);
CREATE INDEX changelog_entries_brand_idx ON changelog_entries(brand_id) WHERE brand_id IS NOT NULL;
CREATE INDEX changelog_entries_author_idx ON changelog_entries(author_id) WHERE author_id IS NOT NULL;

-- The AI drafting queue (contracts/collab.md "AI queue"). A claim holds a conversation
-- for one API key until it expires, so two agents never draft the same one and a stopped
-- agent never blocks it. A skip is a key handing a conversation back ("not confident"):
-- the key is not offered it again until new mail arrives (last_message_at moves on).
-- token is new on every claim: a queue worker's draft carries it, and is refused once the
-- claim it names has expired or passed to another holder.
CREATE TABLE collab_ai_claims (
    thread_id    uuid PRIMARY KEY REFERENCES collab_threads(id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    api_key_id   uuid NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
    token        uuid NOT NULL,
    claimed_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL
);
CREATE INDEX collab_ai_claims_key_idx ON collab_ai_claims(api_key_id);

CREATE TABLE collab_ai_skips (
    thread_id       uuid NOT NULL REFERENCES collab_threads(id) ON DELETE CASCADE,
    api_key_id      uuid NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
    workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    reason          text NOT NULL DEFAULT '',
    last_message_at timestamptz NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (thread_id, api_key_id)
);

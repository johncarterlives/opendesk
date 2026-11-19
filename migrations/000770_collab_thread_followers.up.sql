-- The members who follow a Collab conversation (contracts/collab.md "Mentions"): mentioned in one
-- of its comments, answered after commenting, or added by hand. It lists the conversation in their
-- Mentions box until they remove themselves. activity_at is when it last had something for them:
-- a follow, or a new comment.
CREATE TABLE collab_thread_followers (
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    thread_id    uuid NOT NULL REFERENCES collab_threads(id) ON DELETE CASCADE,
    user_id      uuid NOT NULL,
    activity_at  timestamptz NOT NULL DEFAULT now(),
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (thread_id, user_id),
    -- A member who leaves the workspace leaves what they followed in it.
    FOREIGN KEY (workspace_id, user_id) REFERENCES members(workspace_id, user_id) ON DELETE CASCADE
);
CREATE INDEX collab_thread_followers_user_idx ON collab_thread_followers(workspace_id, user_id);

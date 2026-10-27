-- The Solved and Spam folder counts (GET /v1/tickets/counts) read a workspace's solved
-- tickets from this index alone: whether each is spam, and the team and assignee that decide
-- who sees it.
CREATE INDEX IF NOT EXISTS tickets_ws_solved_count_idx ON tickets(workspace_id) INCLUDE (spam, team_id, assignee_id)
    WHERE status = 'solved' AND deleted_at IS NULL;

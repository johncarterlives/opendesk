-- Who deleted a ticket, for the trash (Settings → Trash): a member (deleted_by) or an API key
-- (deleted_by_api_key_id); neither for an automation's delete or a ticket deleted before. A
-- restore clears them. IF NOT EXISTS: an instance may have added them ahead of this release.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS deleted_by_api_key_id uuid REFERENCES api_keys(id) ON DELETE SET NULL;
-- The trash lists a workspace's deleted tickets, newest first.
CREATE INDEX IF NOT EXISTS tickets_deleted_idx ON tickets (workspace_id, deleted_at DESC, id DESC) WHERE deleted_at IS NOT NULL;
-- Removing a user sets deleted_by to null on the tickets they deleted.
CREATE INDEX IF NOT EXISTS tickets_deleted_by_idx ON tickets (deleted_by) WHERE deleted_by IS NOT NULL;

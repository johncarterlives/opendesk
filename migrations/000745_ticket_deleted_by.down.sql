DROP INDEX IF EXISTS tickets_deleted_by_idx;
DROP INDEX IF EXISTS tickets_deleted_idx;
ALTER TABLE tickets DROP COLUMN IF EXISTS deleted_by_api_key_id;
ALTER TABLE tickets DROP COLUMN IF EXISTS deleted_by;

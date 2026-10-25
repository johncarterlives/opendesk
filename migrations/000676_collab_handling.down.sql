DROP INDEX IF EXISTS collab_threads_needs_action_idx;
ALTER TABLE collab_threads
    DROP COLUMN IF EXISTS handled_by,
    DROP COLUMN IF EXISTS handled_at,
    DROP COLUMN IF EXISTS last_outbound_at,
    DROP COLUMN IF EXISTS last_inbound_at,
    DROP COLUMN IF EXISTS needs_action;
ALTER TABLE collab_accounts DROP COLUMN IF EXISTS handling_since;

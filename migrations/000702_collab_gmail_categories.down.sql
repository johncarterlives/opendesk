DROP TABLE collab_category_intents;
ALTER TABLE collab_threads DROP CONSTRAINT collab_threads_category_owner;
ALTER TABLE collab_accounts DROP CONSTRAINT collab_accounts_category_owner;
ALTER TABLE collab_messages DROP COLUMN gmail_category_mask, DROP COLUMN gmail_category_version;
ALTER TABLE collab_accounts DROP COLUMN category_engine, DROP COLUMN category_epoch, DROP COLUMN category_refresh;
UPDATE collab_category_sets SET mode = 'follow' WHERE mode = 'gmail';
ALTER TABLE collab_category_sets DROP CONSTRAINT collab_category_sets_mode_check;
ALTER TABLE collab_category_sets ADD CONSTRAINT collab_category_sets_mode_check CHECK (mode IN ('on', 'off', 'follow'));

-- Gmail push (contracts/collab.md "Push"): the topic an account is watched on and when that
-- watch is renewed next, and the newest history id Gmail pushed for it.
ALTER TABLE collab_accounts
    ADD COLUMN gmail_watch_topic text NOT NULL DEFAULT '',
    ADD COLUMN gmail_watch_at timestamptz,
    ADD COLUMN gmail_push_history numeric;

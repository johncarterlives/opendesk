-- Who may act on tickets from a support channel destination's threads (contracts/support-channels.md
-- "Access"): any linked agent (the default), only admins, and, when allowed_user_ids is not empty, only
-- those people.
ALTER TABLE support_channel_destinations
    ADD COLUMN min_role text NOT NULL DEFAULT 'agent' CHECK (min_role IN ('agent', 'admin')),
    ADD COLUMN allowed_user_ids uuid[] NOT NULL DEFAULT '{}';

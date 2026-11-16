ALTER TABLE support_channel_destinations
    DROP COLUMN IF EXISTS allowed_user_ids,
    DROP COLUMN IF EXISTS min_role;

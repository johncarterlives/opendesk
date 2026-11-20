DROP TRIGGER IF EXISTS collab_comments_reply_check ON collab_comments;
DROP FUNCTION IF EXISTS collab_comment_reply_check();
DROP INDEX IF EXISTS collab_comments_reply_idx;
ALTER TABLE collab_comments
    DROP CONSTRAINT IF EXISTS collab_comments_reply_flag,
    DROP COLUMN IF EXISTS replied,
    DROP COLUMN IF EXISTS reply_to;

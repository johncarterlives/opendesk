-- A Collab comment can reply to another comment of the same conversation (contracts/collab.md
-- "Replies"). reply_to is the comment it answers; deleting that comment clears it, and replied
-- keeps that it was a reply so the conversation can say the original was deleted.
ALTER TABLE collab_comments
    ADD COLUMN reply_to uuid REFERENCES collab_comments(id) ON DELETE SET NULL,
    ADD COLUMN replied  boolean NOT NULL DEFAULT false,
    ADD CONSTRAINT collab_comments_reply_flag CHECK (reply_to IS NULL OR replied);
CREATE INDEX collab_comments_reply_idx ON collab_comments(reply_to) WHERE reply_to IS NOT NULL;

-- A reply answers a comment in its own workspace and conversation, and never itself.
CREATE FUNCTION collab_comment_reply_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.reply_to IS NOT NULL AND (NEW.reply_to = NEW.id OR NOT EXISTS (
        SELECT 1 FROM collab_comments p
        WHERE p.id = NEW.reply_to AND p.workspace_id = NEW.workspace_id AND p.thread_id = NEW.thread_id)) THEN
        RAISE EXCEPTION 'collab comment % replies to a comment outside its conversation', NEW.id
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER collab_comments_reply_check BEFORE INSERT OR UPDATE OF reply_to, thread_id, workspace_id ON collab_comments
    FOR EACH ROW EXECUTE FUNCTION collab_comment_reply_check();

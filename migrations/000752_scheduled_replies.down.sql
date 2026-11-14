DROP INDEX IF EXISTS ticket_reply_drafts_send_at_idx;
ALTER TABLE ticket_reply_drafts DROP COLUMN IF EXISTS send_error, DROP COLUMN IF EXISTS send_request, DROP COLUMN IF EXISTS send_at;

ALTER TABLE webhooks
    DROP COLUMN IF EXISTS header_names,
    DROP COLUMN IF EXISTS headers_enc;

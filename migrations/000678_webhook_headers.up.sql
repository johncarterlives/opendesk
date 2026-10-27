ALTER TABLE webhooks
    ADD COLUMN headers_enc bytea,
    ADD COLUMN header_names text[] NOT NULL DEFAULT '{}';

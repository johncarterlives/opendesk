-- What a Shopify ticket panel shows (contracts/integrations.md "Ticket panels"): `fields` is the list
-- of Shopify's fields an admin chose (tags, email, orders_count, ...), NULL until one does, which shows
-- the defaults; `orders_shown` is how many of the contact's last orders it reads.
ALTER TABLE ticket_panels
    ADD COLUMN fields text[],
    ADD COLUMN orders_shown smallint NOT NULL DEFAULT 5 CHECK (orders_shown BETWEEN 1 AND 5);

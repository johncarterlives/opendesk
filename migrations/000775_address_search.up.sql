-- Mail addresses as search words (contracts/api.md "Search"): split at "@", dots, plus signs,
-- underscores and hyphens, so a search finds an address by its whole self (as a phrase), its
-- local part or its domain. array_to_string is only stable in general; for text[] it is a join.
CREATE FUNCTION address_words(text[]) RETURNS tsvector LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$ SELECT to_tsvector('simple', translate(array_to_string($1, ' '), '@.+_-', '     ')) $$;

-- Who a message is from, to and cc'd.
CREATE INDEX messages_addresses_idx ON messages USING gin (address_words(array_prepend(from_email, to_emails || cc_emails)));
-- A contact's primary and extra addresses.
CREATE INDEX contacts_address_idx ON contacts USING gin (address_words(ARRAY[email::text]));
CREATE INDEX contact_emails_address_idx ON contact_emails USING gin (address_words(ARRAY[email::text]));

-- The references an http ticket panel finds in a ticket (contracts/integrations.md "The http request"):
-- `reference_pattern` is the workspace's regular expression (RE2) for order and invoice numbers in the
-- ticket's subject and messages, NULL for the default, '' to send none.
ALTER TABLE ticket_panels ADD COLUMN reference_pattern text;

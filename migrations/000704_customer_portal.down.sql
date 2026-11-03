DROP TRIGGER contacts_customer_identity ON contacts;
DROP FUNCTION invalidate_customer_identity();
DROP TABLE customer_password_resets;
DROP TABLE customer_sessions;
DROP TABLE customer_credentials;
ALTER TABLE contacts DROP CONSTRAINT contacts_workspace_id_id_key;

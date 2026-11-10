-- AI notes (contracts/collab.md "AI notes", GH#431): an internal comment a collab:draft key
-- adds, written as the member who created the key and labelled with the key's name as it
-- was then, like an AI draft. Revoking or deleting the key keeps the note and its label.
ALTER TABLE collab_comments
    ADD COLUMN ai_api_key_id uuid REFERENCES api_keys(id) ON DELETE SET NULL,
    ADD COLUMN ai_client     text;

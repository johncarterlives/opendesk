-- A Collab draft an AI client saved through a member's OAuth grant (contracts/collab.md
-- "AI drafts"): the grant, so only that client may save it again, and the client's name
-- as it was then, for the "Draft by" label. Saving the draft as a person clears both.
ALTER TABLE collab_messages ADD COLUMN ai_grant_id uuid, ADD COLUMN ai_client text;

-- The categories an account's inbox was last sorted with: each one's key, name and
-- description, and whether Ollie sorted (NULL: not recorded yet). A change of categories
-- sorts again only what it can affect (contracts/collab.md "Categories").
ALTER TABLE collab_accounts ADD COLUMN category_basis jsonb;

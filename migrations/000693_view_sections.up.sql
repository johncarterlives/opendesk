-- A view's section: views that share one show together under a header that folds in the
-- sidebar (contracts/api.md, /v1/views). NULL: the view stands on its own, as before.
ALTER TABLE views ADD COLUMN section text;

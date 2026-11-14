-- Remove FreeScout import mappings; the history they brought stays.
DELETE FROM imports WHERE source = 'freescout';
ALTER TABLE imports DROP CONSTRAINT imports_source_check;
ALTER TABLE imports ADD CONSTRAINT imports_source_check
    CHECK (source IN ('zendesk', 'helpscout', 'freshdesk', 'intercom', 'front', 'csv'));

-- The collab plan is offered to every workspace (contracts/billing.md "Collab"). A workspace
-- whose Collab access an instance admin set keeps what they chose; `none` now means hidden.
ALTER TABLE subscriptions ALTER COLUMN collab_access SET DEFAULT 'offered';

UPDATE subscriptions s SET collab_access = 'offered'
WHERE s.collab_access = 'none'
  AND NOT EXISTS (
      SELECT 1 FROM admin_audit_logs l
      WHERE l.action = 'workspace.collab_changed' AND l.target_id = s.workspace_id::text
  );

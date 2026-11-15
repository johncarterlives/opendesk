ALTER TABLE subscriptions ALTER COLUMN collab_access SET DEFAULT 'none';

UPDATE subscriptions s SET collab_access = 'none'
WHERE s.collab_access = 'offered'
  AND NOT EXISTS (
      SELECT 1 FROM admin_audit_logs l
      WHERE l.action = 'workspace.collab_changed' AND l.target_id = s.workspace_id::text
  );

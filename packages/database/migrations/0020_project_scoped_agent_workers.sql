-- Agent processes own repository paths and a global Inbox cursor. Legacy
-- unscoped processes must stop before the Project-bound contract is enforced.
UPDATE worker_instances
SET status = 'stale',
    stopped_at = COALESCE(stopped_at, NOW()),
    expires_at = LEAST(expires_at, NOW())
WHERE kind = 'agent'
  AND project_id IS NULL
  AND status = 'running';

ALTER TABLE worker_instances
  DROP CONSTRAINT chk_worker_instances_project_scope;

ALTER TABLE worker_instances
  ADD CONSTRAINT chk_worker_instances_project_scope
  CHECK (
    (kind IN ('agent', 'integration') AND (
      (workspace_id IS NOT NULL AND project_id IS NOT NULL)
      OR status <> 'running'
    ))
    OR
    (kind NOT IN ('agent', 'integration') AND project_id IS NULL)
  );

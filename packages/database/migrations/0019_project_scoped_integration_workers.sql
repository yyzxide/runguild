ALTER TABLE worker_instances
  ADD COLUMN IF NOT EXISTS project_id TEXT;

-- Legacy Integration processes were not repository-scoped. Fence any live row
-- before enforcing the new registration contract; its next heartbeat fails and
-- the process exits without claiming more Worktrees.
UPDATE worker_instances
SET status = 'stale',
    stopped_at = COALESCE(stopped_at, NOW()),
    expires_at = LEAST(expires_at, NOW())
WHERE kind = 'integration'
  AND project_id IS NULL
  AND status = 'running';

ALTER TABLE worker_instances
  ADD CONSTRAINT fk_worker_instances_project_scope
  FOREIGN KEY (project_id, workspace_id)
  REFERENCES projects(id, workspace_id)
  ON DELETE CASCADE;

ALTER TABLE worker_instances
  ADD CONSTRAINT chk_worker_instances_project_scope
  CHECK (
    (kind = 'integration' AND (
      (workspace_id IS NOT NULL AND project_id IS NOT NULL)
      OR status <> 'running'
    ))
    OR
    (kind <> 'integration' AND project_id IS NULL)
  );

CREATE INDEX IF NOT EXISTS idx_worker_instances_project_kind_expiry
  ON worker_instances(workspace_id, project_id, kind, status, expires_at DESC)
  WHERE project_id IS NOT NULL;

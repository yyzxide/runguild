ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS repository_path TEXT;

CREATE TABLE IF NOT EXISTS task_worktrees (
  task_id             TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mission_id          TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  repository_path     TEXT NOT NULL,
  worktree_path       TEXT NOT NULL,
  branch_name         TEXT NOT NULL,
  base_ref            TEXT NOT NULL,
  base_commit         TEXT NOT NULL,
  head_commit         TEXT,
  integrated_commit   TEXT,
  status              TEXT NOT NULL DEFAULT 'provisioning'
                      CHECK (status IN (
                        'provisioning', 'ready', 'committed', 'integrating',
                        'integrated', 'cleanup_pending', 'removed', 'failed'
                      )),
  generation          INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
  provision_token     TEXT,
  provision_expires_at TIMESTAMPTZ,
  integration_token   TEXT,
  integration_expires_at TIMESTAMPTZ,
  cleanup_token       TEXT,
  cleanup_expires_at  TIMESTAMPTZ,
  last_error          JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  integrated_at       TIMESTAMPTZ,
  removed_at          TIMESTAMPTZ,
  UNIQUE (worktree_path),
  UNIQUE (repository_path, branch_name),
  UNIQUE (provision_token),
  UNIQUE (integration_token),
  UNIQUE (cleanup_token),
  FOREIGN KEY (task_id, mission_id) REFERENCES tasks(id, mission_id) ON DELETE CASCADE,
  FOREIGN KEY (mission_id, workspace_id, project_id)
    REFERENCES missions(id, workspace_id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, workspace_id)
    REFERENCES projects(id, workspace_id) ON DELETE CASCADE,
  CHECK (
    (status = 'provisioning' AND provision_token IS NOT NULL AND provision_expires_at IS NOT NULL)
    OR
    (status <> 'provisioning' AND provision_token IS NULL AND provision_expires_at IS NULL)
  ),
  CHECK (
    (status = 'integrating' AND integration_token IS NOT NULL AND integration_expires_at IS NOT NULL)
    OR
    (status <> 'integrating' AND integration_token IS NULL AND integration_expires_at IS NULL)
  ),
  CHECK (
    (status = 'cleanup_pending' AND cleanup_token IS NOT NULL AND cleanup_expires_at IS NOT NULL)
    OR
    (status <> 'cleanup_pending' AND cleanup_token IS NULL AND cleanup_expires_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_task_worktrees_recovery
  ON task_worktrees(status, provision_expires_at, updated_at);

CREATE OR REPLACE FUNCTION enforce_task_worktree_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  task_mission TEXT;
  mission_workspace TEXT;
  mission_project TEXT;
BEGIN
  SELECT mission_id INTO task_mission FROM tasks WHERE id = NEW.task_id;
  SELECT workspace_id, project_id INTO mission_workspace, mission_project
    FROM missions WHERE id = NEW.mission_id;
  IF task_mission IS NULL OR mission_workspace IS NULL
     OR task_mission <> NEW.mission_id
     OR mission_workspace <> NEW.workspace_id
     OR mission_project <> NEW.project_id THEN
    RAISE EXCEPTION 'Task Worktree scope does not match Task and Mission';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_task_worktree_scope ON task_worktrees;
CREATE TRIGGER trg_task_worktree_scope
BEFORE INSERT OR UPDATE OF task_id, workspace_id, mission_id, project_id
ON task_worktrees
FOR EACH ROW EXECUTE FUNCTION enforce_task_worktree_scope();

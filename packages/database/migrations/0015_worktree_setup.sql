ALTER TABLE project_runtime_configs
  ADD COLUMN IF NOT EXISTS worktree_setup_commands JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(worktree_setup_commands) = 'array'),
  ADD COLUMN IF NOT EXISTS worktree_setup_timeout_ms INTEGER NOT NULL DEFAULT 300000
    CHECK (worktree_setup_timeout_ms BETWEEN 1000 AND 900000);

CREATE TABLE IF NOT EXISTS task_worktree_setups (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mission_id          TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id             TEXT NOT NULL REFERENCES task_worktrees(task_id) ON DELETE CASCADE,
  run_id              TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  worktree_generation INTEGER NOT NULL CHECK (worktree_generation > 0),
  commands_hash       TEXT NOT NULL CHECK (commands_hash ~ '^[0-9a-f]{64}$'),
  commands            JSONB NOT NULL CHECK (jsonb_typeof(commands) = 'array'),
  status              TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  attempt             INTEGER NOT NULL DEFAULT 1 CHECK (attempt BETWEEN 1 AND 3),
  lease_token         TEXT,
  lease_expires_at    TIMESTAMPTZ,
  results             JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(results) = 'array'),
  error               JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at         TIMESTAMPTZ,
  UNIQUE (run_id, commands_hash),
  UNIQUE (lease_token),
  FOREIGN KEY (run_id, workspace_id, mission_id, task_id)
    REFERENCES agent_runs(id, workspace_id, mission_id, task_id) ON DELETE CASCADE,
  FOREIGN KEY (mission_id, workspace_id, project_id)
    REFERENCES missions(id, workspace_id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, workspace_id)
    REFERENCES projects(id, workspace_id) ON DELETE CASCADE,
  CHECK (
    (status = 'running' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND finished_at IS NULL)
    OR
    (status <> 'running' AND lease_token IS NULL AND lease_expires_at IS NULL AND finished_at IS NOT NULL)
  ),
  CHECK (
    (status = 'failed' AND error IS NOT NULL)
    OR
    (status <> 'failed' AND error IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_task_worktree_setups_recovery
  ON task_worktree_setups(status, lease_expires_at, updated_at);

CREATE INDEX IF NOT EXISTS idx_task_worktree_setups_project_recent
  ON task_worktree_setups(workspace_id, project_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_task_worktree_setups_reuse
  ON task_worktree_setups(task_id, worktree_generation, commands_hash, status, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_task_worktree_setup_succeeded
  ON task_worktree_setups(task_id, worktree_generation, commands_hash)
  WHERE status = 'succeeded';

CREATE TABLE IF NOT EXISTS project_runtime_configs (
  project_id                 TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  workspace_id               TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  worktree_root              TEXT,
  test_commands              JSONB NOT NULL DEFAULT '[["npm","test"],["npm","run","typecheck"]]'::jsonb,
  agent_context_input_tokens INTEGER NOT NULL DEFAULT 65536
                             CHECK (agent_context_input_tokens BETWEEN 256 AND 2000000),
  agent_max_test_timeout_ms   INTEGER NOT NULL DEFAULT 120000
                             CHECK (agent_max_test_timeout_ms BETWEEN 1000 AND 900000),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (project_id, workspace_id)
    REFERENCES projects(id, workspace_id) ON DELETE CASCADE,
  CHECK (jsonb_typeof(test_commands) = 'array')
);

CREATE INDEX IF NOT EXISTS idx_project_runtime_configs_workspace
  ON project_runtime_configs(workspace_id, updated_at DESC);

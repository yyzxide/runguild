CREATE TABLE IF NOT EXISTS skills (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slug            TEXT NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name            TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description     TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'disabled')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, workspace_id),
  UNIQUE (workspace_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_skills_workspace_status
  ON skills(workspace_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS skill_versions (
  id                TEXT PRIMARY KEY,
  skill_id          TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  version           INTEGER NOT NULL CHECK (version > 0),
  instructions      TEXT NOT NULL CHECK (length(instructions) BETWEEN 1 AND 65536),
  content_hash      TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  estimated_tokens  INTEGER NOT NULL CHECK (estimated_tokens > 0),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, skill_id),
  UNIQUE (skill_id, version),
  UNIQUE (skill_id, content_hash)
);
CREATE INDEX IF NOT EXISTS idx_skill_versions_latest
  ON skill_versions(skill_id, version DESC);

CREATE TABLE IF NOT EXISTS agent_skill_assignments (
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id          TEXT NOT NULL,
  skill_id          TEXT NOT NULL,
  pinned_version_id TEXT,
  priority          INTEGER NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 10000),
  enabled           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_id, skill_id),
  FOREIGN KEY (agent_id, workspace_id)
    REFERENCES agents(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (skill_id, workspace_id)
    REFERENCES skills(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (pinned_version_id, skill_id)
    REFERENCES skill_versions(id, skill_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_agent_skill_assignments_active
  ON agent_skill_assignments(agent_id, priority, skill_id) WHERE enabled;

CREATE TABLE IF NOT EXISTS context_snapshots (
  id                      TEXT PRIMARY KEY,
  workspace_id            TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mission_id              TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  task_id                 TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id                  TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  hop                     INTEGER NOT NULL CHECK (hop > 0),
  strategy                TEXT NOT NULL
                          CHECK (strategy IN ('full', 'deterministic_window_v1')),
  token_budget            INTEGER NOT NULL CHECK (token_budget > 0),
  estimated_tokens        INTEGER NOT NULL CHECK (estimated_tokens > 0),
  compacted               BOOLEAN NOT NULL,
  source_message_count    INTEGER NOT NULL CHECK (source_message_count >= 0),
  included_message_count  INTEGER NOT NULL CHECK (included_message_count >= 0),
  content_hash            TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  content                 JSONB NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, hop),
  CHECK (included_message_count <= source_message_count),
  FOREIGN KEY (run_id, workspace_id, mission_id, task_id)
    REFERENCES agent_runs(id, workspace_id, mission_id, task_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_context_snapshots_run
  ON context_snapshots(run_id, hop);

ALTER TABLE llm_calls
  ADD COLUMN IF NOT EXISTS context_snapshot_id TEXT
    REFERENCES context_snapshots(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_llm_calls_context_snapshot
  ON llm_calls(context_snapshot_id) WHERE context_snapshot_id IS NOT NULL;

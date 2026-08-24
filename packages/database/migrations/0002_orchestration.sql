CREATE TABLE IF NOT EXISTS mission_plan_revisions (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mission_id      TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  version         INTEGER NOT NULL CHECK (version > 0),
  status          TEXT NOT NULL DEFAULT 'proposed'
                  CHECK (status IN ('proposed', 'approved', 'rejected', 'superseded')),
  summary         TEXT NOT NULL,
  plan            JSONB NOT NULL,
  plan_hash       TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  approved_by     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at     TIMESTAMPTZ,
  UNIQUE (mission_id, version),
  FOREIGN KEY (mission_id, workspace_id) REFERENCES missions(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_mission_plan_hash ON mission_plan_revisions(mission_id, plan_hash);
CREATE UNIQUE INDEX IF NOT EXISTS uq_mission_proposed_plan
  ON mission_plan_revisions(mission_id) WHERE status = 'proposed';

CREATE TABLE IF NOT EXISTS task_dispatches (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mission_id      TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id        TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  run_id          TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  attempt         INTEGER NOT NULL CHECK (attempt > 0),
  dispatch_token  TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'consumed', 'expired', 'cancelled')),
  dispatch_count  INTEGER NOT NULL DEFAULT 1 CHECK (dispatch_count > 0),
  dispatched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL,
  consumed_at     TIMESTAMPTZ,
  UNIQUE (task_id, attempt),
  CHECK (expires_at > dispatched_at),
  FOREIGN KEY (mission_id, workspace_id) REFERENCES missions(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (task_id, mission_id) REFERENCES tasks(id, mission_id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id, workspace_id) REFERENCES agents(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (run_id, task_id, agent_id) REFERENCES agent_runs(id, task_id, agent_id) ON DELETE RESTRICT,
  CHECK (status <> 'consumed' OR (run_id IS NOT NULL AND consumed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_task_dispatches_pending
  ON task_dispatches(expires_at, task_id) WHERE status = 'pending';

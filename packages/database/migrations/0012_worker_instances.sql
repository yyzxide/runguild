CREATE TABLE IF NOT EXISTS worker_instances (
  id                         TEXT PRIMARY KEY,
  kind                       TEXT NOT NULL
                             CHECK (kind IN ('scheduler', 'agent', 'integration', 'evaluation')),
  workspace_id               TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id                   TEXT REFERENCES agents(id) ON DELETE CASCADE,
  status                     TEXT NOT NULL DEFAULT 'running'
                             CHECK (status IN ('running', 'stopped', 'stale')),
  hostname                   TEXT NOT NULL,
  process_id                 INTEGER NOT NULL CHECK (process_id > 0),
  heartbeat_interval_seconds INTEGER NOT NULL
                             CHECK (heartbeat_interval_seconds BETWEEN 1 AND 3600),
  heartbeat_timeout_seconds  INTEGER NOT NULL
                             CHECK (heartbeat_timeout_seconds > heartbeat_interval_seconds
                               AND heartbeat_timeout_seconds <= 10800),
  started_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_heartbeat_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at                 TIMESTAMPTZ NOT NULL,
  stopped_at                 TIMESTAMPTZ,
  FOREIGN KEY (agent_id, workspace_id)
    REFERENCES agents(id, workspace_id) ON DELETE CASCADE,
  CHECK (
    (kind = 'agent' AND agent_id IS NOT NULL AND workspace_id IS NOT NULL)
    OR
    (kind <> 'agent' AND agent_id IS NULL)
  ),
  CHECK (
    (status = 'running' AND stopped_at IS NULL)
    OR
    (status <> 'running' AND stopped_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_worker_instances_running_agent
  ON worker_instances(agent_id)
  WHERE kind = 'agent' AND status = 'running';

CREATE INDEX IF NOT EXISTS idx_worker_instances_kind_expiry
  ON worker_instances(kind, status, expires_at DESC);

CREATE INDEX IF NOT EXISTS idx_worker_instances_agent_started
  ON worker_instances(agent_id, started_at DESC)
  WHERE agent_id IS NOT NULL;

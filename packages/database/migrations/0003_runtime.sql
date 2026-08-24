ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS current_hop INTEGER NOT NULL DEFAULT 0 CHECK (current_hop >= 0),
  ADD COLUMN IF NOT EXISTS max_hops INTEGER NOT NULL DEFAULT 30 CHECK (max_hops BETWEEN 1 AND 200),
  ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completion_summary TEXT;

ALTER TABLE agent_runs
  ADD CONSTRAINT uq_agent_runs_workspace_scope
  UNIQUE (id, workspace_id),
  ADD CONSTRAINT uq_agent_runs_runtime_scope
  UNIQUE (id, workspace_id, mission_id, task_id);

CREATE TABLE IF NOT EXISTS agent_run_events (
  seq                 BIGSERIAL PRIMARY KEY,
  id                  TEXT NOT NULL UNIQUE,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mission_id          TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  task_id             TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id              TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  hop                 INTEGER NOT NULL CHECK (hop >= 0),
  kind                TEXT NOT NULL CHECK (kind IN (
                        'run_started', 'model_requested', 'model_responded',
                        'tool_requested', 'tool_completed', 'steering_applied',
                        'completion_rejected', 'run_finished'
                      )),
  data                JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (run_id, workspace_id, mission_id, task_id)
    REFERENCES agent_runs(id, workspace_id, mission_id, task_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agent_run_events_run
  ON agent_run_events(run_id, seq);

CREATE TABLE IF NOT EXISTS agent_run_messages (
  seq                 BIGSERIAL PRIMARY KEY,
  id                  TEXT NOT NULL UNIQUE,
  run_id              TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  hop                 INTEGER NOT NULL CHECK (hop >= 0),
  role                TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
  content             TEXT NOT NULL,
  tool_call_id        TEXT,
  tool_calls          JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (role = 'tool' AND tool_call_id IS NOT NULL)
    OR (role <> 'tool' AND tool_call_id IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_agent_run_messages_run
  ON agent_run_messages(run_id, seq);

CREATE TABLE IF NOT EXISTS llm_calls (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mission_id          TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  task_id             TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id              TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  hop                 INTEGER NOT NULL CHECK (hop > 0),
  provider            TEXT NOT NULL,
  model               TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
  request_hash        TEXT NOT NULL,
  request_redacted    JSONB NOT NULL,
  response_redacted   JSONB,
  provider_request_id TEXT,
  input_tokens        INTEGER CHECK (input_tokens >= 0),
  output_tokens       INTEGER CHECK (output_tokens >= 0),
  cached_input_tokens INTEGER CHECK (cached_input_tokens >= 0),
  estimated_cost_usd  NUMERIC(18, 8) CHECK (estimated_cost_usd >= 0),
  latency_ms          INTEGER CHECK (latency_ms >= 0),
  error               JSONB,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at         TIMESTAMPTZ,
  FOREIGN KEY (run_id, workspace_id, mission_id, task_id)
    REFERENCES agent_runs(id, workspace_id, mission_id, task_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_llm_calls_run ON llm_calls(run_id, hop, started_at);

CREATE TABLE IF NOT EXISTS run_control_requests (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id              TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL CHECK (kind IN ('steer', 'cancel')),
  payload             JSONB NOT NULL DEFAULT '{}'::jsonb,
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'applied', 'rejected')),
  created_by          TEXT NOT NULL,
  dedupe_key          TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_at          TIMESTAMPTZ,
  UNIQUE (run_id, dedupe_key),
  FOREIGN KEY (run_id, workspace_id)
    REFERENCES agent_runs(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_run_controls_pending
  ON run_control_requests(run_id, created_at, id) WHERE status = 'pending';

ALTER TABLE tool_executions
  ADD COLUMN IF NOT EXISTS risk TEXT NOT NULL DEFAULT 'workspace_write'
    CHECK (risk IN ('read_only', 'workspace_write', 'external_write', 'destructive')),
  ADD COLUMN IF NOT EXISTS retry_mode TEXT NOT NULL DEFAULT 'none'
    CHECK (retry_mode IN ('read_only', 'native_idempotency', 'none')),
  ADD COLUMN IF NOT EXISTS execution_token TEXT,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tool_execution_token
  ON tool_executions(execution_token) WHERE execution_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tool_executions_active_lease
  ON tool_executions(lease_expires_at) WHERE status = 'running';

ALTER TABLE tool_executions
  ADD CONSTRAINT fk_tool_execution_run_scope
    FOREIGN KEY (run_id, task_id, agent_id)
    REFERENCES agent_runs(id, task_id, agent_id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_tool_execution_task_scope
    FOREIGN KEY (task_id, mission_id)
    REFERENCES tasks(id, mission_id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_tool_execution_mission_scope
    FOREIGN KEY (mission_id, workspace_id)
    REFERENCES missions(id, workspace_id) ON DELETE CASCADE;

CREATE OR REPLACE FUNCTION enforce_tool_approval_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  execution_workspace TEXT;
  execution_mission TEXT;
  execution_run TEXT;
BEGIN
  IF NEW.subject_type <> 'tool_execution' THEN
    RETURN NEW;
  END IF;

  SELECT workspace_id, mission_id, run_id
  INTO execution_workspace, execution_mission, execution_run
  FROM tool_executions
  WHERE id = NEW.tool_execution_id;

  IF NOT FOUND
     OR execution_workspace IS DISTINCT FROM NEW.workspace_id
     OR execution_mission IS DISTINCT FROM NEW.mission_id
     OR execution_run IS DISTINCT FROM NEW.run_id THEN
    RAISE EXCEPTION 'tool approval scope must match its tool execution';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tool_approval_scope ON approvals;
CREATE TRIGGER trg_tool_approval_scope
BEFORE INSERT OR UPDATE OF workspace_id, mission_id, run_id, tool_execution_id, subject_type
ON approvals
FOR EACH ROW EXECUTE FUNCTION enforce_tool_approval_scope();

ALTER TABLE missions DROP CONSTRAINT IF EXISTS missions_budget_tokens_check;
ALTER TABLE missions ALTER COLUMN budget_tokens TYPE BIGINT;
ALTER TABLE missions ADD CONSTRAINT missions_budget_tokens_check
  CHECK (budget_tokens IS NULL OR budget_tokens >= 0);

CREATE TABLE mission_model_calls (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('planner', 'execution', 'reviewer', 'acceptance')),
  operation_id TEXT NOT NULL,
  lease_token TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'unknown', 'cancelled')),
  input_tokens BIGINT CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens BIGINT CHECK (output_tokens IS NULL OR output_tokens >= 0),
  estimated_cost_usd NUMERIC(18, 8) CHECK (estimated_cost_usd IS NULL OR estimated_cost_usd >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  FOREIGN KEY (mission_id, workspace_id) REFERENCES missions(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX idx_mission_model_calls_budget ON mission_model_calls(mission_id, status);

CREATE TABLE mission_budget_waits (
  mission_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('conversation.plan_requested', 'artifact.review_requested', 'run.control')),
  operation_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  run_id TEXT,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (mission_id, kind, operation_id),
  FOREIGN KEY (mission_id, workspace_id) REFERENCES missions(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id, workspace_id) REFERENCES agents(id, workspace_id) ON DELETE CASCADE
);

-- Historical records remain estimates: earlier Planner attempts were not retained.
INSERT INTO mission_model_calls
  (id, workspace_id, mission_id, role, operation_id, status, input_tokens, output_tokens,
   estimated_cost_usd, created_at, finished_at)
SELECT 'legacy:execution:' || id, workspace_id, mission_id, 'execution', run_id,
  CASE WHEN input_tokens IS NOT NULL AND output_tokens IS NOT NULL THEN 'completed' ELSE 'unknown' END,
  input_tokens, output_tokens, estimated_cost_usd, started_at, finished_at
FROM llm_calls;

INSERT INTO mission_model_calls
  (id, workspace_id, mission_id, role, operation_id, status, input_tokens, output_tokens,
   estimated_cost_usd, created_at, finished_at)
SELECT 'legacy:reviewer:' || id, workspace_id, mission_id, 'reviewer', review_id,
  'completed', input_tokens, output_tokens, estimated_cost_usd, created_at, created_at
FROM reviewer_model_calls;

-- Failed requests without a response never reached the historical review ledger.
INSERT INTO mission_model_calls (id, workspace_id, mission_id, role, operation_id, status)
SELECT 'legacy:reviewer:unrecorded:' || e.review_id || ':' || attempt_number,
  e.workspace_id, e.mission_id, 'reviewer', e.review_id, 'unknown'
FROM review_executions e CROSS JOIN LATERAL generate_series(1, e.attempt) AS attempt_number
WHERE NOT EXISTS (SELECT 1 FROM reviewer_model_calls c
  WHERE c.review_id = e.review_id AND c.attempt = attempt_number);

INSERT INTO mission_model_calls
  (id, workspace_id, mission_id, role, operation_id, status, input_tokens, output_tokens,
   estimated_cost_usd, created_at, finished_at)
SELECT 'legacy:planner:' || id, workspace_id, mission_id, 'planner', id,
  CASE WHEN input_tokens IS NOT NULL AND output_tokens IS NOT NULL THEN 'completed' ELSE 'unknown' END,
  input_tokens, output_tokens, estimated_cost_usd, created_at, updated_at
FROM conversation_planning_requests WHERE attempt > 0;

-- A retried Planner may have made additional calls whose usage was overwritten.
INSERT INTO mission_model_calls (id, workspace_id, mission_id, role, operation_id, status)
SELECT 'legacy:planner:unrecorded:' || id, workspace_id, mission_id, 'planner', id, 'unknown'
FROM conversation_planning_requests WHERE attempt > 1;

CREATE FUNCTION runguild_mission_budget_available(target_mission_id TEXT)
RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
  SELECT budget_tokens IS NULL OR (
    NOT EXISTS (SELECT 1 FROM mission_model_calls c WHERE c.mission_id = m.id AND c.status = 'unknown')
    AND COALESCE((SELECT SUM(COALESCE(c.input_tokens, 0) + COALESCE(c.output_tokens, 0))
      FROM mission_model_calls c WHERE c.mission_id = m.id AND c.status = 'completed'), 0) < budget_tokens
  ) FROM missions m WHERE m.id = target_mission_id
$$;

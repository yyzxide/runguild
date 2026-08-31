ALTER TABLE review_executions
  ADD COLUMN IF NOT EXISTS cached_input_tokens INTEGER
    CHECK (cached_input_tokens IS NULL OR cached_input_tokens >= 0);

ALTER TABLE review_executions
  ADD CONSTRAINT uq_review_executions_model_call_scope
  UNIQUE (review_id, workspace_id, mission_id, task_id);

CREATE TABLE IF NOT EXISTS reviewer_model_calls (
  id                  TEXT PRIMARY KEY,
  review_id           TEXT NOT NULL,
  workspace_id        TEXT NOT NULL,
  mission_id          TEXT NOT NULL,
  task_id             TEXT NOT NULL,
  attempt             INTEGER NOT NULL CHECK (attempt > 0),
  status              TEXT NOT NULL CHECK (status IN ('succeeded', 'invalid')),
  provider            TEXT NOT NULL,
  model               TEXT NOT NULL,
  provider_request_id TEXT,
  input_tokens        INTEGER NOT NULL CHECK (input_tokens >= 0),
  output_tokens       INTEGER NOT NULL CHECK (output_tokens >= 0),
  cached_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cached_input_tokens >= 0),
  estimated_cost_usd  NUMERIC(18, 8)
                      CHECK (estimated_cost_usd IS NULL OR estimated_cost_usd >= 0),
  latency_ms          INTEGER NOT NULL CHECK (latency_ms >= 0),
  error               JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (review_id, attempt),
  FOREIGN KEY (review_id, workspace_id, mission_id, task_id)
    REFERENCES review_executions(review_id, workspace_id, mission_id, task_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_reviewer_model_calls_mission
  ON reviewer_model_calls(mission_id, created_at, id);

INSERT INTO reviewer_model_calls (
  id, review_id, workspace_id, mission_id, task_id, attempt, status,
  provider, model, provider_request_id, input_tokens, output_tokens,
  cached_input_tokens, estimated_cost_usd, latency_ms, error, created_at
)
SELECT
  'review_model_call_backfill_' || execution.review_id,
  execution.review_id,
  execution.workspace_id,
  execution.mission_id,
  execution.task_id,
  execution.attempt,
  CASE WHEN execution.decision IS NULL THEN 'invalid' ELSE 'succeeded' END,
  execution.model_provider,
  execution.model_name,
  execution.provider_request_id,
  execution.input_tokens,
  execution.output_tokens,
  COALESCE(execution.cached_input_tokens, 0),
  execution.estimated_cost_usd,
  COALESCE(execution.latency_ms, 0),
  execution.error,
  execution.updated_at
FROM review_executions execution
WHERE execution.attempt > 0
  AND execution.input_tokens IS NOT NULL
  AND execution.output_tokens IS NOT NULL
ON CONFLICT (review_id, attempt) DO NOTHING;

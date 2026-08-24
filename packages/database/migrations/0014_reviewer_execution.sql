CREATE TABLE IF NOT EXISTS review_executions (
  review_id           TEXT PRIMARY KEY REFERENCES reviews(id) ON DELETE CASCADE,
  workspace_id        TEXT NOT NULL,
  mission_id          TEXT NOT NULL,
  task_id             TEXT NOT NULL,
  submission_id       TEXT NOT NULL,
  reviewer_agent_id   TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued', 'running', 'model_complete', 'completed', 'failed', 'cancelled')),
  attempt             INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts        INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  lease_token         TEXT,
  lease_expires_at    TIMESTAMPTZ,
  materials_snapshot  JSONB,
  prompt_snapshot     JSONB,
  response_snapshot   JSONB,
  decision            JSONB,
  decision_hash       TEXT,
  model_provider      TEXT NOT NULL,
  model_name          TEXT NOT NULL,
  provider_request_id TEXT,
  input_tokens        INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens       INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  estimated_cost_usd  NUMERIC(18, 8) CHECK (estimated_cost_usd IS NULL OR estimated_cost_usd >= 0),
  latency_ms          INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  error               JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at          TIMESTAMPTZ,
  finished_at         TIMESTAMPTZ,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (mission_id, workspace_id) REFERENCES missions(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (task_id, mission_id) REFERENCES tasks(id, mission_id) ON DELETE CASCADE,
  FOREIGN KEY (reviewer_agent_id, workspace_id) REFERENCES agents(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (submission_id) REFERENCES task_submissions(id) ON DELETE CASCADE,
  CHECK (
    (status = 'running' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status <> 'running')
  ),
  CHECK (
    status NOT IN ('model_complete', 'completed')
    OR (decision IS NOT NULL AND decision_hash IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_review_executions_agent_pending
  ON review_executions(reviewer_agent_id, status, lease_expires_at, created_at)
  WHERE status IN ('queued', 'running', 'model_complete');

CREATE OR REPLACE FUNCTION runguild_validate_review_execution()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM reviews review
    WHERE review.id = NEW.review_id
      AND review.workspace_id = NEW.workspace_id
      AND review.mission_id = NEW.mission_id
      AND review.task_id = NEW.task_id
      AND review.submission_id = NEW.submission_id
      AND review.reviewer_kind = 'agent'
      AND review.reviewer_id = NEW.reviewer_agent_id
  ) THEN
    RAISE EXCEPTION 'Reviewer execution scope does not match its Review';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_review_execution ON review_executions;
CREATE TRIGGER trg_validate_review_execution
BEFORE INSERT OR UPDATE OF review_id, workspace_id, mission_id, task_id, submission_id, reviewer_agent_id
ON review_executions
FOR EACH ROW EXECUTE FUNCTION runguild_validate_review_execution();

CREATE TABLE IF NOT EXISTS workspaces (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  display_name    TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, workspace_id)
);

CREATE TABLE IF NOT EXISTS projects (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  repository_url  TEXT,
  default_branch  TEXT NOT NULL DEFAULT 'main',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, workspace_id)
);
CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspace_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS agents (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('planner', 'researcher', 'builder', 'reviewer', 'custom')),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'disabled')),
  model_provider  TEXT NOT NULL,
  model_name      TEXT NOT NULL,
  permissions     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, workspace_id)
);
CREATE INDEX IF NOT EXISTS idx_agents_workspace_status ON agents(workspace_id, status);

CREATE TABLE IF NOT EXISTS conversations (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (project_id, workspace_id) REFERENCES projects(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  author_kind     TEXT NOT NULL CHECK (author_kind IN ('user', 'agent', 'system')),
  author_id       TEXT NOT NULL,
  body            TEXT NOT NULL,
  entity_refs     JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_idempotency
  ON messages(workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at, id);

CREATE TABLE IF NOT EXISTS missions (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  conversation_id     TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  title               TEXT NOT NULL,
  goal                TEXT NOT NULL,
  constraints         JSONB NOT NULL DEFAULT '[]'::jsonb,
  acceptance_criteria JSONB NOT NULL DEFAULT '[]'::jsonb,
  status              TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'planning', 'awaiting_approval', 'running', 'paused', 'reviewing', 'completed', 'failed', 'cancelled')),
  plan_version        INTEGER NOT NULL DEFAULT 0 CHECK (plan_version >= 0),
  budget_tokens       BIGINT CHECK (budget_tokens IS NULL OR budget_tokens > 0),
  budget_cents        BIGINT CHECK (budget_cents IS NULL OR budget_cents > 0),
  created_by          TEXT NOT NULL,
  approved_by         TEXT,
  approved_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (project_id, workspace_id) REFERENCES projects(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_missions_project_status ON missions(project_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS tasks (
  id                  TEXT PRIMARY KEY,
  mission_id          TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  title               TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  status              TEXT NOT NULL DEFAULT 'blocked'
                      CHECK (status IN ('blocked', 'ready', 'claimed', 'running', 'waiting_human', 'reviewing', 'completed', 'failed', 'cancelled')),
  required_role       TEXT CHECK (required_role IS NULL OR required_role IN ('planner', 'researcher', 'builder', 'reviewer', 'custom')),
  priority            INTEGER NOT NULL DEFAULT 100,
  position            INTEGER NOT NULL DEFAULT 0,
  attempt_count       INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts        INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  review_required     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at        TIMESTAMPTZ,
  UNIQUE (id, mission_id)
);
CREATE INDEX IF NOT EXISTS idx_tasks_schedulable ON tasks(status, priority, created_at)
  WHERE status IN ('ready', 'claimed', 'running', 'waiting_human');
CREATE INDEX IF NOT EXISTS idx_tasks_mission ON tasks(mission_id, position, created_at);

CREATE TABLE IF NOT EXISTS task_dependencies (
  mission_id          TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  task_id             TEXT NOT NULL,
  depends_on_task_id  TEXT NOT NULL,
  required            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id),
  FOREIGN KEY (task_id, mission_id) REFERENCES tasks(id, mission_id) ON DELETE CASCADE,
  FOREIGN KEY (depends_on_task_id, mission_id) REFERENCES tasks(id, mission_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_task_dependencies_parent ON task_dependencies(depends_on_task_id, task_id);

CREATE TABLE IF NOT EXISTS task_acceptance_criteria (
  id                      TEXT PRIMARY KEY,
  task_id                 TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  criterion_key           TEXT NOT NULL,
  description             TEXT NOT NULL,
  required                BOOLEAN NOT NULL DEFAULT TRUE,
  required_evidence_kinds TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (task_id, criterion_key)
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mission_id          TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  task_id             TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id            TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  attempt             INTEGER NOT NULL CHECK (attempt > 0),
  status              TEXT NOT NULL
                      CHECK (status IN ('queued', 'starting', 'running', 'waiting_tool', 'waiting_human', 'succeeded', 'failed', 'cancelled', 'timed_out')),
  context_snapshot    JSONB NOT NULL DEFAULT '{}'::jsonb,
  result              JSONB,
  error               JSONB,
  started_at          TIMESTAMPTZ,
  finished_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (task_id, attempt),
  UNIQUE (id, task_id, agent_id),
  FOREIGN KEY (mission_id, workspace_id) REFERENCES missions(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (task_id, mission_id) REFERENCES tasks(id, mission_id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id, workspace_id) REFERENCES agents(id, workspace_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_task ON agent_runs(task_id, attempt DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_status ON agent_runs(agent_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS task_leases (
  task_id             TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  run_id              TEXT NOT NULL UNIQUE,
  agent_id            TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  lease_token         TEXT NOT NULL UNIQUE,
  acquired_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  heartbeat_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at          TIMESTAMPTZ NOT NULL,
  CHECK (expires_at > heartbeat_at),
  FOREIGN KEY (run_id, task_id, agent_id) REFERENCES agent_runs(id, task_id, agent_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_task_leases_expiry ON task_leases(expires_at);

CREATE TABLE IF NOT EXISTS inbox_messages (
  seq                 BIGSERIAL PRIMARY KEY,
  id                  TEXT NOT NULL UNIQUE,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id            TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  mission_id          TEXT REFERENCES missions(id) ON DELETE CASCADE,
  run_id              TEXT REFERENCES agent_runs(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL,
  payload             JSONB NOT NULL,
  payload_hash        TEXT NOT NULL,
  dedupe_key          TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (agent_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_inbox_agent_seq ON inbox_messages(agent_id, seq);

CREATE TABLE IF NOT EXISTS inbox_cursors (
  agent_id            TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  last_seq            BIGINT NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS domain_events (
  id                  TEXT PRIMARY KEY,
  schema_version      INTEGER NOT NULL,
  event_type          TEXT NOT NULL,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  mission_id          TEXT REFERENCES missions(id) ON DELETE CASCADE,
  actor               JSONB NOT NULL,
  correlation_id      TEXT NOT NULL,
  causation_id        TEXT,
  idempotency_key     TEXT,
  payload             JSONB NOT NULL,
  occurred_at         TIMESTAMPTZ NOT NULL,
  recorded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_domain_events_mission ON domain_events(mission_id, occurred_at, id);
CREATE INDEX IF NOT EXISTS idx_domain_events_correlation ON domain_events(correlation_id, occurred_at);

CREATE TABLE IF NOT EXISTS outbox_events (
  id                  TEXT PRIMARY KEY,
  topic               TEXT NOT NULL,
  partition_key       TEXT NOT NULL,
  payload             JSONB NOT NULL,
  available_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at        TIMESTAMPTZ,
  attempts            INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error          TEXT,
  claim_token         TEXT,
  claim_expires_at    TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox_events(available_at, created_at)
  WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS tool_executions (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mission_id          TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  task_id             TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id              TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  agent_id            TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  action              TEXT NOT NULL,
  idempotency_key     TEXT NOT NULL,
  request_hash        TEXT NOT NULL,
  request             JSONB NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('reserved', 'running', 'awaiting_approval', 'succeeded', 'failed')),
  effect_state        TEXT NOT NULL DEFAULT 'none' CHECK (effect_state IN ('none', 'partial', 'complete', 'unknown')),
  result              JSONB,
  error               JSONB,
  started_at          TIMESTAMPTZ,
  finished_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_tool_executions_run ON tool_executions(run_id, created_at);

CREATE TABLE IF NOT EXISTS artifacts (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  mission_id          TEXT REFERENCES missions(id) ON DELETE CASCADE,
  title               TEXT NOT NULL,
  kind                TEXT NOT NULL DEFAULT 'document',
  created_by          TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_artifacts_mission ON artifacts(mission_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS artifact_yjs_updates (
  seq                 BIGSERIAL PRIMARY KEY,
  artifact_id         TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  update_hash         TEXT NOT NULL,
  update_bytes        BYTEA NOT NULL,
  origin              JSONB NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (artifact_id, update_hash)
);
CREATE INDEX IF NOT EXISTS idx_artifact_updates_replay ON artifact_yjs_updates(artifact_id, seq);

CREATE TABLE IF NOT EXISTS artifact_yjs_snapshots (
  artifact_id         TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
  state_bytes         BYTEA NOT NULL,
  state_hash          TEXT NOT NULL,
  through_update_seq  BIGINT NOT NULL DEFAULT 0,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS artifact_versions (
  id                  TEXT PRIMARY KEY,
  artifact_id         TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  version             INTEGER NOT NULL CHECK (version > 0),
  content             JSONB NOT NULL,
  yjs_state_bytes     BYTEA NOT NULL,
  content_hash        TEXT NOT NULL,
  yjs_state_hash      TEXT NOT NULL,
  created_by_run_id   TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (artifact_id, version),
  UNIQUE (artifact_id, content_hash)
);

CREATE TABLE IF NOT EXISTS task_submissions (
  id                      TEXT PRIMARY KEY,
  workspace_id            TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mission_id              TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  task_id                 TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id                  TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE RESTRICT,
  artifact_version_id     TEXT NOT NULL REFERENCES artifact_versions(id) ON DELETE RESTRICT,
  submitted_by_agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  status                  TEXT NOT NULL DEFAULT 'submitted'
                          CHECK (status IN ('submitted', 'in_review', 'approved', 'rejected', 'superseded')),
  evidence_bundle_hash    TEXT NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_task_submissions_task ON task_submissions(task_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_task_active_submission ON task_submissions(task_id)
  WHERE status IN ('submitted', 'in_review', 'approved');

CREATE OR REPLACE FUNCTION enforce_task_submission_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  run_workspace TEXT;
  run_mission TEXT;
  run_task TEXT;
  run_agent TEXT;
  artifact_workspace TEXT;
  artifact_mission TEXT;
BEGIN
  SELECT workspace_id, mission_id, task_id, agent_id
    INTO run_workspace, run_mission, run_task, run_agent
    FROM agent_runs
   WHERE id = NEW.run_id;
  SELECT a.workspace_id, a.mission_id
    INTO artifact_workspace, artifact_mission
    FROM artifact_versions v
    JOIN artifacts a ON a.id = v.artifact_id
   WHERE v.id = NEW.artifact_version_id;

  IF run_task IS NULL OR artifact_workspace IS NULL THEN
    RAISE EXCEPTION 'submission run or artifact version does not exist';
  END IF;
  IF run_workspace <> NEW.workspace_id
     OR run_mission <> NEW.mission_id
     OR run_task <> NEW.task_id
     OR run_agent <> NEW.submitted_by_agent_id THEN
    RAISE EXCEPTION 'submission scope does not match run';
  END IF;
  IF artifact_workspace <> NEW.workspace_id
     OR artifact_mission IS NULL
     OR artifact_mission <> NEW.mission_id THEN
    RAISE EXCEPTION 'submission scope does not match artifact';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_task_submission_scope ON task_submissions;
CREATE TRIGGER trg_task_submission_scope
BEFORE INSERT OR UPDATE OF workspace_id, mission_id, task_id, run_id, artifact_version_id, submitted_by_agent_id
ON task_submissions
FOR EACH ROW EXECUTE FUNCTION enforce_task_submission_scope();

CREATE TABLE IF NOT EXISTS evidence (
  id                      TEXT PRIMARY KEY,
  workspace_id            TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mission_id              TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  task_id                 TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id                  TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  acceptance_criterion_id TEXT REFERENCES task_acceptance_criteria(id) ON DELETE SET NULL,
  kind                    TEXT NOT NULL CHECK (kind IN ('test_run', 'command_result', 'file_diff', 'artifact_version', 'trace_span', 'citation', 'human_attestation')),
  uri                     TEXT NOT NULL,
  content_hash            TEXT,
  metadata                JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at              TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_evidence_task ON evidence(task_id, acceptance_criterion_id, kind);

CREATE OR REPLACE FUNCTION enforce_evidence_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  criterion_task TEXT;
  run_workspace TEXT;
  run_mission TEXT;
  run_task TEXT;
BEGIN
  IF NEW.acceptance_criterion_id IS NOT NULL THEN
    SELECT task_id INTO criterion_task
      FROM task_acceptance_criteria
     WHERE id = NEW.acceptance_criterion_id;
    IF criterion_task IS NULL OR criterion_task <> NEW.task_id THEN
      RAISE EXCEPTION 'evidence criterion does not belong to task';
    END IF;
  END IF;

  IF NEW.run_id IS NOT NULL THEN
    SELECT workspace_id, mission_id, task_id
      INTO run_workspace, run_mission, run_task
      FROM agent_runs
     WHERE id = NEW.run_id;
    IF run_workspace IS NULL
       OR run_workspace <> NEW.workspace_id
       OR run_mission <> NEW.mission_id
       OR run_task <> NEW.task_id THEN
      RAISE EXCEPTION 'evidence scope does not match run';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_evidence_scope ON evidence;
CREATE TRIGGER trg_evidence_scope
BEFORE INSERT OR UPDATE OF workspace_id, mission_id, task_id, run_id, acceptance_criterion_id
ON evidence
FOR EACH ROW EXECUTE FUNCTION enforce_evidence_scope();

CREATE TABLE IF NOT EXISTS reviews (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mission_id          TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  task_id             TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  submission_id       TEXT NOT NULL REFERENCES task_submissions(id) ON DELETE RESTRICT,
  reviewer_agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  status              TEXT NOT NULL CHECK (status IN ('requested', 'in_progress', 'approved', 'rejected', 'changes_requested', 'cancelled')),
  findings            JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_reviews_task ON reviews(task_id, created_at DESC);

CREATE OR REPLACE FUNCTION enforce_review_submission_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  submission_workspace TEXT;
  submission_mission TEXT;
  submission_task TEXT;
  submission_builder TEXT;
BEGIN
  SELECT workspace_id, mission_id, task_id, submitted_by_agent_id
    INTO submission_workspace, submission_mission, submission_task, submission_builder
    FROM task_submissions
   WHERE id = NEW.submission_id;

  IF submission_task IS NULL THEN
    RAISE EXCEPTION 'review submission does not exist';
  END IF;
  IF submission_workspace <> NEW.workspace_id
     OR submission_mission <> NEW.mission_id
     OR submission_task <> NEW.task_id THEN
    RAISE EXCEPTION 'review scope does not match submission';
  END IF;
  IF submission_builder = NEW.reviewer_agent_id THEN
    RAISE EXCEPTION 'builder and reviewer must be different agents';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_review_submission_scope ON reviews;
CREATE TRIGGER trg_review_submission_scope
BEFORE INSERT OR UPDATE OF submission_id, reviewer_agent_id, workspace_id, mission_id, task_id
ON reviews
FOR EACH ROW EXECUTE FUNCTION enforce_review_submission_scope();

CREATE TABLE IF NOT EXISTS review_evidence (
  review_id           TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  evidence_id         TEXT NOT NULL REFERENCES evidence(id) ON DELETE RESTRICT,
  PRIMARY KEY (review_id, evidence_id)
);

CREATE TABLE IF NOT EXISTS approvals (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mission_id          TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  run_id              TEXT REFERENCES agent_runs(id) ON DELETE CASCADE,
  tool_execution_id   TEXT REFERENCES tool_executions(id) ON DELETE CASCADE,
  artifact_version_id TEXT REFERENCES artifact_versions(id) ON DELETE CASCADE,
  subject_type        TEXT NOT NULL CHECK (subject_type IN ('mission', 'run', 'tool_execution', 'artifact_version')),
  subject_id          TEXT NOT NULL,
  kind                TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'cancelled')),
  requested_by        TEXT NOT NULL,
  resolved_by         TEXT,
  reason              TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at         TIMESTAMPTZ,
  CHECK (
    (subject_type = 'mission' AND subject_id = mission_id)
    OR (subject_type = 'run' AND run_id IS NOT NULL AND subject_id = run_id)
    OR (subject_type = 'tool_execution' AND tool_execution_id IS NOT NULL AND subject_id = tool_execution_id)
    OR (subject_type = 'artifact_version' AND artifact_version_id IS NOT NULL AND subject_id = artifact_version_id)
  )
);
CREATE INDEX IF NOT EXISTS idx_approvals_pending ON approvals(workspace_id, created_at)
  WHERE status = 'pending';

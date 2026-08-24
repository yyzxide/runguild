ALTER TABLE missions
  ADD COLUMN IF NOT EXISTS source_message_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE TABLE IF NOT EXISTS conversation_planning_requests (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL,
  project_id          TEXT NOT NULL,
  conversation_id     TEXT NOT NULL,
  mission_id          TEXT NOT NULL,
  planner_agent_id    TEXT NOT NULL,
  source_message_ids  TEXT[] NOT NULL,
  status              TEXT NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued', 'running', 'model_complete', 'awaiting_approval', 'approved', 'failed')),
  attempt             INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts        INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  idempotency_key     TEXT,
  request_hash        TEXT NOT NULL,
  lease_token         TEXT,
  lease_expires_at    TIMESTAMPTZ,
  prompt_snapshot     JSONB,
  response_snapshot   JSONB,
  plan                JSONB,
  plan_hash           TEXT,
  plan_version        INTEGER CHECK (plan_version IS NULL OR plan_version > 0),
  model_provider      TEXT,
  model_name          TEXT,
  provider_request_id TEXT,
  input_tokens        INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens       INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  estimated_cost_usd  NUMERIC(18, 8) CHECK (estimated_cost_usd IS NULL OR estimated_cost_usd >= 0),
  latency_ms          INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  error               JSONB,
  created_by          TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at          TIMESTAMPTZ,
  finished_at         TIMESTAMPTZ,
  UNIQUE (mission_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, workspace_id) REFERENCES projects(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id, workspace_id) REFERENCES conversations(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (mission_id, workspace_id) REFERENCES missions(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (planner_agent_id, workspace_id) REFERENCES agents(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by, workspace_id) REFERENCES users(id, workspace_id) ON DELETE RESTRICT,
  CHECK (cardinality(source_message_ids) BETWEEN 1 AND 50),
  CHECK (
    (status = 'running' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status <> 'running')
  ),
  CHECK (
    status NOT IN ('model_complete', 'awaiting_approval', 'approved')
    OR (plan IS NOT NULL AND plan_hash IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_conversation_planning_idempotency
  ON conversation_planning_requests(workspace_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conversation_planning_agent_pending
  ON conversation_planning_requests(planner_agent_id, status, lease_expires_at, created_at)
  WHERE status IN ('queued', 'running', 'model_complete');

CREATE OR REPLACE FUNCTION runguild_validate_mission_source_messages()
RETURNS TRIGGER AS $$
BEGIN
  IF cardinality(NEW.source_message_ids) = 0 THEN
    RETURN NEW;
  END IF;
  IF NEW.conversation_id IS NULL THEN
    RAISE EXCEPTION 'Mission source messages require a Conversation';
  END IF;
  IF cardinality(NEW.source_message_ids) <> (
    SELECT COUNT(DISTINCT source_id)::INTEGER FROM unnest(NEW.source_message_ids) source_id
  ) THEN
    RAISE EXCEPTION 'Mission source messages must be unique';
  END IF;
  IF cardinality(NEW.source_message_ids) <> (
    SELECT COUNT(*)::INTEGER FROM messages message
    WHERE message.id = ANY(NEW.source_message_ids)
      AND message.workspace_id = NEW.workspace_id
      AND message.conversation_id = NEW.conversation_id
  ) THEN
    RAISE EXCEPTION 'Mission source message is outside its Conversation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_mission_source_messages ON missions;
CREATE TRIGGER trg_validate_mission_source_messages
BEFORE INSERT OR UPDATE OF workspace_id, conversation_id, source_message_ids ON missions
FOR EACH ROW EXECUTE FUNCTION runguild_validate_mission_source_messages();

CREATE OR REPLACE FUNCTION runguild_validate_conversation_planning_request()
RETURNS TRIGGER AS $$
BEGIN
  IF cardinality(NEW.source_message_ids) <> (
    SELECT COUNT(DISTINCT source_id)::INTEGER FROM unnest(NEW.source_message_ids) source_id
  ) THEN
    RAISE EXCEPTION 'Planning request source messages must be unique';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM conversations conversation
    WHERE conversation.id = NEW.conversation_id
      AND conversation.workspace_id = NEW.workspace_id
      AND conversation.project_id = NEW.project_id
  ) THEN
    RAISE EXCEPTION 'Planning request Conversation scope is invalid';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM missions mission
    WHERE mission.id = NEW.mission_id
      AND mission.workspace_id = NEW.workspace_id
      AND mission.project_id = NEW.project_id
      AND mission.conversation_id = NEW.conversation_id
      AND mission.source_message_ids = NEW.source_message_ids
  ) THEN
    RAISE EXCEPTION 'Planning request Mission scope is invalid';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM agents agent
    JOIN conversation_members member
      ON member.conversation_id = NEW.conversation_id
      AND member.workspace_id = NEW.workspace_id
      AND member.participant_kind = 'agent'
      AND member.participant_id = agent.id
    WHERE agent.id = NEW.planner_agent_id
      AND agent.workspace_id = NEW.workspace_id
      AND agent.role = 'planner'
      AND agent.status = 'active'
  ) THEN
    RAISE EXCEPTION 'Planning request requires an active Planner in the Conversation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_conversation_planning_request ON conversation_planning_requests;
CREATE TRIGGER trg_validate_conversation_planning_request
BEFORE INSERT OR UPDATE OF workspace_id, project_id, conversation_id, mission_id,
  planner_agent_id, source_message_ids
ON conversation_planning_requests
FOR EACH ROW EXECUTE FUNCTION runguild_validate_conversation_planning_request();

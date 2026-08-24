ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'project_room'
  CHECK (kind IN ('project_room', 'mission_room', 'group'));

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id   TEXT NOT NULL,
  workspace_id      TEXT NOT NULL,
  participant_kind  TEXT NOT NULL CHECK (participant_kind IN ('user', 'agent')),
  participant_id    TEXT NOT NULL,
  notifications     BOOLEAN NOT NULL DEFAULT TRUE,
  joined_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (conversation_id, participant_kind, participant_id),
  FOREIGN KEY (conversation_id, workspace_id)
    REFERENCES conversations(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_conversation_members_participant
  ON conversation_members(workspace_id, participant_kind, participant_id, conversation_id);

ALTER TABLE messages ADD COLUMN IF NOT EXISTS sequence BIGSERIAL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS mentioned_agent_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE messages
  ADD CONSTRAINT uq_messages_conversation_sequence UNIQUE (conversation_id, sequence);
ALTER TABLE messages
  ADD CONSTRAINT uq_messages_id_conversation UNIQUE (id, conversation_id);
ALTER TABLE messages
  ADD CONSTRAINT fk_messages_conversation_workspace
  FOREIGN KEY (conversation_id, workspace_id)
  REFERENCES conversations(id, workspace_id) ON DELETE CASCADE;

CREATE TABLE IF NOT EXISTS conversation_message_deliveries (
  message_id        TEXT NOT NULL,
  conversation_id   TEXT NOT NULL,
  agent_id          TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  run_id            TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  status            TEXT NOT NULL CHECK (status IN ('steered', 'context_pending', 'context_loaded')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at      TIMESTAMPTZ,
  PRIMARY KEY (message_id, agent_id),
  FOREIGN KEY (message_id, conversation_id)
    REFERENCES messages(id, conversation_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_conversation_message_deliveries_agent
  ON conversation_message_deliveries(agent_id, status, created_at);

CREATE OR REPLACE FUNCTION runguild_validate_conversation_member()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.participant_kind = 'user' THEN
    IF NOT EXISTS (
      SELECT 1 FROM users
      WHERE id = NEW.participant_id AND workspace_id = NEW.workspace_id
    ) THEN
      RAISE EXCEPTION 'Conversation user is outside its Workspace';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1 FROM agents
    WHERE id = NEW.participant_id AND workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'Conversation Agent is outside its Workspace';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_conversation_member ON conversation_members;
CREATE TRIGGER trg_validate_conversation_member
BEFORE INSERT OR UPDATE ON conversation_members
FOR EACH ROW EXECUTE FUNCTION runguild_validate_conversation_member();

CREATE OR REPLACE FUNCTION runguild_validate_conversation_message()
RETURNS TRIGGER AS $$
DECLARE
  conversation_workspace TEXT;
  conversation_project TEXT;
BEGIN
  SELECT workspace_id, project_id INTO conversation_workspace, conversation_project
  FROM conversations WHERE id = NEW.conversation_id;
  IF NOT FOUND OR conversation_workspace IS DISTINCT FROM NEW.workspace_id THEN
    RAISE EXCEPTION 'Message scope does not match its Conversation';
  END IF;

  IF NEW.author_kind <> 'system' AND NOT EXISTS (
    SELECT 1 FROM conversation_members member
    WHERE member.conversation_id = NEW.conversation_id
      AND member.workspace_id = NEW.workspace_id
      AND member.participant_kind = NEW.author_kind
      AND member.participant_id = NEW.author_id
  ) THEN
    RAISE EXCEPTION 'Message author is not a member of the Conversation';
  END IF;

  IF NEW.reply_to_message_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM messages parent
    WHERE parent.id = NEW.reply_to_message_id
      AND parent.conversation_id = NEW.conversation_id
  ) THEN
    RAISE EXCEPTION 'Reply target is outside the Conversation';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(NEW.mentioned_agent_ids) AS mentioned(agent_id)
    WHERE NOT EXISTS (
      SELECT 1 FROM conversation_members member
      WHERE member.conversation_id = NEW.conversation_id
        AND member.workspace_id = NEW.workspace_id
        AND member.participant_kind = 'agent'
        AND member.participant_id = mentioned.agent_id
    )
  ) THEN
    RAISE EXCEPTION 'Mentioned Agent is not a member of the Conversation';
  END IF;

  IF jsonb_typeof(NEW.entity_refs) <> 'object' THEN
    RAISE EXCEPTION 'Message entity references must be a JSON object';
  END IF;
  IF NEW.entity_refs ? 'missionId' AND NOT EXISTS (
    SELECT 1 FROM missions mission
    WHERE mission.id = NEW.entity_refs->>'missionId'
      AND mission.workspace_id = conversation_workspace
      AND mission.project_id = conversation_project
      AND (mission.conversation_id IS NULL OR mission.conversation_id = NEW.conversation_id)
  ) THEN
    RAISE EXCEPTION 'Message Mission reference is outside the Conversation scope';
  END IF;
  IF NEW.entity_refs ? 'taskId' AND (
    NOT (NEW.entity_refs ? 'missionId') OR NOT EXISTS (
      SELECT 1 FROM tasks task
      WHERE task.id = NEW.entity_refs->>'taskId'
        AND task.mission_id = NEW.entity_refs->>'missionId'
    )
  ) THEN
    RAISE EXCEPTION 'Message Task reference is outside the Mission scope';
  END IF;
  IF NEW.entity_refs ? 'runId' AND (
    NOT (NEW.entity_refs ? 'missionId') OR NOT (NEW.entity_refs ? 'taskId') OR NOT EXISTS (
      SELECT 1 FROM agent_runs run
      WHERE run.id = NEW.entity_refs->>'runId'
        AND run.workspace_id = conversation_workspace
        AND run.mission_id = NEW.entity_refs->>'missionId'
        AND run.task_id = NEW.entity_refs->>'taskId'
    )
  ) THEN
    RAISE EXCEPTION 'Message Run reference is outside the Task scope';
  END IF;
  IF NEW.entity_refs ? 'artifactId' AND NOT EXISTS (
    SELECT 1 FROM artifacts artifact
    WHERE artifact.id = NEW.entity_refs->>'artifactId'
      AND artifact.workspace_id = conversation_workspace
      AND artifact.project_id = conversation_project
      AND (
        NOT (NEW.entity_refs ? 'missionId')
        OR artifact.mission_id IS NULL
        OR artifact.mission_id = NEW.entity_refs->>'missionId'
      )
  ) THEN
    RAISE EXCEPTION 'Message Artifact reference is outside the Conversation scope';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_conversation_message ON messages;
CREATE TRIGGER trg_validate_conversation_message
BEFORE INSERT OR UPDATE ON messages
FOR EACH ROW EXECUTE FUNCTION runguild_validate_conversation_message();

CREATE OR REPLACE FUNCTION runguild_validate_message_delivery()
RETURNS TRIGGER AS $$
DECLARE
  message_workspace TEXT;
  message_refs JSONB;
  message_mentions TEXT[];
BEGIN
  SELECT workspace_id, entity_refs, mentioned_agent_ids
  INTO message_workspace, message_refs, message_mentions
  FROM messages
  WHERE id = NEW.message_id AND conversation_id = NEW.conversation_id;

  IF NOT FOUND OR NOT (NEW.agent_id = ANY(message_mentions)) THEN
    RAISE EXCEPTION 'Message delivery Agent was not mentioned by this message';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM agents WHERE id = NEW.agent_id AND workspace_id = message_workspace
  ) THEN
    RAISE EXCEPTION 'Message delivery Agent is outside the Workspace';
  END IF;
  IF NEW.run_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM agent_runs run
    WHERE run.id = NEW.run_id
      AND run.workspace_id = message_workspace
      AND run.agent_id = NEW.agent_id
      AND (
        NOT (message_refs ? 'missionId')
        OR run.mission_id = message_refs->>'missionId'
      )
  ) THEN
    RAISE EXCEPTION 'Message delivery Run is outside the Agent or Mission scope';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_message_delivery ON conversation_message_deliveries;
CREATE TRIGGER trg_validate_message_delivery
BEFORE INSERT OR UPDATE ON conversation_message_deliveries
FOR EACH ROW EXECUTE FUNCTION runguild_validate_message_delivery();

CREATE INDEX IF NOT EXISTS idx_messages_conversation_sequence
  ON messages(conversation_id, sequence DESC);

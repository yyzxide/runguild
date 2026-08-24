ALTER TABLE missions
  ADD CONSTRAINT uq_missions_project_scope
  UNIQUE (id, workspace_id, project_id);

ALTER TABLE artifacts
  ADD CONSTRAINT uq_artifacts_workspace_scope
  UNIQUE (id, workspace_id),
  ADD CONSTRAINT fk_artifacts_project_scope
  FOREIGN KEY (project_id, workspace_id)
    REFERENCES projects(id, workspace_id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_artifacts_mission_scope
  FOREIGN KEY (mission_id, workspace_id, project_id)
    REFERENCES missions(id, workspace_id, project_id) ON DELETE CASCADE;

ALTER TABLE artifact_versions
  ADD COLUMN IF NOT EXISTS through_update_seq BIGINT NOT NULL DEFAULT 0
    CHECK (through_update_seq >= 0),
  ADD COLUMN IF NOT EXISTS created_by_kind TEXT NOT NULL DEFAULT 'system'
    CHECK (created_by_kind IN ('user', 'agent', 'system', 'service')),
  ADD COLUMN IF NOT EXISTS created_by_id TEXT NOT NULL DEFAULT 'migration';

ALTER TABLE artifact_versions
  DROP CONSTRAINT IF EXISTS artifact_versions_artifact_id_content_hash_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_artifact_version_exact_state
  ON artifact_versions(artifact_id, content_hash, yjs_state_hash);

CREATE OR REPLACE FUNCTION enforce_artifact_version_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  artifact_workspace TEXT;
  artifact_mission TEXT;
  run_workspace TEXT;
  run_mission TEXT;
  run_agent TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'artifact versions are immutable';
  END IF;

  IF NEW.created_by_kind <> 'agent' AND NEW.created_by_run_id IS NOT NULL THEN
    RAISE EXCEPTION 'only an Agent-created Artifact Version may reference a Run';
  END IF;

  IF NEW.created_by_kind <> 'agent' THEN
    RETURN NEW;
  END IF;

  IF NEW.created_by_run_id IS NULL THEN
    RAISE EXCEPTION 'Agent-created Artifact Version requires a Run';
  END IF;

  SELECT workspace_id, mission_id
    INTO artifact_workspace, artifact_mission
    FROM artifacts WHERE id = NEW.artifact_id;
  SELECT workspace_id, mission_id, agent_id
    INTO run_workspace, run_mission, run_agent
    FROM agent_runs WHERE id = NEW.created_by_run_id;

  IF artifact_workspace IS NULL OR run_workspace IS NULL
     OR artifact_mission IS NULL
     OR artifact_workspace <> run_workspace
     OR artifact_mission <> run_mission
     OR NEW.created_by_id <> run_agent THEN
    RAISE EXCEPTION 'artifact version creator Run is outside Artifact scope';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_artifact_version_scope ON artifact_versions;
CREATE TRIGGER trg_artifact_version_scope
BEFORE INSERT OR UPDATE ON artifact_versions
FOR EACH ROW EXECUTE FUNCTION enforce_artifact_version_scope();

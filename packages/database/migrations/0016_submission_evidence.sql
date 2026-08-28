CREATE TABLE IF NOT EXISTS task_submission_evidence (
  submission_id TEXT NOT NULL REFERENCES task_submissions(id) ON DELETE CASCADE,
  evidence_id   TEXT NOT NULL REFERENCES evidence(id) ON DELETE RESTRICT,
  PRIMARY KEY (submission_id, evidence_id)
);

CREATE INDEX IF NOT EXISTS idx_task_submission_evidence_evidence
  ON task_submission_evidence(evidence_id);

CREATE OR REPLACE FUNCTION enforce_task_submission_evidence_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  submission_workspace TEXT;
  submission_mission TEXT;
  submission_task TEXT;
  evidence_workspace TEXT;
  evidence_mission TEXT;
  evidence_task TEXT;
BEGIN
  SELECT workspace_id, mission_id, task_id
    INTO submission_workspace, submission_mission, submission_task
    FROM task_submissions WHERE id = NEW.submission_id;
  SELECT workspace_id, mission_id, task_id
    INTO evidence_workspace, evidence_mission, evidence_task
    FROM evidence WHERE id = NEW.evidence_id;

  IF submission_task IS NULL OR evidence_task IS NULL THEN
    RAISE EXCEPTION 'submission evidence reference does not exist';
  END IF;
  IF submission_workspace <> evidence_workspace
     OR submission_mission <> evidence_mission
     OR submission_task <> evidence_task THEN
    RAISE EXCEPTION 'submission evidence is outside the Task scope';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_task_submission_evidence_scope ON task_submission_evidence;
CREATE TRIGGER trg_task_submission_evidence_scope
BEFORE INSERT OR UPDATE OF submission_id, evidence_id
ON task_submission_evidence
FOR EACH ROW EXECUTE FUNCTION enforce_task_submission_evidence_scope();

ALTER TABLE task_submissions
  ADD COLUMN IF NOT EXISTS note TEXT NOT NULL DEFAULT '';

ALTER TABLE reviews
  ALTER COLUMN reviewer_agent_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS reviewer_kind TEXT NOT NULL DEFAULT 'agent'
    CHECK (reviewer_kind IN ('user', 'agent')),
  ADD COLUMN IF NOT EXISTS reviewer_id TEXT,
  ADD COLUMN IF NOT EXISTS reviewer_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS summary TEXT NOT NULL DEFAULT '';

UPDATE reviews
   SET reviewer_id = reviewer_agent_id
 WHERE reviewer_id IS NULL;

ALTER TABLE reviews
  ALTER COLUMN reviewer_id SET NOT NULL;

ALTER TABLE reviews
  DROP CONSTRAINT IF EXISTS ck_review_actor_shape;
ALTER TABLE reviews
  ADD CONSTRAINT ck_review_actor_shape CHECK (
    (reviewer_kind = 'agent' AND reviewer_agent_id = reviewer_id)
    OR
    (reviewer_kind = 'user' AND reviewer_agent_id IS NULL AND reviewer_run_id IS NULL)
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_reviews_submission
  ON reviews(submission_id);

CREATE OR REPLACE FUNCTION enforce_review_submission_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  submission_workspace TEXT;
  submission_mission TEXT;
  submission_task TEXT;
  submission_builder TEXT;
  reviewer_workspace TEXT;
  reviewer_role TEXT;
  reviewer_status TEXT;
  run_workspace TEXT;
  run_mission TEXT;
  run_agent TEXT;
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

  IF NEW.reviewer_kind = 'user' THEN
    SELECT workspace_id INTO reviewer_workspace FROM users WHERE id = NEW.reviewer_id;
    IF reviewer_workspace IS NULL OR reviewer_workspace <> NEW.workspace_id THEN
      RAISE EXCEPTION 'human reviewer is outside the submission workspace';
    END IF;
    RETURN NEW;
  END IF;

  SELECT workspace_id, role, status
    INTO reviewer_workspace, reviewer_role, reviewer_status
    FROM agents WHERE id = NEW.reviewer_id;
  IF reviewer_workspace IS NULL OR reviewer_workspace <> NEW.workspace_id
     OR reviewer_role <> 'reviewer' OR reviewer_status <> 'active' THEN
    RAISE EXCEPTION 'Agent reviewer must be an active reviewer in the submission workspace';
  END IF;
  IF submission_builder = NEW.reviewer_id THEN
    RAISE EXCEPTION 'builder and reviewer must be different agents';
  END IF;

  IF NEW.reviewer_run_id IS NOT NULL THEN
    SELECT workspace_id, mission_id, agent_id
      INTO run_workspace, run_mission, run_agent
      FROM agent_runs WHERE id = NEW.reviewer_run_id;
    IF run_workspace IS NULL OR run_workspace <> NEW.workspace_id
       OR run_mission <> NEW.mission_id OR run_agent <> NEW.reviewer_id THEN
      RAISE EXCEPTION 'reviewer Run is outside the submission scope';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_review_submission_scope ON reviews;
CREATE TRIGGER trg_review_submission_scope
BEFORE INSERT OR UPDATE OF submission_id, reviewer_kind, reviewer_id, reviewer_agent_id,
  reviewer_run_id, workspace_id, mission_id, task_id
ON reviews
FOR EACH ROW EXECUTE FUNCTION enforce_review_submission_scope();

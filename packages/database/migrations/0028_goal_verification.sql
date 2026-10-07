ALTER TABLE missions ADD COLUMN goal_verification BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE missions ADD COLUMN verification_task_id TEXT REFERENCES tasks(id);

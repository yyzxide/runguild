ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived_by TEXT;

ALTER TABLE projects
  ADD CONSTRAINT projects_archive_pair
  CHECK ((archived_at IS NULL) = (archived_by IS NULL));

ALTER TABLE projects
  ADD CONSTRAINT projects_archived_by_user
  FOREIGN KEY (archived_by, workspace_id)
  REFERENCES users(id, workspace_id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_projects_workspace_active
  ON projects(workspace_id, updated_at DESC, id)
  WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS project_lifecycle_events (
  id              BIGSERIAL PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  project_id      TEXT NOT NULL,
  actor_id        TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('renamed', 'archived', 'restored')),
  previous_name   TEXT,
  next_name       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (project_id, workspace_id)
    REFERENCES projects(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (actor_id, workspace_id)
    REFERENCES users(id, workspace_id) ON DELETE RESTRICT,
  CHECK (
    (kind = 'renamed' AND previous_name IS NOT NULL AND next_name IS NOT NULL)
    OR (kind IN ('archived', 'restored') AND previous_name IS NULL AND next_name IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_project_lifecycle_events_project
  ON project_lifecycle_events(project_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS project_memberships (
  workspace_id  TEXT NOT NULL,
  project_id    TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'operator'
                CHECK (role IN ('owner', 'operator', 'viewer')),
  joined_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  added_by      TEXT,
  PRIMARY KEY (project_id, user_id),
  FOREIGN KEY (project_id, workspace_id)
    REFERENCES projects(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, workspace_id)
    REFERENCES users(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (added_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_project_memberships_user
  ON project_memberships(workspace_id, user_id, joined_at DESC);

-- Preserve the access semantics that existed before membership was explicit.
INSERT INTO project_memberships (workspace_id, project_id, user_id, role)
SELECT project.workspace_id, project.id, user_account.id, user_account.role
FROM projects project
JOIN users user_account ON user_account.workspace_id = project.workspace_id
ON CONFLICT (project_id, user_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS project_membership_events (
  id            BIGSERIAL PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  project_id    TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  actor_id      TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('member_added', 'role_changed', 'member_removed')),
  previous_role TEXT CHECK (previous_role IS NULL OR previous_role IN ('owner', 'operator', 'viewer')),
  next_role     TEXT CHECK (next_role IS NULL OR next_role IN ('owner', 'operator', 'viewer')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (project_id, workspace_id)
    REFERENCES projects(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_project_membership_events_project
  ON project_membership_events(workspace_id, project_id, created_at DESC, id DESC);

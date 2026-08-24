CREATE TABLE IF NOT EXISTS evaluation_scenarios (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  slug            TEXT NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name            TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description     TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 4000),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, workspace_id, project_id),
  UNIQUE (workspace_id, project_id, slug),
  FOREIGN KEY (project_id, workspace_id)
    REFERENCES projects(id, workspace_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS evaluation_scenario_versions (
  id              TEXT PRIMARY KEY,
  scenario_id     TEXT NOT NULL REFERENCES evaluation_scenarios(id) ON DELETE CASCADE,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version         INTEGER NOT NULL CHECK (version > 0),
  definition      JSONB NOT NULL,
  definition_hash TEXT NOT NULL CHECK (definition_hash ~ '^[0-9a-f]{64}$'),
  created_by      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (scenario_id, version),
  UNIQUE (scenario_id, definition_hash),
  UNIQUE (id, workspace_id, project_id),
  FOREIGN KEY (scenario_id, workspace_id, project_id)
    REFERENCES evaluation_scenarios(id, workspace_id, project_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_evaluation_scenario_versions_latest
  ON evaluation_scenario_versions(scenario_id, version DESC);

CREATE OR REPLACE FUNCTION reject_evaluation_scenario_version_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'evaluation scenario versions are immutable';
END;
$$;

DROP TRIGGER IF EXISTS trg_evaluation_scenario_version_immutable
  ON evaluation_scenario_versions;
CREATE TRIGGER trg_evaluation_scenario_version_immutable
BEFORE UPDATE ON evaluation_scenario_versions
FOR EACH ROW EXECUTE FUNCTION reject_evaluation_scenario_version_mutation();

CREATE TABLE IF NOT EXISTS evaluation_experiments (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scenario_version_id TEXT NOT NULL REFERENCES evaluation_scenario_versions(id) ON DELETE RESTRICT,
  name                TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  status              TEXT NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  repetitions         INTEGER NOT NULL CHECK (repetitions BETWEEN 1 AND 100),
  variants            TEXT[] NOT NULL,
  created_by          TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at          TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, workspace_id, project_id),
  CHECK (cardinality(variants) BETWEEN 1 AND 2),
  CHECK (variants <@ ARRAY['single_agent', 'multi_agent']::TEXT[]),
  CHECK (cardinality(variants) = 1 OR variants[1] <> variants[2]),
  FOREIGN KEY (scenario_version_id, workspace_id, project_id)
    REFERENCES evaluation_scenario_versions(id, workspace_id, project_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_evaluation_experiments_status
  ON evaluation_experiments(status, created_at);

CREATE TABLE IF NOT EXISTS evaluation_trials (
  id                    TEXT PRIMARY KEY,
  experiment_id         TEXT NOT NULL REFERENCES evaluation_experiments(id) ON DELETE CASCADE,
  scenario_version_id   TEXT NOT NULL REFERENCES evaluation_scenario_versions(id) ON DELETE RESTRICT,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  variant               TEXT NOT NULL CHECK (variant IN ('single_agent', 'multi_agent')),
  repetition            INTEGER NOT NULL CHECK (repetition > 0),
  seed                  TEXT NOT NULL CHECK (seed ~ '^[0-9a-f]{64}$'),
  status                TEXT NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued', 'materializing', 'running', 'completed', 'failed', 'cancelled')),
  mission_id            TEXT,
  materialization_token TEXT,
  materialization_expires_at TIMESTAMPTZ,
  materialization_attempts INTEGER NOT NULL DEFAULT 0 CHECK (materialization_attempts >= 0),
  metrics               JSONB,
  error                 JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at            TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (experiment_id, variant, repetition),
  UNIQUE (mission_id),
  UNIQUE (id, workspace_id, project_id),
  CHECK (status <> 'completed' OR metrics IS NOT NULL),
  CHECK (materialization_token IS NULL OR status = 'materializing'),
  CHECK (materialization_expires_at IS NULL OR materialization_token IS NOT NULL),
  FOREIGN KEY (experiment_id, workspace_id, project_id)
    REFERENCES evaluation_experiments(id, workspace_id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (scenario_version_id, workspace_id, project_id)
    REFERENCES evaluation_scenario_versions(id, workspace_id, project_id) ON DELETE RESTRICT,
  FOREIGN KEY (mission_id, workspace_id)
    REFERENCES missions(id, workspace_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_evaluation_trial_materialization_token
  ON evaluation_trials(materialization_token) WHERE materialization_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_evaluation_trials_runnable
  ON evaluation_trials(status, materialization_expires_at, created_at);
CREATE INDEX IF NOT EXISTS idx_evaluation_trials_experiment
  ON evaluation_trials(experiment_id, repetition, variant);

CREATE OR REPLACE FUNCTION enforce_evaluation_trial_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  mission_project TEXT;
BEGIN
  IF NEW.mission_id IS NOT NULL THEN
    SELECT project_id INTO mission_project FROM missions
     WHERE id = NEW.mission_id AND workspace_id = NEW.workspace_id;
    IF mission_project IS NULL OR mission_project <> NEW.project_id THEN
      RAISE EXCEPTION 'evaluation trial mission is outside project scope';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_evaluation_trial_scope ON evaluation_trials;
CREATE TRIGGER trg_evaluation_trial_scope
BEFORE INSERT OR UPDATE OF mission_id, workspace_id, project_id
ON evaluation_trials
FOR EACH ROW EXECUTE FUNCTION enforce_evaluation_trial_scope();

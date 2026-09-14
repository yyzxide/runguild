ALTER TABLE project_runtime_configs
  ADD COLUMN IF NOT EXISTS protected_test_paths JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE project_runtime_configs
  DROP CONSTRAINT IF EXISTS project_runtime_configs_protected_test_paths_check;

ALTER TABLE project_runtime_configs
  ADD CONSTRAINT project_runtime_configs_protected_test_paths_check
  CHECK (jsonb_typeof(protected_test_paths) = 'array');

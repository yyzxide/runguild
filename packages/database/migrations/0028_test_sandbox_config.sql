ALTER TABLE project_runtime_configs
  ADD COLUMN IF NOT EXISTS test_sandbox_mode TEXT NOT NULL DEFAULT 'trusted_process',
  ADD COLUMN IF NOT EXISTS test_network_mode TEXT NOT NULL DEFAULT 'host',
  ADD COLUMN IF NOT EXISTS test_max_processes INTEGER NOT NULL DEFAULT 128,
  ADD COLUMN IF NOT EXISTS test_max_open_files INTEGER NOT NULL DEFAULT 1024,
  ADD COLUMN IF NOT EXISTS test_max_file_size_mb INTEGER NOT NULL DEFAULT 512;

ALTER TABLE project_runtime_configs
  DROP CONSTRAINT IF EXISTS project_runtime_configs_test_sandbox_mode_check,
  DROP CONSTRAINT IF EXISTS project_runtime_configs_test_network_mode_check,
  DROP CONSTRAINT IF EXISTS project_runtime_configs_test_max_processes_check,
  DROP CONSTRAINT IF EXISTS project_runtime_configs_test_max_open_files_check,
  DROP CONSTRAINT IF EXISTS project_runtime_configs_test_max_file_size_mb_check,
  DROP CONSTRAINT IF EXISTS project_runtime_configs_trusted_process_network_check;

ALTER TABLE project_runtime_configs
  ADD CONSTRAINT project_runtime_configs_test_sandbox_mode_check
    CHECK (test_sandbox_mode IN ('trusted_process', 'bubblewrap')),
  ADD CONSTRAINT project_runtime_configs_test_network_mode_check
    CHECK (test_network_mode IN ('none', 'host')),
  ADD CONSTRAINT project_runtime_configs_test_max_processes_check
    CHECK (test_max_processes BETWEEN 16 AND 4096),
  ADD CONSTRAINT project_runtime_configs_test_max_open_files_check
    CHECK (test_max_open_files BETWEEN 16 AND 65536),
  ADD CONSTRAINT project_runtime_configs_test_max_file_size_mb_check
    CHECK (test_max_file_size_mb BETWEEN 16 AND 16384),
  ADD CONSTRAINT project_runtime_configs_trusted_process_network_check
    CHECK (test_sandbox_mode <> 'trusted_process' OR test_network_mode = 'host');

ALTER TABLE task_worktrees
  ADD COLUMN IF NOT EXISTS reconciliation_base_commit TEXT;

ALTER TABLE task_worktrees
  DROP CONSTRAINT IF EXISTS ck_task_worktree_reconciliation_base;
ALTER TABLE task_worktrees
  ADD CONSTRAINT ck_task_worktree_reconciliation_base CHECK (
    reconciliation_base_commit IS NULL
    OR (
      status IN ('ready', 'committed')
      AND reconciliation_base_commit ~ '^[0-9a-f]{40,64}$'
    )
  );

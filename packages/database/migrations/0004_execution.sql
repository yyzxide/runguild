CREATE UNIQUE INDEX IF NOT EXISTS uq_run_criterion_evidence
  ON evidence (
    run_id,
    COALESCE(acceptance_criterion_id, ''),
    kind,
    content_hash
  )
  WHERE run_id IS NOT NULL AND content_hash IS NOT NULL;

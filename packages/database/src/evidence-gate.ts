import type { PoolClient } from 'pg'

/** Evaluate completion against the current attempt or an exact committed tree. */
export async function hasMissingTaskEvidence(client: PoolClient, taskId: string): Promise<boolean> {
  const result = await client.query<{ missing: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM task_acceptance_criteria c
      JOIN tasks t ON t.id = c.task_id
      LEFT JOIN task_worktrees w ON w.task_id = t.id
      WHERE c.task_id = $1 AND c.required AND EXISTS (
        SELECT 1 FROM unnest(CASE WHEN cardinality(c.required_evidence_kinds) = 0
          THEN ARRAY[NULL::text] ELSE c.required_evidence_kinds END) AS required_kind
        WHERE NOT EXISTS (
          SELECT 1 FROM evidence e JOIN agent_runs producer ON producer.id = e.run_id
          WHERE e.acceptance_criterion_id = c.id AND e.task_id = t.id
            AND producer.task_id = t.id AND producer.mission_id = t.mission_id
            AND (required_kind IS NULL OR e.kind = required_kind)
            AND (e.expires_at IS NULL OR e.expires_at > NOW())
            AND (
              (e.kind NOT IN ('test_run', 'command_result') AND (
                producer.attempt = t.attempt_count OR EXISTS (
                  SELECT 1 FROM task_submission_evidence se
                  JOIN task_submissions s ON s.id = se.submission_id
                  JOIN agent_runs sr ON sr.id = s.run_id
                  WHERE se.evidence_id = e.id AND s.task_id = t.id
                    AND sr.attempt = t.attempt_count
                    AND s.status IN ('submitted', 'in_review', 'approved')
                )
              )) OR (
                e.kind IN ('test_run', 'command_result') AND e.metadata->>'passed' = 'true'
                AND (
                  (w.task_id IS NULL AND producer.attempt = t.attempt_count) OR (
                    w.head_commit IS NOT NULL AND e.metadata->>'headCommit' = w.head_commit
                    AND e.metadata->>'clean' = 'true' AND e.metadata->>'stable' = 'true'
                    AND EXISTS (
                      SELECT 1 FROM evidence commit_e WHERE commit_e.task_id = t.id
                        AND commit_e.kind = 'file_diff' AND commit_e.metadata->>'commit' = w.head_commit
                        AND commit_e.metadata->>'treeHash' = e.metadata->>'treeHash'
                    )
                  )
                )
                AND NOT EXISTS (
                  SELECT 1 FROM evidence later JOIN agent_runs lr ON lr.id = later.run_id
                  WHERE later.task_id = t.id AND later.kind = e.kind
                    AND later.created_at >= e.created_at AND later.id <> e.id
                    AND later.metadata->>'passed' = 'false'
                    AND later.metadata->'command' IS NOT DISTINCT FROM e.metadata->'command'
                    AND ((w.task_id IS NULL AND lr.attempt = t.attempt_count)
                      OR (w.task_id IS NOT NULL AND later.metadata->>'headCommit' = w.head_commit))
                )
              )
            )
            AND (NOT t.review_required OR EXISTS (
              SELECT 1 FROM task_submission_evidence se JOIN task_submissions s ON s.id = se.submission_id
              JOIN agent_runs sr ON sr.id = s.run_id
              WHERE se.evidence_id = e.id AND s.task_id = t.id AND sr.attempt = t.attempt_count
                AND s.status IN ('submitted', 'in_review', 'approved')
            ))
        )
      )
    ) AS missing`, [taskId])
  return result.rows[0]?.missing ?? true
}

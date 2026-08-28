import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import type { Pool } from 'pg'

const MIGRATIONS = [
  '0001_core.sql',
  '0002_orchestration.sql',
  '0003_runtime.sql',
  '0004_execution.sql',
  '0005_artifacts.sql',
  '0006_reviews.sql',
  '0007_worktrees.sql',
  '0008_context.sql',
  '0009_evaluation.sql',
  '0010_conversations.sql',
  '0011_conversation_planning.sql',
  '0012_worker_instances.sql',
  '0013_project_runtime_config.sql',
  '0014_reviewer_execution.sql',
  '0015_worktree_setup.sql',
  '0016_submission_evidence.sql',
] as const

function checksum(contents: string): string {
  return createHash('sha256').update(contents).digest('hex')
}

export async function runMigrations(pool: Pool): Promise<readonly string[]> {
  const client = await pool.connect()
  const applied: string[] = []
  try {
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (' +
      'name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())',
    )
    await client.query("SELECT pg_advisory_lock(hashtext('runguild:migrations'))")

    for (const name of MIGRATIONS) {
      const url = new URL('../migrations/' + name, import.meta.url)
      const sql = await readFile(url, 'utf8')
      const expectedChecksum = checksum(sql)
      const existing = await client.query<{ checksum: string }>(
        'SELECT checksum FROM schema_migrations WHERE name = $1',
        [name],
      )

      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== expectedChecksum) {
          throw new Error('Migration checksum mismatch: ' + name)
        }
        continue
      }

      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query(
          'INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)',
          [name, expectedChecksum],
        )
        await client.query('COMMIT')
        applied.push(name)
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('runguild:migrations'))").catch(() => undefined)
    client.release()
  }
  return applied
}

import { createDatabasePool } from './pool.js'
import { runMigrations } from './migrate.js'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required')
}

const pool = createDatabasePool(databaseUrl)
try {
  const applied = await runMigrations(pool)
  process.stdout.write(applied.length === 0 ? 'Database is up to date.\n' : 'Applied: ' + applied.join(', ') + '\n')
} finally {
  await pool.end()
}

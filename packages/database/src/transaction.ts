import type { Pool, PoolClient } from 'pg'

export type TransactionIsolation = 'read committed' | 'repeatable read' | 'serializable'

export async function withTransaction<Result>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<Result>,
  isolation: TransactionIsolation = 'read committed',
): Promise<Result> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (isolation !== 'read committed') {
      const statement = isolation === 'serializable'
        ? 'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE'
        : 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'
      await client.query(statement)
    }
    const result = await operation(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

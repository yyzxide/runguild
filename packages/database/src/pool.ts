import { Pool, type PoolConfig } from 'pg'

export function createDatabasePool(config: PoolConfig | string): Pool {
  if (typeof config === 'string') {
    return new Pool({ connectionString: config })
  }
  return new Pool(config)
}

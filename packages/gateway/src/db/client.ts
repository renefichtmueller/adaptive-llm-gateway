import pg from 'pg';
import { logger } from '../observability/logger.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;

/**
 * Build pool config from DATABASE_URL (preferred) or individual DB_* env vars.
 * DATABASE_URL format: postgresql://user:password@host:port/database
 */
function buildPoolConfig(): pg.PoolConfig {
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl) {
    return {
      connectionString: databaseUrl,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    };
  }
  return {
    host: process.env['DB_HOST'] ?? 'localhost',
    port: parseInt(process.env['DB_PORT'] ?? '5432', 10),
    database: process.env['DB_NAME'] ?? 'llm_gateway',
    user: process.env['DB_USER'] ?? 'llm',
    password: process.env['DB_PASSWORD'] ?? '',
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  };
}

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool(buildPoolConfig());

    pool.on('error', (err) => {
      logger.error({ err }, 'PostgreSQL pool error');
    });
  }
  return pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  const p = getPool();
  const maxRetries = 3;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await p.query<T>(sql, params);
    } catch (err) {
      const pgErr = err as pg.DatabaseError;
      const isDeadlock =
        pgErr.code === '40P01' || pgErr.code === '40001';
      if (!isDeadlock || attempt === maxRetries - 1) {
        throw err;
      }
      lastError = pgErr;
      const delay = 50 * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
      logger.warn({ attempt, sql }, 'Retrying after deadlock');
    }
  }

  throw lastError ?? new Error('Query failed after retries');
}

export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

import pg from 'pg';
import { logger } from '../observability/logger.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;

function buildPoolConfig(): pg.PoolConfig {
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl) {
    return { connectionString: databaseUrl, max: 5, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 };
  }
  return {
    host: process.env['DB_HOST'] ?? 'localhost',
    port: parseInt(process.env['DB_PORT'] ?? '5432', 10),
    database: process.env['DB_NAME'] ?? 'llm_gateway',
    user: process.env['DB_USER'] ?? 'llm',
    password: process.env['DB_PASSWORD'] ?? '',
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  };
}

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool(buildPoolConfig());

    pool.on('error', (err) => {
      logger.error({ err }, 'PostgreSQL pool error (learning engine)');
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
      const isRetryable = pgErr.code === '40P01' || pgErr.code === '40001';
      if (!isRetryable || attempt === maxRetries - 1) {
        throw err;
      }
      lastError = pgErr;
      const delay = 50 * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
      logger.warn({ attempt, sql: sql.slice(0, 80) }, 'Retrying after deadlock');
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

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

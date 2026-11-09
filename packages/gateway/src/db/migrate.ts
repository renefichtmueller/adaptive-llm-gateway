import { readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { getPool } from './client.js';
import { logger } from '../observability/logger.js';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');

interface MigrationRecord {
  name: string;
  executed_at: string;
}

async function ensureMigrationsTable(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      executed_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);
}

async function getMigratedFiles(): Promise<Set<string>> {
  const pool = getPool();
  try {
    const result = await pool.query('SELECT name FROM schema_migrations;');
    return new Set(result.rows.map((row: MigrationRecord) => row.name));
  } catch {
    return new Set();
  }
}

async function runMigration(name: string, sql: string): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query(
      'INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING;',
      [name],
    );
    await client.query('COMMIT');
    logger.info({ migration: name }, 'Migration executed successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err, migration: name }, 'Migration failed');
    throw err;
  } finally {
    client.release();
  }
}

export async function runMigrations(): Promise<void> {
  try {
    await ensureMigrationsTable();
    const migrated = await getMigratedFiles();

    const migrations = [
      { name: '001_initial.sql', path: './migrations/001_initial.sql' },
      { name: '002-tokenvault-cost-tracking.sql', path: './migrations/002-tokenvault-cost-tracking.sql' },
      { name: '003-dashboard.sql', path: './migrations/003-dashboard.sql' },
      { name: '010-feature-tables.sql', path: './migrations/010-feature-tables.sql' },
      { name: '011-learning-service.sql', path: './migrations/011-learning-service.sql' },
    ];

    for (const { name, path } of migrations) {
      if (!migrated.has(name)) {
        logger.info({ migration: name }, 'Running migration');
        const sql = readFileSync(resolve(__dirname, path), 'utf-8');
        await runMigration(name, sql);
      }
    }

    logger.info({ count: migrations.length }, 'All migrations completed');
  } catch (err) {
    logger.error({ err }, 'Migration runner failed');
    throw err;
  }
}

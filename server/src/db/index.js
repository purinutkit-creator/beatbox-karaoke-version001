import pg from 'pg';
import { config } from '../config.js';

// numeric → JS number, bigint → number (safe for our ranges)
pg.types.setTypeParser(1700, (v) => (v == null ? null : Number(v)));
pg.types.setTypeParser(20, (v) => (v == null ? null : Number(v)));
// date columns stay strings (YYYY-MM-DD)
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: Number(process.env.DB_POOL_MAX || 20) });
pool.on('error', (err) => console.error('[db] idle client error', err.message));

export async function query(text, params) {
  return pool.query(text, params);
}

export async function one(text, params) {
  const r = await pool.query(text, params);
  return r.rows[0] || null;
}

export async function many(text, params) {
  const r = await pool.query(text, params);
  return r.rows;
}

const RETRYABLE = new Set(['40001', '40P01']);

/** Run fn inside a transaction. Retries on serialization failures / deadlocks. */
export async function tx(fn, { retries = 3, isolation } = {}) {
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query(isolation ? `BEGIN ISOLATION LEVEL ${isolation}` : 'BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (RETRYABLE.has(err.code) && attempt < retries) {
        await new Promise((r) => setTimeout(r, 30 * (attempt + 1) + Math.random() * 50));
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
}

/** Atomic counter (used for receipt / queue / booking numbers) */
export async function nextCounter(client, name, period = 'ALL', start = 1) {
  const r = await client.query(
    `INSERT INTO counters(name, period, value) VALUES ($1, $2, $3)
     ON CONFLICT (name, period) DO UPDATE SET value = counters.value + 1, updated_at = now()
     RETURNING value`,
    [name, period, start],
  );
  return Number(r.rows[0].value);
}

import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import { config } from '../config.js';

// numeric → JS number, bigint → number (safe for our ranges)
pg.types.setTypeParser(1700, (v) => (v == null ? null : Number(v)));
pg.types.setTypeParser(20, (v) => (v == null ? null : Number(v)));
// date columns stay strings (YYYY-MM-DD)
pg.types.setTypeParser(1082, (v) => v);

// ── Store (tenant) context ──
// Every request / socket event / scheduled job runs inside a context { storeId, bypass }.
// Before a pooled connection is used, `app.store_id` and `app.bypass_rls` are set on it, and PostgreSQL
// row-level security (migration 004) only returns / accepts rows of that store.
export const storeContext = new AsyncLocalStorage();

export function currentStoreId() {
  return storeContext.getStore()?.storeId ?? null;
}

/** Run fn for one store. */
export function runWithStore(storeId, fn) {
  return storeContext.run({ storeId: storeId ? Number(storeId) : null, bypass: false }, fn);
}

/** Platform-level code (registration, Super Owner, schedulers, token lookups) that must see all stores. */
export function runAsPlatform(fn) {
  return storeContext.run({ storeId: null, bypass: true }, fn);
}

/** Change the store of the current context (after resolving it from a global token, e.g. a QR link). */
export function setContextStore(storeId) {
  const c = storeContext.getStore();
  if (c) {
    c.storeId = Number(storeId);
    c.bypass = false;
  }
}

const rawPool = new pg.Pool({ connectionString: config.databaseUrl, max: Number(process.env.DB_POOL_MAX || 20) });
rawPool.on('error', (err) => console.error('[db] idle client error', err.message));

// When the server connects as a PostgreSQL superuser (local development), row-level security would be skipped.
// In that case every pooled connection switches to the restricted role `beatbox_app` (created by ensureAppRole).
let appRole = null;

async function applyContext(client) {
  if (appRole && client.__bbRole !== appRole) {
    await client.query(`SET ROLE ${appRole}`);
    client.__bbRole = appRole;
  }
  const c = storeContext.getStore();
  const sid = c?.storeId ? String(c.storeId) : '';
  const by = c?.bypass ? 'on' : 'off';
  if (client.__bbStore !== sid || client.__bbBypass !== by) {
    await client.query(`SELECT set_config('app.store_id', $1, false), set_config('app.bypass_rls', $2, false)`, [sid, by]);
    client.__bbStore = sid;
    client.__bbBypass = by;
  }
}

/** Pool wrapper: identical API (query / connect) but every query carries the store context. */
export const pool = {
  async query(text, params) {
    const client = await rawPool.connect();
    try {
      await applyContext(client);
      return await client.query(text, params);
    } finally {
      client.release();
    }
  },
  async connect() {
    const client = await rawPool.connect();
    try {
      await applyContext(client);
    } catch (e) {
      client.release();
      throw e;
    }
    return client;
  },
  end: () => rawPool.end(),
  on: (...a) => rawPool.on(...a),
};

/** Connection without role switching / context (migrations). */
export function adminConnect() {
  return rawPool.connect().then(async (c) => {
    await c.query('RESET ROLE');
    await c.query(`SELECT set_config('app.store_id', '', false), set_config('app.bypass_rls', 'on', false)`);
    c.__bbRole = null;
    c.__bbStore = undefined;
    c.__bbBypass = undefined;
    return c;
  });
}

/** Detect a superuser connection and make sure the restricted application role exists with the right grants. */
export async function ensureAppRole() {
  const c = await rawPool.connect();
  try {
    await c.query('RESET ROLE');
    c.__bbRole = null;
    const me = (await c.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0];
    if (!me?.rolsuper && !me?.rolbypassrls) {
      appRole = null;
      return null;
    }
    const role = 'beatbox_app';
    await c.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$`);
    await c.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await c.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    await c.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
    await c.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${role}`);
    appRole = role;
    return role;
  } finally {
    c.release();
  }
}

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

/** Atomic counter (used for receipt / queue / booking numbers) — per store. */
export async function nextCounter(client, name, period = 'ALL', start = 1) {
  const r = await client.query(
    `INSERT INTO counters(name, period, value) VALUES ($1, $2, $3)
     ON CONFLICT (store_id, name, period) DO UPDATE SET value = counters.value + 1, updated_at = now()
     RETURNING value`,
    [name, period, start],
  );
  return Number(r.rows[0].value);
}

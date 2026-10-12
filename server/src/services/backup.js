import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pool, many, currentStoreId } from '../db/index.js';

const PLATFORM_TABLES = new Set(['platform_users', 'platform_sessions', 'plans', 'store_subscriptions', 'subscription_events', 'platform_settings', 'renewal_requests', 'idempotency_keys', 'schema_migrations', 'permissions', 'stored_files']);
import { config } from '../config.js';
import { getSettings } from './settings.js';

async function jsonDump(file) {
  const tables = (await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`)).rows.map((r) => r.tablename);
  const data = {};
  for (const t of tables) {
    // platform tables (plans, platform users, other stores' subscriptions) are never part of a store backup
    if (PLATFORM_TABLES.has(t)) continue;
    data[t] = (await pool.query(`SELECT * FROM "${t}"`)).rows;
  }
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify({ createdAt: new Date(), tables: data })));
}

/**
 * Store backup: a JSON export of this store's rows only (row-level security scopes every table to the store),
 * so a store admin can never download another store's data. A full database dump is a platform task (pg_dump).
 */
export async function runBackup(kind = 'AUTO') {
  fs.mkdirSync(config.backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(config.backupDir, `store-${currentStoreId()}-${kind.toLowerCase()}-${stamp}.json.gz`);
  try {
    await jsonDump(file);
    const size = fs.statSync(file).size;
    const row = (await pool.query(`INSERT INTO backups(file_name, size_bytes, status) VALUES ($1,$2,'SUCCESS') RETURNING *`, [path.basename(file), size])).rows[0];
    await prune();
    return row;
  } catch (e) {
    const row = (await pool.query(`INSERT INTO backups(file_name, status, error) VALUES ($1,'FAILED',$2) RETURNING *`, [path.basename(file), e.message])).rows[0];
    return row;
  }
}

async function prune() {
  const s = await getSettings();
  const keep = Number(s.backup.keep || 14);
  const files = fs.readdirSync(config.backupDir).filter((f) => f.startsWith(`store-${currentStoreId()}-`)).sort().reverse();
  for (const f of files.slice(keep)) fs.rmSync(path.join(config.backupDir, f), { force: true });
}

export async function listBackups() {
  return many('SELECT * FROM backups ORDER BY id DESC LIMIT 50');
}

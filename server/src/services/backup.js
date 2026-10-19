import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import { pool, many, currentStoreId } from '../db/index.js';

// stored_files / stored_file_chunks hold uploaded files (pictures, videos: tens of MB) — not data to restore from JSON
const PLATFORM_TABLES = new Set(['platform_users', 'platform_sessions', 'plans', 'store_subscriptions', 'subscription_events', 'platform_settings', 'renewal_requests', 'idempotency_keys', 'schema_migrations', 'permissions', 'stored_files', 'stored_file_chunks']);
import { config } from '../config.js';
import { getSettings } from './settings.js';

/**
 * Written as it is read: table by table, 500 rows at a time through a cursor, straight into a gzip file, so a backup
 * never holds the whole store in memory (the server has 512 MB).
 */
async function jsonDump(file) {
  const tables = (await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`)).rows.map((r) => r.tablename);
  const gz = zlib.createGzip();
  const done = pipeline(gz, fs.createWriteStream(file));
  const write = async (text) => {
    if (!gz.write(text)) await once(gz, 'drain');
  };
  const client = await pool.connect();
  try {
    await write(`{"createdAt":${JSON.stringify(new Date())},"tables":{`);
    let firstTable = true;
    for (const t of tables) {
      // platform tables (plans, platform users, other stores' subscriptions) are never part of a store backup
      if (PLATFORM_TABLES.has(t)) continue;
      await write(`${firstTable ? '' : ','}${JSON.stringify(t)}:[`);
      firstTable = false;
      await client.query('BEGIN');
      await client.query(`DECLARE bb_dump NO SCROLL CURSOR FOR SELECT * FROM "${t}"`);
      let first = true;
      for (;;) {
        const { rows } = await client.query('FETCH 500 FROM bb_dump');
        if (!rows.length) break;
        await write((first ? '' : ',') + rows.map((r) => JSON.stringify(r)).join(','));
        first = false;
      }
      await client.query('CLOSE bb_dump');
      await client.query('COMMIT');
      await write(']');
    }
    await write('}}');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    gz.destroy(e);
    throw e;
  } finally {
    client.release();
  }
  gz.end();
  await done;
}

/**
 * Store backup: a JSON export of this store's rows only (row-level security scopes every table to the store),
 * so a store admin can never download another store's data. A full database dump is a platform task (pg_dump).
 */
export async function runBackup(kind = 'AUTO') {
  fs.mkdirSync(config.backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(config.backupDir, `store-${currentStoreId()}-${kind.toLowerCase()}-${stamp}.json.gz`);
  // the row is there before the work starts: if the server dies on the way, the daily job does not start it again
  const { id } = (await pool.query(`INSERT INTO backups(file_name, status) VALUES ($1,'RUNNING') RETURNING id`, [path.basename(file)])).rows[0];
  try {
    await jsonDump(file);
    const size = fs.statSync(file).size;
    const row = (await pool.query(`UPDATE backups SET status = 'SUCCESS', size_bytes = $2 WHERE id = $1 RETURNING *`, [id, size])).rows[0];
    await prune();
    return row;
  } catch (e) {
    fs.rmSync(file, { force: true });
    return (await pool.query(`UPDATE backups SET status = 'FAILED', error = $2 WHERE id = $1 RETURNING *`, [id, e.message])).rows[0];
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

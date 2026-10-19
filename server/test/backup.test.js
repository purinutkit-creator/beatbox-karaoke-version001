// Store backups: written as they are read (no whole-store copy in memory), uploaded files (video chunks) left out, and
// a backup the server died in the middle of is not started again by the daily job.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const DB = (process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/beatbox_test').replace(/\/[^/]+$/, '/beatbox_test_backup');
process.env.DATABASE_URL = DB;
process.env.BACKUP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-backup-'));
process.env.DISABLE_SCHEDULER = 'true';
process.env.PAYMENT_MODE = 'DEMO';
process.env.PORT = '4982';
process.env.SEED_STORE_CODE = 'beatbox1';
process.env.ADMIN_PASSWORD = 'Admin12345';

let server;
let base;
let token;
async function api(method, url, body, { headers = {}, auth = true } = {}) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

before(async () => {
  const admin = new pg.Client({ connectionString: DB.replace(/\/[^/]+$/, '/postgres') });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS beatbox_test_backup WITH (FORCE)');
  await admin.query('CREATE DATABASE beatbox_test_backup');
  await admin.end();
  const { start } = await import('../src/index.js');
  server = await start();
  base = 'http://localhost:4982/api';
  const storeSession = (await api('POST', '/auth/store-login', { storeCode: 'beatbox1', login: 'admin', password: 'Admin12345' })).body.storeSession;
  token = (await api('POST', '/auth/login', { pin: '1234' }, { headers: { 'X-Store-Session': storeSession } })).body.token;
});

after(async () => {
  server?.close();
  const { pool } = await import('../src/db/index.js');
  await pool.end();
  setTimeout(() => process.exit(0), 200).unref();
});


test('a backup with a 60 MB video uploaded: succeeds, leaves the file out, memory stays small', async () => {
  const { pool } = await import('../src/db/index.js');
  const c = await pool.connect();
  try {
  await c.query(`SELECT set_config('app.bypass_rls','on',false)`);
  const f = (await c.query(`INSERT INTO stored_files(kind, file_name, mime, size_bytes, sha256, data, chunked, complete) VALUES ('PROMO_MEDIA', 'promo.mp4', 'video/mp4', 0, '', ''::bytea, true, true) RETURNING id`)).rows[0];
  // 120 pieces of 512 KB, made in the database
  await c.query(`INSERT INTO stored_file_chunks(file_id, seq, data) SELECT $1, g, decode(repeat(md5(g::text), 16384), 'hex') FROM generate_series(1, 120) g`, [f.id]);
  } finally {
    c.release();
  }
  const before = process.memoryUsage().rss;
  let peak = before;
  const timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 20);
  const r = await api('POST', '/backups');
  clearInterval(timer);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'SUCCESS', r.body.error);
  assert.ok(peak - before < 120 * 1024 * 1024, `memory grew ${Math.round((peak - before) / 1048576)} MB`);
  const file = path.join(process.env.BACKUP_DIR, r.body.file_name);
  const dump = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString());
  assert.ok(Array.isArray(dump.tables.members) && dump.tables.rooms.length > 0, 'store data is in the backup');
  assert.equal(dump.tables.stored_file_chunks, undefined, 'uploaded file pieces are not in the backup');
  assert.equal(dump.tables.stored_files, undefined);
  assert.ok(r.body.size_bytes < 5 * 1024 * 1024);
});

test('a finished backup is not left RUNNING (RUNNING only marks one the server died in)', async () => {
  const list = (await api('GET', '/backups')).body;
  assert.ok(list.length && list.every((b) => b.status !== 'RUNNING'));
});

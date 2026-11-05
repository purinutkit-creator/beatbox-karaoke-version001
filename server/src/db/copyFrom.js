// Moving to another PostgreSQL server (e.g. a free database that does not expire): set DATABASE_URL to the new, empty
// database and COPY_FROM_DATABASE_URL to the old one. On start, when the new database has no tables yet, the whole old
// database (schema + every row, row-level security included) is copied with pg_dump | psql. Once the new database has
// tables nothing is copied again, so the variable can stay until it is removed. A failed copy stops the start, so the
// server never seeds a fresh, empty store over a half-copied database.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';

async function hasTables(url) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const r = await c.query(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`);
    return r.rows[0].n > 0;
  } finally {
    await c.end().catch(() => {});
  }
}

export async function copyFromOldDatabase({ from = process.env.COPY_FROM_DATABASE_URL, to = process.env.DATABASE_URL } = {}) {
  if (!from || !to || from === to) return false;
  if (await hasTables(to)) {
    console.log('[copy] the database already has data — nothing copied (COPY_FROM_DATABASE_URL can be removed)');
    return false;
  }
  console.log('[copy] copying the old database into the new one …');
  const started = Date.now();
  // dumped to a file first, then restored in one transaction: a dump that breaks off never reaches the new database
  const file = path.join(os.tmpdir(), `bb-copy-${process.pid}.sql`);
  // app.bypass_rls lets pg_dump read (and psql write) every store's rows through the forced row-level security
  const env = { ...process.env, PGOPTIONS: '-c app.bypass_rls=on' };
  try {
    await run(['pg_dump', '--no-owner', '--no-privileges', '--enable-row-security', '-f', file, '-d', from], env);
    await run(['psql', '-X', '-q', '-1', '-o', '/dev/null', '-v', 'ON_ERROR_STOP=1', '-f', file, '-d', to], env);
  } finally {
    fs.rm(file, { force: true }, () => {});
  }
  console.log(`[copy] done in ${Math.round((Date.now() - started) / 1000)} s`);
  return true;
}

function run([cmd, ...args], env) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => {
      err = (err + d).slice(-2000);
    });
    p.on('error', reject);
    // the message names the tool and its error text only — connection strings are never echoed by pg_dump / psql
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`database copy failed (${cmd} ${code}): ${err.trim()}`))));
  });
}

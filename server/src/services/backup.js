import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { pool, many } from '../db/index.js';
import { config } from '../config.js';
import { getSettings } from './settings.js';

function pgDump(file) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file);
    const gz = zlib.createGzip();
    const p = spawn('pg_dump', ['--no-owner', '--format=plain', config.databaseUrl]);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.stdout.pipe(gz).pipe(out);
    p.on('close', (code) => (code === 0 ? out.on('finish', resolve) : reject(new Error(err || `pg_dump exited ${code}`))));
  });
}

async function jsonDump(file) {
  const tables = (await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`)).rows.map((r) => r.tablename);
  const data = {};
  for (const t of tables) data[t] = (await pool.query(`SELECT * FROM "${t}"`)).rows;
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify({ createdAt: new Date(), tables: data })));
}

export async function runBackup(kind = 'AUTO') {
  fs.mkdirSync(config.backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let file = path.join(config.backupDir, `beatbox-${kind.toLowerCase()}-${stamp}.sql.gz`);
  try {
    try {
      await pgDump(file);
    } catch {
      file = file.replace('.sql.gz', '.json.gz');
      await jsonDump(file);
    }
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
  const files = fs.readdirSync(config.backupDir).filter((f) => f.startsWith('beatbox-')).sort().reverse();
  for (const f of files.slice(keep)) fs.rmSync(path.join(config.backupDir, f), { force: true });
}

export async function listBackups() {
  return many('SELECT * FROM backups ORDER BY id DESC LIMIT 50');
}

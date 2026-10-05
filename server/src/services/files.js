// Uploaded files stored in PostgreSQL (see migration 002). References look like `db:<uuid>`.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { pool } from '../db/index.js';

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

export async function saveFile(c, { kind, name, mime, buffer }) {
  const row = (
    await (c || pool).query(`INSERT INTO stored_files(kind, file_name, mime, size_bytes, sha256, data) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [kind, name || 'file', mime || 'application/octet-stream', buffer.length, sha256(buffer), buffer])
  ).rows[0];
  return { id: row.id, ref: `db:${row.id}` };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getFile(id) {
  if (!UUID.test(id)) return null;
  return (await pool.query('SELECT id, kind, file_name, mime, data FROM stored_files WHERE id = $1', [id])).rows[0] || null;
}

export async function deleteFile(id) {
  if (UUID.test(id)) await pool.query('DELETE FROM stored_files WHERE id = $1', [id]);
}

/** Send a stored reference (`db:<uuid>`) or a legacy on-disk path. */
export async function sendStored(res, ref, { cache = 'private, no-store' } = {}) {
  if (ref?.startsWith('db:')) {
    const f = await getFile(ref.slice(3));
    if (!f) return false;
    res.set({ 'Content-Type': f.mime, 'Cache-Control': cache });
    res.send(f.data);
    return true;
  }
  if (ref && fs.existsSync(ref)) {
    res.sendFile(ref);
    return true;
  }
  return false;
}

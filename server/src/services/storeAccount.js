// Store account: a device signs in to a store with the store code + the store account (username or e-mail + password),
// then staff use their 4-digit PIN inside. The account is the owner employee (all permissions, default PIN 1234).
// Starting credentials made by the system / the Super Owner are kept encrypted only until the owner changes them,
// so the Super Owner console and the owner's settings can show them; password hashes are never shown.
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { pool, tx, runAsPlatform, runWithStore } from '../db/index.js';
import { hashPin, pinLookup, verifyPin, signToken, verifyToken } from '../lib/auth.js';
import { encryptJson, decryptJson } from './integrations.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';

export const DEFAULT_OWNER_PIN = '1234';
export const DEFAULT_USERNAME = 'admin';
const CODE_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';

export const normalizeCode = (c) => String(c || '').trim().toLowerCase().replace(/[\s-]/g, '');
export const validCode = (c) => /^[a-z0-9]{8}$/.test(c) && /[0-9]/.test(c) && /[a-z]/.test(c);

function randomFrom(chars, n) {
  const bytes = crypto.randomBytes(n);
  return [...bytes].map((b) => chars[b % chars.length]).join('');
}

/** Readable starting password: 10 characters, letters + digits (no look-alikes). */
export function generatePassword() {
  for (;;) {
    const p = randomFrom('abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789', 10);
    if (/[0-9]/.test(p) && /[a-z]/.test(p) && /[A-Z]/.test(p)) return p;
  }
}

export async function generateStoreCode(c = pool) {
  for (;;) {
    const code = randomFrom(CODE_CHARS, 8);
    if (!validCode(code)) continue;
    if (!(await c.query('SELECT 1 FROM stores WHERE lower(store_code) = $1', [code])).rows[0]) return code;
  }
}

// ── store sessions (one per device, long lived; raising stores.login_version signs every device out) ──
const versionCache = new Map(); // storeId → { v, at }

export async function storeLoginVersion(storeId, { fresh = false } = {}) {
  const hit = versionCache.get(storeId);
  if (!fresh && hit && Date.now() - hit.at < 30000) return hit.v;
  const r = await runAsPlatform(() => pool.query('SELECT login_version, is_active FROM stores WHERE id = $1', [storeId]));
  const v = r.rows[0] ? (r.rows[0].is_active === false ? -1 : Number(r.rows[0].login_version)) : null;
  versionCache.set(storeId, { v, at: Date.now() });
  return v;
}

export function signStoreSession(storeId, version, accountId) {
  return signToken({ typ: 'store', st: storeId, v: version, aid: accountId }, '180d');
}

/** Store id of a valid store-session token (header X-Store-Session), or null. */
export async function readStoreSession(token) {
  const p = token ? verifyToken(token) : null;
  if (!p || p.typ !== 'store' || !p.st) return null;
  const v = await storeLoginVersion(Number(p.st));
  if (v == null || v < 0 || Number(p.v) !== v) return null;
  return Number(p.st);
}

export async function signOutAllDevices(storeId) {
  await runAsPlatform(() => pool.query('UPDATE stores SET login_version = login_version + 1, updated_at = now() WHERE id = $1', [storeId]));
  versionCache.delete(storeId);
}

// ── starting credentials ──
export function readInitial(enc) {
  const v = enc ? decryptJson(enc) : {};
  return { password: v.p || null, pin: v.pin || null };
}
function writeInitial({ password, pin }) {
  return password || pin ? encryptJson({ ...(password ? { p: password } : {}), ...(pin ? { pin } : {}) }) : null;
}

/** Set a password the Super Owner / system chose (visible until the owner changes it). Runs in the store's context. */
export async function setStartingPassword(c, employeeId, password) {
  const e = (await c.query('SELECT initial_password_enc FROM employees WHERE id = $1', [employeeId])).rows[0];
  const init = readInitial(e?.initial_password_enc);
  await c.query(`UPDATE employees SET password_hash = $2, initial_password_enc = $3, password_changed_at = NULL, failed_attempts = 0, locked_until = NULL, updated_at = now() WHERE id = $1`, [
    employeeId,
    await bcrypt.hash(password, 12),
    writeInitial({ ...init, password }),
  ]);
}

/** The owner chose their own password → the starting one is forgotten. */
export async function setOwnPassword(c, employeeId, password) {
  const e = (await c.query('SELECT initial_password_enc FROM employees WHERE id = $1', [employeeId])).rows[0];
  const init = readInitial(e?.initial_password_enc);
  await c.query(`UPDATE employees SET password_hash = $2, initial_password_enc = $3, password_changed_at = now(), updated_at = now() WHERE id = $1`, [employeeId, await bcrypt.hash(password, 12), writeInitial({ ...init, password: null })]);
}

async function pinTaken(c, pin, exceptId = null) {
  return !!(await c.query('SELECT 1 FROM employees WHERE pin_lookup = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR id <> $2)', [pinLookup(pin), exceptId])).rows[0];
}

/** Owner PIN back to 1234 (or a free random PIN when 1234 belongs to someone else) — shown until changed. */
export async function resetOwnerPin(c, employeeId) {
  let pin = DEFAULT_OWNER_PIN;
  for (let i = 0; (await pinTaken(c, pin, employeeId)) && i < 200; i++) pin = String(1000 + crypto.randomInt(9000));
  const e = (await c.query('SELECT initial_password_enc FROM employees WHERE id = $1', [employeeId])).rows[0];
  const init = readInitial(e?.initial_password_enc);
  await c.query('UPDATE employees SET pin_hash = $2, pin_lookup = $3, initial_password_enc = $4, updated_at = now() WHERE id = $1', [employeeId, await hashPin(pin), pinLookup(pin), writeInitial({ ...init, pin: pin === DEFAULT_OWNER_PIN ? null : pin })]);
  return pin;
}

/** Owner / any employee changes their own PIN. */
export async function setOwnPin(c, employeeId, pin) {
  if (!/^\d{4}$/.test(pin)) throw badRequest('PIN ต้องเป็นตัวเลข 4 หลัก');
  if (await pinTaken(c, pin, employeeId)) throw conflict('PIN นี้มีพนักงานคนอื่นใช้แล้ว', 'DUPLICATE');
  const e = (await c.query('SELECT initial_password_enc FROM employees WHERE id = $1', [employeeId])).rows[0];
  const init = readInitial(e?.initial_password_enc);
  await c.query('UPDATE employees SET pin_hash = $2, pin_lookup = $3, initial_password_enc = $4, updated_at = now() WHERE id = $1', [employeeId, await hashPin(pin), pinLookup(pin), writeInitial({ ...init, pin: null })]);
}

export function validUsername(u) {
  return /^[a-z0-9._-]{3,40}$/i.test(u || '');
}

/** Owner of the current store (context). */
export async function ownerOf(c = pool) {
  return (await c.query(`SELECT * FROM employees WHERE is_owner AND deleted_at IS NULL AND NOT is_hidden ORDER BY id LIMIT 1`)).rows[0] || null;
}

/** Everything the owner / Super Owner sees about the store account (current store context). */
export async function accountInfo(c = pool) {
  const store = (await c.query('SELECT id, name, slug, store_code, owner_email FROM stores LIMIT 1')).rows[0];
  const o = await ownerOf(c);
  if (!o) return { storeId: store?.id, storeCode: store?.store_code, storeName: store?.name, owner: null };
  const init = readInitial(o.initial_password_enc);
  const pinIsDefault = o.pin_hash ? await verifyPin(DEFAULT_OWNER_PIN, o.pin_hash) : false;
  return {
    storeId: store.id,
    storeCode: store.store_code,
    storeName: store.name,
    slug: store.slug,
    owner: {
      id: o.id,
      name: o.name,
      username: o.username,
      email: o.email,
      hasPassword: !!o.password_hash,
      startingPassword: init.password, // null once the owner changed it
      passwordChangedAt: o.password_changed_at,
      pin: pinIsDefault ? DEFAULT_OWNER_PIN : init.pin, // only a default / reset PIN is ever shown
      pinIsDefault,
    },
  };
}

/** Change username / e-mail / store code (owner or Super Owner). */
export async function updateAccount(c, { username, email, storeCode }) {
  const o = await ownerOf(c);
  if (!o) throw notFound('ไม่พบบัญชีเจ้าของร้าน');
  if (username !== undefined) {
    if (!validUsername(username)) throw badRequest('ชื่อผู้ใช้ 3–40 ตัว ใช้ได้เฉพาะ a-z 0-9 . _ -');
    const dup = (await c.query('SELECT 1 FROM employees WHERE lower(username) = lower($1) AND id <> $2 AND deleted_at IS NULL', [username, o.id])).rows[0];
    if (dup) throw conflict('ชื่อผู้ใช้นี้ถูกใช้แล้วในร้านนี้', 'USERNAME_TAKEN');
    await c.query('UPDATE employees SET username = $2, updated_at = now() WHERE id = $1', [o.id, username.toLowerCase()]);
  }
  if (email !== undefined) {
    const em = email ? String(email).trim().toLowerCase() : null;
    if (em) {
      const taken = await runAsPlatform(() =>
        pool.query(`SELECT 1 FROM employees WHERE lower(email) = $1 AND id <> $2 AND deleted_at IS NULL UNION SELECT 1 FROM platform_users WHERE lower(email) = $1`, [em, o.id]),
      );
      if (taken.rows[0]) throw conflict('อีเมลนี้ถูกใช้แล้ว', 'EMAIL_TAKEN');
    }
    await c.query('UPDATE employees SET email = $2, updated_at = now() WHERE id = $1', [o.id, em]);
    await c.query('UPDATE stores SET owner_email = $1, updated_at = now()', [em]);
  }
  if (storeCode !== undefined) {
    const code = normalizeCode(storeCode);
    if (!validCode(code)) throw badRequest('รหัสร้านค้าต้องเป็นตัวอักษร a-z และตัวเลข รวม 8 ตัว (มีทั้งตัวอักษรและตัวเลข)');
    const taken = await runAsPlatform(async () => (await pool.query('SELECT id FROM stores WHERE lower(store_code) = $1', [code])).rows[0]);
    const me = (await c.query('SELECT id FROM stores LIMIT 1')).rows[0];
    if (taken && taken.id !== me.id) throw conflict('รหัสร้านค้านี้ถูกใช้แล้ว', 'CODE_TAKEN');
    await c.query('UPDATE stores SET store_code = $1, updated_at = now()', [code]);
  }
}

/**
 * Startup: every store has an owner account that can sign in — username, password and PIN.
 * Missing pieces are created (never overwritten): first ADMIN becomes the owner, username "admin",
 * a random starting password (shown to the Super Owner), owner PIN 1234.
 */
export async function ensureStoreAccounts({ seedPassword = null } = {}) {
  const stores = (await runAsPlatform(() => pool.query('SELECT id FROM stores ORDER BY id'))).rows;
  const created = [];
  for (const { id } of stores) {
    try {
      await runWithStore(id, () =>
        tx(async (c) => {
          let o = await ownerOf(c);
          if (!o) {
            o = (await c.query(`SELECT e.* FROM employees e JOIN roles r ON r.id = e.role_id WHERE r.code = 'ADMIN' AND e.deleted_at IS NULL AND NOT e.is_hidden ORDER BY e.id LIMIT 1`)).rows[0];
            if (!o) return;
            await c.query('UPDATE employees SET is_owner = true WHERE id = $1', [o.id]);
          }
          if (!o.username) {
            let u = DEFAULT_USERNAME;
            for (let i = 2; (await c.query('SELECT 1 FROM employees WHERE lower(username) = $1 AND deleted_at IS NULL', [u])).rows[0]; i++) u = `${DEFAULT_USERNAME}${i}`;
            await c.query('UPDATE employees SET username = $2 WHERE id = $1', [o.id, u]);
          }
          if (!o.password_hash) {
            await setStartingPassword(c, o.id, seedPassword || generatePassword());
            created.push(id);
          }
          if (!o.pin_hash) await resetOwnerPin(c, o.id);
        }),
      );
    } catch (e) {
      console.error(`[store-account] store ${id}:`, e.message);
    }
  }
  if (created.length) console.log(`[store-account] starting login created for store(s) ${created.join(', ')} — see the Super Owner console`);
  return created;
}

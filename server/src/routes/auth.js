import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { pool, tx, one, currentStoreId, runAsPlatform, setContextStore } from '../db/index.js';
import { getSubscription, planAllowsPermission, publicSubscription } from '../services/subscription.js';
import { ALL_PERMISSION_CODES } from '@beatbox/shared/constants.js';
import { pinLookup, verifyPin, signToken, requireAuth, loadPermissions, signApproval, hasPerm, ownDevice } from '../lib/auth.js';
import { unauthorized, forbidden } from '../lib/errors.js';
import { logActivity } from '../lib/activity.js';
import { z, parse } from '../lib/validate.js';
import { getSettings } from '../services/settings.js';
import { findPlatformUser, platformSignIn } from '../services/platformAuth.js';
import { normalizeCode, readStoreSession, signStoreSession, storeLoginVersion, accountInfo, updateAccount, setOwnPassword, setOwnPin, signOutAllDevices } from '../services/storeAccount.js';
import { notFound } from '../lib/errors.js';

const r = Router();

async function findByPin(pin) {
  if (!/^\d{4}$/.test(String(pin || ''))) return null;
  const e = (
    await pool.query(
      `SELECT e.*, r.code AS role FROM employees e JOIN roles r ON r.id = e.role_id WHERE e.pin_lookup = $1 AND e.deleted_at IS NULL AND NOT e.is_hidden`,
      [pinLookup(pin)],
    )
  ).rows[0];
  if (!e) return null;
  if (!e.pin_hash || !(await verifyPin(pin, e.pin_hash))) return null;
  return e;
}

/** Effective permissions = staff permissions ∩ features of the store plan. */
export async function effectivePermissions(e, sub) {
  // the store owner can use every system (only limited by the store's plan)
  const own = e.role === 'ADMIN' || e.is_owner ? ALL_PERMISSION_CODES : await loadPermissions(e.id);
  return own.filter((p) => planAllowsPermission(sub, p));
}

/** Create a server-side session for an employee of the current store and return the login payload. */
export async function issueEmployeeSession(req, e, { deviceId = null, method = 'PIN', claims = {}, activityDetails = {} } = {}) {
  const ua = req.headers['user-agent'] || '';
  const out = await tx(async (c) => {
    const s = (await c.query('INSERT INTO auth_sessions(employee_id, device_id) VALUES ($1,$2) RETURNING id', [e.id, deviceId || null])).rows[0];
    await c.query('UPDATE employees SET last_login_at = now(), failed_attempts = 0, locked_until = NULL WHERE id = $1', [e.id]);
    await c.query(`INSERT INTO employee_login_logs(employee_id, device_id, success, ip, user_agent) VALUES ($1,$2,true,$3,$4)`, [e.id, deviceId || null, req.ip, ua]);
    await logActivity(c, { employee: { id: e.id, name: e.name, platformUserId: claims.sup || null }, ip: req.ip, deviceId }, 'LOGIN', 'employee', e.id, { method, ...activityDetails });
    return s;
  });
  const settings = await getSettings();
  const sub = await getSubscription(currentStoreId(), { fresh: true });
  const token = signToken({ typ: 'employee', sid: out.id, eid: e.id, st: currentStoreId(), ...claims }, '24h');
  return {
    token,
    idleMinutes: settings.security.sessionIdleMinutes,
    store: { id: currentStoreId(), slug: settings.store.slug, code: settings.store.code, name: settings.store.name },
    employee: { id: e.id, name: e.name, photoUrl: e.photo_url, position: e.position, role: e.role, discountLimitPercent: Number(e.discount_limit_percent), isOwner: !!e.is_owner, superOwnerName: claims.supName || null },
    permissions: await effectivePermissions(e, sub),
    subscription: publicSubscription(sub),
  };
}

/** Step 1: the store code (e.g. 58bksn3j) → which store this is (name + logo for the next screen). */
r.get('/store/:code', async (req, res) => {
  const code = normalizeCode(req.params.code);
  const s = code ? await runAsPlatform(() => one('SELECT id, name, logo_url, store_code, is_active FROM stores WHERE lower(store_code) = $1', [code])) : null;
  if (!s) throw notFound('ไม่พบร้านค้า กรุณาตรวจสอบรหัสร้านค้า 8 หลัก');
  if (s.is_active === false) throw forbidden('ร้านค้านี้ถูกระงับการใช้งาน กรุณาติดต่อผู้ดูแลระบบ');
  res.json({ code: s.store_code, name: s.name, logoUrl: s.logo_url });
});

/** Step 2: store account (username or e-mail + password) → this device is signed in to the store (store session). */
r.post('/store-login', async (req, res) => {
  const b = parse(z.object({ storeCode: z.string().trim().min(1).max(20), login: z.string().trim().min(1).max(200), password: z.string().min(1).max(200) }), req.body);
  const code = normalizeCode(b.storeCode);
  const store = await runAsPlatform(() => one('SELECT id, name, slug, store_code, logo_url, is_active FROM stores WHERE lower(store_code) = $1', [code]));
  if (!store) throw notFound('ไม่พบร้านค้า กรุณาตรวจสอบรหัสร้านค้า 8 หลัก');
  if (store.is_active === false) throw forbidden('ร้านค้านี้ถูกระงับการใช้งาน กรุณาติดต่อผู้ดูแลระบบ');
  setContextStore(store.id);
  const e = await one(
    `SELECT e.*, r.code AS role FROM employees e JOIN roles r ON r.id = e.role_id
     WHERE (lower(e.username) = lower($1) OR lower(e.email) = lower($1)) AND e.password_hash IS NOT NULL AND e.deleted_at IS NULL AND NOT e.is_hidden ORDER BY e.is_owner DESC, e.id LIMIT 1`,
    [b.login],
  );
  const fail = 'ชื่อผู้ใช้ / อีเมล หรือรหัสผ่านไม่ถูกต้อง';
  if (!e) {
    await pool.query(`INSERT INTO employee_login_logs(employee_id, success, ip, user_agent, action) VALUES (NULL,false,$1,$2,'STORE_LOGIN')`, [req.ip, req.headers['user-agent'] || '']).catch(() => {});
    throw unauthorized(fail);
  }
  if (e.locked_until && new Date(e.locked_until) > new Date()) throw unauthorized(`เข้าสู่ระบบผิดหลายครั้ง กรุณารอ ${Math.ceil((new Date(e.locked_until) - Date.now()) / 60000)} นาที`);
  if (!(await bcrypt.compare(b.password, e.password_hash))) {
    const n = Number(e.failed_attempts) + 1;
    await pool.query(`UPDATE employees SET failed_attempts = $2, locked_until = CASE WHEN $3 THEN now() + interval '15 minutes' ELSE locked_until END WHERE id = $1`, [e.id, n >= 5 ? 0 : n, n >= 5]);
    await pool.query(`INSERT INTO employee_login_logs(employee_id, success, ip, user_agent, action) VALUES ($1,false,$2,$3,'STORE_LOGIN')`, [e.id, req.ip, req.headers['user-agent'] || '']);
    throw unauthorized(n >= 5 ? 'เข้าสู่ระบบผิดเกิน 5 ครั้ง ระบบพักการเข้าสู่ระบบ 15 นาที' : fail);
  }
  if (!e.is_active) throw forbidden('บัญชีนี้ถูกปิดใช้งาน');
  await pool.query('UPDATE employees SET failed_attempts = 0, locked_until = NULL WHERE id = $1', [e.id]);
  await pool.query(`INSERT INTO employee_login_logs(employee_id, success, ip, user_agent, action) VALUES ($1,true,$2,$3,'STORE_LOGIN')`, [e.id, req.ip, req.headers['user-agent'] || '']);
  await logActivity(null, { employee: { id: e.id, name: e.name }, ip: req.ip }, 'STORE_LOGIN', 'store', store.id, { login: b.login });
  const version = await storeLoginVersion(store.id, { fresh: true });
  res.json({ storeSession: signStoreSession(store.id, version, e.id), store: { id: store.id, code: store.store_code, slug: store.slug, name: store.name, logoUrl: store.logo_url } });
});

/** Step 3: staff PIN — only on a device that is signed in to this store. */
r.post('/login', async (req, res) => {
  const { pin, deviceId: rawDevice } = parse(z.object({ pin: z.string(), deviceId: z.coerce.number().int().optional().nullable() }), req.body);
  const signedInStore = await readStoreSession(req.headers['x-store-session']);
  if (!signedInStore || signedInStore !== Number(currentStoreId())) throw unauthorized('กรุณาเข้าสู่ระบบร้านค้าก่อน (รหัสร้านค้า + บัญชีร้าน)', 'STORE_LOGIN_REQUIRED');
  const deviceId = await ownDevice(rawDevice);
  const e = await findByPin(pin);
  const ua = req.headers['user-agent'] || '';
  if (!e) {
    await pool.query(`INSERT INTO employee_login_logs(employee_id, device_id, success, ip, user_agent) VALUES (NULL,$1,false,$2,$3)`, [deviceId || null, req.ip, ua]);
    throw unauthorized('รหัสพนักงานไม่ถูกต้อง');
  }
  if (!e.is_active) throw forbidden('บัญชีพนักงานนี้ถูกปิดใช้งาน');
  res.json(await issueEmployeeSession(req, e, { deviceId, method: 'PIN' }));
});

/** Store owner: email + password (no OTP / verification code). The email decides the store. */
r.post('/owner-login', async (req, res) => {
  const b = parse(z.object({ email: z.string().trim().min(3).max(200), password: z.string().min(1).max(200), deviceId: z.coerce.number().int().optional().nullable() }), req.body);
  const found = await runAsPlatform(() => one(`SELECT id, store_id FROM employees WHERE lower(email) = lower($1) AND deleted_at IS NULL AND password_hash IS NOT NULL`, [b.email]));
  if (!found) {
    // the Super Admin's e-mail typed on the store login page → sign in to the central console instead
    if (await findPlatformUser(b.email)) return res.json({ platform: true, ...(await platformSignIn(b.email, b.password)) });
    throw unauthorized('อีเมลหรือรหัสผ่านไม่ถูกต้อง');
  }
  setContextStore(found.store_id);
  const e = await one(`SELECT e.*, r.code AS role FROM employees e JOIN roles r ON r.id = e.role_id WHERE e.id = $1`, [found.id]);
  if (e.locked_until && new Date(e.locked_until) > new Date()) throw unauthorized(`เข้าสู่ระบบผิดหลายครั้ง กรุณารอ ${Math.ceil((new Date(e.locked_until) - Date.now()) / 60000)} นาที`);
  if (!(await bcrypt.compare(b.password, e.password_hash))) {
    const n = Number(e.failed_attempts) + 1;
    await pool.query(`UPDATE employees SET failed_attempts = $2, locked_until = CASE WHEN $3 THEN now() + interval '15 minutes' ELSE locked_until END WHERE id = $1`, [e.id, n >= 5 ? 0 : n, n >= 5]);
    await pool.query(`INSERT INTO employee_login_logs(employee_id, success, ip, user_agent) VALUES ($1,false,$2,$3)`, [e.id, req.ip, req.headers['user-agent'] || '']);
    throw unauthorized(n >= 5 ? 'เข้าสู่ระบบผิดเกิน 5 ครั้ง ระบบพักการเข้าสู่ระบบ 15 นาที' : 'อีเมลหรือรหัสผ่านไม่ถูกต้อง');
  }
  if (!e.is_active) throw forbidden('บัญชีนี้ถูกปิดใช้งาน');
  res.json(await issueEmployeeSession(req, e, { deviceId: await ownDevice(b.deviceId), method: 'EMAIL' }));
});

/** Owner changes the store account password (the starting password is forgotten). */
r.post('/password', requireAuth, async (req, res) => {
  const b = parse(z.object({ current: z.string().min(1), password: z.string().min(8, 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร').max(200) }), req.body);
  const e = await one('SELECT id, password_hash FROM employees WHERE id = $1', [req.employee.id]);
  if (!e?.password_hash || !(await bcrypt.compare(b.current, e.password_hash))) throw unauthorized('รหัสผ่านปัจจุบันไม่ถูกต้อง');
  await tx((c) => setOwnPassword(c, e.id, b.password));
  await logActivity(null, req, 'PASSWORD_CHANGE', 'employee', e.id, {});
  res.json({ ok: true });
});

/** Any staff member changes their own 4-digit PIN (needs the current PIN). */
r.post('/my-pin', requireAuth, async (req, res) => {
  const b = parse(z.object({ current: z.string(), pin: z.string().regex(/^\d{4}$/, 'PIN ต้องเป็นตัวเลข 4 หลัก') }), req.body);
  const me = await one('SELECT id, pin_hash FROM employees WHERE id = $1', [req.employee.id]);
  if (!me?.pin_hash || !(await verifyPin(b.current, me.pin_hash))) throw unauthorized('PIN ปัจจุบันไม่ถูกต้อง');
  await tx((c) => setOwnPin(c, me.id, b.pin));
  await logActivity(null, req, 'PIN_CHANGE', 'employee', me.id, {});
  res.json({ ok: true });
});

// ── store account (owner, or the Super Owner visiting the store) ──
function ownerOnly(req, _res, next) {
  if (!req.employee?.isOwner && !req.employee?.platformUserId) throw forbidden('เฉพาะเจ้าของร้านเท่านั้น');
  next();
}

r.get('/store-account', requireAuth, ownerOnly, async (_req, res) => res.json(await accountInfo()));

r.put('/store-account', requireAuth, ownerOnly, async (req, res) => {
  const b = parse(z.object({ username: z.string().trim().max(40).optional(), email: z.string().trim().email('อีเมลไม่ถูกต้อง').max(200).optional().nullable().or(z.literal('')), storeCode: z.string().trim().max(20).optional() }), req.body);
  await tx((c) => updateAccount(c, { username: b.username, email: b.email === undefined ? undefined : b.email || null, storeCode: b.storeCode }));
  const { clearStoreCache } = await import('../lib/tenant.js');
  clearStoreCache();
  await logActivity(null, req, 'STORE_ACCOUNT_UPDATE', 'store', currentStoreId(), { username: b.username, email: b.email, storeCode: b.storeCode });
  res.json(await accountInfo());
});

/** Sign every device out of the store (they need the store code + account again). */
r.post('/store-account/sign-out-devices', requireAuth, ownerOnly, async (req, res) => {
  await signOutAllDevices(currentStoreId());
  await logActivity(null, req, 'STORE_SIGN_OUT_DEVICES', 'store', currentStoreId(), {});
  res.json({ ok: true });
});

r.post('/logout', requireAuth, async (req, res) => {
  await pool.query('UPDATE auth_sessions SET revoked_at = now() WHERE id = $1', [req.authSessionId]);
  await pool.query(`INSERT INTO employee_login_logs(employee_id, device_id, success, ip, action) VALUES ($1,$2,true,$3,'LOGOUT')`, [req.employee.id, req.deviceId, req.ip]);
  await logActivity(null, req, 'LOGOUT', 'employee', req.employee.id);
  res.json({ ok: true });
});

r.get('/me', requireAuth, async (req, res) => {
  const settings = await getSettings();
  res.json({ employee: req.employee, permissions: [...req.permissions], store: { id: currentStoreId(), slug: settings.store.slug, code: settings.store.code, name: settings.store.name }, subscription: publicSubscription(req.subscription) });
});

// keep-alive ping from an active UI (extends idle timeout)
r.post('/ping', requireAuth, (_req, res) => res.json({ ok: true, now: Date.now() }));

/** Manager approval with PIN → short-lived approval token (discount over limit, refunds, etc.). */
r.post('/approve', requireAuth, async (req, res) => {
  const { pin, permission, reason } = parse(z.object({ pin: z.string(), permission: z.string(), reason: z.string().optional() }), req.body);
  const m = await findByPin(pin);
  if (!m || !m.is_active) throw unauthorized('รหัสผู้อนุมัติไม่ถูกต้อง');
  const perms = await effectivePermissions(m, req.subscription);
  if (!perms.includes(permission)) throw forbidden(`${m.name} ไม่มีสิทธิ์อนุมัติรายการนี้`);
  await logActivity(null, req, 'APPROVAL_GRANTED', 'approval', permission, { approver: m.name, approverId: m.id, reason });
  res.json({ approvalToken: signApproval({ id: m.id, name: m.name }, permission), approver: { id: m.id, name: m.name } });
});

r.get('/can/:perm', requireAuth, (req, res) => res.json({ allowed: hasPerm(req, req.params.perm) }));

export default r;

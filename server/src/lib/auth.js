import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { pool } from '../db/index.js';
import { unauthorized, forbidden } from './errors.js';
import { getSettings } from '../services/settings.js';

export function pinLookup(pin) {
  return crypto.createHmac('sha256', config.pinPepper).update(String(pin)).digest('hex');
}

export async function hashPin(pin) {
  return bcrypt.hash(String(pin), 10);
}

export async function verifyPin(pin, hash) {
  return bcrypt.compare(String(pin), hash);
}

export function signToken(payload, expiresIn = '7d') {
  return jwt.sign(payload, config.jwtSecret, { expiresIn });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch {
    return null;
  }
}

function getBearer(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  return null;
}

const permCache = new Map(); // employeeId -> { at, perms }

export async function loadPermissions(employeeId, client = pool) {
  const hit = permCache.get(employeeId);
  if (hit && Date.now() - hit.at < 10000) return hit.perms;
  const r = await client.query(
    `SELECT rp.permission_code FROM employees e JOIN role_permissions rp ON rp.role_id = e.role_id WHERE e.id = $1`,
    [employeeId],
  );
  const set = new Set(r.rows.map((x) => x.permission_code));
  const o = await client.query('SELECT permission_code, granted FROM employee_permissions WHERE employee_id = $1', [employeeId]);
  for (const row of o.rows) {
    if (row.granted) set.add(row.permission_code);
    else set.delete(row.permission_code);
  }
  const perms = [...set];
  permCache.set(employeeId, { at: Date.now(), perms });
  return perms;
}

export function clearPermCache(employeeId) {
  if (employeeId) permCache.delete(employeeId);
  else permCache.clear();
}

/** Resolves the employee from an auth token (checks server-side session + idle timeout). */
export async function authenticateToken(token) {
  const payload = verifyToken(token);
  if (!payload || payload.typ !== 'employee') return null;
  const s = await pool.query(
    `SELECT s.id, s.last_active_at, s.revoked_at, s.device_id, e.id AS employee_id, e.name, e.photo_url, e.position, e.is_active,
            e.discount_limit_percent, r.code AS role
     FROM auth_sessions s JOIN employees e ON e.id = s.employee_id JOIN roles r ON r.id = e.role_id
     WHERE s.id = $1 AND e.deleted_at IS NULL`,
    [payload.sid],
  );
  const row = s.rows[0];
  if (!row || row.revoked_at || !row.is_active) return null;
  const settings = await getSettings();
  const idleMs = Number(settings.security.sessionIdleMinutes || 30) * 60000;
  if (Date.now() - new Date(row.last_active_at).getTime() > idleMs) {
    await pool.query('UPDATE auth_sessions SET revoked_at = now() WHERE id = $1', [row.id]);
    return { expired: true };
  }
  return {
    sessionId: row.id,
    lastActiveAt: row.last_active_at,
    deviceId: row.device_id,
    employee: {
      id: row.employee_id,
      name: row.name,
      photoUrl: row.photo_url,
      position: row.position,
      role: row.role,
      discountLimitPercent: Number(row.discount_limit_percent),
    },
  };
}

export async function requireAuth(req, _res, next) {
  if (req.employee) return next(); // already authenticated by an earlier router
  const token = getBearer(req);
  if (!token) throw unauthorized();
  const auth = await authenticateToken(token);
  if (!auth) throw unauthorized();
  if (auth.expired) throw unauthorized('หมดเวลาการใช้งาน กรุณาเข้าสู่ระบบใหม่');
  req.employee = auth.employee;
  req.authSessionId = auth.sessionId;
  req.deviceId = Number(req.headers['x-device-id']) || auth.deviceId || null;
  req.permissions = new Set(await loadPermissions(auth.employee.id));
  // passive requests (polling) should not extend the session
  if (req.headers['x-passive'] !== '1' && Date.now() - new Date(auth.lastActiveAt).getTime() > 15000) {
    pool.query('UPDATE auth_sessions SET last_active_at = now() WHERE id = $1', [auth.sessionId]).catch(() => {});
  }
  next();
}

export function can(...perms) {
  return (req, _res, next) => {
    if (!req.employee) throw unauthorized();
    if (req.employee.role === 'ADMIN') return next();
    if (!perms.every((p) => req.permissions.has(p))) throw forbidden(`คุณไม่มีสิทธิ์ทำรายการนี้ (${perms.join(', ')})`);
    next();
  };
}

export function hasPerm(req, perm) {
  return req.employee?.role === 'ADMIN' || req.permissions?.has(perm);
}

/** Manager approval token (short lived) issued after a manager enters their PIN. */
export function signApproval(employee, permission) {
  return signToken({ typ: 'approval', eid: employee.id, name: employee.name, perm: permission }, '10m');
}

export function readApproval(token, permission) {
  const p = token ? verifyToken(token) : null;
  if (!p || p.typ !== 'approval' || (permission && p.perm !== permission)) return null;
  return { id: p.eid, name: p.name };
}

// ── Members (customer website) ──
export async function requireMember(req, _res, next) {
  const token = getBearer(req);
  const p = token ? verifyToken(token) : null;
  if (!p || p.typ !== 'member') throw unauthorized('กรุณาเข้าสู่ระบบสมาชิก');
  const s = await pool.query(
    `SELECT ms.id, m.* FROM member_sessions ms JOIN members m ON m.id = ms.member_id
     WHERE ms.id = $1 AND ms.revoked_at IS NULL AND ms.expires_at > now() AND m.deleted_at IS NULL`,
    [p.sid],
  );
  if (!s.rows[0]) throw unauthorized('กรุณาเข้าสู่ระบบสมาชิก');
  req.member = s.rows[0];
  req.memberSessionId = p.sid;
  next();
}

export async function optionalMember(req, _res, next) {
  const token = getBearer(req);
  const p = token ? verifyToken(token) : null;
  if (p && p.typ === 'member') {
    const s = await pool.query(
      `SELECT m.* FROM member_sessions ms JOIN members m ON m.id = ms.member_id
       WHERE ms.id = $1 AND ms.revoked_at IS NULL AND ms.expires_at > now() AND m.deleted_at IS NULL`,
      [p.sid],
    );
    if (s.rows[0]) req.member = s.rows[0];
  }
  next();
}

export async function createMemberSession(client, memberId) {
  const r = await client.query(`INSERT INTO member_sessions(member_id, expires_at) VALUES ($1, now() + interval '30 days') RETURNING id`, [memberId]);
  return signToken({ typ: 'member', sid: r.rows[0].id, mid: memberId }, '30d');
}

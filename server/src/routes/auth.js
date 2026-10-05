import { Router } from 'express';
import { pool, tx } from '../db/index.js';
import { pinLookup, verifyPin, signToken, requireAuth, loadPermissions, signApproval, hasPerm } from '../lib/auth.js';
import { unauthorized, forbidden } from '../lib/errors.js';
import { logActivity } from '../lib/activity.js';
import { z, parse } from '../lib/validate.js';
import { getSettings } from '../services/settings.js';

const r = Router();

async function findByPin(pin) {
  if (!/^\d{4}$/.test(String(pin || ''))) return null;
  const e = (
    await pool.query(
      `SELECT e.*, r.code AS role FROM employees e JOIN roles r ON r.id = e.role_id WHERE e.pin_lookup = $1 AND e.deleted_at IS NULL`,
      [pinLookup(pin)],
    )
  ).rows[0];
  if (!e) return null;
  if (!(await verifyPin(pin, e.pin_hash))) return null;
  return e;
}

r.post('/login', async (req, res) => {
  const { pin, deviceId } = parse(z.object({ pin: z.string(), deviceId: z.coerce.number().int().optional().nullable() }), req.body);
  const e = await findByPin(pin);
  const ua = req.headers['user-agent'] || '';
  if (!e) {
    await pool.query(`INSERT INTO employee_login_logs(employee_id, device_id, success, ip, user_agent) VALUES (NULL,$1,false,$2,$3)`, [deviceId || null, req.ip, ua]);
    throw unauthorized('รหัสพนักงานไม่ถูกต้อง');
  }
  if (!e.is_active) throw forbidden('บัญชีพนักงานนี้ถูกปิดใช้งาน');
  const out = await tx(async (c) => {
    const s = (await c.query('INSERT INTO auth_sessions(employee_id, device_id) VALUES ($1,$2) RETURNING id', [e.id, deviceId || null])).rows[0];
    await c.query('UPDATE employees SET last_login_at = now(), failed_attempts = 0 WHERE id = $1', [e.id]);
    await c.query(`INSERT INTO employee_login_logs(employee_id, device_id, success, ip, user_agent) VALUES ($1,$2,true,$3,$4)`, [e.id, deviceId || null, req.ip, ua]);
    await logActivity(c, { employee: { id: e.id, name: e.name }, ip: req.ip, deviceId }, 'LOGIN', 'employee', e.id, {});
    return s;
  });
  const settings = await getSettings();
  const token = signToken({ typ: 'employee', sid: out.id, eid: e.id }, '24h');
  res.json({
    token,
    idleMinutes: settings.security.sessionIdleMinutes,
    employee: { id: e.id, name: e.name, photoUrl: e.photo_url, position: e.position, role: e.role, discountLimitPercent: Number(e.discount_limit_percent) },
    permissions: await loadPermissions(e.id),
  });
});

r.post('/logout', requireAuth, async (req, res) => {
  await pool.query('UPDATE auth_sessions SET revoked_at = now() WHERE id = $1', [req.authSessionId]);
  await pool.query(`INSERT INTO employee_login_logs(employee_id, device_id, success, ip, action) VALUES ($1,$2,true,$3,'LOGOUT')`, [req.employee.id, req.deviceId, req.ip]);
  await logActivity(null, req, 'LOGOUT', 'employee', req.employee.id);
  res.json({ ok: true });
});

r.get('/me', requireAuth, async (req, res) => {
  res.json({ employee: req.employee, permissions: [...req.permissions] });
});

// keep-alive ping from an active UI (extends idle timeout)
r.post('/ping', requireAuth, (_req, res) => res.json({ ok: true, now: Date.now() }));

/** Manager approval with PIN → short-lived approval token (discount over limit, refunds, etc.). */
r.post('/approve', requireAuth, async (req, res) => {
  const { pin, permission, reason } = parse(z.object({ pin: z.string(), permission: z.string(), reason: z.string().optional() }), req.body);
  const m = await findByPin(pin);
  if (!m || !m.is_active) throw unauthorized('รหัสผู้อนุมัติไม่ถูกต้อง');
  const perms = await loadPermissions(m.id);
  if (m.role !== 'ADMIN' && !perms.includes(permission)) throw forbidden(`${m.name} ไม่มีสิทธิ์อนุมัติรายการนี้`);
  await logActivity(null, req, 'APPROVAL_GRANTED', 'approval', permission, { approver: m.name, approverId: m.id, reason });
  res.json({ approvalToken: signApproval({ id: m.id, name: m.name }, permission), approver: { id: m.id, name: m.name } });
});

r.get('/can/:perm', requireAuth, (req, res) => res.json({ allowed: hasPerm(req, req.params.perm) }));

export default r;

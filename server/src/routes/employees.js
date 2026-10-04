import { Router } from 'express';
import { pool, tx, many, one } from '../db/index.js';
import { requireAuth, can, hashPin, pinLookup, clearPermCache, loadPermissions } from '../lib/auth.js';
import { logActivity } from '../lib/activity.js';
import { z, parse, zUrl } from '../lib/validate.js';
import { PERMISSIONS } from '@beatbox/shared/constants.js';
import { notFound, badRequest } from '../lib/errors.js';

const r = Router();
r.use(requireAuth);

r.get('/permissions', async (_req, res) => res.json(PERMISSIONS));
r.get('/roles', async (_req, res) => {
  const roles = await many('SELECT * FROM roles ORDER BY id');
  const rp = await many('SELECT * FROM role_permissions');
  res.json(roles.map((ro) => ({ ...ro, permissions: rp.filter((x) => x.role_id === ro.id).map((x) => x.permission_code) })));
});
r.put('/roles/:id/permissions', can('employee.manage'), async (req, res) => {
  const { permissions } = parse(z.object({ permissions: z.array(z.string()) }), req.body);
  await tx(async (c) => {
    await c.query('DELETE FROM role_permissions WHERE role_id = $1', [req.params.id]);
    for (const p of permissions) await c.query('INSERT INTO role_permissions(role_id, permission_code) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.params.id, p]);
    await logActivity(c, req, 'ROLE_PERMISSIONS_UPDATE', 'role', req.params.id, { permissions });
  });
  clearPermCache();
  res.json({ ok: true });
});

r.get('/employees', can('employee.manage'), async (_req, res) => {
  const rows = await many(
    `SELECT e.id, e.name, e.photo_url, e.position, e.phone, e.role_id, r.code AS role, r.name AS role_name, e.is_active, e.created_at, e.last_login_at, e.discount_limit_percent
     FROM employees e JOIN roles r ON r.id = e.role_id WHERE e.deleted_at IS NULL ORDER BY e.id`,
  );
  const overrides = await many('SELECT * FROM employee_permissions');
  res.json(rows.map((e) => ({ ...e, overrides: overrides.filter((o) => o.employee_id === e.id) })));
});

r.get('/employees/directory', async (_req, res) => {
  res.json(await many(`SELECT id, name, photo_url, position FROM employees WHERE deleted_at IS NULL ORDER BY name`));
});

const empSchema = z.object({
  name: z.string().min(1).max(100),
  pin: z.string().regex(/^\d{4}$/, 'รหัสพนักงานต้องเป็นตัวเลข 4 หลัก').optional(),
  photoUrl: zUrl,
  position: z.string().max(100).optional().nullable(),
  phone: z.string().max(20).optional().nullable(),
  roleId: z.coerce.number().int(),
  isActive: z.boolean().default(true),
  discountLimitPercent: z.coerce.number().min(0).max(100).default(10),
});

r.post('/employees', can('employee.manage'), async (req, res) => {
  const b = parse(empSchema, req.body);
  if (!b.pin) throw badRequest('กรุณากำหนดรหัสพนักงาน 4 หลัก');
  const row = await tx(async (c) => {
    const e = (
      await c.query(
        `INSERT INTO employees(name, pin_hash, pin_lookup, photo_url, position, phone, role_id, is_active, discount_limit_percent) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, name`,
        [b.name, await hashPin(b.pin), pinLookup(b.pin), b.photoUrl, b.position, b.phone, b.roleId, b.isActive, b.discountLimitPercent],
      )
    ).rows[0];
    await logActivity(c, req, 'EMPLOYEE_CREATE', 'employee', e.id, { ...b, pin: '****' });
    return e;
  });
  res.json(row);
});

r.put('/employees/:id', can('employee.manage'), async (req, res) => {
  const b = parse(empSchema, req.body);
  await tx(async (c) => {
    const ex = (await c.query('SELECT * FROM employees WHERE id = $1 AND deleted_at IS NULL', [req.params.id])).rows[0];
    if (!ex) throw notFound();
    await c.query(`UPDATE employees SET name=$2, photo_url=$3, position=$4, phone=$5, role_id=$6, is_active=$7, discount_limit_percent=$8, updated_at=now() WHERE id=$1`, [req.params.id, b.name, b.photoUrl, b.position, b.phone, b.roleId, b.isActive, b.discountLimitPercent]);
    if (b.pin) await c.query('UPDATE employees SET pin_hash=$2, pin_lookup=$3 WHERE id=$1', [req.params.id, await hashPin(b.pin), pinLookup(b.pin)]);
    if (!b.isActive) await c.query('UPDATE auth_sessions SET revoked_at = now() WHERE employee_id = $1 AND revoked_at IS NULL', [req.params.id]);
    await logActivity(c, req, 'EMPLOYEE_UPDATE', 'employee', req.params.id, { before: { name: ex.name, role_id: ex.role_id, is_active: ex.is_active }, after: { ...b, pin: b.pin ? '(changed)' : undefined } });
  });
  clearPermCache(Number(req.params.id));
  res.json({ ok: true });
});

r.delete('/employees/:id', can('employee.manage'), async (req, res) => {
  if (Number(req.params.id) === req.employee.id) throw badRequest('ไม่สามารถลบบัญชีของตนเองได้');
  await pool.query('UPDATE employees SET deleted_at = now(), is_active = false WHERE id = $1', [req.params.id]);
  await pool.query('UPDATE auth_sessions SET revoked_at = now() WHERE employee_id = $1 AND revoked_at IS NULL', [req.params.id]);
  await logActivity(null, req, 'EMPLOYEE_DELETE', 'employee', req.params.id);
  res.json({ ok: true });
});

r.put('/employees/:id/permissions', can('employee.manage'), async (req, res) => {
  const { overrides } = parse(z.object({ overrides: z.array(z.object({ code: z.string(), granted: z.boolean() })) }), req.body);
  await tx(async (c) => {
    await c.query('DELETE FROM employee_permissions WHERE employee_id = $1', [req.params.id]);
    for (const o of overrides) await c.query('INSERT INTO employee_permissions(employee_id, permission_code, granted) VALUES ($1,$2,$3)', [req.params.id, o.code, o.granted]);
    await logActivity(c, req, 'EMPLOYEE_PERMISSIONS_UPDATE', 'employee', req.params.id, { overrides });
  });
  clearPermCache(Number(req.params.id));
  res.json({ permissions: await loadPermissions(Number(req.params.id)) });
});

/** History tabs: login | sales | edits | voids | refunds | shifts */
r.get('/employees/:id/history', can('employee.manage'), async (req, res) => {
  const id = req.params.id;
  const type = req.query.type || 'login';
  let rows = [];
  if (type === 'login') rows = await many('SELECT * FROM employee_login_logs WHERE employee_id = $1 ORDER BY id DESC LIMIT 200', [id]);
  else if (type === 'sales') rows = await many(`SELECT o.id, o.order_no, rc.receipt_no, o.queue_no, o.grand_total, o.paid_at, o.status FROM orders o LEFT JOIN receipts rc ON rc.order_id = o.id WHERE o.paid_by = $1 ORDER BY o.paid_at DESC NULLS LAST LIMIT 200`, [id]);
  else if (type === 'edits') rows = await many(`SELECT * FROM activity_logs WHERE employee_id = $1 AND (action LIKE '%UPDATE%' OR action LIKE '%ADJUST%' OR action LIKE '%EDIT%' OR action LIKE '%MOVE%') ORDER BY id DESC LIMIT 200`, [id]);
  else if (type === 'voids') rows = await many(`SELECT * FROM activity_logs WHERE employee_id = $1 AND (action LIKE '%VOID%' OR action LIKE '%CANCEL%') ORDER BY id DESC LIMIT 200`, [id]);
  else if (type === 'refunds') rows = await many(`SELECT rf.*, o.order_no FROM refunds rf JOIN orders o ON o.id = rf.order_id WHERE rf.requested_by = $1 OR rf.approved_by = $1 ORDER BY rf.id DESC LIMIT 200`, [id]);
  else if (type === 'shifts') rows = await many(`SELECT * FROM shifts WHERE employee_id = $1 OR closed_by = $1 ORDER BY id DESC LIMIT 200`, [id]);
  res.json(rows);
});

export default r;

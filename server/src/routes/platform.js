// Platform level: public store registration + plans, and the Super Owner console API.
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { pool, one, many, storeContext, setContextStore } from '../db/index.js';
import { signToken, verifyToken } from '../lib/auth.js';
import { z, parse } from '../lib/validate.js';
import { unauthorized, forbidden, notFound, badRequest } from '../lib/errors.js';
import { logActivity } from '../lib/activity.js';
import { createStore, changeSubscription, addPeriod } from '../services/stores.js';
import { getSubscription, invalidateSubscription, publicSubscription } from '../services/subscription.js';
import { issueEmployeeSession } from './auth.js';
import { PLAN_FEATURES, PLAN_LIMITS } from '@beatbox/shared/plans.js';
import { emitStaff } from '../lib/realtime.js';
import { clearStoreCache } from '../lib/tenant.js';

const r = Router();

/** All platform routes see every store (explicit bypass of row-level security). */
r.use((_req, _res, next) => {
  const c = storeContext.getStore();
  if (c) {
    c.storeId = null;
    c.bypass = true;
  }
  next();
});

async function platformSetting(key, fallback) {
  const row = await one('SELECT value FROM platform_settings WHERE key = $1', [key]);
  return { ...fallback, ...(row?.value || {}) };
}

const planOut = (p) => ({ id: p.id, name: p.name, description: p.description, price: Number(p.price), currency: p.currency, billingCycle: p.billing_cycle, billingInterval: p.billing_interval, features: p.features, limits: p.limits, isPublic: p.is_public, trialDays: p.trial_days, sortOrder: p.sort_order });

// ───────────── public ─────────────
r.get('/public', async (_req, res) => {
  const signup = await platformSetting('signup', { enabled: true });
  const plans = await many('SELECT * FROM plans WHERE is_public ORDER BY sort_order, id');
  res.json({ signupEnabled: signup.enabled !== false, contact: { phone: signup.contactPhone || '', line: signup.contactLine || '', email: signup.contactEmail || '' }, plans: plans.map(planOut), features: PLAN_FEATURES, limits: PLAN_LIMITS });
});

const registerSchema = z
  .object({
    storeName: z.string().trim().min(2, 'กรุณากรอกชื่อร้าน').max(200),
    ownerFirstName: z.string().trim().min(1, 'กรุณากรอกชื่อเจ้าของ').max(100),
    ownerLastName: z.string().trim().min(1, 'กรุณากรอกนามสกุลเจ้าของ').max(100),
    email: z.string().trim().toLowerCase().email('อีเมลไม่ถูกต้อง').max(200),
    phone: z.string().trim().regex(/^0\d{8,9}$/, 'เบอร์โทรศัพท์ไม่ถูกต้อง'),
    password: z.string().min(8, 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร').max(200),
    confirmPassword: z.string(),
    planId: z.coerce.number().int({ message: 'กรุณาเลือกแพ็กเกจ' }),
    deviceId: z.coerce.number().int().optional().nullable(),
  })
  .refine((v) => v.password === v.confirmPassword, { message: 'รหัสผ่านและยืนยันรหัสผ่านไม่ตรงกัน', path: ['confirmPassword'] });

/** Store registration: email + password, no OTP / verification code. */
r.post('/register', rateLimit({ windowMs: 60 * 60000, limit: 10, message: { error: 'สมัครบ่อยเกินไป กรุณาลองใหม่ภายหลัง' } }), async (req, res) => {
  const b = parse(registerSchema, { ...req.body, phone: String(req.body?.phone || '').replace(/\D/g, '') });
  const signup = await platformSetting('signup', { enabled: true });
  if (signup.enabled === false) throw forbidden('ปิดรับสมัครร้านค้าชั่วคราว กรุณาติดต่อผู้ดูแลระบบ');
  const plan = await one('SELECT * FROM plans WHERE id = $1 AND is_public', [b.planId]);
  if (!plan) throw badRequest('แพ็กเกจนี้ไม่เปิดรับสมัคร');
  const trialDays = Number(plan.trial_days ?? signup.trialDays ?? 14);
  const out = await createStore({
    storeName: b.storeName,
    ownerFirstName: b.ownerFirstName,
    ownerLastName: b.ownerLastName,
    email: b.email,
    phone: b.phone,
    password: b.password,
    // trial of the chosen plan (0 days = waits for the Super Owner to activate)
    subscription: { planId: plan.id, status: 'TRIAL', expiresAt: new Date(Date.now() + Math.max(0, trialDays) * 86400000) },
    actor: { type: 'OWNER', name: `${b.ownerFirstName} ${b.ownerLastName}` },
  });
  setContextStore(out.storeId);
  const e = await one(`SELECT e.*, r.code AS role FROM employees e JOIN roles r ON r.id = e.role_id WHERE e.id = $1`, [out.ownerId]);
  res.json({ ok: true, storeId: out.storeId, slug: out.slug, ...(await issueEmployeeSession(req, e, { deviceId: null, method: 'REGISTER' })) });
});

// ───────────── Super Owner auth ─────────────
r.post('/login', rateLimit({ windowMs: 5 * 60000, limit: 20, message: { error: 'พยายามเข้าสู่ระบบบ่อยเกินไป กรุณารอ 5 นาที' } }), async (req, res) => {
  const b = parse(z.object({ username: z.string().trim().min(1).max(200), password: z.string().min(1).max(200) }), req.body);
  const u = await one('SELECT * FROM platform_users WHERE lower(username) = lower($1)', [b.username]);
  if (!u || !u.is_active) throw unauthorized('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
  if (u.locked_until && new Date(u.locked_until) > new Date()) throw unauthorized(`เข้าสู่ระบบผิดหลายครั้ง กรุณารอ ${Math.ceil((new Date(u.locked_until) - Date.now()) / 60000)} นาที`);
  if (!(await bcrypt.compare(b.password, u.password_hash))) {
    const n = Number(u.failed_attempts) + 1;
    await pool.query(`UPDATE platform_users SET failed_attempts = $2, locked_until = CASE WHEN $3 THEN now() + interval '15 minutes' ELSE locked_until END WHERE id = $1`, [u.id, n >= 5 ? 0 : n, n >= 5]);
    throw unauthorized(n >= 5 ? 'เข้าสู่ระบบผิดเกิน 5 ครั้ง ระบบพักการเข้าสู่ระบบ 15 นาที' : 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
  }
  const s = await one('INSERT INTO platform_sessions(platform_user_id) VALUES ($1) RETURNING id', [u.id]);
  await pool.query('UPDATE platform_users SET failed_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [u.id]);
  res.json({ token: signToken({ typ: 'platform', psid: s.id, pid: u.id }, '12h'), user: { id: u.id, username: u.username, displayName: u.display_name, role: u.role } });
});

async function requirePlatform(req, _res, next) {
  const h = req.headers.authorization || '';
  const p = h.startsWith('Bearer ') ? verifyToken(h.slice(7)) : null;
  if (!p || p.typ !== 'platform') throw unauthorized('กรุณาเข้าสู่ระบบผู้ดูแลระบบ');
  const u = await one(
    `SELECT u.* FROM platform_sessions s JOIN platform_users u ON u.id = s.platform_user_id WHERE s.id = $1 AND s.revoked_at IS NULL AND u.is_active`,
    [p.psid],
  );
  if (!u) throw unauthorized('กรุณาเข้าสู่ระบบผู้ดูแลระบบ');
  req.platformUser = { id: u.id, username: u.username, displayName: u.display_name || u.username, role: u.role };
  req.platformSessionId = p.psid;
  pool.query('UPDATE platform_sessions SET last_active_at = now() WHERE id = $1', [p.psid]).catch(() => {});
  next();
}
const actorOf = (req) => ({ type: 'PLATFORM', id: req.platformUser.id, name: `Super Owner: ${req.platformUser.displayName}` });

r.get('/me', requirePlatform, (req, res) => res.json({ user: req.platformUser }));
r.post('/logout', requirePlatform, async (req, res) => {
  await pool.query('UPDATE platform_sessions SET revoked_at = now() WHERE id = $1', [req.platformSessionId]);
  res.json({ ok: true });
});
r.post('/password', requirePlatform, async (req, res) => {
  const b = parse(z.object({ current: z.string().min(1), password: z.string().min(8, 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร').max(200) }), req.body);
  const u = await one('SELECT * FROM platform_users WHERE id = $1', [req.platformUser.id]);
  if (!(await bcrypt.compare(b.current, u.password_hash))) throw unauthorized('รหัสผ่านปัจจุบันไม่ถูกต้อง');
  await pool.query('UPDATE platform_users SET password_hash = $2, password_changed_at = now() WHERE id = $1', [u.id, await bcrypt.hash(b.password, 12)]);
  // other sessions of this account are signed out
  await pool.query('UPDATE platform_sessions SET revoked_at = now() WHERE platform_user_id = $1 AND id <> $2 AND revoked_at IS NULL', [u.id, req.platformSessionId]);
  res.json({ ok: true });
});

// ───────────── stores ─────────────
r.get('/stores', requirePlatform, async (_req, res) => {
  const rows = await many(
    `SELECT s.id, s.name, s.slug, s.phone, s.address, s.owner_name, s.owner_email, s.is_active, s.suspend_reason, s.created_at,
            ss.plan_id, ss.status AS sub_status, ss.started_at, ss.expires_at, p.name AS plan_name,
            (SELECT count(*) FROM rooms x WHERE x.store_id = s.id AND x.deleted_at IS NULL) AS rooms,
            (SELECT count(*) FROM employees x WHERE x.store_id = s.id AND x.deleted_at IS NULL AND NOT x.is_hidden) AS employees,
            (SELECT count(*) FROM orders x WHERE x.store_id = s.id) AS orders,
            (SELECT max(created_at) FROM activity_logs x WHERE x.store_id = s.id) AS last_activity_at,
            (SELECT count(*) FROM renewal_requests x WHERE x.store_id = s.id AND x.status = 'OPEN') AS open_requests
     FROM stores s LEFT JOIN store_subscriptions ss ON ss.store_id = s.id LEFT JOIN plans p ON p.id = ss.plan_id ORDER BY s.id`,
  );
  const out = [];
  for (const s of rows) out.push({ ...s, subscription: publicSubscription(await getSubscription(s.id, { fresh: true })) });
  res.json(out);
});

const storeCreateSchema = z.object({
  storeName: z.string().trim().min(2).max(200),
  ownerFirstName: z.string().trim().min(1).max(100),
  ownerLastName: z.string().trim().min(1).max(100),
  email: z.string().trim().toLowerCase().email('อีเมลไม่ถูกต้อง').max(200),
  phone: z.string().trim().regex(/^0\d{8,9}$/, 'เบอร์โทรศัพท์ไม่ถูกต้อง'),
  password: z.string().min(8, 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร').max(200),
  planId: z.coerce.number().int(),
  status: z.enum(['TRIAL', 'ACTIVE']).default('TRIAL'),
  trialDays: z.coerce.number().int().min(0).max(3650).optional().nullable(),
  expiresAt: z.string().optional().nullable(),
  address: z.string().max(500).optional().nullable(),
  demo: z.boolean().default(false),
});

r.post('/stores', requirePlatform, async (req, res) => {
  const b = parse(storeCreateSchema, { ...req.body, phone: String(req.body?.phone || '').replace(/\D/g, '') });
  const plan = await one('SELECT * FROM plans WHERE id = $1', [b.planId]);
  if (!plan) throw notFound('ไม่พบแพ็กเกจ');
  let expiresAt = b.expiresAt ? new Date(b.expiresAt) : null;
  if (!expiresAt) expiresAt = b.status === 'TRIAL' ? new Date(Date.now() + Number(b.trialDays ?? plan.trial_days ?? 14) * 86400000) : addPeriod(Date.now(), plan.billing_cycle, plan.billing_interval);
  const out = await createStore({ ...b, subscription: { planId: plan.id, status: b.status, expiresAt }, actor: actorOf(req) });
  res.json(out);
});

r.put('/stores/:id', requirePlatform, async (req, res) => {
  const b = parse(z.object({ name: z.string().trim().min(2).max(200), phone: z.string().max(30).optional().nullable(), address: z.string().max(500).optional().nullable(), ownerName: z.string().max(200).optional().nullable(), slug: z.string().trim().regex(/^[a-z0-9-]{3,40}$/, 'slug ใช้ a-z 0-9 และ - (3–40 ตัว)').optional() }), req.body);
  const before = await one('SELECT name, phone, address, owner_name, slug FROM stores WHERE id = $1', [req.params.id]);
  if (!before) throw notFound();
  if (b.slug && b.slug !== before.slug && (await one('SELECT 1 FROM stores WHERE lower(slug) = lower($1) AND id <> $2', [b.slug, req.params.id]))) throw badRequest('slug นี้ถูกใช้แล้ว');
  await pool.query(`UPDATE stores SET name = $2, phone = $3, address = $4, owner_name = $5, slug = COALESCE($6, slug), updated_at = now() WHERE id = $1`, [req.params.id, b.name, b.phone, b.address, b.ownerName, b.slug || null]);
  await pool.query(`INSERT INTO subscription_events(store_id, action, before, after, actor_type, actor_id, actor_name) VALUES ($1,'EDIT_STORE',$2,$3,'PLATFORM',$4,$5)`, [req.params.id, before, b, req.platformUser.id, actorOf(req).name]);
  invalidateSubscription(req.params.id);
  clearStoreCache();
  emitStaff('subscription:changed', { at: Date.now() }, Number(req.params.id));
  res.json({ ok: true });
});

const subSchema = z.object({
  action: z.enum(['TRIAL', 'EXTEND_TRIAL', 'RENEW', 'CHANGE_PLAN', 'SET_EXPIRY', 'SUSPEND', 'ACTIVATE']),
  planId: z.coerce.number().int().optional().nullable(),
  days: z.coerce.number().int().min(1).max(3650).optional().nullable(),
  periods: z.coerce.number().int().min(1).max(120).optional().nullable(),
  expiresAt: z.string().optional().nullable(),
  reason: z.string().max(300).optional().nullable(),
  note: z.string().max(300).optional().nullable(),
});

r.post('/stores/:id/subscription', requirePlatform, async (req, res) => {
  const b = parse(subSchema, req.body);
  if (b.action === 'SUSPEND' && !b.reason) throw badRequest('กรุณาระบุเหตุผลการระงับ');
  const out = await changeSubscription(Number(req.params.id), b, actorOf(req));
  res.json({ ...out, subscription: publicSubscription(await getSubscription(Number(req.params.id), { fresh: true })) });
});

r.get('/stores/:id/events', requirePlatform, async (req, res) => {
  res.json(await many('SELECT * FROM subscription_events WHERE store_id = $1 ORDER BY id DESC LIMIT 200', [req.params.id]));
});

/** "เข้าจัดการร้าน": a session inside the store, acting as a hidden admin linked to the real Super Owner identity. */
r.post('/stores/:id/enter', requirePlatform, async (req, res) => {
  const store = await one('SELECT id, name, slug FROM stores WHERE id = $1', [req.params.id]);
  if (!store) throw notFound('ไม่พบร้านค้า');
  setContextStore(store.id);
  let e = await one(`SELECT e.*, r.code AS role FROM employees e JOIN roles r ON r.id = e.role_id WHERE e.platform_user_id = $1 AND e.is_hidden AND e.deleted_at IS NULL`, [req.platformUser.id]);
  if (!e) {
    const role = await one(`SELECT id FROM roles WHERE code = 'ADMIN' ORDER BY id LIMIT 1`);
    if (!role) throw badRequest('ร้านนี้ยังไม่มีบทบาท ADMIN');
    const row = await one(
      `INSERT INTO employees(name, role_id, position, discount_limit_percent, is_hidden, platform_user_id) VALUES ($1,$2,'Super Owner',100,true,$3) RETURNING id`,
      [`Super Owner: ${req.platformUser.displayName}`, role.id, req.platformUser.id],
    );
    e = await one(`SELECT e.*, r.code AS role FROM employees e JOIN roles r ON r.id = e.role_id WHERE e.id = $1`, [row.id]);
  }
  const out = await issueEmployeeSession(req, e, { method: 'SUPER_OWNER', claims: { sup: req.platformUser.id, supName: req.platformUser.displayName } });
  await logActivity(null, { employee: { id: e.id, name: e.name, platformUserId: req.platformUser.id }, ip: req.ip }, 'SUPER_OWNER_ENTER', 'store', store.id, { superOwner: req.platformUser.username });
  res.json({ ...out, store });
});

// ───────────── plans (4, fully editable) ─────────────
r.get('/plans', requirePlatform, async (_req, res) => {
  res.json({ plans: (await many('SELECT * FROM plans ORDER BY sort_order, id')).map(planOut), features: PLAN_FEATURES, limits: PLAN_LIMITS });
});

const featureKeys = PLAN_FEATURES.map((f) => f.key);
const limitKeys = PLAN_LIMITS.map((l) => l.key);
r.put('/plans/:id', requirePlatform, async (req, res) => {
  const b = parse(
    z.object({
      name: z.string().trim().min(1).max(100),
      description: z.string().max(1000).optional().nullable(),
      price: z.coerce.number().min(0),
      currency: z.string().max(10).default('THB'),
      billingCycle: z.enum(['DAY', 'MONTH', 'YEAR']),
      billingInterval: z.coerce.number().int().min(1).max(120),
      features: z.record(z.string(), z.boolean()),
      limits: z.record(z.string(), z.union([z.coerce.number().int().min(0), z.null()])),
      isPublic: z.boolean(),
      trialDays: z.coerce.number().int().min(0).max(3650),
      sortOrder: z.coerce.number().int().optional(),
    }),
    req.body,
  );
  const features = Object.fromEntries(featureKeys.map((k) => [k, !!b.features[k]]));
  const limits = Object.fromEntries(limitKeys.filter((k) => b.limits[k] !== null && b.limits[k] !== undefined).map((k) => [k, Number(b.limits[k])]));
  const before = await one('SELECT * FROM plans WHERE id = $1', [req.params.id]);
  if (!before) throw notFound();
  const row = await one(
    `UPDATE plans SET name=$2, description=$3, price=$4, currency=$5, billing_cycle=$6, billing_interval=$7, features=$8, limits=$9, is_public=$10, trial_days=$11, sort_order=COALESCE($12, sort_order), updated_at=now() WHERE id=$1 RETURNING *`,
    [req.params.id, b.name, b.description, b.price, b.currency, b.billingCycle, b.billingInterval, features, limits, b.isPublic, b.trialDays, b.sortOrder ?? null],
  );
  // every store on this plan sees the new rights immediately (open screens re-read their package)
  invalidateSubscription();
  await pool.query(`INSERT INTO subscription_events(store_id, action, before, after, actor_type, actor_id, actor_name)
                    SELECT store_id, 'EDIT_PLAN', $1, $2, 'PLATFORM', $3, $4 FROM store_subscriptions WHERE plan_id = $5`, [planOut(before), planOut(row), req.platformUser.id, actorOf(req).name, row.id]);
  for (const s of await many('SELECT store_id FROM store_subscriptions WHERE plan_id = $1', [row.id])) emitStaff('subscription:changed', { at: Date.now() }, s.store_id);
  res.json(planOut(row));
});

// ───────────── platform settings + renewal requests ─────────────
r.get('/settings', requirePlatform, async (_req, res) => res.json({ signup: await platformSetting('signup', { enabled: true }) }));
r.put('/settings', requirePlatform, async (req, res) => {
  const b = parse(z.object({ signup: z.object({ enabled: z.boolean(), trialDays: z.coerce.number().int().min(0).max(3650).optional(), contactPhone: z.string().max(50).optional(), contactLine: z.string().max(100).optional(), contactEmail: z.string().max(200).optional() }) }), req.body);
  await pool.query(`INSERT INTO platform_settings(key, value) VALUES ('signup',$1) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`, [b.signup]);
  res.json({ ok: true });
});

r.get('/renewal-requests', requirePlatform, async (_req, res) => {
  res.json(await many(`SELECT rr.*, s.name AS store_name, p.name AS plan_name FROM renewal_requests rr JOIN stores s ON s.id = rr.store_id LEFT JOIN plans p ON p.id = rr.plan_id ORDER BY rr.status = 'OPEN' DESC, rr.id DESC LIMIT 200`));
});
r.post('/renewal-requests/:id/:status', requirePlatform, async (req, res) => {
  if (!['DONE', 'REJECTED'].includes(req.params.status)) throw notFound();
  await pool.query(`UPDATE renewal_requests SET status = $2, handled_at = now(), handled_by = $3 WHERE id = $1`, [req.params.id, req.params.status, req.platformUser.id]);
  res.json({ ok: true });
});

export default r;

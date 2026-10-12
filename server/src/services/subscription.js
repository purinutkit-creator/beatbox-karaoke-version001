// Store subscription (plan, trial, expiry) — the server clock decides, every API request is checked.
import { pool, runAsPlatform, currentStoreId } from '../db/index.js';
import { verifyToken } from '../lib/auth.js';
import { featureForPath, PERMISSION_FEATURE, PLAN_FEATURES } from '@beatbox/shared/plans.js';
import { AppError } from '../lib/errors.js';

const cache = new Map(); // storeId -> { sub, at }

export function invalidateSubscription(storeId) {
  if (storeId) cache.delete(Number(storeId));
  else cache.clear();
}

/** Subscription view of a store (status computed from the server time). */
export async function getSubscription(storeId = currentStoreId(), { fresh = false } = {}) {
  const sid = Number(storeId);
  const hit = cache.get(sid);
  if (!fresh && hit && Date.now() - hit.at < 5000) return computeStatus(hit.sub);
  const row = (
    await runAsPlatform(() =>
      pool.query(
        `SELECT s.id AS store_id, s.name AS store_name, s.slug, s.is_active, s.suspend_reason, s.timezone,
                ss.status, ss.started_at, ss.expires_at, ss.plan_id, p.name AS plan_name, p.description AS plan_description,
                p.price, p.currency, p.billing_cycle, p.billing_interval, p.features, p.limits
         FROM stores s LEFT JOIN store_subscriptions ss ON ss.store_id = s.id LEFT JOIN plans p ON p.id = ss.plan_id
         WHERE s.id = $1`,
        [sid],
      ),
    )
  ).rows[0];
  if (!row) return null;
  const sub = {
    storeId: row.store_id,
    storeName: row.store_name,
    slug: row.slug,
    timezone: row.timezone || 'Asia/Bangkok',
    rawStatus: row.status || 'EXPIRED',
    suspended: !row.is_active || row.status === 'SUSPENDED',
    suspendReason: row.suspend_reason,
    startedAt: row.started_at,
    expiresAt: row.expires_at,
    plan: row.plan_id
      ? { id: row.plan_id, name: row.plan_name, description: row.plan_description, price: Number(row.price), currency: row.currency, billingCycle: row.billing_cycle, billingInterval: row.billing_interval, features: row.features || {}, limits: row.limits || {} }
      : null,
  };
  cache.set(sid, { sub, at: Date.now() });
  return computeStatus(sub);
}

function computeStatus(sub) {
  const now = Date.now();
  let status = sub.rawStatus === 'TRIAL' ? 'TRIAL' : 'ACTIVE';
  if (sub.suspended) status = 'SUSPENDED';
  else if (!sub.plan || (sub.expiresAt && new Date(sub.expiresAt).getTime() <= now)) status = 'EXPIRED';
  return { ...sub, status, usable: status === 'TRIAL' || status === 'ACTIVE', isTrial: sub.rawStatus === 'TRIAL', serverNow: now };
}

/** What the store's screens may see (no internal ids beyond the plan). */
export function publicSubscription(sub) {
  if (!sub) return null;
  return {
    storeId: sub.storeId,
    storeName: sub.storeName,
    slug: sub.slug,
    timezone: sub.timezone,
    status: sub.status,
    usable: sub.usable,
    isTrial: sub.isTrial,
    startedAt: sub.startedAt,
    expiresAt: sub.expiresAt,
    suspendReason: sub.status === 'SUSPENDED' ? sub.suspendReason : null,
    serverNow: Date.now(),
    plan: sub.plan ? { id: sub.plan.id, name: sub.plan.name, description: sub.plan.description, price: sub.plan.price, currency: sub.plan.currency, billingCycle: sub.plan.billingCycle, billingInterval: sub.plan.billingInterval, features: sub.plan.features, limits: sub.plan.limits } : null,
  };
}

export function hasFeature(sub, feature) {
  return !!(sub?.usable && sub.plan?.features?.[feature]);
}

export function featureLabel(key) {
  return PLAN_FEATURES.find((f) => f.key === key)?.label || key;
}

/** Permission allowed by the plan? (core permissions without a feature are always allowed) */
export function planAllowsPermission(sub, perm) {
  // expiry is handled by subscriptionGuard (which lets in-flight payments through); here only the plan's features count
  const f = PERMISSION_FEATURE[perm];
  return !f || !!sub?.plan?.features?.[f];
}

/** Plan limit for a resource (null = unlimited). */
export function planLimit(sub, key) {
  const v = sub?.plan?.limits?.[key];
  return v === undefined || v === null || v === '' ? null : Number(v);
}

export async function assertLimit(client, key, sql) {
  const sub = await getSubscription();
  const max = planLimit(sub, key);
  if (max == null) return;
  const n = Number((await client.query(sql)).rows[0].n);
  if (n >= max) throw new AppError(403, `แพ็กเกจ ${sub.plan?.name || ''} ใช้ได้สูงสุด ${max} ${{ branches: 'สาขา', rooms: 'ห้อง', employees: 'คน', devices: 'เครื่อง' }[key] || ''} กรุณาอัปเกรดแพ็กเกจ`, 'PLAN_LIMIT', { limit: key, max });
}

export async function recordSubscriptionEvent(client, { storeId, action, before = null, after = null, note = null, actorType, actorId = null, actorName = null }) {
  await client.query(
    `INSERT INTO subscription_events(store_id, action, before, after, note, actor_type, actor_id, actor_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [storeId, action, before, after, note, actorType, actorId, actorName],
  );
}

// ── API guard ──
const ALWAYS_ALLOWED = [
  /^\/health$/, /^\/time$/,
  /^\/auth\//,
  /^\/platform(\/|$)/,
  /^\/subscription(\/|$)/,
  /^\/public\/settings$/, /^\/public\/store$/,
  /^\/public\/terminal\//, // webhooks only re-check payments that were already started
];

function expiredError(sub) {
  const msg = sub.status === 'SUSPENDED' ? 'ร้านนี้ถูกระงับการใช้งาน กรุณาติดต่อผู้ดูแลระบบ' : 'แพ็กเกจของร้านหมดอายุแล้ว กรุณาต่ออายุเพื่อใช้งานต่อ (ข้อมูลเดิมยังอยู่ครบ)';
  return new AppError(402, msg, 'SUBSCRIPTION_EXPIRED', { subscription: { status: sub.status, expiresAt: sub.expiresAt, planName: sub.plan?.name || null } });
}

/** Payments already sent out before the expiry must still be recorded correctly (no lost / double money). */
async function isInFlightPayment(req, sub) {
  const expiresMs = sub.expiresAt ? new Date(sub.expiresAt).getTime() : Date.now();
  const before = (d) => d && new Date(d).getTime() < expiresMs;
  const path = req.path;
  // idempotent replay of a request that already completed
  const key = req.headers['idempotency-key'] || req.body?.idempotencyKey;
  if (key) {
    const ex = await pool.query(`SELECT 1 FROM idempotency_keys WHERE key LIKE $1 AND status_code IS NOT NULL LIMIT 1`, [`${sub.storeId}:%:${key}`]);
    if (ex.rows[0]) return true;
  }
  let m = path.match(/^\/terminal\/payments\/([0-9a-f-]{36})(\/confirm)?$/);
  if (m) {
    const t = (await pool.query('SELECT created_at FROM terminal_payments WHERE id = $1', [m[1]])).rows[0];
    return before(t?.created_at);
  }
  m = path.match(/^\/orders\/(\d+)\/pay$/);
  if (m && req.method === 'POST') {
    const tenders = Array.isArray(req.body?.payments) ? req.body.payments : [];
    return tenders.length > 0 && tenders.every((t) => {
      const v = t.verificationToken ? verifyToken(t.verificationToken) : null;
      return v && v.typ === 'slip' && v.iat * 1000 < expiresMs;
    });
  }
  m = path.match(/^\/public\/holds\/([^/]+)\/slip$/);
  if (m) {
    const h = (await pool.query(`SELECT pt.created_at FROM reservation_holds rh JOIN payment_transactions pt ON pt.reservation_id = rh.reservation_id WHERE rh.hold_token = $1 ORDER BY pt.created_at DESC LIMIT 1`, [m[1]])).rows[0];
    return before(h?.created_at);
  }
  m = path.match(/^\/public\/room\/[^/]+\/orders\/(\d+)\/(pay|payment)$/);
  if (m) {
    const o = (await pool.query('SELECT created_at FROM room_customer_orders WHERE id = $1', [m[1]])).rows[0];
    return before(o?.created_at);
  }
  return false;
}

/** Express middleware (mounted on /api after the store context). */
export async function subscriptionGuard(req, _res, next) {
  const path = req.path;
  if (ALWAYS_ALLOWED.some((re) => re.test(path))) return next();
  const storeId = currentStoreId();
  if (!storeId) return next();
  const sub = await getSubscription(storeId);
  if (!sub) return next();
  req.subscription = sub;
  if (!sub.usable) {
    if (await isInFlightPayment(req, sub)) return next();
    throw expiredError(sub);
  }
  const feature = featureForPath(path);
  if (feature && !hasFeature(sub, feature)) {
    throw new AppError(403, `แพ็กเกจ ${sub.plan?.name || ''} ไม่รวมฟังก์ชัน "${featureLabel(feature)}" กรุณาอัปเกรดแพ็กเกจ`, 'FEATURE_NOT_IN_PLAN', { feature });
  }
  next();
}

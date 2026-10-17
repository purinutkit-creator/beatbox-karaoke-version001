// Creating stores (self-registration and by the Super Owner) and changing their subscription — with history.
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { pool, tx, runAsPlatform } from '../db/index.js';
import { insertStore, seedStoreData } from '../db/seed.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { recordSubscriptionEvent, invalidateSubscription } from './subscription.js';
import { clearStoreCache } from '../lib/tenant.js';
import { emitStaff } from '../lib/realtime.js';
import { generatePassword, setStartingPassword, DEFAULT_USERNAME, DEFAULT_OWNER_PIN } from './storeAccount.js';

export function slugify(name) {
  const base = String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
  return base.length >= 3 ? base : `shop-${crypto.randomBytes(3).toString('hex')}`;
}

async function uniqueSlug(c, name) {
  const base = slugify(name);
  for (let i = 0; i < 50; i++) {
    const slug = i ? `${base}-${i + 1}` : base;
    const ex = (await c.query('SELECT 1 FROM stores WHERE lower(slug) = lower($1)', [slug])).rows[0];
    if (!ex) return slug;
  }
  return `${base}-${crypto.randomBytes(3).toString('hex')}`;
}

export async function emailTaken(email) {
  return runAsPlatform(async () => {
    const e = (await pool.query(`SELECT 1 FROM employees WHERE lower(email) = lower($1) AND deleted_at IS NULL UNION SELECT 1 FROM stores WHERE lower(owner_email) = lower($1) UNION SELECT 1 FROM platform_users WHERE lower(email) = lower($1)`, [email])).rows[0];
    return !!e;
  });
}

export function addPeriod(fromMs, cycle, interval = 1, periods = 1) {
  const d = new Date(fromMs);
  const n = Number(interval || 1) * Number(periods || 1);
  if (cycle === 'DAY') d.setUTCDate(d.getUTCDate() + n);
  else if (cycle === 'YEAR') d.setUTCFullYear(d.getUTCFullYear() + n);
  else d.setUTCMonth(d.getUTCMonth() + n);
  return d;
}

/**
 * Create a store + its owner account (email / password) + default data + subscription, all in one transaction.
 * subscription: { planId, status: 'TRIAL' | 'ACTIVE', expiresAt }
 */
export async function createStore({ storeName, ownerFirstName, ownerLastName, email, phone, password, address = null, subscription, actor, demo = false }) {
  if (await emailTaken(email)) throw conflict('อีเมลนี้ถูกใช้ลงทะเบียนแล้ว', 'EMAIL_TAKEN');
  // created by the Super Owner → the password is a starting password (shown to the Super Owner and the owner until changed)
  const starting = actor.type === 'PLATFORM' ? password || generatePassword() : null;
  const passwordHash = await bcrypt.hash(starting || password, 12);
  const ownerName = `${ownerFirstName} ${ownerLastName || ''}`.trim();
  return runAsPlatform(() =>
    tx(async (c) => {
      const plan = subscription.planId ? (await c.query('SELECT * FROM plans WHERE id = $1', [subscription.planId])).rows[0] : null;
      if (subscription.planId && !plan) throw notFound('ไม่พบแพ็กเกจ');
      const slug = await uniqueSlug(c, storeName);
      const storeId = await insertStore(c, { name: storeName, slug, phone, address, ownerName, ownerEmail: email, slogan: null });
      await c.query(`INSERT INTO store_subscriptions(store_id, plan_id, status, started_at, expires_at) VALUES ($1,$2,$3,now(),$4)`, [storeId, plan?.id || null, subscription.status, subscription.expiresAt || null]);
      await recordSubscriptionEvent(c, { storeId, action: actor.type === 'OWNER' ? 'REGISTER' : 'CREATE_STORE', after: { planId: plan?.id || null, planName: plan?.name || null, status: subscription.status, expiresAt: subscription.expiresAt || null }, actorType: actor.type, actorId: actor.id || null, actorName: actor.name || ownerName });
      // the rest of the transaction runs as the new store (row-level security + default store_id)
      await c.query(`SELECT set_config('app.store_id', $1, true), set_config('app.bypass_rls', 'off', true)`, [String(storeId)]);
      const seeded = await seedStoreData(c, { storeId, branchName: 'สาขาหลัก', address, phone, demo, employee: { name: ownerName, email, passwordHash, isOwner: true, position: 'เจ้าของร้าน', username: DEFAULT_USERNAME, pin: DEFAULT_OWNER_PIN } });
      if (starting) await setStartingPassword(c, seeded.ownerId, starting);
      const storeCode = (await c.query('SELECT store_code FROM stores WHERE id = $1', [storeId])).rows[0].store_code;
      await c.query(`INSERT INTO activity_logs(employee_id, employee_name, action, entity, entity_id, details, actor_type, platform_user_id) VALUES ($1,$2,'STORE_CREATED','store',$3,$4,$5,$6)`, [
        actor.type === 'OWNER' ? seeded.ownerId : null,
        actor.name || ownerName,
        String(storeId),
        { storeName, email, phone, planId: plan?.id || null, status: subscription.status, expiresAt: subscription.expiresAt || null },
        actor.type === 'PLATFORM' ? 'SUPER_OWNER' : 'EMPLOYEE',
        actor.type === 'PLATFORM' ? actor.id : null,
      ]);
      clearStoreCache();
      return { storeId, slug, storeCode, ownerId: seeded.ownerId, plan, login: { storeCode, username: DEFAULT_USERNAME, email, password: starting, pin: DEFAULT_OWNER_PIN } };
    }),
  );
}

/** Super Owner subscription actions. Every change is written to subscription_events with the actor and time. */
export async function changeSubscription(storeId, { action, planId, days, periods, expiresAt, reason, note }, actor) {
  const result = await runAsPlatform(() =>
    tx(async (c) => {
      const store = (await c.query('SELECT * FROM stores WHERE id = $1 FOR UPDATE', [storeId])).rows[0];
      if (!store) throw notFound('ไม่พบร้านค้า');
      let sub = (await c.query('SELECT * FROM store_subscriptions WHERE store_id = $1 FOR UPDATE', [storeId])).rows[0];
      if (!sub) sub = (await c.query(`INSERT INTO store_subscriptions(store_id, status, expires_at) VALUES ($1,'TRIAL',now()) RETURNING *`, [storeId])).rows[0];
      const before = { planId: sub.plan_id, status: sub.status, expiresAt: sub.expires_at, storeActive: store.is_active };
      const plan = planId ? (await c.query('SELECT * FROM plans WHERE id = $1', [planId])).rows[0] : sub.plan_id ? (await c.query('SELECT * FROM plans WHERE id = $1', [sub.plan_id])).rows[0] : null;
      if (planId && !plan) throw notFound('ไม่พบแพ็กเกจ');
      const now = Date.now();
      const from = Math.max(now, sub.expires_at ? new Date(sub.expires_at).getTime() : now);
      let next = { plan_id: sub.plan_id, status: sub.status, expires_at: sub.expires_at };
      let storeActive = store.is_active;
      switch (action) {
        case 'TRIAL': {
          if (!plan) throw badRequest('กรุณาเลือกแพ็กเกจ');
          const end = expiresAt ? new Date(expiresAt) : new Date(now + Number(days || plan.trial_days || 14) * 86400000);
          next = { plan_id: plan.id, status: 'TRIAL', expires_at: end };
          break;
        }
        case 'EXTEND_TRIAL': {
          if (!Number(days) && !expiresAt) throw badRequest('กรุณาระบุจำนวนวันหรือวันหมดอายุ');
          next = { ...next, status: 'TRIAL', expires_at: expiresAt ? new Date(expiresAt) : new Date(from + Number(days) * 86400000) };
          break;
        }
        case 'RENEW': {
          if (!plan) throw badRequest('กรุณาเลือกแพ็กเกจ');
          const end = expiresAt ? new Date(expiresAt) : addPeriod(from, plan.billing_cycle, plan.billing_interval, Number(periods || 1));
          next = { plan_id: plan.id, status: 'ACTIVE', expires_at: end };
          break;
        }
        case 'CHANGE_PLAN': {
          if (!plan) throw badRequest('กรุณาเลือกแพ็กเกจ');
          next = { ...next, plan_id: plan.id };
          break;
        }
        case 'SET_EXPIRY':
          next = { ...next, expires_at: expiresAt ? new Date(expiresAt) : null };
          break;
        case 'SUSPEND':
          storeActive = false;
          break;
        case 'ACTIVATE':
          storeActive = true;
          break;
        default:
          throw badRequest('การดำเนินการไม่ถูกต้อง');
      }
      if (next.expires_at && Number.isNaN(new Date(next.expires_at).getTime())) throw badRequest('วันหมดอายุไม่ถูกต้อง');
      await c.query(`UPDATE store_subscriptions SET plan_id = $2, status = $3, expires_at = $4, started_at = CASE WHEN $5 THEN now() ELSE started_at END, updated_at = now() WHERE store_id = $1`, [
        storeId, next.plan_id, next.status, next.expires_at, ['TRIAL', 'RENEW'].includes(action),
      ]);
      if (storeActive !== store.is_active) {
        await c.query(`UPDATE stores SET is_active = $2, suspended_at = CASE WHEN $2 THEN NULL ELSE now() END, suspend_reason = CASE WHEN $2 THEN NULL ELSE $3 END, updated_at = now() WHERE id = $1`, [storeId, storeActive, reason || note || null]);
      }
      const after = { planId: next.plan_id, planName: plan?.name || null, status: next.status, expiresAt: next.expires_at, storeActive };
      await recordSubscriptionEvent(c, { storeId, action, before, after, note: reason || note || null, actorType: actor.type, actorId: actor.id, actorName: actor.name });
      return { before, after };
    }),
  );
  invalidateSubscription(storeId);
  clearStoreCache();
  emitStaff('subscription:changed', { at: Date.now() }, storeId);
  return result;
}

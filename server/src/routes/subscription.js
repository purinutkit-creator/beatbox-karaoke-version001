// Store side: the current plan / expiry (top-right widget, expired screen) and renewal requests.
// Always reachable, even when the subscription has expired, so the store can see what to do next.
import { Router } from 'express';
import { one, many, runAsPlatform, currentStoreId } from '../db/index.js';
import { requireAuth, hasPerm } from '../lib/auth.js';
import { z, parse } from '../lib/validate.js';
import { logActivity } from '../lib/activity.js';
import { getSubscription, publicSubscription } from '../services/subscription.js';
import { PLAN_FEATURES, PLAN_LIMITS } from '@beatbox/shared/plans.js';

const r = Router();
r.use(requireAuth);

r.get('/subscription', async (req, res) => {
  const storeId = currentStoreId();
  const sub = await getSubscription(storeId, { fresh: true });
  const data = await runAsPlatform(async () => ({
    plans: await many('SELECT id, name, description, price, currency, billing_cycle, billing_interval, features, limits, trial_days FROM plans WHERE is_public OR id = $1 ORDER BY sort_order, id', [sub?.plan?.id || 0]),
    signup: (await one(`SELECT value FROM platform_settings WHERE key = 'signup'`))?.value || {},
    events: hasPerm(req, 'settings.manage') ? await many('SELECT action, before, after, note, actor_type, actor_name, created_at FROM subscription_events WHERE store_id = $1 ORDER BY id DESC LIMIT 30', [storeId]) : [],
    openRequest: await one(`SELECT id, plan_id, message, created_at FROM renewal_requests WHERE store_id = $1 AND status = 'OPEN' ORDER BY id DESC LIMIT 1`, [storeId]),
  }));
  res.json({
    subscription: publicSubscription(sub),
    plans: data.plans.map((p) => ({ id: p.id, name: p.name, description: p.description, price: Number(p.price), currency: p.currency, billingCycle: p.billing_cycle, billingInterval: p.billing_interval, features: p.features, limits: p.limits, trialDays: p.trial_days })),
    features: PLAN_FEATURES,
    limits: PLAN_LIMITS,
    contact: { phone: data.signup.contactPhone || '', line: data.signup.contactLine || '', email: data.signup.contactEmail || '' },
    events: data.events,
    openRequest: data.openRequest,
  });
});

/** Ask the Super Owner to renew / change the plan (handled in the platform console). */
r.post('/subscription/renewal-request', async (req, res) => {
  const b = parse(z.object({ planId: z.coerce.number().int().optional().nullable(), message: z.string().max(500).optional().nullable() }), req.body);
  const storeId = currentStoreId();
  const row = await runAsPlatform(() => one(`INSERT INTO renewal_requests(store_id, plan_id, message, requested_by) VALUES ($1,$2,$3,$4) RETURNING id, created_at`, [storeId, b.planId || null, b.message || null, req.employee.name]));
  await logActivity(null, req, 'RENEWAL_REQUEST', 'store', storeId, b);
  res.json(row);
});

export default r;

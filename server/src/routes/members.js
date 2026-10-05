import { Router } from 'express';
import { tx, many, one } from '../db/index.js';
import { requireAuth, can } from '../lib/auth.js';
import { idempotent } from '../lib/idempotency.js';
import { logActivity } from '../lib/activity.js';
import { z, parse, zUrl } from '../lib/validate.js';
import { notFound, badRequest, conflict } from '../lib/errors.js';
import { emitSync } from '../lib/realtime.js';
import { nextMemberCode, randomCode } from '../services/numbers.js';
import { addPointTx, evaluateTier } from '../services/points.js';
import { normalizePhone } from '@beatbox/shared/format.js';

const r = Router();
r.use(requireAuth);

export const MEMBER_SELECT = `
  SELECT m.*, t.name AS tier_name, t.color AS tier_color, t.point_multiplier,
         EXISTS (SELECT 1 FROM line_connections lc WHERE lc.member_id = m.id AND lc.status = 'CONNECTED') AS line_connected,
         (SELECT rm.name FROM room_sessions rs JOIN rooms rm ON rm.id = rs.room_id WHERE rs.member_id = m.id GROUP BY rm.name ORDER BY COUNT(*) DESC LIMIT 1) AS favorite_room
  FROM members m LEFT JOIN member_tiers t ON t.id = m.tier_id`;

r.get('/members', can('member.view'), async (req, res) => {
  const q = String(req.query.q || '').trim();
  const phone = normalizePhone(q);
  const rows = await many(
    `${MEMBER_SELECT} WHERE m.deleted_at IS NULL AND ($1 = '' OR m.phone LIKE '%'||$2||'%' AND $2 <> '' OR m.first_name ILIKE '%'||$1||'%' OR m.last_name ILIKE '%'||$1||'%'
       OR m.nickname ILIKE '%'||$1||'%' OR upper(m.member_code) = upper($1))
     ORDER BY m.id DESC LIMIT $3`,
    [q, phone, Number(req.query.limit || 200)],
  );
  res.json(rows);
});

r.get('/members/lookup', async (req, res) => {
  const phone = normalizePhone(req.query.phone || req.query.q);
  const q = String(req.query.q || '').trim();
  const m = await one(`${MEMBER_SELECT} WHERE m.deleted_at IS NULL AND (m.phone = $1 OR upper(m.member_code) = upper($2)) LIMIT 1`, [phone, q]);
  res.json(m);
});

r.get('/members/:id', can('member.view'), async (req, res) => {
  const m = await one(`${MEMBER_SELECT} WHERE m.id = $1`, [req.params.id]);
  if (!m) throw notFound('ไม่พบสมาชิก');
  const ledger = await many(`SELECT pl.*, e.name AS employee_name FROM point_ledgers pl LEFT JOIN employees e ON e.id = pl.employee_id WHERE pl.member_id = $1 ORDER BY pl.id DESC LIMIT 200`, [m.id]);
  const orders = await many(`SELECT o.id, o.order_no, rc.receipt_no, o.grand_total, o.paid_at, o.status, o.points_earned, rm.name AS room_name FROM orders o LEFT JOIN receipts rc ON rc.order_id = o.id LEFT JOIN room_sessions rs ON rs.id = o.session_id LEFT JOIN rooms rm ON rm.id = rs.room_id WHERE o.member_id = $1 AND o.paid_at IS NOT NULL ORDER BY o.paid_at DESC LIMIT 100`, [m.id]);
  const reservations = await many(`SELECT rv.id, rv.booking_no, rv.start_at, rv.end_at, rv.status, rv.source, rm.name AS room_name FROM reservations rv JOIN rooms rm ON rm.id = rv.room_id WHERE rv.member_id = $1 AND rv.status <> 'EXPIRED' ORDER BY rv.start_at DESC LIMIT 100`, [m.id]);
  const redemptions = await many(`SELECT rr.*, rw.name AS reward_name FROM reward_redemptions rr JOIN rewards rw ON rw.id = rr.reward_id WHERE rr.member_id = $1 ORDER BY rr.id DESC LIMIT 100`, [m.id]);
  const identities = await many(`SELECT provider, display_name, picture_url, status, linked_at, last_login_at FROM member_auth_identities WHERE member_id = $1 ORDER BY id`, [m.id]);
  const topItems = await many(`SELECT oi.name, SUM(oi.qty) AS qty FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.member_id = $1 AND o.status = 'PAID' AND oi.item_type = 'PRODUCT' AND oi.voided_at IS NULL GROUP BY oi.name ORDER BY qty DESC LIMIT 5`, [m.id]);
  res.json({ ...m, ledger, orders, reservations, redemptions, identities, topItems });
});

const memberSchema = z.object({
  firstName: z.string().min(1, 'กรุณากรอกชื่อ').max(100),
  lastName: z.string().max(100).optional().nullable(),
  nickname: z.string().max(100).optional().nullable(),
  phone: z.string().min(9).max(20),
  birthday: z.string().optional().nullable().transform((v) => v || null),
  gender: z.string().max(20).optional().nullable(),
  email: z.string().email().optional().nullable().or(z.literal('')).transform((v) => v || null),
  photoUrl: zUrl,
  tierId: z.coerce.number().int().optional().nullable(),
  favoriteItems: z.string().max(500).optional().nullable(),
  note: z.string().max(1000).optional().nullable(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'BANNED']).default('ACTIVE'),
  marketingConsent: z.boolean().default(false),
});

r.post('/members', can('member.edit'), async (req, res) => {
  const b = parse(memberSchema, req.body);
  const phone = normalizePhone(b.phone);
  const row = await tx(async (c) => {
    const ex = (await c.query('SELECT id FROM members WHERE phone = $1 AND deleted_at IS NULL', [phone])).rows[0];
    if (ex) throw conflict('เบอร์โทรศัพท์นี้เป็นสมาชิกอยู่แล้ว');
    const defTier = (await c.query('SELECT id FROM member_tiers WHERE is_active ORDER BY sort_order LIMIT 1')).rows[0];
    const m = (
      await c.query(
        `INSERT INTO members(member_code, first_name, last_name, nickname, phone, birthday, gender, email, photo_url, tier_id, favorite_items, note, status, marketing_consent, created_by, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'POS') RETURNING *`,
        [await nextMemberCode(c), b.firstName, b.lastName, b.nickname, phone, b.birthday, b.gender, b.email, b.photoUrl, b.tierId || defTier?.id || null, b.favoriteItems, b.note, b.status, b.marketingConsent, req.employee.id],
      )
    ).rows[0];
    await c.query(`INSERT INTO member_auth_identities(member_id, provider, provider_user_id) VALUES ($1,'PHONE',$2) ON CONFLICT DO NOTHING`, [m.id, phone]);
    await logActivity(c, req, 'MEMBER_CREATE', 'member', m.id, { code: m.member_code, phone });
    return m;
  });
  emitSync('members');
  res.json(row);
});

r.put('/members/:id', can('member.edit'), async (req, res) => {
  const b = parse(memberSchema, req.body);
  const phone = normalizePhone(b.phone);
  const row = await tx(async (c) => {
    const before = (await c.query('SELECT * FROM members WHERE id = $1 AND deleted_at IS NULL', [req.params.id])).rows[0];
    if (!before) throw notFound();
    const m = (
      await c.query(
        `UPDATE members SET first_name=$2, last_name=$3, nickname=$4, phone=$5, birthday=$6, gender=$7, email=$8, photo_url=$9, tier_id=COALESCE($10, tier_id),
           favorite_items=$11, note=$12, status=$13, marketing_consent=$14, updated_at=now() WHERE id=$1 RETURNING *`,
        [req.params.id, b.firstName, b.lastName, b.nickname, phone, b.birthday, b.gender, b.email, b.photoUrl, b.tierId || null, b.favoriteItems, b.note, b.status, b.marketingConsent],
      )
    ).rows[0];
    if (before.phone !== phone) {
      await c.query(`UPDATE member_auth_identities SET status = 'DISCONNECTED', disconnected_at = now() WHERE member_id = $1 AND provider = 'PHONE' AND status = 'ACTIVE'`, [m.id]);
      await c.query(`INSERT INTO member_auth_identities(member_id, provider, provider_user_id) VALUES ($1,'PHONE',$2)`, [m.id, phone]);
    }
    await logActivity(c, req, 'MEMBER_UPDATE', 'member', m.id, { before: { phone: before.phone, name: before.first_name, tier: before.tier_id }, after: b });
    return m;
  });
  emitSync('members');
  res.json(row);
});

r.post('/members/:id/points', can('member.points'), idempotent('points-adjust', { required: false }), async (req, res) => {
  const b = parse(z.object({ points: z.coerce.number().refine((v) => v !== 0, 'จำนวนคะแนนต้องไม่เป็น 0'), reason: z.string().min(1, 'กรุณาระบุเหตุผล').max(300) }), req.body);
  const out = await tx(async (c) => {
    const led = await addPointTx(c, { memberId: Number(req.params.id), type: 'ADJUST', points: b.points, employeeId: req.employee.id, reason: b.reason, idempotencyKey: req.idempotencyKey ? `adj:${req.idempotencyKey}` : null });
    await evaluateTier(c, Number(req.params.id));
    await logActivity(c, req, 'POINTS_ADJUST', 'member', req.params.id, b);
    return led;
  });
  emitSync('members');
  res.json(out);
});

/** Redeem a reward for a member at the POS → unique redemption code. */
export async function redeemReward(c, { memberId, rewardId, employeeId = null, source = 'POS', idempotencyKey = null }) {
  if (idempotencyKey) {
    const ex = (await c.query('SELECT * FROM reward_redemptions WHERE idempotency_key = $1', [idempotencyKey])).rows[0];
    if (ex) return ex;
  }
  const rw = (await c.query('SELECT * FROM rewards WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [rewardId])).rows[0];
  if (!rw || !rw.is_active) throw notFound('ไม่พบของรางวัล');
  if (rw.expires_at && new Date(rw.expires_at) < new Date()) throw badRequest('ของรางวัลหมดอายุแล้ว');
  if (rw.quantity_total && rw.quantity_used >= rw.quantity_total) throw badRequest('ของรางวัลหมดแล้ว');
  if (rw.limit_per_member) {
    const used = (await c.query(`SELECT COUNT(*) AS n FROM reward_redemptions WHERE reward_id = $1 AND member_id = $2 AND status <> 'CANCELLED'`, [rw.id, memberId])).rows[0];
    if (Number(used.n) >= rw.limit_per_member) throw badRequest('แลกของรางวัลนี้ครบตามสิทธิ์แล้ว');
  }
  let code;
  for (let i = 0; i < 5; i++) {
    code = 'RW' + randomCode(8);
    if (!(await c.query('SELECT 1 FROM reward_redemptions WHERE code = $1', [code])).rows[0]) break;
  }
  const rd = (
    await c.query(
      `INSERT INTO reward_redemptions(code, reward_id, member_id, points, expires_at, employee_id, idempotency_key) VALUES ($1,$2,$3,$4, now() + ($5 || ' days')::interval, $6, $7) RETURNING *`,
      [code, rw.id, memberId, rw.points_cost, String(rw.valid_days || 30), employeeId, idempotencyKey],
    )
  ).rows[0];
  await addPointTx(c, { memberId, type: 'REDEEM', points: -rw.points_cost, source, rewardId: rw.id, redemptionId: rd.id, employeeId, reason: `แลก ${rw.name}`, idempotencyKey: `redeem:${rd.id}` });
  await c.query('UPDATE rewards SET quantity_used = quantity_used + 1 WHERE id = $1', [rw.id]);
  return { ...rd, reward_name: rw.name, reward_type: rw.reward_type };
}

r.post('/members/:id/redeem', can('member.points'), idempotent('redeem'), async (req, res) => {
  const { rewardId } = parse(z.object({ rewardId: z.coerce.number().int() }), req.body);
  const out = await tx(async (c) => {
    const rd = await redeemReward(c, { memberId: Number(req.params.id), rewardId, employeeId: req.employee.id, idempotencyKey: req.idempotencyKey });
    await logActivity(c, req, 'REWARD_REDEEM', 'member', req.params.id, { code: rd.code, reward: rd.reward_name });
    return rd;
  });
  emitSync('members');
  res.json(out);
});

r.get('/redemptions/:code', async (req, res) => {
  const rd = await one(
    `SELECT rr.*, rw.name AS reward_name, rw.reward_type, rw.value, rw.image_url, m.first_name, m.last_name, m.phone, m.member_code
     FROM reward_redemptions rr JOIN rewards rw ON rw.id = rr.reward_id JOIN members m ON m.id = rr.member_id WHERE rr.code = upper($1)`,
    [req.params.code.trim()],
  );
  if (!rd) throw notFound('ไม่พบรหัสแลกรางวัล');
  res.json(rd);
});

r.post('/redemptions/:code/cancel', can('member.points'), async (req, res) => {
  const out = await tx(async (c) => {
    const rd = (await c.query('SELECT * FROM reward_redemptions WHERE code = upper($1) FOR UPDATE', [req.params.code])).rows[0];
    if (!rd) throw notFound();
    if (rd.status !== 'ISSUED') throw conflict('รหัสนี้ไม่สามารถยกเลิกได้');
    await c.query(`UPDATE reward_redemptions SET status = 'CANCELLED' WHERE id = $1`, [rd.id]);
    await addPointTx(c, { memberId: rd.member_id, type: 'REVERSE', points: rd.points, rewardId: rd.reward_id, redemptionId: rd.id, employeeId: req.employee.id, reason: 'ยกเลิกการแลกรางวัล', idempotencyKey: `redeem-cancel:${rd.id}` });
    await c.query('UPDATE rewards SET quantity_used = GREATEST(0, quantity_used - 1) WHERE id = $1', [rd.reward_id]);
    await logActivity(c, req, 'REWARD_REDEEM_CANCEL', 'member', rd.member_id, { code: rd.code });
    return { ok: true };
  });
  emitSync('members');
  res.json(out);
});

export default r;

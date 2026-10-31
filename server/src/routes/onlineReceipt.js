// The online receipt (link in LINE, random token) and "collect points" for a bill paid without a member: the customer
// signs in / signs up as a member and the bill's points go to them — once, within the store's time limit.
import { Router } from 'express';
import { tx, one } from '../db/index.js';
import { requireMember } from '../lib/auth.js';
import { useStoreOf } from '../lib/tenant.js';
import { logActivity } from '../lib/activity.js';
import { emitSync } from '../lib/realtime.js';
import { notFound, conflict } from '../lib/errors.js';
import { getSettings } from '../services/settings.js';
import { addPointTx, evaluateTier } from '../services/points.js';
import { calculatePoints } from '@beatbox/shared/calc.js';

export const CLAIM_DAYS = 7;
const r = Router();

const receiptRow = (token) =>
  one(
    `SELECT rc.id, rc.receipt_no, rc.public_token, rc.snapshot, rc.issued_at, rc.points_claimed_by, rc.points_claimed_at, o.id AS order_id, o.status AS order_status,
            o.member_id, o.points_earned, o.calc_snapshot
     FROM receipts rc JOIN orders o ON o.id = rc.order_id WHERE rc.public_token = $1`,
    [token],
  );

/** What the bill gives and whether it can still be collected. */
function claimInfo(rc, settings, memberId = null) {
  const enabled = !!settings.points?.enabled;
  const points = enabled && rc.calc_snapshot ? calculatePoints(rc.calc_snapshot, settings.points, 1).points : 0;
  const days = Number(settings.points?.claimDays || CLAIM_DAYS);
  const expiresAt = new Date(new Date(rc.issued_at).getTime() + days * 86400000);
  let state = 'OPEN';
  if (!enabled || points <= 0) state = 'NONE';
  else if (rc.member_id) state = memberId && Number(rc.member_id) === Number(memberId) ? 'MINE' : 'TAKEN';
  else if (rc.order_status !== 'PAID') state = 'VOID';
  else if (expiresAt < new Date()) state = 'EXPIRED';
  return { state, points: rc.member_id ? Number(rc.points_earned) || points : points, expiresAt, days };
}

r.get('/receipts/:token', async (req, res) => {
  const token = String(req.params.token);
  if (!(await useStoreOf('receipts', 'public_token', token))) throw notFound('ไม่พบใบเสร็จ');
  const rc = await receiptRow(token);
  if (!rc) throw notFound('ไม่พบใบเสร็จ');
  const settings = await getSettings();
  const s = rc.snapshot || {};
  // the customer's own copy: no staff names, member codes or card references
  res.json({
    receiptNo: rc.receipt_no,
    issuedAt: rc.issued_at,
    status: rc.order_status,
    store: { ...s.store, slug: settings.store.slug, logoUrl: settings.store.logoUrl || s.store?.logoUrl },
    room: s.room ? { name: s.room.name, startedAt: s.room.startedAt, endedAt: s.room.endedAt, guests: s.room.guests, billedMinutes: s.room.billedMinutes } : null,
    customer: s.customer ? { name: s.customer.name } : null,
    lines: (s.lines || []).map((l) => ({ type: l.type, name: l.name, qty: l.qty, unitPrice: l.unitPrice, net: l.net, discount: l.discount })),
    discounts: (s.discounts || []).map((d) => ({ name: d.name, amount: d.amount })),
    totals: s.totals || {},
    tax: s.tax || null,
    payments: (s.payments || []).map((p) => ({ method: p.method, amount: p.amount })),
    thankYou: s.thankYou,
    claim: claimInfo(rc, settings),
  });
});

r.get('/receipts/:token/claim', requireMember, async (req, res) => {
  const rc = await receiptRow(String(req.params.token));
  if (!rc) throw notFound('ไม่พบใบเสร็จ');
  res.json({ receiptNo: rc.receipt_no, total: rc.snapshot?.totals?.grandTotal, issuedAt: rc.issued_at, ...claimInfo(rc, await getSettings(), req.member.id), balance: Number(req.member.points_balance) });
});

r.post('/receipts/:token/claim', requireMember, async (req, res) => {
  const settings = await getSettings();
  const out = await tx(async (c) => {
    const rc0 = await receiptRow(String(req.params.token));
    if (!rc0) throw notFound('ไม่พบใบเสร็จ');
    await c.query('SELECT id FROM orders WHERE id = $1 FOR UPDATE', [rc0.order_id]);
    const rc = (await c.query(`SELECT rc.*, o.id AS order_id, o.status AS order_status, o.member_id, o.points_earned, o.calc_snapshot, o.grand_total, o.billed_minutes, o.session_id FROM receipts rc JOIN orders o ON o.id = rc.order_id WHERE rc.id = $1`, [rc0.id])).rows[0];
    const m = (await c.query('SELECT m.*, t.point_multiplier FROM members m LEFT JOIN member_tiers t ON t.id = m.tier_id WHERE m.id = $1', [req.member.id])).rows[0];
    const info = claimInfo(rc, settings, m.id);
    if (info.state === 'MINE') return { ...info, already: true, balance: Number(m.points_balance) };
    if (info.state === 'TAKEN') throw conflict('บิลนี้สะสมแต้มให้สมาชิกท่านอื่นแล้ว');
    if (info.state === 'VOID') throw conflict('บิลนี้ถูกยกเลิกหรือคืนเงินแล้ว');
    if (info.state === 'EXPIRED') throw conflict(`เกินเวลารับแต้มของบิลนี้แล้ว (ภายใน ${info.days} วันหลังชำระเงิน)`);
    if (info.state === 'NONE') throw conflict('บิลนี้ไม่มีแต้มให้สะสม');
    const pts = calculatePoints(rc.calc_snapshot, settings.points, Number(m.point_multiplier || 1)).points;
    const months = Number(settings.points.expiryMonths || 0);
    const led = await addPointTx(c, { memberId: m.id, type: 'EARN', points: pts, source: 'RECEIPT_CLAIM', orderId: rc.order_id, receiptId: rc.id, reason: `รับแต้มใบเสร็จ ${rc.receipt_no}`, expiresAt: months > 0 ? new Date(Date.now() + months * 30 * 86400000) : null, idempotencyKey: `earn:${rc.order_id}` });
    // the bill is now the member's (refunds take the points back, it counts in their history and tier)
    await c.query('UPDATE orders SET member_id = $2, points_earned = $3 WHERE id = $1', [rc.order_id, m.id, pts]);
    await c.query('UPDATE receipts SET points_claimed_by = $2, points_claimed_at = now() WHERE id = $1', [rc.id, m.id]);
    await c.query('UPDATE members SET total_spending = total_spending + $2, visit_count = visit_count + $3, total_minutes = total_minutes + $4, updated_at = now() WHERE id = $1', [m.id, Number(rc.grand_total) || 0, rc.session_id ? 1 : 0, Number(rc.billed_minutes) || 0]);
    await evaluateTier(c, m.id);
    await logActivity(c, { employee: { id: null, name: `สมาชิก ${m.member_code}` }, ip: req.ip }, 'POINTS_CLAIM', 'order', rc.order_id, { receiptNo: rc.receipt_no, points: pts, memberId: m.id });
    return { ...info, state: 'MINE', points: pts, balance: Number(led.balance_after) };
  });
  emitSync('members');
  res.json(out);
});

export default r;

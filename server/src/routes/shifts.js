import { Router } from 'express';
import { pool, tx, many, one } from '../db/index.js';
import { requireAuth, can } from '../lib/auth.js';
import { logActivity } from '../lib/activity.js';
import { z, parse } from '../lib/validate.js';
import { notFound, conflict, badRequest } from '../lib/errors.js';
import { nextShiftNo } from '../services/numbers.js';
import { round2 } from '@beatbox/shared/money.js';
import { emitSync } from '../lib/realtime.js';

const r = Router();
r.use(requireAuth);

export async function shiftSummary(client, shift) {
  const id = shift.id;
  const until = shift.closed_at || new Date();
  const q = async (sql, params = [id]) => (await client.query(sql, params)).rows;
  const pay = await q(`SELECT method, SUM(amount) AS amount, COUNT(*) AS n FROM payments WHERE shift_id = $1 AND purpose = 'SALE' AND status IN ('PAID','PARTIALLY_REFUNDED','REFUNDED') GROUP BY method`);
  const byMethod = Object.fromEntries(pay.map((p) => [p.method, Number(p.amount)]));
  const dep = await q(`SELECT method, SUM(amount) AS amount, COUNT(*) AS n FROM deposits WHERE shift_id = $1 AND verification_status = 'VERIFIED' GROUP BY method`);
  const depByMethod = Object.fromEntries(dep.map((p) => [p.method, Number(p.amount)]));
  const depRef = await q(`SELECT refund_type, SUM(amount) AS amount, COUNT(*) AS n FROM deposit_refunds WHERE shift_id = $1 GROUP BY refund_type`);
  const depRefByType = Object.fromEntries(depRef.map((p) => [p.refund_type, Number(p.amount)]));
  const refunds = await q(`SELECT rf.*, o.order_no FROM refunds rf JOIN orders o ON o.id = rf.order_id WHERE rf.shift_id = $1 AND rf.status = 'COMPLETED' ORDER BY rf.id`);
  const orders = (
    await q(
      `SELECT COUNT(*) FILTER (WHERE status <> 'VOID') AS receipts, COALESCE(SUM(discount_total) FILTER (WHERE status <> 'VOID'),0) AS discount_total,
              COALESCE(SUM(service_charge) FILTER (WHERE status <> 'VOID'),0) AS service_charge, COALESCE(SUM(vat) FILTER (WHERE status <> 'VOID'),0) AS vat,
              COALESCE(SUM(grand_total) FILTER (WHERE status <> 'VOID'),0) AS grand_total,
              COALESCE(SUM(room_total) FILTER (WHERE status <> 'VOID'),0) AS room_total, COALESCE(SUM(product_total) FILTER (WHERE status <> 'VOID'),0) AS product_total,
              COUNT(*) FILTER (WHERE session_id IS NOT NULL AND status <> 'VOID') AS rooms_sold,
              COALESCE(SUM(billed_minutes) FILTER (WHERE status <> 'VOID'),0) AS minutes_sold
       FROM orders WHERE shift_id = $1 AND paid_at IS NOT NULL`,
    )
  )[0];
  const items = (await q(`SELECT COALESCE(SUM(oi.qty),0) AS qty FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.shift_id = $1 AND o.paid_at IS NOT NULL AND oi.voided_at IS NULL AND oi.item_type = 'PRODUCT'`))[0];
  const voids = await q(`SELECT o.id, o.order_no, o.grand_total, o.void_reason, o.voided_at, e.name AS voided_by_name FROM orders o LEFT JOIN employees e ON e.id = o.voided_by WHERE o.shift_id = $1 AND o.status = 'VOID' ORDER BY o.voided_at`);
  const newMembers = (await client.query(`SELECT COUNT(*) AS n FROM members WHERE created_at >= $1 AND created_at <= $2`, [shift.opened_at, until])).rows[0];

  const cashSales = byMethod.CASH || 0;
  const cashDeposits = depByMethod.CASH || 0;
  const cashDepositRefunds = depRefByType.CASH || 0;
  const cashRefunds = refunds.filter((x) => x.method === 'CASH').reduce((s, x) => s + Number(x.amount), 0);
  const expectedCash = round2(Number(shift.opening_cash) + cashSales + cashDeposits - cashDepositRefunds - cashRefunds);
  return {
    openingCash: Number(shift.opening_cash),
    cashSales,
    qrSales: byMethod.QR || 0,
    transferSales: byMethod.TRANSFER || 0,
    cardSales: byMethod.CARD || 0,
    otherSales: round2((byMethod.OTHER || 0) + (byMethod.CREDIT || 0)),
    salesByMethod: byMethod,
    depositsReceived: round2(Object.values(depByMethod).reduce((s, v) => s + v, 0)),
    depositsByMethod: depByMethod,
    depositsRefunded: round2(Object.values(depRefByType).reduce((s, v) => s + v, 0)),
    refundsTotal: round2(refunds.reduce((s, x) => s + Number(x.amount), 0)),
    discountTotal: Number(orders.discount_total),
    serviceCharge: Number(orders.service_charge),
    vat: Number(orders.vat),
    grandTotal: Number(orders.grand_total),
    roomTotal: Number(orders.room_total),
    productTotal: Number(orders.product_total),
    expectedCash,
    receipts: Number(orders.receipts),
    itemsSold: Number(items.qty),
    roomsSold: Number(orders.rooms_sold),
    hoursSold: round2(Number(orders.minutes_sold) / 60),
    newMembers: Number(newMembers.n),
    voids,
    refunds,
  };
}

r.get('/shifts', async (req, res) => {
  const rows = await many(
    `SELECT s.*, e.name AS employee_name, c.name AS closed_by_name, d.name AS device_name FROM shifts s
     JOIN employees e ON e.id = s.employee_id LEFT JOIN employees c ON c.id = s.closed_by LEFT JOIN pos_devices d ON d.id = s.device_id
     ORDER BY s.id DESC LIMIT $1`,
    [Number(req.query.limit || 100)],
  );
  res.json(rows);
});

r.get('/shifts/current', async (req, res) => {
  const deviceId = Number(req.query.deviceId || req.deviceId) || null;
  const s = await one(
    `SELECT s.*, e.name AS employee_name, d.name AS device_name FROM shifts s JOIN employees e ON e.id = s.employee_id LEFT JOIN pos_devices d ON d.id = s.device_id
     WHERE s.status = 'OPEN' AND ($1::int IS NULL OR s.device_id = $1) ORDER BY s.id DESC LIMIT 1`,
    [deviceId],
  );
  res.json(s);
});

r.post('/shifts/open', can('shift.open'), async (req, res) => {
  const b = parse(z.object({ deviceId: z.coerce.number().int(), openingCash: z.coerce.number().min(0), note: z.string().max(500).optional().nullable() }), req.body);
  const row = await tx(async (c) => {
    const open = (await c.query(`SELECT id FROM shifts WHERE device_id = $1 AND status = 'OPEN'`, [b.deviceId])).rows[0];
    if (open) throw conflict('เครื่องนี้มีรอบการขายที่เปิดอยู่แล้ว');
    const s = (
      await c.query(
        `INSERT INTO shifts(shift_no, device_id, employee_id, opening_cash, open_note, branch_id) VALUES ($1,$2,$3,$4,$5,(SELECT branch_id FROM pos_devices WHERE id = $2)) RETURNING *`,
        [await nextShiftNo(c), b.deviceId, req.employee.id, b.openingCash, b.note],
      )
    ).rows[0];
    await logActivity(c, req, 'SHIFT_OPEN', 'shift', s.id, { openingCash: b.openingCash, note: b.note, deviceId: b.deviceId });
    return s;
  });
  emitSync('shifts');
  res.json(row);
});

r.get('/shifts/:id/summary', async (req, res) => {
  const s = await one(`SELECT s.*, e.name AS employee_name, c.name AS closed_by_name, d.name AS device_name FROM shifts s JOIN employees e ON e.id = s.employee_id LEFT JOIN employees c ON c.id = s.closed_by LEFT JOIN pos_devices d ON d.id = s.device_id WHERE s.id = $1`, [req.params.id]);
  if (!s) throw notFound();
  const summary = s.status === 'CLOSED' && s.summary ? s.summary : await shiftSummary(pool, s);
  res.json({ shift: s, summary });
});

r.post('/shifts/:id/close', can('shift.close'), async (req, res) => {
  const b = parse(z.object({ countedCash: z.coerce.number().min(0), note: z.string().max(500).optional().nullable() }), req.body);
  const out = await tx(async (c) => {
    const s = (await c.query('SELECT * FROM shifts WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!s) throw notFound();
    if (s.status !== 'OPEN') throw conflict('รอบการขายนี้ปิดไปแล้ว');
    const openOrders = (await c.query(`SELECT COUNT(*) AS n FROM orders WHERE shift_id = $1 AND status = 'OPEN' AND session_id IS NULL`, [s.id])).rows[0];
    if (Number(openOrders.n) > 0 && !req.body.force) throw badRequest(`ยังมีบิลค้างชำระ ${openOrders.n} รายการในรอบนี้`, 'OPEN_ORDERS');
    const closedAt = new Date();
    const summary = await shiftSummary(c, { ...s, closed_at: closedAt });
    const diff = round2(b.countedCash - summary.expectedCash);
    summary.countedCash = b.countedCash;
    summary.difference = diff;
    summary.shortage = diff < 0 ? -diff : 0;
    summary.overage = diff > 0 ? diff : 0;
    const row = (
      await c.query(
        `UPDATE shifts SET status = 'CLOSED', closed_at = $2, closed_by = $3, expected_cash = $4, counted_cash = $5, difference = $6, close_note = $7, summary = $8 WHERE id = $1 RETURNING *`,
        [s.id, closedAt, req.employee.id, summary.expectedCash, b.countedCash, diff, b.note, summary],
      )
    ).rows[0];
    await logActivity(c, req, 'SHIFT_CLOSE', 'shift', s.id, { expectedCash: summary.expectedCash, countedCash: b.countedCash, difference: diff });
    return { shift: row, summary };
  });
  emitSync('shifts');
  res.json(out);
});

export default r;

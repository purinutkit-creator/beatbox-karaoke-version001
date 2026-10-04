import { Router } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import multer from 'multer';
import { pool, tx, many, one } from '../db/index.js';
import { requireAuth, can, hasPerm, signToken, readApproval } from '../lib/auth.js';
import { requireShift, attachShift } from '../lib/shift.js';
import { idempotent } from '../lib/idempotency.js';
import { logActivity } from '../lib/activity.js';
import { z, parse } from '../lib/validate.js';
import { notFound, badRequest, conflict, forbidden } from '../lib/errors.js';
import { emitSync } from '../lib/realtime.js';
import { getSettings } from '../services/settings.js';
import { createOrder, addProductItem, computeOrder, payOrder, discountNeedsApproval } from '../services/orders.js';
import { nextRefundNo } from '../services/numbers.js';
import { moveStock } from '../services/stock.js';
import { addPointTx, evaluateTier } from '../services/points.js';
import { refreshRoomStatuses } from '../services/rooms.js';
import { getSlipProvider, fileHash } from '../providers/slip.js';
import { notify } from '../services/notifications.js';
import { config } from '../config.js';
import { round2 } from '@beatbox/shared/money.js';

const r = Router();
r.use(requireAuth);

const itemSchema = z.object({
  productId: z.coerce.number().int(),
  qty: z.coerce.number().positive().max(9999).default(1),
  options: z.array(z.any()).default([]),
  note: z.string().max(300).optional().nullable(),
  discountType: z.enum(['AMOUNT', 'PERCENT']).optional().nullable(),
  discountValue: z.coerce.number().min(0).default(0),
  clientOpId: z.string().max(100).optional().nullable(),
});

async function openOrderOrThrow(c, id) {
  const o = (await c.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!o) throw notFound('ไม่พบบิล');
  if (o.status !== 'OPEN') throw conflict('บิลนี้ปิดแล้ว');
  return o;
}

r.get('/orders/open', async (_req, res) => {
  res.json(
    await many(
      `SELECT o.*, rs.room_id, rm.name AS room_name FROM orders o LEFT JOIN room_sessions rs ON rs.id = o.session_id LEFT JOIN rooms rm ON rm.id = rs.room_id
       WHERE o.status = 'OPEN' ORDER BY o.created_at DESC LIMIT 200`,
    ),
  );
});

/** Walk-in POS sale (no room): create an order with items in one call. */
r.post('/orders', can('pos.access'), attachShift, async (req, res) => {
  const b = parse(
    z.object({
      items: z.array(itemSchema).min(1, 'กรุณาเลือกสินค้า'),
      memberId: z.coerce.number().int().optional().nullable(),
      customerName: z.string().max(200).optional().nullable(),
      phone: z.string().max(20).optional().nullable(),
      clientOpId: z.string().max(100).optional().nullable(),
    }),
    req.body,
  );
  const order = await tx(async (c) => {
    const ex = b.clientOpId ? (await c.query('SELECT * FROM orders WHERE client_op_id = $1', [b.clientOpId])).rows[0] : null;
    if (ex) return ex;
    const o = await createOrder(c, { memberId: b.memberId, customerName: b.customerName, phone: b.phone, employeeId: req.employee.id, deviceId: req.deviceId, shiftId: req.shiftId, clientOpId: b.clientOpId });
    for (const it of b.items) await addProductItem(c, o, { ...it, clientOpId: it.clientOpId || (b.clientOpId ? `${b.clientOpId}:${it.productId}:${Math.random()}` : null), employeeId: req.employee.id });
    await logActivity(c, req, 'ORDER_CREATE', 'order', o.id, { items: b.items.length });
    return o;
  });
  emitSync('orders');
  res.json(order);
});

r.get('/orders/:id', async (req, res) => {
  const settings = await getSettings();
  const data = await computeOrder(pool, req.params.id, settings);
  const receipt = await one('SELECT * FROM receipts WHERE order_id = $1', [req.params.id]);
  const payments = await many('SELECT p.*, e.name AS employee_name FROM payments p LEFT JOIN employees e ON e.id = p.employee_id WHERE p.order_id = $1 ORDER BY p.id', [req.params.id]);
  const refunds = await many('SELECT rf.*, e.name AS requested_by_name, a.name AS approved_by_name FROM refunds rf LEFT JOIN employees e ON e.id = rf.requested_by LEFT JOIN employees a ON a.id = rf.approved_by WHERE rf.order_id = $1 ORDER BY rf.id', [req.params.id]);
  res.json({ ...data, receipt, payments, refunds, needsApproval: data.order.status === 'OPEN' ? discountNeedsApproval(req, settings, data.calc) && !data.order.discount_approved_by : false, now: Date.now() });
});

r.post('/orders/:id/items', can('pos.access'), async (req, res) => {
  const b = parse(itemSchema, req.body);
  const item = await tx(async (c) => {
    const o = await openOrderOrThrow(c, req.params.id);
    const it = await addProductItem(c, o, { ...b, employeeId: req.employee.id });
    await logActivity(c, req, 'ORDER_ITEM_ADD', 'order', o.id, { item: it.name, qty: it.qty });
    return it;
  });
  emitSync(['orders', 'rooms'], { orderId: Number(req.params.id) });
  res.json(item);
});

r.patch('/orders/:id/items/:itemId', can('pos.access'), async (req, res) => {
  const b = parse(
    z.object({ qty: z.coerce.number().positive().optional(), note: z.string().max(300).optional().nullable(), discountType: z.enum(['AMOUNT', 'PERCENT']).optional().nullable(), discountValue: z.coerce.number().min(0).optional() }),
    req.body,
  );
  if ((b.discountValue || 0) > 0 && !hasPerm(req, 'discount.give')) throw forbidden('คุณไม่มีสิทธิ์ให้ส่วนลด');
  await tx(async (c) => {
    const o = await openOrderOrThrow(c, req.params.id);
    const it = (await c.query('SELECT * FROM order_items WHERE id = $1 AND order_id = $2 AND voided_at IS NULL', [req.params.itemId, o.id])).rows[0];
    if (!it) throw notFound('ไม่พบรายการ');
    if (b.qty != null && it.kitchen_status === 'SENT' && b.qty < Number(it.qty) && !hasPerm(req, 'order.void')) throw forbidden('รายการที่ส่งครัวแล้ว ต้องมีสิทธิ์ยกเลิกรายการ');
    await c.query(
      `UPDATE order_items SET qty = COALESCE($2, qty), note = CASE WHEN $3::boolean THEN $4 ELSE note END,
         discount_type = CASE WHEN $5::boolean THEN $6 ELSE discount_type END, discount_value = COALESCE($7, discount_value) WHERE id = $1`,
      [it.id, b.qty ?? null, b.note !== undefined, b.note ?? null, b.discountType !== undefined, b.discountType ?? null, b.discountValue ?? null],
    );
    await logActivity(c, req, 'ORDER_ITEM_UPDATE', 'order', o.id, { item: it.name, before: { qty: it.qty, discount: it.discount_value }, after: b });
  });
  emitSync(['orders', 'rooms'], { orderId: Number(req.params.id) });
  res.json({ ok: true });
});

r.delete('/orders/:id/items/:itemId', can('pos.access'), async (req, res) => {
  const reason = req.body?.reason || req.query.reason || null;
  await tx(async (c) => {
    const o = await openOrderOrThrow(c, req.params.id);
    const it = (await c.query('SELECT * FROM order_items WHERE id = $1 AND order_id = $2 AND voided_at IS NULL', [req.params.itemId, o.id])).rows[0];
    if (!it) throw notFound('ไม่พบรายการ');
    if (it.kitchen_status === 'SENT') {
      if (!hasPerm(req, 'order.void')) throw forbidden('รายการที่ส่งครัวแล้ว ต้องมีสิทธิ์ยกเลิกรายการ');
      if (!reason) throw badRequest('กรุณาระบุเหตุผลการยกเลิกรายการ');
    }
    // soft-void: keeps the audit trail
    await c.query('UPDATE order_items SET voided_at = now(), voided_by = $2, void_reason = $3 WHERE id = $1', [it.id, req.employee.id, reason]);
    await logActivity(c, req, 'ORDER_ITEM_VOID', 'order', o.id, { item: it.name, qty: it.qty, reason });
  });
  emitSync(['orders', 'rooms'], { orderId: Number(req.params.id) });
  res.json({ ok: true });
});

r.put('/orders/:id/discount', can('pos.access'), async (req, res) => {
  const b = parse(
    z.object({
      billDiscountType: z.enum(['AMOUNT', 'PERCENT']).optional().nullable(),
      billDiscountValue: z.coerce.number().min(0).default(0),
      billDiscountReason: z.string().max(200).optional().nullable(),
      promoCode: z.string().max(50).optional().nullable(),
      promotionIds: z.array(z.coerce.number().int()).default([]),
      approvalToken: z.string().optional().nullable(),
    }),
    req.body,
  );
  if (b.billDiscountValue > 0 && !hasPerm(req, 'discount.give')) throw forbidden('คุณไม่มีสิทธิ์ให้ส่วนลด');
  const settings = await getSettings();
  const out = await tx(async (c) => {
    const o = await openOrderOrThrow(c, req.params.id);
    if (b.promoCode) {
      const p = (await c.query('SELECT id FROM promotions WHERE upper(code) = upper($1) AND deleted_at IS NULL AND is_active', [b.promoCode])).rows[0];
      if (!p) throw badRequest('ไม่พบ Promo Code นี้หรือหมดอายุแล้ว');
    }
    const approval = readApproval(b.approvalToken, 'discount.approve');
    await c.query(
      `UPDATE orders SET bill_discount_type = $2, bill_discount_value = $3, bill_discount_reason = $4, promo_code = $5, promotion_ids = $6, discount_approved_by = $7, version = version + 1 WHERE id = $1`,
      [o.id, b.billDiscountValue > 0 ? b.billDiscountType || 'AMOUNT' : null, b.billDiscountValue, b.billDiscountReason, b.promoCode ? b.promoCode.toUpperCase() : null, b.promotionIds, approval?.id || null],
    );
    const data = await computeOrder(c, o.id, settings);
    if (discountNeedsApproval(req, settings, data.calc) && !approval) throw conflict('ส่วนลดเกินวงเงินที่กำหนด ต้องให้ผู้จัดการอนุมัติ', 'APPROVAL_REQUIRED');
    await logActivity(c, req, 'ORDER_DISCOUNT', 'order', o.id, { ...b, approvalToken: undefined, approvedBy: approval?.name, discountTotal: data.calc.discountTotal });
    return data;
  });
  emitSync('orders', { orderId: Number(req.params.id) });
  res.json(out);
});

r.put('/orders/:id/customer', can('pos.access'), async (req, res) => {
  const b = parse(z.object({ memberId: z.coerce.number().int().optional().nullable(), customerName: z.string().max(200).optional().nullable(), phone: z.string().max(20).optional().nullable() }), req.body);
  await tx(async (c) => {
    const o = await openOrderOrThrow(c, req.params.id);
    await c.query('UPDATE orders SET member_id = $2, customer_name = $3, phone = $4 WHERE id = $1', [o.id, b.memberId || null, b.customerName, b.phone]);
    if (o.session_id) await c.query('UPDATE room_sessions SET member_id = $2, customer_name = COALESCE($3, customer_name), phone = COALESCE($4, phone) WHERE id = $1', [o.session_id, b.memberId || null, b.customerName, b.phone]);
    await logActivity(c, req, 'ORDER_CUSTOMER', 'order', o.id, b);
  });
  emitSync(['orders', 'rooms']);
  res.json({ ok: true });
});

/** Apply / remove reward redemption codes on an order. */
r.put('/orders/:id/redemptions', can('pos.access'), async (req, res) => {
  const { codes } = parse(z.object({ codes: z.array(z.string()).default([]) }), req.body);
  const settings = await getSettings();
  const out = await tx(async (c) => {
    const o = await openOrderOrThrow(c, req.params.id);
    const ids = [];
    for (const code of codes) {
      const rd = (await c.query('SELECT * FROM reward_redemptions WHERE code = $1', [code.trim().toUpperCase()])).rows[0];
      if (!rd) throw badRequest(`ไม่พบรหัสแลกรางวัล ${code}`);
      if (rd.status !== 'ISSUED') throw badRequest(`รหัส ${code} ถูกใช้แล้วหรือหมดอายุ`);
      if (rd.expires_at && new Date(rd.expires_at) < new Date()) throw badRequest(`รหัส ${code} หมดอายุแล้ว`);
      if (o.member_id && rd.member_id !== o.member_id) throw badRequest(`รหัส ${code} เป็นของสมาชิกท่านอื่น`);
      if (!o.member_id) await c.query('UPDATE orders SET member_id = $2 WHERE id = $1', [o.id, rd.member_id]);
      ids.push(rd.id);
    }
    await c.query('UPDATE orders SET redemption_ids = $2 WHERE id = $1', [o.id, ids]);
    await logActivity(c, req, 'ORDER_REDEMPTION', 'order', o.id, { codes });
    return computeOrder(c, o.id, settings);
  });
  emitSync('orders');
  res.json(out);
});

/** Send unsent food/drink items to kitchen / bar / prep stations (creates print jobs per station). */
r.post('/orders/:id/send-kitchen', can('pos.access'), async (req, res) => {
  const out = await tx(async (c) => {
    const o = (await c.query('SELECT o.*, rm.name AS room_name FROM orders o LEFT JOIN room_sessions rs ON rs.id = o.session_id LEFT JOIN rooms rm ON rm.id = rs.room_id WHERE o.id = $1', [req.params.id])).rows[0];
    if (!o) throw notFound();
    const items = (await c.query(`SELECT * FROM order_items WHERE order_id = $1 AND voided_at IS NULL AND kitchen_status = 'NONE' AND station <> 'NONE' AND item_type = 'PRODUCT'`, [o.id])).rows;
    if (!items.length) return { tickets: [] };
    const byStation = {};
    for (const it of items) (byStation[it.station] ||= []).push(it);
    const tickets = [];
    for (const [station, list] of Object.entries(byStation)) {
      const printer = (await c.query(`SELECT id FROM printers WHERE station = $1 AND is_active ORDER BY is_default DESC, id LIMIT 1`, [station])).rows[0];
      const payload = { station, orderNo: o.order_no, queueNo: o.queue_no, room: o.room_name, time: new Date(), employee: req.employee.name, items: list.map((i) => ({ name: i.name, qty: Number(i.qty), note: i.note })) };
      const job = (await c.query(`INSERT INTO print_jobs(printer_id, job_type, reference, payload, employee_id) VALUES ($1,'KITCHEN',$2,$3,$4) RETURNING *`, [printer?.id || null, o.order_no, payload, req.employee.id])).rows[0];
      tickets.push({ ...payload, jobId: job.id, printerId: printer?.id || null });
    }
    await c.query(`UPDATE order_items SET kitchen_status = 'SENT', sent_at = now() WHERE id = ANY($1)`, [items.map((i) => i.id)]);
    await logActivity(c, req, 'KITCHEN_SEND', 'order', o.id, { items: items.length });
    return { tickets };
  });
  emitSync(['orders', 'print-jobs']);
  res.json(out);
});

// ── Slip verification (POS) ──
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _f, cb) => {
      const dir = path.join(config.uploadDir, 'slips');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, f, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(f.originalname || '.jpg').toLowerCase()}`),
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, f, cb) => cb(null, /image\/(jpe?g|png|webp)/.test(f.mimetype)),
});

/**
 * POS slip check.
 * DEMO: simulated ~5 seconds then success (clearly marked demo).
 * PRODUCTION: real provider when a slip image is uploaded, otherwise a staff with slip.verify confirms manually (logged).
 */
r.post('/payments/verify-slip', can('slip.verify'), upload.single('slip'), async (req, res) => {
  const b = parse(z.object({ orderId: z.coerce.number().int().optional().nullable(), depositRef: z.string().optional().nullable(), amount: z.coerce.number().positive(), method: z.enum(['QR', 'TRANSFER']).default('QR'), manualConfirm: z.coerce.boolean().optional() }), req.body);
  const settings = await getSettings();
  let result;
  if (config.paymentMode !== 'PRODUCTION') {
    await new Promise((rs) => setTimeout(rs, Math.min(10, Number(settings.payment.slipCheckSeconds || 5)) * 1000));
    result = { ok: true, mode: 'DEMO', ref: `DEMO-${Date.now()}` };
  } else if (req.file) {
    const provider = getSlipProvider();
    const v = await provider.verify({ filePath: req.file.path, expectedAmount: b.amount });
    const hash = fileHash(req.file.path);
    if (v.ok && Math.abs(Number(v.amount) - b.amount) > 0.01) result = { ok: false, reason: 'ยอดเงินไม่ตรง' };
    else if (v.ok) {
      await pool.query(`INSERT INTO payment_verifications(provider, transaction_ref, amount, slip_path, slip_hash, result, verified_at, raw_provider_ref, reviewed_by) VALUES ($1,$2,$3,$4,$5,'PASSED',now(),$6,$7)`, [provider.name, v.transactionRef, v.amount, req.file.path, hash, v.raw || {}, req.employee.id]);
      result = { ok: true, mode: 'PROVIDER', ref: v.transactionRef };
    } else result = { ok: false, reason: v.reason || 'ไม่สามารถตรวจสอบรายการได้', manualReview: v.manualReview };
  } else if (b.manualConfirm) {
    result = { ok: true, mode: 'MANUAL', ref: `MANUAL-${Date.now()}` };
  } else {
    result = { ok: false, reason: 'กรุณาอัปโหลดสลิป หรือยืนยันการรับเงินด้วยตนเอง' };
  }
  await logActivity(null, req, result.ok ? 'SLIP_VERIFIED' : 'SLIP_FAILED', 'order', b.orderId, { amount: b.amount, method: b.method, mode: result.mode, ref: result.ref, reason: result.reason });
  if (!result.ok) return res.status(422).json({ error: result.reason, code: 'SLIP_FAILED', manualReview: !!result.manualReview });
  const token = signToken({ typ: 'slip', orderId: b.orderId || null, depositRef: b.depositRef || null, amount: b.amount, method: b.method, mode: result.mode, ref: result.ref, eid: req.employee.id }, '30m');
  res.json({ verified: true, verificationToken: token, reference: result.ref, mode: result.mode, verifiedAt: new Date(), verifiedBy: req.employee.name });
});

r.post('/orders/:id/pay', can('pos.access'), requireShift, idempotent('pay'), async (req, res) => {
  const b = parse(
    z.object({
      payments: z.array(z.object({ method: z.string(), amount: z.coerce.number().min(0), received: z.coerce.number().min(0).optional().nullable(), reference: z.string().optional().nullable(), verificationToken: z.string().optional().nullable(), slipUrl: z.string().optional().nullable() })).default([]),
      approvalToken: z.string().optional().nullable(),
    }),
    req.body,
  );
  const settings = await getSettings();
  const out = await tx((c) => payOrder(c, req, settings, Number(req.params.id), { payments: b.payments, idempotencyKey: req.idempotencyKey, approvalToken: b.approvalToken }));
  if (!out.replay) {
    await logActivity(null, req, 'ORDER_PAY', 'order', req.params.id, { receiptNo: out.receipt.receipt_no, total: out.calc?.grandTotal, payments: b.payments.map((p) => ({ method: p.method, amount: p.amount })) });
  }
  await refreshRoomStatuses(settings);
  emitSync(['orders', 'rooms', 'reservations', 'members', 'dashboard', 'products']);
  res.json({ receipt: out.receipt, change: out.change, pointsEarned: out.pointsEarned });
});

/** Void (cancel) an order. Paid orders are reversed: stock, points, deposits; requires reason. Audit trail kept. */
r.post('/orders/:id/void', can('order.void'), attachShift, async (req, res) => {
  const { reason, approvalToken } = parse(z.object({ reason: z.string().min(1, 'กรุณาระบุเหตุผล').max(500), approvalToken: z.string().optional().nullable() }), req.body);
  const settings = await getSettings();
  await tx(async (c) => {
    const o = (await c.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!o) throw notFound();
    if (o.status === 'VOID') throw conflict('บิลนี้ถูกยกเลิกแล้ว');
    if (o.status !== 'OPEN' && o.status !== 'PAID') throw conflict('บิลที่มีการคืนเงินแล้วไม่สามารถยกเลิกได้ กรุณาใช้การคืนเงิน');
    if (o.status === 'PAID') {
      if (!hasPerm(req, 'refund.approve') && !readApproval(approvalToken, 'refund.approve')) throw conflict('การยกเลิกบิลที่ชำระแล้วต้องได้รับอนุมัติ', 'APPROVAL_REQUIRED');
      const items = (await c.query(`SELECT * FROM order_items WHERE order_id = $1 AND voided_at IS NULL AND item_type = 'PRODUCT'`, [o.id])).rows;
      for (const it of items) await moveStock(c, { productId: it.product_id, type: 'VOID', quantity: Number(it.qty) - Number(it.refunded_qty), orderId: o.id, reference: o.order_no, employeeId: req.employee.id, note: `ยกเลิกบิล: ${reason}` });
      if (o.member_id && o.points_earned > 0) {
        await addPointTx(c, { memberId: o.member_id, type: 'REVERSE', points: -o.points_earned, orderId: o.id, employeeId: req.employee.id, reason: `ยกเลิกบิล ${o.order_no}`, idempotencyKey: `void-reverse:${o.id}`, allowNegative: true });
      }
      if (o.member_id) {
        await c.query('UPDATE members SET total_spending = GREATEST(0, total_spending - $2), visit_count = GREATEST(0, visit_count - $3), total_minutes = GREATEST(0, total_minutes - $4) WHERE id = $1', [o.member_id, o.grand_total, o.session_id ? 1 : 0, o.billed_minutes]);
        await evaluateTier(c, o.member_id);
      }
      await c.query(`UPDATE reward_redemptions SET status = 'ISSUED', used_at = NULL, used_order_id = NULL WHERE used_order_id = $1`, [o.id]);
      await c.query(`UPDATE deposits SET status = 'RECEIVED', applied_order_id = NULL WHERE applied_order_id = $1`, [o.id]);
      // refund record for the money (separate transaction, original payments untouched)
      await c.query(
        `INSERT INTO refunds(refund_no, order_id, amount, method, reason, status, is_full, requested_by, approved_by, shift_id, approved_at) VALUES ($1,$2,$3,$4,$5,'COMPLETED',true,$6,$6,$7,now())`,
        [await nextRefundNo(c), o.id, o.paid_total, 'CASH', `ยกเลิกบิล: ${reason}`, req.employee.id, req.shiftId || o.shift_id],
      );
    }
    await c.query(`UPDATE orders SET status = 'VOID', voided_at = now(), voided_by = $2, void_reason = $3, version = version + 1 WHERE id = $1`, [o.id, req.employee.id, reason]);
    if (o.session_id && o.status === 'OPEN') {
      await c.query(`UPDATE room_sessions SET status = 'CANCELLED', ended_at = COALESCE(ended_at, now()), cancel_reason = $2 WHERE id = $1 AND status IN ('ACTIVE','PAUSED','CLOSED','SCHEDULED')`, [o.session_id, reason]);
      await c.query(`UPDATE rooms SET status = 'CLEANING' WHERE id = (SELECT room_id FROM room_sessions WHERE id = $1)`, [o.session_id]);
    }
    await logActivity(c, req, 'ORDER_VOID', 'order', o.id, { reason, wasPaid: o.status === 'PAID', amount: o.grand_total });
  });
  await refreshRoomStatuses(settings);
  emitSync(['orders', 'rooms', 'dashboard', 'products', 'members']);
  res.json({ ok: true });
});

// ── Refunds ──
r.post('/orders/:id/refunds', can('refund.create'), attachShift, idempotent('refund', { required: false }), async (req, res) => {
  const b = parse(
    z.object({
      amount: z.coerce.number().positive().optional(),
      items: z.array(z.object({ itemId: z.coerce.number().int(), qty: z.coerce.number().positive() })).default([]),
      method: z.enum(['CASH', 'QR', 'TRANSFER', 'CARD', 'CREDIT', 'OTHER']).default('CASH'),
      reason: z.string().min(1, 'กรุณาระบุเหตุผล').max(500),
      full: z.boolean().default(false),
      restock: z.boolean().default(true),
      approvalToken: z.string().optional().nullable(),
    }),
    req.body,
  );
  const settings = await getSettings();
  const out = await tx(async (c) => {
    const o = (await c.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!o) throw notFound();
    if (!['PAID', 'PARTIALLY_REFUNDED'].includes(o.status)) throw conflict('บิลนี้ไม่สามารถคืนเงินได้');
    const refundable = round2(Number(o.paid_total) - Number(o.refunded_total));
    let amount = b.full ? refundable : b.amount;
    const itemsDetail = [];
    if (!b.full && b.items.length) {
      let sum = 0;
      for (const x of b.items) {
        const it = (await c.query('SELECT * FROM order_items WHERE id = $1 AND order_id = $2', [x.itemId, o.id])).rows[0];
        if (!it) throw badRequest('ไม่พบรายการสินค้า');
        if (x.qty > Number(it.qty) - Number(it.refunded_qty)) throw badRequest(`จำนวนคืนเกินจำนวนที่ซื้อ (${it.name})`);
        const line = (o.calc_snapshot?.lines || []).find((l) => l.id === it.id);
        const unitNet = line ? line.afterDiscount / line.qty : Number(it.unit_price);
        sum += unitNet * x.qty;
        itemsDetail.push({ itemId: it.id, productId: it.product_id, name: it.name, qty: x.qty, amount: round2(unitNet * x.qty) });
      }
      amount = amount || round2(sum);
    }
    if (!amount || amount <= 0) throw badRequest('กรุณาระบุจำนวนเงินคืน');
    if (amount > refundable + 0.001) throw badRequest(`คืนเงินได้สูงสุด ${refundable} บาท`);
    const approval = readApproval(b.approvalToken, 'refund.approve');
    const canApprove = hasPerm(req, 'refund.approve') || !!approval;
    const needsApproval = settings.security.refundRequiresApproval && !canApprove;
    const rf = (
      await c.query(
        `INSERT INTO refunds(refund_no, order_id, amount, method, reason, items, status, is_full, restock, requested_by, approved_by, shift_id, approved_at, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [await nextRefundNo(c), o.id, amount, b.method, b.reason, JSON.stringify(itemsDetail), needsApproval ? 'REQUESTED' : 'APPROVED', b.full || amount >= refundable, b.restock, req.employee.id, needsApproval ? null : approval?.id || req.employee.id, req.shiftId || null, needsApproval ? null : new Date(), req.idempotencyKey || null],
      )
    ).rows[0];
    await logActivity(c, req, 'REFUND_REQUEST', 'order', o.id, { refundNo: rf.refund_no, amount, reason: b.reason, needsApproval });
    if (needsApproval) {
      await notify({ type: 'REFUND_REQUEST', level: 'warning', title: 'คำขอคืนเงิน', message: `${req.employee.name} ขอคืนเงิน ${amount} บาท (บิล ${o.order_no}) — ${b.reason}`, data: { refundId: rf.id, orderId: o.id } }, c);
      return rf;
    }
    return completeRefund(c, req, rf.id, settings);
  });
  emitSync(['orders', 'dashboard', 'notifications']);
  res.json(out);
});

async function completeRefund(c, req, refundId, settings) {
  const rf = (await c.query('SELECT * FROM refunds WHERE id = $1 FOR UPDATE', [refundId])).rows[0];
  const o = (await c.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [rf.order_id])).rows[0];
  const refundable = round2(Number(o.paid_total) - Number(o.refunded_total));
  if (rf.amount > refundable + 0.001) throw badRequest(`คืนเงินได้สูงสุด ${refundable} บาท`);
  // restock
  if (rf.restock) {
    const items = rf.is_full && !(rf.items || []).length
      ? (await c.query(`SELECT id AS "itemId", product_id AS "productId", qty - refunded_qty AS qty FROM order_items WHERE order_id = $1 AND voided_at IS NULL AND item_type = 'PRODUCT'`, [o.id])).rows
      : rf.items || [];
    for (const it of items) {
      if (!it.productId || Number(it.qty) <= 0) continue;
      await moveStock(c, { productId: it.productId, type: 'RETURN', quantity: Number(it.qty), orderId: o.id, reference: rf.refund_no, employeeId: req.employee.id, note: 'คืนสินค้าจากการคืนเงิน' });
      await c.query('UPDATE order_items SET refunded_qty = refunded_qty + $2 WHERE id = $1', [it.itemId, it.qty]);
    }
  }
  // reverse points proportionally
  let pointsReversed = 0;
  if (o.member_id && o.points_earned > 0 && settings.points.reverseOnRefund) {
    pointsReversed = Math.min(o.points_earned, Math.ceil((o.points_earned * Number(rf.amount)) / Math.max(1, Number(o.paid_total))));
    if (pointsReversed > 0) await addPointTx(c, { memberId: o.member_id, type: 'REFUND', points: -pointsReversed, orderId: o.id, employeeId: req.employee.id, reason: `คืนเงิน ${rf.refund_no}`, idempotencyKey: `refund-points:${rf.id}`, allowNegative: true });
  }
  const newRefunded = round2(Number(o.refunded_total) + Number(rf.amount));
  const status = newRefunded >= Number(o.paid_total) - 0.001 ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
  await c.query('UPDATE orders SET refunded_total = $2, status = $3, version = version + 1 WHERE id = $1', [o.id, newRefunded, status]);
  await c.query(`UPDATE payments SET status = $2 WHERE order_id = $1 AND status IN ('PAID','PARTIALLY_REFUNDED')`, [o.id, status]);
  if (o.member_id) await c.query('UPDATE members SET total_spending = GREATEST(0, total_spending - $2) WHERE id = $1', [o.member_id, rf.amount]);
  const done = (await c.query(`UPDATE refunds SET status = 'COMPLETED', points_reversed = $2, shift_id = COALESCE(shift_id, $3), approved_at = COALESCE(approved_at, now()) WHERE id = $1 RETURNING *`, [rf.id, pointsReversed, req.shiftId || null])).rows[0];
  await logActivity(c, req, 'REFUND_COMPLETE', 'order', o.id, { refundNo: rf.refund_no, amount: rf.amount, pointsReversed });
  return done;
}

r.get('/refunds', async (req, res) => {
  res.json(
    await many(
      `SELECT rf.*, o.order_no, rc.receipt_no, e.name AS requested_by_name, a.name AS approved_by_name FROM refunds rf JOIN orders o ON o.id = rf.order_id
       LEFT JOIN receipts rc ON rc.order_id = o.id LEFT JOIN employees e ON e.id = rf.requested_by LEFT JOIN employees a ON a.id = rf.approved_by
       WHERE ($1::text IS NULL OR rf.status = $1) ORDER BY rf.id DESC LIMIT 300`,
      [req.query.status || null],
    ),
  );
});

r.post('/refunds/:id/approve', can('refund.approve'), attachShift, async (req, res) => {
  const { approve, note } = parse(z.object({ approve: z.boolean(), note: z.string().max(300).optional() }), req.body);
  const settings = await getSettings();
  const out = await tx(async (c) => {
    const rf = (await c.query('SELECT * FROM refunds WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!rf) throw notFound();
    if (rf.status !== 'REQUESTED') throw conflict('คำขอนี้ดำเนินการไปแล้ว');
    if (!approve) {
      await logActivity(c, req, 'REFUND_REJECT', 'order', rf.order_id, { refundNo: rf.refund_no, note });
      return (await c.query(`UPDATE refunds SET status = 'REJECTED', approved_by = $2, approved_at = now() WHERE id = $1 RETURNING *`, [rf.id, req.employee.id])).rows[0];
    }
    await c.query(`UPDATE refunds SET status = 'APPROVED', approved_by = $2, approved_at = now() WHERE id = $1`, [rf.id, req.employee.id]);
    return completeRefund(c, req, rf.id, settings);
  });
  emitSync(['orders', 'dashboard']);
  res.json(out);
});

// ── Receipts ──
r.get('/receipts', async (req, res) => {
  const q = req.query;
  const rows = await many(
    `SELECT rc.id, rc.receipt_no, rc.queue_no, rc.issued_at, rc.print_count, o.id AS order_id, o.order_no, o.status, o.grand_total, o.net_total, o.refunded_total,
            o.customer_name, o.phone, m.first_name AS member_name, m.phone AS member_phone, rm.name AS room_name, e.name AS employee_name,
            (SELECT string_agg(DISTINCT p.method, ',') FROM payments p WHERE p.order_id = o.id) AS methods
     FROM receipts rc JOIN orders o ON o.id = rc.order_id
     LEFT JOIN members m ON m.id = o.member_id LEFT JOIN room_sessions rs ON rs.id = o.session_id LEFT JOIN rooms rm ON rm.id = rs.room_id
     LEFT JOIN employees e ON e.id = o.paid_by
     WHERE ($1::text IS NULL OR rc.receipt_no ILIKE '%'||$1||'%' OR rc.queue_no ILIKE '%'||$1||'%' OR o.customer_name ILIKE '%'||$1||'%' OR o.phone ILIKE '%'||$1||'%'
            OR m.phone ILIKE '%'||$1||'%' OR m.first_name ILIKE '%'||$1||'%' OR rm.name ILIKE '%'||$1||'%' OR o.order_no ILIKE '%'||$1||'%')
       AND ($2::date IS NULL OR (rc.issued_at AT TIME ZONE 'Asia/Bangkok')::date >= $2) AND ($3::date IS NULL OR (rc.issued_at AT TIME ZONE 'Asia/Bangkok')::date <= $3)
       AND ($4::int IS NULL OR o.paid_by = $4)
       AND ($5::text IS NULL OR EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.method = $5))
       AND ($6::text IS NULL OR o.status = $6)
     ORDER BY rc.issued_at DESC LIMIT 500`,
    [q.q || null, q.from || null, q.to || null, q.employeeId || null, q.method || null, q.status || null],
  );
  res.json(rows);
});

r.get('/receipts/:id', async (req, res) => {
  const rc = await one(`SELECT rc.*, o.status AS order_status, o.void_reason, o.refunded_total FROM receipts rc JOIN orders o ON o.id = rc.order_id WHERE rc.id = $1 OR rc.receipt_no = $2`, [Number(req.params.id) || 0, req.params.id]);
  if (!rc) throw notFound();
  const logs = await many(`SELECT * FROM activity_logs WHERE entity = 'order' AND entity_id = $1 ORDER BY id`, [String(rc.order_id)]);
  res.json({ ...rc, logs });
});

/** Record a print (original or COPY). Re-prints require receipt.reprint and are always marked COPY. */
r.post('/receipts/:id/print', async (req, res) => {
  const b = parse(z.object({ kind: z.enum(['FULL', 'SHORT']).default('FULL'), printerId: z.coerce.number().int().optional().nullable(), confirmReprint: z.boolean().default(false) }), req.body);
  const out = await tx(async (c) => {
    const rc = (await c.query('SELECT * FROM receipts WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!rc) throw notFound();
    const isCopy = rc.print_count > 0;
    if (isCopy) {
      if (!hasPerm(req, 'receipt.reprint')) throw forbidden('คุณไม่มีสิทธิ์พิมพ์ใบเสร็จซ้ำ');
      if (!b.confirmReprint) throw conflict('ใบเสร็จนี้พิมพ์ไปแล้ว ต้องการพิมพ์สำเนาหรือไม่?', 'REPRINT_CONFIRM');
    }
    await c.query('UPDATE receipts SET print_count = print_count + 1, last_printed_at = now() WHERE id = $1', [rc.id]);
    await c.query(`INSERT INTO print_jobs(printer_id, job_type, reference, is_copy, status, employee_id, printed_at) VALUES ($1,$2,$3,$4,'PRINTED',$5,now())`, [b.printerId || null, b.kind === 'SHORT' ? 'RECEIPT_SHORT' : 'RECEIPT', rc.receipt_no, isCopy, req.employee.id]);
    if (isCopy) await logActivity(c, req, 'RECEIPT_REPRINT', 'order', rc.order_id, { receiptNo: rc.receipt_no, copy: rc.print_count });
    return { ...rc, isCopy, print_count: rc.print_count + 1 };
  });
  res.json(out);
});

r.post('/receipts/:id/send', async (req, res) => {
  const b = parse(z.object({ channel: z.enum(['LINE', 'SMS', 'EMAIL']), to: z.string().max(200) }), req.body);
  const rc = await one('SELECT rc.*, o.member_id FROM receipts rc JOIN orders o ON o.id = rc.order_id WHERE rc.id = $1', [req.params.id]);
  if (!rc) throw notFound();
  const link = `${config.publicUrl}/r/${rc.receipt_no}`;
  const n = await one(
    `INSERT INTO notifications(channel, type, title, message, data, member_id, status, error) VALUES ($1,'RECEIPT','ใบเสร็จรับเงิน',$2,$3,$4,$5,$6) RETURNING *`,
    [b.channel, `ใบเสร็จ ${rc.receipt_no} ยอดสุทธิ ${rc.snapshot?.totals?.netTotal} บาท ดูได้ที่ ${link}`, { to: b.to, receiptNo: rc.receipt_no }, rc.member_id, b.channel === 'LINE' ? 'PENDING' : 'FAILED', b.channel === 'LINE' ? null : 'ยังไม่ได้เชื่อมต่อผู้ให้บริการ ' + b.channel],
  );
  await logActivity(null, req, 'RECEIPT_SEND', 'order', rc.order_id, b);
  res.json(n);
});

r.get('/payments', can('sales.view'), async (req, res) => {
  res.json(
    await many(
      `SELECT p.*, o.order_no, e.name AS employee_name FROM payments p LEFT JOIN orders o ON o.id = p.order_id LEFT JOIN employees e ON e.id = p.employee_id
       WHERE ($1::date IS NULL OR (p.created_at AT TIME ZONE 'Asia/Bangkok')::date >= $1) AND ($2::date IS NULL OR (p.created_at AT TIME ZONE 'Asia/Bangkok')::date <= $2)
       ORDER BY p.id DESC LIMIT 500`,
      [req.query.from || null, req.query.to || null],
    ),
  );
});

r.post('/drawer/open', can('drawer.open'), async (req, res) => {
  await logActivity(null, req, 'DRAWER_OPEN', 'drawer', req.deviceId, { reason: req.body?.reason || 'เปิดลิ้นชักด้วยตนเอง' });
  res.json({ ok: true });
});

export default r;

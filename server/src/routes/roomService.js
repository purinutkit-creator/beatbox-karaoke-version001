// In-room QR ordering (public, by the session's one-time token) + staff handling of room payments and problems.
import { Router } from 'express';
import multer from 'multer';
import { pool, tx, one, many } from '../db/index.js';
import { requireAuth, can } from '../lib/auth.js';
import { logActivity } from '../lib/activity.js';
import { z, parse } from '../lib/validate.js';
import { notFound, badRequest, conflict } from '../lib/errors.js';
import { emitStaff, emitSync } from '../lib/realtime.js';
import { getSettings } from '../services/settings.js';
import { saveFile, sendStored } from '../services/files.js';
import { verifySlip } from '../providers/slip.js';
import { notify } from '../services/notifications.js';
import { LIVE_SESSION, priceItems, placeCustomerOrder, announce, roomServiceState } from '../services/roomService.js';
import { sessionTiming } from '@beatbox/shared/roomPricing.js';
import { promptPayPayload } from '@beatbox/shared/promptpay.js';

const actor = (name) => ({ employee: { id: null, name }, ip: null });

// ───────────── public: /api/public/room/:token ─────────────
export const publicRoom = Router();

async function liveSession(c, token, lock = false) {
  const s = (
    await c.query(
      `SELECT rs.*, rm.name AS room_name, rm.number AS room_number, rt.name AS type_name FROM room_sessions rs JOIN rooms rm ON rm.id = rs.room_id JOIN room_types rt ON rt.id = rs.room_type_id
       WHERE rs.order_token = $1 ${lock ? 'FOR UPDATE OF rs' : ''}`,
      [String(token || '')],
    )
  ).rows[0];
  if (!s) throw notFound('QR นี้ไม่ถูกต้อง');
  if (!LIVE_SESSION.includes(s.status)) throw Object.assign(conflict('QR นี้หมดอายุแล้ว เนื่องจากห้องปิดแล้ว ขอบคุณที่ใช้บริการ', 'ROOM_CLOSED'), { status: 410 });
  return s;
}

const publicOrder = (o) => ({ id: o.id, items: o.items, amount: Number(o.amount), payMode: o.pay_mode, status: o.status, paymentStatus: o.payment_status, rejectReason: o.reject_reason, createdAt: o.created_at, submittedAt: o.submitted_at });

publicRoom.get('/room/:token', async (req, res) => {
  const s = await liveSession(pool, req.params.token);
  const settings = await getSettings();
  const rs = settings.roomService;
  const t = sessionTiming(s);
  const [categories, products, orders, issues] = await Promise.all([
    many(`SELECT id, name, color FROM categories WHERE is_active AND deleted_at IS NULL ORDER BY sort_order, id`).catch(() => many(`SELECT id, name, color FROM categories ORDER BY sort_order, id`)),
    many(
      `SELECT p.id, p.name, p.price, p.image_url, p.category_id, p.description, (p.is_sold_out OR (p.track_stock AND COALESCE(sb.quantity,0) <= 0)) AS sold_out,
              COALESCE((SELECT json_agg(json_build_object('id', o.id, 'group', o.group_name, 'name', o.name, 'price', o.price_delta) ORDER BY o.id) FROM product_options o WHERE o.product_id = p.id), '[]') AS options
       FROM products p LEFT JOIN stock_balances sb ON sb.product_id = p.id WHERE p.deleted_at IS NULL AND p.is_available ORDER BY p.sort_order, p.name`,
    ),
    many(`SELECT * FROM room_customer_orders WHERE session_id = $1 AND status <> 'CANCELLED' ORDER BY id DESC`, [s.id]),
    many(`SELECT id, category, message, status, created_at FROM room_issues WHERE session_id = $1 ORDER BY id DESC LIMIT 10`, [s.id]),
  ]);
  res.json({
    now: Date.now(),
    store: { name: settings.store.name, logoUrl: settings.store.logoUrl, phone: settings.store.phone },
    room: { name: s.room_name, number: s.room_number, type: s.type_name, guests: s.guest_count, status: s.status, startedAt: s.started_at, endAt: new Date(t.endMs), remainingMs: t.remainingMs, paused: t.isPaused, session: { started_at: s.started_at, scheduled_end_at: s.scheduled_end_at, paused_at: s.paused_at, total_paused_seconds: s.total_paused_seconds, ended_at: s.ended_at } },
    service: { enabled: rs.enabled !== false, allowPayNow: rs.allowPayNow !== false, allowPayAtCounter: rs.allowPayAtCounter !== false, issueOptions: rs.issueOptions || [], autoAcceptSeconds: Number(rs.autoAcceptSeconds ?? 60), requireSlip: rs.requireSlip !== false },
    payment: { accountName: settings.payment.accountName, bankName: settings.payment.bankName, accountNumber: settings.payment.accountNumber, promptPayId: settings.payment.promptPayId, qrImageUrl: settings.payment.qrImageUrl },
    categories,
    products: products.map((p) => ({ ...p, price: Number(p.price) })),
    orders: orders.map(publicOrder),
    issues,
  });
});

const orderSchema = z.object({
  items: z.array(z.object({ productId: z.coerce.number().int(), qty: z.coerce.number().int().min(1).max(50), note: z.string().max(200).optional().nullable(), options: z.array(z.coerce.number().int()).default([]) })).min(1).max(40),
  payMode: z.enum(['NOW', 'COUNTER']),
  clientOpId: z.string().max(100).optional().nullable(),
});

publicRoom.post('/room/:token/orders', async (req, res) => {
  const b = parse(orderSchema, req.body);
  const settings = await getSettings();
  const rs = settings.roomService;
  if (rs.enabled === false) throw conflict('ร้านปิดการสั่งอาหารผ่าน QR ชั่วคราว กรุณาติดต่อพนักงาน');
  if (b.payMode === 'NOW' && rs.allowPayNow === false) throw badRequest('ร้านไม่เปิดให้ชำระเงินทันที');
  if (b.payMode === 'COUNTER' && rs.allowPayAtCounter === false) throw badRequest('กรุณาชำระเงินทันที');
  let jobs = [];
  const out = await tx(async (c) => {
    if (b.clientOpId) {
      const ex = (await c.query('SELECT * FROM room_customer_orders WHERE client_op_id = $1', [b.clientOpId])).rows[0];
      if (ex) return ex;
    }
    const s = await liveSession(c, req.params.token, true);
    if (!s.order_id) throw conflict('ไม่พบบิลของห้องนี้');
    const priced = await priceItems(c, b.items, settings);
    let rco = (
      await c.query(
        `INSERT INTO room_customer_orders(session_id, order_id, items, amount, pay_mode, status, client_op_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [s.id, s.order_id, JSON.stringify(priced.lines), priced.amount, b.payMode, b.payMode === 'NOW' ? 'AWAITING_PAYMENT' : 'PLACED', b.clientOpId || null],
      )
    ).rows[0];
    if (b.payMode === 'COUNTER') {
      const placed = await placeCustomerOrder(c, rco, { paymentStatus: 'NONE' });
      rco = placed.rco;
      jobs = placed.jobs;
      await notify({ type: 'ROOM_ORDER', level: 'info', title: `ห้อง ${s.room_name} สั่งอาหาร`, message: `${priced.lines.map((l) => `${l.name} x${l.qty}`).join(', ')} (ชำระที่เคาน์เตอร์)`, roomId: s.room_id, data: { roomOrderId: rco.id } }, c);
    }
    await logActivity(c, actor(`ลูกค้าห้อง ${s.room_name}`), 'ROOM_QR_ORDER', 'room_session', s.id, { orderId: rco.id, amount: priced.amount, payMode: b.payMode, items: priced.lines.map((l) => `${l.name} x${l.qty}`) });
    return rco;
  });
  announce(jobs);
  const p = settings.payment;
  res.json({ order: publicOrder(out), payment: out.pay_mode === 'NOW' ? { qrData: p.promptPayId ? promptPayPayload(p.promptPayId, Number(out.amount)) : null, qrImageUrl: p.qrImageUrl || null, amount: Number(out.amount), accountName: p.accountName, bankName: p.bankName, accountNumber: p.accountNumber } : null });
});

async function loadCustomerOrder(c, token, id) {
  const s = await liveSession(c, token);
  const o = (await c.query('SELECT * FROM room_customer_orders WHERE id = $1 AND session_id = $2 FOR UPDATE', [id, s.id])).rows[0];
  if (!o) throw notFound('ไม่พบรายการสั่ง');
  return { s, o };
}

publicRoom.get('/room/:token/orders/:id/payment', async (req, res) => {
  const { o } = await loadCustomerOrder(pool, req.params.token, req.params.id);
  const p = (await getSettings()).payment;
  res.json({ order: publicOrder(o), payment: { qrData: p.promptPayId ? promptPayPayload(p.promptPayId, Number(o.amount)) : null, qrImageUrl: p.qrImageUrl || null, amount: Number(o.amount), accountName: p.accountName, bankName: p.bankName, accountNumber: p.accountNumber } });
});

const slipUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, f, cb) => (/image\/(jpe?g|png)/.test(f.mimetype) ? cb(null, true) : cb(Object.assign(new Error('รองรับเฉพาะไฟล์ JPG, JPEG, PNG'), { status: 400 }))),
});

/** Customer pressed "ตรวจสอบการชำระเงิน" (with the slip). */
publicRoom.post('/room/:token/orders/:id/pay', (req, res, next) => slipUpload.single('slip')(req, res, (e) => (e ? res.status(400).json({ error: e.message }) : next())), async (req, res) => {
  const settings = await getSettings();
  const requireSlip = settings.roomService.requireSlip !== false;
  if (requireSlip && !req.file) throw badRequest('กรุณาแนบสลิปการโอนเงิน');
  const pre = await tx(async (c) => {
    const { s, o } = await loadCustomerOrder(c, req.params.token, req.params.id);
    if (o.pay_mode !== 'NOW' || !['AWAITING_PAYMENT'].includes(o.status)) throw conflict('รายการนี้ส่งตรวจสอบแล้ว');
    return { s, o };
  });
  const { s, o } = pre;
  // real verification when a slip provider is configured (PRODUCTION); demo / manual → cashier review
  let v = null;
  if (req.file) v = await verifySlip({ buffer: req.file.buffer, mime: req.file.mimetype, expectedAmount: Number(o.amount), notBefore: o.created_at, settings });
  const providerPassed = v?.ok && v.mode === 'PROVIDER';
  const providerRejected = v && !v.ok && !v.manualReview;
  let jobs = [];
  const result = await tx(async (c) => {
    const cur = (await c.query('SELECT * FROM room_customer_orders WHERE id = $1 FOR UPDATE', [o.id])).rows[0];
    if (cur.status !== 'AWAITING_PAYMENT') return cur;
    let slipRef = null;
    let pvId = null;
    if (req.file) {
      slipRef = (await saveFile(c, { kind: 'SLIP', name: req.file.originalname, mime: req.file.mimetype, buffer: req.file.buffer })).ref;
      const result = providerPassed ? 'PASSED' : providerRejected ? 'FAILED' : 'MANUAL_REVIEW';
      try {
        pvId = (
          await c.query(
            `INSERT INTO payment_verifications(provider, transaction_ref, amount, slip_path, slip_hash, result, failure_reason, raw_provider_ref, verified_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $6 = 'PASSED' THEN now() END) RETURNING id`,
            [v.provider, providerPassed ? v.transactionRef : null, Number(o.amount), slipRef, providerPassed ? v.hash : null, result, v.reason || null, { qr: v.qr, mode: v.mode, roomOrderId: o.id }],
          )
        ).rows[0].id;
      } catch (e) {
        if (e.code !== '23505') throw e;
        return { ...cur, _error: 'พบรายการนี้ถูกใช้แล้ว' };
      }
    }
    if (providerRejected) {
      await c.query(`UPDATE room_customer_orders SET reject_reason = $2, verification_id = $3 WHERE id = $1`, [o.id, v.reason, pvId]);
      return { ...cur, _error: v.reason };
    }
    const u = (await c.query(`UPDATE room_customer_orders SET status = 'VERIFYING', payment_status = 'PENDING', submitted_at = now(), slip_ref = $2, verification_id = $3, reject_reason = NULL WHERE id = $1 RETURNING *`, [o.id, slipRef, pvId])).rows[0];
    if (providerPassed) {
      const placed = await placeCustomerOrder(c, u, { paymentStatus: 'VERIFIED' });
      jobs = placed.jobs;
      await notify({ type: 'ROOM_ORDER', level: 'success', title: `ห้อง ${s.room_name} สั่งอาหาร (ชำระแล้ว)`, message: `${o.items.map((l) => `${l.name} x${l.qty}`).join(', ')} · ${o.amount} บาท · ตรวจสลิปผ่าน ${v.provider}`, roomId: s.room_id, data: { roomOrderId: o.id } }, c);
      return placed.rco;
    }
    const n = await notify({ type: 'ROOM_PREPAY', level: 'warning', title: `ห้อง ${s.room_name} ชำระเงินมา กรุณาตรวจสอบสลิป`, message: `ค่าอาหาร ${o.amount} บาท · ${o.items.map((l) => `${l.name} x${l.qty}`).join(', ')}`, roomId: s.room_id, data: { roomOrderId: o.id } }, c);
    emitStaff('room:payment', { roomOrderId: o.id, roomId: s.room_id, roomName: s.room_name, amount: Number(o.amount), items: o.items, hasSlip: !!slipRef, autoAcceptSeconds: Number(settings.roomService.autoAcceptSeconds ?? 60), notificationId: n?.id });
    return u;
  });
  announce(jobs);
  if (result._error) return res.status(422).json({ error: result._error, code: 'SLIP_FAILED', order: publicOrder(result) });
  res.json({ order: publicOrder(result) });
});

/** Switch an unpaid pay-now order to "pay at the counter". */
publicRoom.post('/room/:token/orders/:id/counter', async (req, res) => {
  const settings = await getSettings();
  if (settings.roomService.allowPayAtCounter === false) throw badRequest('กรุณาชำระเงินทันที');
  let jobs = [];
  const out = await tx(async (c) => {
    const { s, o } = await loadCustomerOrder(c, req.params.token, req.params.id);
    if (o.status !== 'AWAITING_PAYMENT') throw conflict('รายการนี้ส่งตรวจสอบแล้ว');
    await c.query(`UPDATE room_customer_orders SET pay_mode = 'COUNTER' WHERE id = $1`, [o.id]);
    const placed = await placeCustomerOrder(c, { ...o, pay_mode: 'COUNTER' }, { paymentStatus: 'NONE' });
    jobs = placed.jobs;
    await notify({ type: 'ROOM_ORDER', level: 'info', title: `ห้อง ${s.room_name} สั่งอาหาร`, message: `${o.items.map((l) => `${l.name} x${l.qty}`).join(', ')} (ชำระที่เคาน์เตอร์)`, roomId: s.room_id, data: { roomOrderId: o.id } }, c);
    return placed.rco;
  });
  announce(jobs);
  res.json({ order: publicOrder(out) });
});

publicRoom.post('/room/:token/orders/:id/cancel', async (req, res) => {
  const out = await tx(async (c) => {
    const { o } = await loadCustomerOrder(c, req.params.token, req.params.id);
    if (o.status !== 'AWAITING_PAYMENT') throw conflict('ยกเลิกไม่ได้ รายการนี้ส่งตรวจสอบหรือส่งครัวแล้ว');
    return (await c.query(`UPDATE room_customer_orders SET status = 'CANCELLED' WHERE id = $1 RETURNING *`, [o.id])).rows[0];
  });
  res.json({ order: publicOrder(out) });
});

/** Customer reports a problem / calls staff. */
publicRoom.post('/room/:token/issues', async (req, res) => {
  const b = parse(z.object({ category: z.string().trim().min(1).max(100), message: z.string().trim().max(500).optional().nullable() }), req.body);
  const settings = await getSettings();
  const issue = await tx(async (c) => {
    const s = await liveSession(c, req.params.token, true);
    const recent = (await c.query(`SELECT COUNT(*)::int AS n FROM room_issues WHERE session_id = $1 AND created_at > now() - interval '10 minutes'`, [s.id])).rows[0].n;
    if (recent >= 5) throw badRequest('แจ้งปัญหาบ่อยเกินไป พนักงานกำลังไปที่ห้อง');
    if (b.category === 'OTHER' && !b.message) throw badRequest('กรุณาอธิบายปัญหา');
    const category = b.category === 'OTHER' ? 'อื่นๆ' : b.category;
    const row = (await c.query(`INSERT INTO room_issues(session_id, room_id, category, message) VALUES ($1,$2,$3,$4) RETURNING *`, [s.id, s.room_id, category, b.message || null])).rows[0];
    await notify({ type: 'ROOM_ISSUE', level: 'error', title: `ห้อง ${s.room_name}: ลูกค้าพบปัญหา`, message: `${category}${b.message ? ` — ${b.message}` : ''}`, roomId: s.room_id, data: { issueId: row.id } }, c);
    await logActivity(c, actor(`ลูกค้าห้อง ${s.room_name}`), 'ROOM_ISSUE_REPORT', 'room', s.room_id, { category, message: b.message });
    return { ...row, room_name: s.room_name };
  });
  emitStaff('room:issue', { id: issue.id, roomId: issue.room_id, roomName: issue.room_name, category: issue.category, message: issue.message, soundUrl: settings.roomService.issueSoundUrl || null, createdAt: issue.created_at });
  emitSync(['rooms', 'room-service']);
  res.json({ id: issue.id, category: issue.category, message: issue.message, status: issue.status, created_at: issue.created_at });
});

// ───────────── staff ─────────────
const staff = Router();
staff.use(requireAuth);

staff.get('/room-service', async (_req, res) => res.json(await roomServiceState()));

staff.get('/room-service/orders/:id/slip', can('slip.verify'), async (req, res) => {
  const o = await one('SELECT slip_ref FROM room_customer_orders WHERE id = $1', [req.params.id]);
  if (!o?.slip_ref || !(await sendStored(res, o.slip_ref))) throw notFound('ไม่มีสลิปแนบ');
});

/** Cashier verifies (or rejects) a customer's prepayment from the room. */
staff.post('/room-service/orders/:id/verify', can('slip.verify'), async (req, res) => {
  const b = parse(z.object({ approve: z.boolean(), reason: z.string().max(300).optional().nullable() }), req.body);
  if (!b.approve && !b.reason) throw badRequest('กรุณาระบุเหตุผลที่ไม่ผ่าน');
  let jobs = [];
  const out = await tx(async (c) => {
    const o = (await c.query('SELECT * FROM room_customer_orders WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!o) throw notFound();
    if (!['PENDING', 'AUTO_ACCEPTED'].includes(o.payment_status)) throw conflict('รายการนี้ตรวจสอบแล้ว');
    let u;
    if (b.approve) {
      if (o.status === 'VERIFYING') {
        const placed = await placeCustomerOrder(c, o, { paymentStatus: 'VERIFIED', verifiedBy: req.employee.id });
        u = placed.rco;
        jobs = placed.jobs;
      } else {
        u = (await c.query(`UPDATE room_customer_orders SET payment_status = 'VERIFIED', verified_by = $2, verified_at = now() WHERE id = $1 RETURNING *`, [o.id, req.employee.id])).rows[0];
      }
      if (u.deposit_id) await c.query(`UPDATE deposits SET verification_status = 'VERIFIED', received_by = COALESCE(received_by, $2) WHERE id = $1`, [u.deposit_id, req.employee.id]);
      if (o.verification_id) await c.query(`UPDATE payment_verifications SET result = 'PASSED', reviewed_by = $2, verified_at = now() WHERE id = $1 AND result <> 'PASSED'`, [o.verification_id, req.employee.id]);
    } else if (o.status === 'VERIFYING') {
      // not accepted yet → back to the customer: pay again or choose the counter
      u = (await c.query(`UPDATE room_customer_orders SET status = 'AWAITING_PAYMENT', payment_status = 'REJECTED', reject_reason = $2, verified_by = $3, verified_at = now() WHERE id = $1 RETURNING *`, [o.id, b.reason, req.employee.id])).rows[0];
      if (o.verification_id) await c.query(`UPDATE payment_verifications SET result = 'FAILED', failure_reason = $2, reviewed_by = $3, verified_at = now() WHERE id = $1`, [o.verification_id, b.reason, req.employee.id]);
    } else {
      // already accepted (food sent): the prepayment does not count — the items stay on the bill to be paid at checkout
      u = (await c.query(`UPDATE room_customer_orders SET payment_status = 'REJECTED', reject_reason = $2, verified_by = $3, verified_at = now() WHERE id = $1 RETURNING *`, [o.id, b.reason, req.employee.id])).rows[0];
      if (u.deposit_id) await c.query(`UPDATE deposits SET verification_status = 'REJECTED', status = 'CANCELLED', note = COALESCE(note, '') || $2 WHERE id = $1`, [u.deposit_id, ` · ไม่ผ่าน: ${b.reason}`]);
      if (o.verification_id) await c.query(`UPDATE payment_verifications SET result = 'FAILED', failure_reason = $2, reviewed_by = $3, verified_at = now() WHERE id = $1`, [o.verification_id, b.reason, req.employee.id]);
    }
    await c.query(`UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE type IN ('ROOM_PREPAY','ROOM_PREPAY_AUTO') AND (data->>'roomOrderId')::int = $1`, [o.id]).catch(() => {});
    await logActivity(c, req, b.approve ? 'ROOM_PREPAY_VERIFIED' : 'ROOM_PREPAY_REJECTED', 'room_customer_order', o.id, { amount: o.amount, reason: b.reason, wasAutoAccepted: o.payment_status === 'AUTO_ACCEPTED' });
    return u;
  });
  announce(jobs);
  emitStaff('room:payment-resolved', { roomOrderId: out.id });
  res.json(out);
});

staff.post('/room-issues/:id/:action', can('room.operate'), async (req, res) => {
  const action = req.params.action;
  if (!['ack', 'resolve'].includes(action)) throw notFound();
  const note = req.body?.note ? String(req.body.note).slice(0, 300) : null;
  const row =
    action === 'ack'
      ? await one(`UPDATE room_issues SET status = 'ACKNOWLEDGED', acknowledged_by = $2, acknowledged_at = now() WHERE id = $1 AND status = 'OPEN' RETURNING *`, [req.params.id, req.employee.id])
      : await one(`UPDATE room_issues SET status = 'RESOLVED', resolved_by = $2, resolved_at = now(), resolution = $3, acknowledged_by = COALESCE(acknowledged_by, $2), acknowledged_at = COALESCE(acknowledged_at, now()) WHERE id = $1 AND status <> 'RESOLVED' RETURNING *`, [req.params.id, req.employee.id, note]);
  if (!row) throw conflict('รายการนี้ดำเนินการแล้ว');
  await logActivity(null, req, action === 'ack' ? 'ROOM_ISSUE_ACK' : 'ROOM_ISSUE_RESOLVE', 'room', row.room_id, { issueId: row.id, category: row.category, note });
  emitSync(['rooms', 'room-service']);
  emitStaff('room:issue-updated', { id: row.id, status: row.status });
  res.json(row);
});

/** Data for the room tickets printed when a room opens (store copy + customer copy with the ordering QR). */
staff.get('/sessions/:id/ticket', async (req, res) => {
  const s = await one(
    `SELECT rs.*, rm.name AS room_name, rm.number AS room_number, rt.name AS type_name, e.name AS opened_by_name FROM room_sessions rs JOIN rooms rm ON rm.id = rs.room_id
     JOIN room_types rt ON rt.id = rs.room_type_id LEFT JOIN employees e ON e.id = rs.opened_by WHERE rs.id = $1`,
    [req.params.id],
  );
  if (!s) throw notFound();
  const settings = await getSettings();
  const t = sessionTiming(s);
  const minutes = Number(s.package_minutes) + Number(s.booked_minutes) + Number(s.extension_minutes);
  res.json({
    store: { name: settings.store.name, branchName: settings.store.branchName, phone: settings.store.phone, logoUrl: settings.store.logoUrl },
    sessionNo: s.session_no,
    room: s.room_name,
    roomNumber: s.room_number,
    type: s.type_name,
    customer: s.customer_name,
    guests: s.guest_count,
    capacity: s.room_capacity,
    extraMics: s.extra_mics,
    packageName: s.package_name,
    startAt: s.started_at,
    endAt: new Date(t.endMs),
    minutes,
    employee: s.opened_by_name,
    orderToken: LIVE_SESSION.includes(s.status) ? s.order_token : null,
    ticket: settings.roomTicket,
    roomServiceEnabled: settings.roomService.enabled !== false,
  });
});

export default staff;

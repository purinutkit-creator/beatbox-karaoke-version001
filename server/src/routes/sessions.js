import { Router } from 'express';
import { pool, tx, many, one } from '../db/index.js';
import { requireAuth, can, verifyToken } from '../lib/auth.js';
import { attachShift, requireShift } from '../lib/shift.js';
import { idempotent } from '../lib/idempotency.js';
import { paymentMode } from '../providers/slip.js';
import { logActivity } from '../lib/activity.js';
import { z, parse } from '../lib/validate.js';
import { notFound, badRequest, conflict } from '../lib/errors.js';
import { emitSync } from '../lib/realtime.js';
import { getSettings } from '../services/settings.js';
import { lockRoom, assertRoomFree } from '../services/availability.js';
import { getRoomBoard, refreshRoomStatuses, SESSION_SELECT, sessionCharges } from '../services/rooms.js';
import { createOrder, addProductItem, computeOrder, payOrder } from '../services/orders.js';
import { round2 } from '@beatbox/shared/money.js';
import { nextSessionNo, nextDepositNo, randomToken } from '../services/numbers.js';
import { sessionTiming } from '@beatbox/shared/roomPricing.js';
import { notify, queueLineMessage, bookingMessage } from '../services/notifications.js';

const r = Router();
r.use(requireAuth);

const ACTIVE = ['PENDING_PAYMENT', 'SCHEDULED', 'ACTIVE', 'PAUSED', 'CLOSED'];

r.get('/rooms/board', async (_req, res) => {
  const settings = await getSettings();
  res.json({ now: Date.now(), rooms: await getRoomBoard(settings) });
});

r.post('/rooms/:id/status', can('room.operate'), async (req, res) => {
  const { status, note } = parse(z.object({ status: z.enum(['AVAILABLE', 'CLEANING', 'MAINTENANCE', 'DISABLED']), note: z.string().max(500).optional() }), req.body);
  await tx(async (c) => {
    const room = await lockRoom(c, req.params.id);
    if (!room) throw notFound();
    const s = (await c.query('SELECT id FROM room_sessions WHERE room_id = $1 AND status = ANY($2)', [room.id, ACTIVE])).rows[0];
    if (s) throw conflict('ห้องนี้มีลูกค้าใช้งานอยู่ ไม่สามารถเปลี่ยนสถานะได้');
    await c.query('UPDATE rooms SET status = $2, is_active = $3, updated_at = now() WHERE id = $1', [room.id, status, status !== 'DISABLED']);
    await logActivity(c, req, status === 'AVAILABLE' && room.status === 'CLEANING' ? 'ROOM_READY' : 'ROOM_STATUS', 'room', room.id, { from: room.status, to: status, note });
  });
  await refreshRoomStatuses(await getSettings());
  emitSync('rooms');
  res.json({ ok: true });
});

async function loadSession(c, id, lock = false) {
  const s = (await c.query(`SELECT * FROM room_sessions WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id])).rows[0];
  if (!s) throw notFound('ไม่พบรายการเปิดห้อง');
  return s;
}

function packageUsable(pkg, roomTypeId, startAt) {
  if (!pkg.is_active) return 'แพ็กเกจปิดใช้งาน';
  if (pkg.room_type_ids?.length && !pkg.room_type_ids.includes(Number(roomTypeId))) return 'แพ็กเกจนี้ใช้ไม่ได้กับ Type ห้องนี้';
  const d = new Date(new Date(startAt).getTime() + 7 * 3600000);
  if (pkg.available_days?.length && !pkg.available_days.includes(d.getUTCDay())) return 'แพ็กเกจนี้ใช้ไม่ได้ในวันนี้';
  const dateStr = d.toISOString().slice(0, 10);
  if ((pkg.blackout_dates || []).map(String).includes(dateStr)) return 'แพ็กเกจนี้ใช้ไม่ได้ในวันหยุดที่กำหนด';
  if (pkg.available_from && pkg.available_to) {
    const m = d.getUTCHours() * 60 + d.getUTCMinutes();
    const [fh, fm] = String(pkg.available_from).split(':').map(Number);
    const [th, tm] = String(pkg.available_to).split(':').map(Number);
    const f = fh * 60 + fm;
    const t = th * 60 + tm;
    const ok = f <= t ? m >= f && m < t : m >= f || m < t;
    if (!ok) return `แพ็กเกจนี้ใช้ได้ช่วงเวลา ${String(pkg.available_from).slice(0, 5)}–${String(pkg.available_to).slice(0, 5)}`;
  }
  return null;
}

const openSchema = z.object({
  roomId: z.coerce.number().int(),
  reservationId: z.coerce.number().int().optional().nullable(),
  memberId: z.coerce.number().int().optional().nullable(),
  customerName: z.string().max(200).optional().nullable(),
  phone: z.string().max(20).optional().nullable(),
  guestCount: z.coerce.number().int().min(1).max(500),
  extraMics: z.coerce.number().int().min(0).max(20).default(0),
  packageId: z.coerce.number().int().optional().nullable(),
  minutes: z.coerce.number().int().min(0).max(24 * 60).default(0),
  startMode: z.enum(['NOW', 'SCHEDULED']).default('NOW'),
  startAt: z.string().optional().nullable(),
  deposit: z
    .object({ amount: z.coerce.number().min(0), method: z.enum(['CASH', 'QR', 'TRANSFER', 'CARD', 'OTHER']), reference: z.string().optional().nullable(), slipUrl: z.string().optional().nullable(), verificationToken: z.string().optional().nullable() })
    .optional()
    .nullable(),
  items: z.array(z.object({ productId: z.coerce.number().int(), qty: z.coerce.number().positive().default(1), note: z.string().optional().nullable(), options: z.array(z.any()).default([]) })).default([]),
  note: z.string().max(500).optional().nullable(),
  clientOpId: z.string().max(100).optional().nullable(),
});

export async function openSession(c, req, b, settings) {
  if (b.clientOpId) {
    const ex = (await c.query('SELECT * FROM room_sessions WHERE client_op_id = $1', [b.clientOpId])).rows[0];
    if (ex) return ex;
  }
  const room = await lockRoom(c, b.roomId);
  if (!room) throw notFound('ไม่พบห้อง');
  if (!room.is_active || ['MAINTENANCE', 'DISABLED'].includes(room.status)) throw conflict('ห้องนี้ปิดใช้งาน/ปิดปรับปรุง');
  if (room.status === 'CLEANING') throw conflict('ห้องนี้ยังรอทำความสะอาด กรุณากด "ห้องพร้อมใช้งาน" ก่อน');
  const active = (await c.query('SELECT id FROM room_sessions WHERE room_id = $1 AND status = ANY($2)', [room.id, ACTIVE])).rows[0];
  if (active) throw conflict('ห้องนี้ถูกเปิดใช้งานแล้วจากเครื่องอื่น', 'ROOM_IN_USE');

  const now = new Date();
  const start = b.startMode === 'SCHEDULED' && b.startAt ? new Date(b.startAt) : now;
  if (Number.isNaN(start.getTime())) throw badRequest('เวลาเริ่มไม่ถูกต้อง');
  let pkg = null;
  if (b.packageId) {
    pkg = (await c.query('SELECT * FROM room_packages WHERE id = $1 AND deleted_at IS NULL', [b.packageId])).rows[0];
    if (!pkg) throw notFound('ไม่พบแพ็กเกจ');
    const err = packageUsable(pkg, room.room_type_id, start);
    if (err) throw badRequest(err);
  }
  const pkgMinutes = pkg ? pkg.hours * 60 + pkg.minutes : 0;
  const total = pkgMinutes + b.minutes;
  if (total <= 0) throw badRequest('กรุณาเลือกแพ็กเกจหรือจำนวนเวลา');
  const end = new Date(start.getTime() + total * 60000);

  let reservation = null;
  if (b.reservationId) {
    reservation = (await c.query('SELECT * FROM reservations WHERE id = $1 FOR UPDATE', [b.reservationId])).rows[0];
    if (!reservation) throw notFound('ไม่พบการจอง');
    if (!['PENDING', 'CONFIRMED', 'DEPOSIT_PAID', 'WAITING', 'ARRIVED'].includes(reservation.status)) throw conflict('การจองนี้ไม่อยู่ในสถานะที่เปิดห้องได้');
    if (reservation.room_id !== room.id) throw conflict('ห้องไม่ตรงกับการจอง กรุณาย้ายห้องในการจองก่อน');
  }
  // walk-in must not collide with upcoming reservations (own reservation excluded)
  await assertRoomFree(c, room.id, start, end, { excludeReservationId: reservation?.id || null });

  const startStatus = start.getTime() > now.getTime() + 60000 ? 'SCHEDULED' : 'ACTIVE';
  // pay before entering (store default): the room is held but the clock does not run until the room charge is paid
  const paymentModeSetting = settings.room.paymentMode === 'POSTPAY' ? 'POSTPAY' : 'PREPAY';
  const status = paymentModeSetting === 'PREPAY' ? 'PENDING_PAYMENT' : startStatus;
  const session = (
    await c.query(
      `INSERT INTO room_sessions(session_no, room_id, room_type_id, reservation_id, member_id, customer_name, phone, guest_count, room_capacity,
         package_id, package_name, package_minutes, package_price, booked_minutes, price_hour, price_half, extra_guest_fee, started_at, scheduled_end_at,
         status, opened_by, client_op_id, extra_mics, mic_fee, order_token, payment_mode)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26) RETURNING *`,
      [await nextSessionNo(c), room.id, room.room_type_id, reservation?.id || null, b.memberId || reservation?.member_id || null, b.customerName || reservation?.customer_name || null, b.phone || reservation?.phone || null, b.guestCount, room.capacity, pkg?.id || null, pkg?.name || null, pkgMinutes, pkg ? Number(pkg.price) : 0, b.minutes, room.price_hour, room.price_half, settings.room.extraGuestFee, start, end, status, req.employee.id, b.clientOpId || null, b.extraMics || 0, Number(settings.room.extraMicFee || 0), randomToken(24), paymentModeSetting],
    )
  ).rows[0];
  const order = await createOrder(c, { sessionId: session.id, reservationId: reservation?.id || null, memberId: session.member_id, customerName: session.customer_name, phone: session.phone, employeeId: req.employee.id, deviceId: req.deviceId, shiftId: req.shiftId || null, branchId: room.branch_id });
  await c.query('UPDATE room_sessions SET order_id = $2 WHERE id = $1', [session.id, order.id]);
  session.order_id = order.id;

  if (reservation) {
    await c.query(`UPDATE reservations SET status = 'IN_USE', session_id = $2, checked_in_at = COALESCE(checked_in_at, now()), updated_at = now() WHERE id = $1`, [reservation.id, session.id]);
  }
  if (b.deposit && b.deposit.amount > 0) {
    if (!req.shiftId) throw conflict('กรุณาเปิดรอบการขายก่อนรับเงินมัดจำ', 'NO_SHIFT');
    if (['QR', 'TRANSFER'].includes(b.deposit.method)) {
      const v = b.deposit.verificationToken ? verifyToken(b.deposit.verificationToken) : null;
      if (!v || v.typ !== 'slip') throw badRequest('กรุณาตรวจสอบสลิปมัดจำก่อน', 'SLIP_NOT_VERIFIED');
    }
    await c.query(
      `INSERT INTO deposits(deposit_no, session_id, reservation_id, member_id, customer_name, phone, amount, method, slip_url, verification_status, status, received_by, shift_id, note, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'VERIFIED','RECEIVED',$10,$11,$12,$13)`,
      [await nextDepositNo(c), session.id, reservation?.id || null, session.member_id, session.customer_name, session.phone, b.deposit.amount, b.deposit.method, b.deposit.slipUrl || null, req.employee.id, req.shiftId, b.deposit.reference || 'มัดจำเปิดห้อง', b.clientOpId ? `open-dep:${b.clientOpId}` : null],
    );
  }
  for (const it of b.items || []) await addProductItem(c, order, { ...it, employeeId: req.employee.id });
  await c.query(`INSERT INTO room_time_adjustments(session_id, type, minutes, after, employee_id, reason) VALUES ($1,'OPEN',$2,$3,$4,$5)`, [session.id, total, { started_at: start, scheduled_end_at: end, package: pkg?.name }, req.employee.id, b.note]);
  await logActivity(c, req, 'ROOM_OPEN', 'room_session', session.id, { room: room.name, guests: b.guestCount, mics: b.extraMics || 0, minutes: total, package: pkg?.name, reservationId: reservation?.id, deposit: b.deposit?.amount || 0, paymentMode: paymentModeSetting });
  if (session.status === 'PENDING_PAYMENT') {
    const due = await prepayDue(c, session, settings);
    // nothing left to pay (e.g. the booking deposit already covers the room) → the room starts right away
    if (due.amount <= 0) return startPrepaidSession(c, req, session, settings, { amount: 0, key: null });
    return { ...session, prepay: due };
  }
  return session;
}

/** Amount to collect before the room starts (prepay mode): the bill so far (booked room time, extra guests / mics, items) less money already held. */
export async function prepayDue(c, session, settings) {
  const bundle = await computeOrder(c, session.order_id, settings);
  return {
    amount: round2(Math.max(0, bundle.calc.netTotal)),
    grandTotal: bundle.calc.grandTotal,
    held: bundle.calc.depositApplied,
    lines: bundle.calc.lines.map((l) => ({ type: l.type, name: l.name, qty: l.qty, unitPrice: l.unitPrice, gross: l.gross })),
    calc: bundle.calc,
  };
}

/** Prepaid → the clock starts now (or at the scheduled start), the end time is recomputed from the real start. */
async function startPrepaidSession(c, req, s, settings, { amount, key }) {
  const now = new Date();
  const booked = new Date(s.started_at);
  const total = Number(s.package_minutes) + Number(s.booked_minutes) + Number(s.extension_minutes) + Number(s.bonus_minutes || 0);
  const start = booked.getTime() > now.getTime() + 60000 ? booked : now;
  const end = new Date(start.getTime() + total * 60000);
  const status = start === booked ? 'SCHEDULED' : 'ACTIVE';
  const u = (
    await c.query(
      `UPDATE room_sessions SET status = $2, started_at = $3, scheduled_end_at = $4, prepaid_amount = prepaid_amount + $5, prepaid_at = now(), prepay_key = COALESCE($6, prepay_key),
         version = version + 1, updated_at = now() WHERE id = $1 RETURNING *`,
      [s.id, status, start, end, amount, key],
    )
  ).rows[0];
  if (s.reservation_id) await c.query('UPDATE reservations SET end_at = GREATEST(end_at, $2), updated_at = now() WHERE id = $1', [s.reservation_id, end]);
  await c.query(`INSERT INTO room_time_adjustments(session_id, type, minutes, before, after, employee_id, reason) VALUES ($1,'PREPAID_START',$2,$3,$4,$5,$6)`, [
    s.id, total, { started_at: s.started_at, scheduled_end_at: s.scheduled_end_at }, { started_at: start, scheduled_end_at: end, prepaid: amount }, req.employee.id, 'ชำระค่าห้องครบแล้ว เริ่มเวลา',
  ]);
  return u;
}

r.post('/sessions/open', can('room.operate'), attachShift, async (req, res) => {
  const b = parse(openSchema, req.body);
  const settings = await getSettings();
  const session = await tx((c) => openSession(c, req, b, settings));
  await refreshRoomStatuses(settings);
  emitSync(['rooms', 'orders', 'reservations']);
  res.json(session);
});

const tenderSchema = z.object({
  method: z.enum(['CASH', 'QR', 'TRANSFER', 'CARD', 'OTHER']),
  amount: z.coerce.number().positive(),
  received: z.coerce.number().min(0).optional().nullable(),
  reference: z.string().max(200).optional().nullable(),
  verificationToken: z.string().optional().nullable(),
  slipUrl: z.string().max(500).optional().nullable(),
});

/** Prepay mode: collect the room charge, then start the clock. Idempotent — a double click / retry never charges twice. */
r.post('/sessions/:id/prepay', can('room.operate'), requireShift, idempotent('prepay'), async (req, res) => {
  const b = parse(z.object({ payments: z.array(tenderSchema).min(1) }), req.body);
  const settings = await getSettings();
  const out = await tx(async (c) => {
    const s = await loadSession(c, req.params.id, true);
    if (s.prepay_key && s.prepay_key === req.idempotencyKey) return { session: s, replay: true };
    if (s.status !== 'PENDING_PAYMENT') throw conflict('ห้องนี้ชำระค่าห้องแล้ว หรือไม่ได้อยู่ในสถานะรอชำระค่าห้อง', 'NOT_PENDING_PAYMENT');
    const due = await prepayDue(c, s, settings);
    const tenders = b.payments.map((t) => ({ ...t, amount: round2(t.amount), received: t.received != null ? round2(t.received) : null }));
    for (const t of tenders) {
      if (settings.payment.methods?.[t.method] === false) throw badRequest(`ช่องทาง ${t.method} ถูกปิดใช้งาน`);
      if (['QR', 'TRANSFER'].includes(t.method)) {
        const v = t.verificationToken ? verifyToken(t.verificationToken) : null;
        if (!v || v.typ !== 'slip' || Number(v.orderId) !== Number(s.order_id) || round2(v.amount) < t.amount) throw badRequest('กรุณาตรวจสอบสลิปก่อนยืนยันการชำระเงิน', 'SLIP_NOT_VERIFIED');
        if (v.mode === 'DEMO' && (await paymentMode()) === 'PRODUCTION') throw badRequest('Production Mode ต้องตรวจสลิปจากผู้ให้บริการจริงหรือพนักงานยืนยัน');
        t.reference = t.reference || v.ref;
      }
      if (t.method === 'CASH' && t.received != null && t.received + 0.001 < t.amount) throw badRequest('เงินสดที่รับน้อยกว่ายอดชำระ');
    }
    const sum = round2(tenders.reduce((a, t) => a + t.amount, 0));
    // the whole room charge must be paid before the room starts (no partial prepay, no overpay except cash change)
    if (Math.abs(sum - due.amount) > 0.009) throw badRequest(`ยอดชำระค่าห้องต้องเท่ากับ ${due.amount} บาท (ส่งมา ${sum} บาท)`, 'PREPAY_AMOUNT_MISMATCH', { due: due.amount });
    let i = 0;
    const deposits = [];
    for (const t of tenders) {
      const change = t.method === 'CASH' && t.received != null ? round2(t.received - t.amount) : 0;
      deposits.push(
        (
          await c.query(
            `INSERT INTO deposits(deposit_no, session_id, reservation_id, member_id, customer_name, phone, amount, method, slip_url, verification_status, status, received_by, shift_id, source, note, reference, cash_received, change_amount, idempotency_key)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'VERIFIED','RECEIVED',$10,$11,'PREPAY','ชำระค่าห้องล่วงหน้า',$12,$13,$14,$15) RETURNING *`,
            [await nextDepositNo(c), s.id, s.reservation_id, s.member_id, s.customer_name, s.phone, t.amount, t.method, t.slipUrl || null, req.employee.id, req.shiftId, t.reference || null, t.method === 'CASH' ? t.received ?? t.amount : null, change, `prepay:${s.id}:${req.idempotencyKey}:${i++}`],
          )
        ).rows[0],
      );
    }
    const session = await startPrepaidSession(c, req, s, settings, { amount: sum, key: req.idempotencyKey });
    await logActivity(c, req, 'ROOM_PREPAY', 'room_session', s.id, { amount: sum, payments: tenders.map((t) => ({ method: t.method, amount: t.amount, reference: t.reference || null })) });
    return { session, deposits, change: round2(deposits.reduce((a, d) => a + Number(d.change_amount || 0), 0)) };
  });
  await refreshRoomStatuses(settings);
  emitSync(['rooms', 'orders', 'reservations', 'deposits']);
  res.json(out);
});

/** Prepay mode: give up before paying → the held room is released (nothing was charged, the empty bill is voided). */
r.post('/sessions/:id/cancel-pending', can('room.operate'), async (req, res) => {
  const { reason } = parse(z.object({ reason: z.string().max(300).default('ยกเลิกก่อนชำระค่าห้อง') }), req.body || {});
  const settings = await getSettings();
  await tx(async (c) => {
    const s = await loadSession(c, req.params.id, true);
    if (s.status !== 'PENDING_PAYMENT') throw conflict('ยกเลิกได้เฉพาะห้องที่ยังรอชำระค่าห้อง');
    await c.query(`UPDATE room_sessions SET status = 'CANCELLED', ended_at = now(), cancel_reason = $2, updated_at = now() WHERE id = $1`, [s.id, reason]);
    if (s.order_id) await c.query(`UPDATE orders SET status = 'VOID', voided_at = now(), voided_by = $2, void_reason = $3 WHERE id = $1 AND status = 'OPEN'`, [s.order_id, req.employee.id, reason]);
    if (s.reservation_id) await c.query(`UPDATE reservations SET status = 'ARRIVED', session_id = NULL, updated_at = now() WHERE id = $1`, [s.reservation_id]);
    await c.query(`INSERT INTO room_time_adjustments(session_id, type, reason, employee_id) VALUES ($1,'CANCEL',$2,$3)`, [s.id, reason, req.employee.id]);
    await logActivity(c, req, 'ROOM_CANCEL_PENDING', 'room_session', s.id, { reason });
  });
  await refreshRoomStatuses(settings);
  emitSync(['rooms', 'orders', 'reservations']);
  res.json({ ok: true });
});

/** Amount still owed on the room bill (room + extensions + items + other charges − everything already paid). */
async function outstandingOf(c, s, settings, nowMs = Date.now()) {
  const bundle = await computeOrder(c, s.order_id, settings, { nowMs });
  const calc = bundle.calc;
  const prepaid = round2(bundle.deposits.filter((d) => d.source === 'PREPAY').reduce((a, d) => a + Number(d.amount) - Number(d.refunded_amount), 0));
  const otherHeld = round2(bundle.deposits.filter((d) => d.source !== 'PREPAY').reduce((a, d) => a + Number(d.amount) - Number(d.refunded_amount), 0));
  const room = (await c.query('SELECT r.name, r.number, rt.name AS type_name FROM rooms r JOIN room_types rt ON rt.id = r.room_type_id WHERE r.id = $1', [s.room_id])).rows[0];
  return {
    session: { id: s.id, status: s.status, sessionNo: s.session_no, paymentMode: s.payment_mode },
    orderId: s.order_id,
    room: { name: room?.name, number: room?.number, type: room?.type_name },
    lines: calc.lines.filter((l) => !l.voided).map((l) => ({ type: l.type, name: l.name, qty: l.qty, unitPrice: l.unitPrice, gross: l.gross, discount: l.discount, net: l.net })),
    discounts: calc.discounts,
    totals: { grossTotal: calc.grossTotal, lineDiscountTotal: calc.lineDiscountTotal, discountTotal: calc.discountTotal, serviceCharge: calc.serviceCharge, vat: calc.vat, rounding: calc.rounding, grandTotal: calc.grandTotal },
    tax: calc.tax,
    paid: { prepaid, deposits: otherHeld, applied: calc.depositApplied },
    outstanding: round2(Math.max(0, calc.netTotal)),
    refundable: calc.depositRefundable || 0,
    pendingPrepayments: bundle.pendingPrepayments || [],
  };
}

r.get('/sessions/:id/outstanding', async (req, res) => {
  const settings = await getSettings();
  const s = await loadSession(pool, req.params.id);
  if (!s.order_id) throw notFound('ไม่พบบิลของห้องนี้');
  res.json(await outstandingOf(pool, s, settings));
});

/**
 * "ปิดห้อง": the server re-checks what is still owed. Something due → 409 with the full breakdown (nothing changes, the room stays as it is).
 * Nothing due → the clock stops, the bill is closed with the receipt, the room goes to cleaning. Idempotent.
 */
r.post('/sessions/:id/checkout', can('room.operate'), requireShift, idempotent('checkout'), async (req, res) => {
  const settings = await getSettings();
  const out = await tx(async (c) => {
    const s = await loadSession(c, req.params.id, true);
    if (s.status === 'PAID') {
      const rc = (await c.query('SELECT * FROM receipts WHERE order_id = $1', [s.order_id])).rows[0];
      return { receipt: rc, alreadyPaid: true };
    }
    if (s.status === 'PENDING_PAYMENT') throw conflict('ห้องนี้ยังไม่ได้ชำระค่าห้อง', 'NOT_PREPAID');
    if (!['ACTIVE', 'PAUSED', 'CLOSED', 'SCHEDULED'].includes(s.status)) throw conflict('ไม่สามารถปิดห้องได้');
    const nowMs = Date.now();
    const o = await outstandingOf(c, s, settings, nowMs);
    if (o.pendingPrepayments.length) throw conflict('มีการชำระเงินจากในห้องที่ยังไม่ได้ตรวจสลิป กรุณาตรวจสอบก่อนปิดห้อง', 'PENDING_PREPAYMENT', o);
    if (o.outstanding > 0) throw conflict('ห้องนี้มียอดค้างชำระ กรุณาเก็บเงินลูกค้าเพิ่มเติมก่อนปิดห้อง', 'OUTSTANDING_BALANCE', o);
    const paid = await payOrder(c, req, settings, s.order_id, { payments: [], idempotencyKey: `checkout:${req.idempotencyKey}` });
    await logActivity(c, req, 'ROOM_CHECKOUT', 'room_session', s.id, { receiptNo: paid.receipt.receipt_no, outstanding: 0 });
    return { receipt: paid.receipt, change: 0 };
  });
  await refreshRoomStatuses(settings);
  emitSync(['orders', 'rooms', 'reservations', 'members', 'dashboard', 'products', 'deposits']);
  res.json(out);
});

r.get('/sessions/:id', async (req, res) => {
  const settings = await getSettings();
  const s = await one(`${SESSION_SELECT} WHERE rs.id = $1`, [req.params.id]);
  if (!s) throw notFound();
  const charges = sessionCharges(s, settings);
  const order = s.order_id ? await computeOrder(pool, s.order_id, settings) : null;
  const adjustments = await many(`SELECT a.*, e.name AS employee_name FROM room_time_adjustments a LEFT JOIN employees e ON e.id = a.employee_id WHERE a.session_id = $1 ORDER BY a.id DESC`, [s.id]);
  res.json({ now: Date.now(), session: s, charges, order, adjustments });
});

async function afterChange(settings) {
  await refreshRoomStatuses(settings);
  emitSync(['rooms', 'orders', 'reservations']);
}

/** Recompute which alert thresholds already passed (so extending time does not re-fire stale alerts). */
function alertsAfter(session, settings) {
  const t = sessionTiming(session);
  const remainingMin = t.remainingMs / 60000;
  return (settings.room.alertMinutes || []).filter((m) => remainingMin <= m).map(String).concat(remainingMin <= 0 ? ['END'] : []);
}

r.post('/sessions/:id/extend', can('room.operate'), async (req, res) => {
  const { minutes, reason, free } = parse(z.object({ minutes: z.coerce.number().int().min(1).max(24 * 60), reason: z.string().trim().max(300).optional(), free: z.boolean().optional() }), req.body);
  // free minutes (no charge) always need a reason — they are recorded in the history and the Activity Log
  if (free && !reason) throw badRequest('กรุณาระบุเหตุผลของการเพิ่มเวลาโดยไม่คิดค่าบริการ');
  const settings = await getSettings();
  const out = await tx(async (c) => {
    const s = await loadSession(c, req.params.id, true);
    if (!['ACTIVE', 'PAUSED', 'SCHEDULED', 'CLOSED'].includes(s.status)) throw conflict('ไม่สามารถเพิ่มเวลาได้');
    await lockRoom(c, s.room_id);
    const oldEnd = new Date(s.scheduled_end_at);
    const newEnd = new Date(oldEnd.getTime() + minutes * 60000);
    const from = new Date(Math.max(oldEnd.getTime(), Date.now()));
    if (newEnd > from) await assertRoomFree(c, s.room_id, from, newEnd, { excludeSessionId: s.id, excludeReservationId: s.reservation_id });
    const reopened = s.status === 'CLOSED';
    const updated = (
      await c.query(
        `UPDATE room_sessions SET ${free ? 'bonus_minutes = bonus_minutes' : 'extension_minutes = extension_minutes'} + $2, scheduled_end_at = $3, status = CASE WHEN status = 'CLOSED' THEN 'ACTIVE' ELSE status END,
           ended_at = CASE WHEN status = 'CLOSED' THEN NULL ELSE ended_at END, version = version + 1, updated_at = now() WHERE id = $1 RETURNING *`,
        [s.id, minutes, newEnd],
      )
    ).rows[0];
    await c.query('UPDATE room_sessions SET alerts_sent = $2 WHERE id = $1', [s.id, JSON.stringify(alertsAfter(updated, settings))]);
    if (s.reservation_id) await c.query('UPDATE reservations SET end_at = GREATEST(end_at, $2), updated_at = now() WHERE id = $1', [s.reservation_id, newEnd]);
    await c.query(`INSERT INTO room_time_adjustments(session_id, type, minutes, before, after, reason, employee_id) VALUES ($1,'EXTEND',$2,$3,$4,$5,$6)`, [s.id, minutes, { scheduled_end_at: oldEnd }, { scheduled_end_at: newEnd, reopened, free: !!free }, reason || null, req.employee.id]);
    await logActivity(c, req, free ? 'ROOM_EXTEND_FREE' : 'ROOM_EXTEND', 'room_session', s.id, { minutes, from: oldEnd, to: newEnd, free: !!free, reason: reason || null });
    return updated;
  });
  await afterChange(settings);
  res.json(out);
});

r.post('/sessions/:id/pause', can('room.pause'), async (req, res) => {
  const settings = await getSettings();
  const out = await tx(async (c) => {
    const s = await loadSession(c, req.params.id, true);
    if (s.status !== 'ACTIVE') throw conflict('ห้องนี้ไม่ได้อยู่ในสถานะกำลังใช้งาน');
    const u = (await c.query(`UPDATE room_sessions SET status = 'PAUSED', paused_at = now(), version = version + 1, updated_at = now() WHERE id = $1 RETURNING *`, [s.id])).rows[0];
    await c.query(`INSERT INTO room_time_adjustments(session_id, type, employee_id, reason, before) VALUES ($1,'PAUSE',$2,$3,$4)`, [s.id, req.employee.id, req.body?.reason || null, { scheduled_end_at: s.scheduled_end_at }]);
    await logActivity(c, req, 'ROOM_PAUSE', 'room_session', s.id, { reason: req.body?.reason });
    return u;
  });
  await afterChange(settings);
  res.json(out);
});

r.post('/sessions/:id/resume', can('room.pause'), async (req, res) => {
  const settings = await getSettings();
  const out = await tx(async (c) => {
    const s = await loadSession(c, req.params.id, true);
    if (s.status !== 'PAUSED') throw conflict('ห้องนี้ไม่ได้หยุดเวลาอยู่');
    await lockRoom(c, s.room_id);
    const pausedSec = Math.floor((Date.now() - new Date(s.paused_at).getTime()) / 1000);
    const newEnd = new Date(new Date(s.scheduled_end_at).getTime() + pausedSec * 1000);
    await assertRoomFree(c, s.room_id, new Date(), newEnd, { excludeSessionId: s.id, excludeReservationId: s.reservation_id }).catch(async (e) => {
      // resume anyway but warn the staff about the upcoming reservation
      await notify({ type: 'ROOM_CONFLICT', level: 'warning', title: 'เวลาห้องทับซ้อนการจอง', message: e.message, roomId: s.room_id }, c);
    });
    const u = (
      await c.query(
        `UPDATE room_sessions SET status = 'ACTIVE', paused_at = NULL, total_paused_seconds = total_paused_seconds + $2, scheduled_end_at = $3, version = version + 1, updated_at = now() WHERE id = $1 RETURNING *`,
        [s.id, pausedSec, newEnd],
      )
    ).rows[0];
    await c.query(`INSERT INTO room_time_adjustments(session_id, type, minutes, before, after, employee_id) VALUES ($1,'RESUME',$2,$3,$4,$5)`, [s.id, Math.round(pausedSec / 60), { scheduled_end_at: s.scheduled_end_at }, { scheduled_end_at: newEnd, paused_seconds: pausedSec }, req.employee.id]);
    await logActivity(c, req, 'ROOM_RESUME', 'room_session', s.id, { pausedSeconds: pausedSec });
    return u;
  });
  await afterChange(settings);
  res.json(out);
});

/** Manual time edit (requires room.time_edit) — always recorded in room_time_adjustments + Activity Log. */
r.post('/sessions/:id/adjust', can('room.time_edit'), async (req, res) => {
  const b = parse(z.object({ startedAt: z.string().optional(), scheduledEndAt: z.string().optional(), reason: z.string().min(1, 'กรุณาระบุเหตุผล').max(300) }), req.body);
  const settings = await getSettings();
  const out = await tx(async (c) => {
    const s = await loadSession(c, req.params.id, true);
    if (!['ACTIVE', 'PAUSED', 'SCHEDULED', 'CLOSED'].includes(s.status)) throw conflict('ไม่สามารถแก้ไขเวลาได้');
    await lockRoom(c, s.room_id);
    let start = new Date(s.started_at);
    let end = new Date(s.scheduled_end_at);
    let booked = Number(s.booked_minutes);
    if (b.startedAt) {
      const ns = new Date(b.startedAt);
      const delta = ns - start;
      start = ns;
      end = new Date(end.getTime() + delta);
    }
    if (b.scheduledEndAt) {
      const ne = new Date(b.scheduledEndAt);
      const diffMin = Math.round((ne - end) / 60000);
      booked = Math.max(0, booked + diffMin);
      end = ne;
    }
    if (end <= start) throw badRequest('เวลาสิ้นสุดต้องมากกว่าเวลาเริ่ม');
    await assertRoomFree(c, s.room_id, start, end, { excludeSessionId: s.id, excludeReservationId: s.reservation_id });
    const u = (await c.query(`UPDATE room_sessions SET started_at = $2, scheduled_end_at = $3, booked_minutes = $4, version = version + 1, updated_at = now() WHERE id = $1 RETURNING *`, [s.id, start, end, booked])).rows[0];
    await c.query('UPDATE room_sessions SET alerts_sent = $2 WHERE id = $1', [s.id, JSON.stringify(alertsAfter(u, settings))]);
    await c.query(`INSERT INTO room_time_adjustments(session_id, type, before, after, reason, employee_id) VALUES ($1,'EDIT',$2,$3,$4,$5)`, [s.id, { started_at: s.started_at, scheduled_end_at: s.scheduled_end_at, booked_minutes: s.booked_minutes }, { started_at: start, scheduled_end_at: end, booked_minutes: booked }, b.reason, req.employee.id]);
    await logActivity(c, req, 'ROOM_TIME_EDIT', 'room_session', s.id, { before: { started_at: s.started_at, scheduled_end_at: s.scheduled_end_at }, after: { started_at: start, scheduled_end_at: end }, reason: b.reason });
    return u;
  });
  await afterChange(settings);
  res.json(out);
});

r.post('/sessions/:id/move', can('room.move'), async (req, res) => {
  const b = parse(z.object({ toRoomId: z.coerce.number().int(), reprice: z.boolean().default(true), reason: z.string().max(300).optional() }), req.body);
  const settings = await getSettings();
  const out = await tx(async (c) => {
    const s = await loadSession(c, req.params.id, true);
    if (!['ACTIVE', 'PAUSED', 'SCHEDULED'].includes(s.status)) throw conflict('ไม่สามารถย้ายห้องได้');
    if (s.room_id === b.toRoomId) throw badRequest('เลือกห้องเดิม');
    const [a, z2] = [s.room_id, b.toRoomId].sort((x, y) => x - y);
    await lockRoom(c, a);
    await lockRoom(c, z2);
    const from = (await c.query('SELECT * FROM rooms WHERE id = $1', [s.room_id])).rows[0];
    const to = (await c.query('SELECT * FROM rooms WHERE id = $1 AND deleted_at IS NULL', [b.toRoomId])).rows[0];
    if (!to || !to.is_active || ['MAINTENANCE', 'DISABLED', 'CLEANING'].includes(to.status)) throw conflict('ห้องปลายทางไม่พร้อมใช้งาน');
    const busy = (await c.query('SELECT id FROM room_sessions WHERE room_id = $1 AND status = ANY($2)', [to.id, ACTIVE])).rows[0];
    if (busy) throw conflict('ห้องปลายทางมีลูกค้าใช้งานอยู่');
    const t = sessionTiming(s);
    await assertRoomFree(c, to.id, new Date(), new Date(t.endMs), { excludeReservationId: s.reservation_id });
    const u = (
      await c.query(
        `UPDATE room_sessions SET room_id = $2, room_type_id = CASE WHEN $3 THEN $4 ELSE room_type_id END, room_capacity = $5,
           price_hour = CASE WHEN $3 THEN $6 ELSE price_hour END, price_half = CASE WHEN $3 THEN $7 ELSE price_half END, version = version + 1, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [s.id, to.id, b.reprice, to.room_type_id, to.capacity, to.price_hour, to.price_half],
      )
    ).rows[0];
    await c.query(`UPDATE rooms SET status = 'CLEANING', updated_at = now() WHERE id = $1`, [from.id]);
    if (s.reservation_id) {
      await c.query('UPDATE reservations SET room_id = $2, room_type_id = $3, updated_at = now() WHERE id = $1', [s.reservation_id, to.id, to.room_type_id]);
      const resv = (await c.query('SELECT r.*, rm.name AS room_name FROM reservations r JOIN rooms rm ON rm.id = r.room_id WHERE r.id = $1', [s.reservation_id])).rows[0];
      if (resv?.member_id) await queueLineMessage({ memberId: resv.member_id, type: 'ROOM_CHANGED', title: 'เปลี่ยนห้อง', message: bookingMessage('ROOM_CHANGED', resv), reservationId: resv.id }, c);
    }
    await c.query(`INSERT INTO room_time_adjustments(session_id, type, before, after, reason, employee_id) VALUES ($1,'MOVE',$2,$3,$4,$5)`, [s.id, { room: from.name, price_hour: s.price_hour }, { room: to.name, price_hour: u.price_hour }, b.reason, req.employee.id]);
    await logActivity(c, req, 'ROOM_MOVE', 'room_session', s.id, { from: from.name, to: to.name, reprice: b.reprice, reason: b.reason });
    return u;
  });
  await afterChange(settings);
  res.json(out);
});

r.post('/sessions/:id/change-type', can('room.move'), async (req, res) => {
  const b = parse(z.object({ roomTypeId: z.coerce.number().int(), reason: z.string().max(300).optional() }), req.body);
  const settings = await getSettings();
  const out = await tx(async (c) => {
    const s = await loadSession(c, req.params.id, true);
    if (!['ACTIVE', 'PAUSED', 'SCHEDULED', 'CLOSED'].includes(s.status)) throw conflict('ไม่สามารถเปลี่ยน Type ห้องได้');
    const t = (await c.query('SELECT * FROM room_types WHERE id = $1 AND deleted_at IS NULL', [b.roomTypeId])).rows[0];
    if (!t) throw notFound('ไม่พบ Type ห้อง');
    const u = (await c.query(`UPDATE room_sessions SET room_type_id = $2, price_hour = $3, price_half = $4, version = version + 1, updated_at = now() WHERE id = $1 RETURNING *`, [s.id, t.id, t.price_hour, t.price_half])).rows[0];
    await c.query(`INSERT INTO room_time_adjustments(session_id, type, before, after, reason, employee_id) VALUES ($1,'CHANGE_TYPE',$2,$3,$4,$5)`, [s.id, { room_type_id: s.room_type_id, price_hour: s.price_hour }, { room_type_id: t.id, price_hour: t.price_hour }, b.reason, req.employee.id]);
    await logActivity(c, req, 'ROOM_CHANGE_TYPE', 'room_session', s.id, { to: t.name, priceHour: t.price_hour, reason: b.reason });
    return u;
  });
  await afterChange(settings);
  res.json(out);
});

r.post('/sessions/:id/guests', can('room.operate'), async (req, res) => {
  const { guestCount } = parse(z.object({ guestCount: z.coerce.number().int().min(1).max(500) }), req.body);
  const settings = await getSettings();
  const out = await tx(async (c) => {
    const s = await loadSession(c, req.params.id, true);
    if (!ACTIVE.includes(s.status)) throw conflict('ไม่สามารถแก้ไขได้');
    const u = (await c.query('UPDATE room_sessions SET guest_count = $2, updated_at = now() WHERE id = $1 RETURNING *', [s.id, guestCount])).rows[0];
    await logActivity(c, req, 'ROOM_GUESTS_UPDATE', 'room_session', s.id, { from: s.guest_count, to: guestCount });
    return u;
  });
  await afterChange(settings);
  res.json(out);
});

r.post('/sessions/:id/mics', can('room.operate'), async (req, res) => {
  const { extraMics } = parse(z.object({ extraMics: z.coerce.number().int().min(0).max(20) }), req.body);
  const settings = await getSettings();
  const out = await tx(async (c) => {
    const s = await loadSession(c, req.params.id, true);
    if (!ACTIVE.includes(s.status)) throw conflict('ไม่สามารถแก้ไขได้');
    const fee = Number(s.mic_fee) > 0 ? Number(s.mic_fee) : Number(settings.room.extraMicFee || 0);
    const u = (await c.query('UPDATE room_sessions SET extra_mics = $2, mic_fee = $3, version = version + 1, updated_at = now() WHERE id = $1 RETURNING *', [s.id, extraMics, fee])).rows[0];
    await logActivity(c, req, 'ROOM_MICS_UPDATE', 'room_session', s.id, { from: s.extra_mics, to: extraMics, fee });
    return u;
  });
  await afterChange(settings);
  res.json(out);
});

r.post('/sessions/:id/customer', can('room.operate'), async (req, res) => {
  const b = parse(z.object({ memberId: z.coerce.number().int().optional().nullable(), customerName: z.string().max(200).optional().nullable(), phone: z.string().max(20).optional().nullable() }), req.body);
  const settings = await getSettings();
  await tx(async (c) => {
    const s = await loadSession(c, req.params.id, true);
    await c.query('UPDATE room_sessions SET member_id = $2, customer_name = $3, phone = $4, updated_at = now() WHERE id = $1', [s.id, b.memberId || null, b.customerName, b.phone]);
    if (s.order_id) await c.query(`UPDATE orders SET member_id = $2, customer_name = $3, phone = $4 WHERE id = $1 AND status = 'OPEN'`, [s.order_id, b.memberId || null, b.customerName, b.phone]);
    await logActivity(c, req, 'ROOM_CUSTOMER_UPDATE', 'room_session', s.id, b);
  });
  await afterChange(settings);
  res.json({ ok: true });
});

/** Close the room: stop the clock → compute → go to checkout. */
r.post('/sessions/:id/close', can('room.operate'), async (req, res) => {
  const settings = await getSettings();
  const out = await tx(async (c) => {
    const s = await loadSession(c, req.params.id, true);
    if (s.status === 'CLOSED') return s;
    if (!['ACTIVE', 'PAUSED'].includes(s.status)) throw conflict('ไม่สามารถปิดห้องได้');
    const now = new Date();
    let paused = Number(s.total_paused_seconds);
    if (s.paused_at) paused += Math.floor((now - new Date(s.paused_at)) / 1000);
    const u = (await c.query(`UPDATE room_sessions SET status = 'CLOSED', ended_at = $2, paused_at = NULL, total_paused_seconds = $3, closed_by = $4, version = version + 1, updated_at = now() WHERE id = $1 RETURNING *`, [s.id, now, paused, req.employee.id])).rows[0];
    await c.query(`INSERT INTO room_time_adjustments(session_id, type, after, employee_id) VALUES ($1,'CLOSE',$2,$3)`, [s.id, { ended_at: now }, req.employee.id]);
    await logActivity(c, req, 'ROOM_CLOSE', 'room_session', s.id, {});
    return u;
  });
  const order = out.order_id ? await computeOrder(pool, out.order_id, settings) : null;
  await afterChange(settings);
  res.json({ session: out, order });
});

r.post('/sessions/:id/cancel', can('order.void'), async (req, res) => {
  const { reason } = parse(z.object({ reason: z.string().min(1, 'กรุณาระบุเหตุผลการยกเลิก').max(500) }), req.body);
  const settings = await getSettings();
  await tx(async (c) => {
    const s = await loadSession(c, req.params.id, true);
    if (!ACTIVE.includes(s.status)) throw conflict('ไม่สามารถยกเลิกได้');
    await c.query(`UPDATE room_sessions SET status = 'CANCELLED', ended_at = COALESCE(ended_at, now()), cancel_reason = $2, updated_at = now() WHERE id = $1`, [s.id, reason]);
    if (s.order_id) await c.query(`UPDATE orders SET status = 'VOID', voided_at = now(), voided_by = $2, void_reason = $3 WHERE id = $1 AND status = 'OPEN'`, [s.order_id, req.employee.id, reason]);
    await c.query(`UPDATE rooms SET status = 'CLEANING' WHERE id = $1`, [s.room_id]);
    if (s.reservation_id) await c.query(`UPDATE reservations SET status = 'ARRIVED', session_id = NULL, updated_at = now() WHERE id = $1`, [s.reservation_id]);
    await c.query(`INSERT INTO room_time_adjustments(session_id, type, reason, employee_id) VALUES ($1,'CANCEL',$2,$3)`, [s.id, reason, req.employee.id]);
    await logActivity(c, req, 'ROOM_CANCEL', 'room_session', s.id, { reason });
  });
  await afterChange(settings);
  res.json({ ok: true });
});

export default r;

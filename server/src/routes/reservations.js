import { Router } from 'express';
import { pool, tx, many, one } from '../db/index.js';
import { requireAuth, can, verifyToken, readApproval, hasPerm } from '../lib/auth.js';
import { attachShift } from '../lib/shift.js';
import { idempotent } from '../lib/idempotency.js';
import { logActivity } from '../lib/activity.js';
import { z, parse } from '../lib/validate.js';
import { notFound, badRequest, conflict } from '../lib/errors.js';
import { emitSync } from '../lib/realtime.js';
import { getSettings } from '../services/settings.js';
import { expireStaleHolds, lockRoom, assertRoomFree, searchRooms, suggestAlternatives, findConflicts } from '../services/availability.js';
import { estimateReservation, confirmOnlineDeposit } from '../services/booking.js';
import { nextBookingNo, nextDepositNo, nextDepositRefundNo, randomToken } from '../services/numbers.js';
import { refreshRoomStatuses } from '../services/rooms.js';
import { queueLineMessage, bookingMessage, notify } from '../services/notifications.js';
import { openSession } from './sessions.js';
import { calculateCancellationRefund } from '@beatbox/shared/calc.js';
import { normalizePhone } from '@beatbox/shared/format.js';
import { round2 } from '@beatbox/shared/money.js';

const r = Router();
r.use(requireAuth);

export const RESERVATION_SELECT = `
  SELECT rv.*, rm.name AS room_name, rm.number AS room_number, rm.capacity AS room_capacity, rt.name AS type_name, rt.color AS type_color,
         p.name AS package_name, m.member_code, m.first_name AS member_first_name, m.last_name AS member_last_name, m.points_balance AS member_points,
         e.name AS created_by_name,
         EXISTS (SELECT 1 FROM line_connections lc WHERE lc.member_id = rv.member_id AND lc.status = 'CONNECTED') AS line_connected,
         (SELECT pt.status FROM payment_transactions pt WHERE pt.reservation_id = rv.id ORDER BY pt.created_at DESC LIMIT 1) AS payment_status,
         (SELECT pv.result FROM payment_verifications pv WHERE pv.reservation_id = rv.id ORDER BY pv.id DESC LIMIT 1) AS slip_result,
         (SELECT string_agg(DISTINCT d.method, ',') FROM deposits d WHERE d.reservation_id = rv.id) AS deposit_methods
  FROM reservations rv
  JOIN rooms rm ON rm.id = rv.room_id
  JOIN room_types rt ON rt.id = rv.room_type_id
  LEFT JOIN room_packages p ON p.id = rv.package_id
  LEFT JOIN members m ON m.id = rv.member_id
  LEFT JOIN employees e ON e.id = rv.created_by`;

r.get('/reservations', async (req, res) => {
  const q = req.query;
  const rows = await many(
    `${RESERVATION_SELECT}
     WHERE ($1::timestamptz IS NULL OR rv.end_at >= $1) AND ($2::timestamptz IS NULL OR rv.start_at <= $2)
       AND ($3::text IS NULL OR rv.status = ANY(string_to_array($3, ','))) AND ($4::text IS NULL OR rv.source = $4)
       AND ($5::text IS NULL OR rv.booking_no ILIKE '%'||$5||'%' OR rv.customer_name ILIKE '%'||$5||'%' OR rv.phone LIKE '%'||$5||'%')
       AND ($6::int IS NULL OR rv.room_id = $6) AND ($7::int IS NULL OR rv.room_type_id = $7)
       AND (rv.status <> 'EXPIRED' OR $8::boolean)
     ORDER BY rv.start_at ${q.order === 'desc' ? 'DESC' : 'ASC'} LIMIT 1000`,
    [q.from || null, q.to || null, q.status || null, q.source || null, q.q || null, q.roomId || null, q.roomTypeId || null, q.includeExpired === 'true'],
  );
  res.json(rows);
});

r.get('/reservations/availability', async (req, res) => {
  const q = parse(z.object({ startAt: z.string(), durationMinutes: z.coerce.number().int().min(30), guests: z.coerce.number().int().min(0).default(0), roomTypeId: z.coerce.number().int().optional(), excludeReservationId: z.coerce.number().int().optional() }), req.query);
  const start = new Date(q.startAt);
  const end = new Date(start.getTime() + q.durationMinutes * 60000);
  await expireStaleHolds(pool);
  const rooms = await searchRooms(pool, { startAt: start, endAt: end, guests: q.guests, roomTypeId: q.roomTypeId });
  const available = rooms.filter((x) => x.available && x.fits);
  const settings = await getSettings();
  const suggestions = available.length ? null : await suggestAlternatives(pool, { startAt: start, durationMinutes: q.durationMinutes, guests: q.guests, roomTypeId: q.roomTypeId, openTime: settings.store.openTime, closeTime: settings.store.closeTime });
  res.json({ rooms, suggestions });
});

/** Lookup for check-in: booking number, QR check-in token, phone or member code. */
r.get('/reservations/lookup', async (req, res) => {
  const raw = String(req.query.q || '').trim();
  if (!raw) return res.json([]);
  const token = raw.replace(/^.*[?&/]t(oken)?[=/]/i, '').replace(/^CHECKIN:/i, '');
  const phone = normalizePhone(raw);
  const rows = await many(
    `${RESERVATION_SELECT}
     WHERE (upper(rv.booking_no) = upper($1) OR rv.check_in_token = $2 OR ($3 <> '' AND length($3) >= 9 AND (rv.phone = $3 OR m.phone = $3)) OR upper(m.member_code) = upper($1))
       AND rv.status NOT IN ('EXPIRED')
     ORDER BY CASE WHEN rv.status IN ('PENDING','CONFIRMED','DEPOSIT_PAID','WAITING','ARRIVED','IN_USE') THEN 0 ELSE 1 END, abs(extract(epoch FROM rv.start_at - now())) LIMIT 30`,
    [raw, token, phone],
  );
  res.json(rows);
});

r.get('/reservations/:id', async (req, res) => {
  const rv = await one(`${RESERVATION_SELECT} WHERE rv.id = $1`, [req.params.id]);
  if (!rv) throw notFound();
  const deposits = await many(`SELECT d.*, e.name AS received_by_name FROM deposits d LEFT JOIN employees e ON e.id = d.received_by WHERE d.reservation_id = $1 ORDER BY d.id`, [rv.id]);
  const refunds = await many(`SELECT dr.*, e.name AS employee_name FROM deposit_refunds dr JOIN deposits d ON d.id = dr.deposit_id LEFT JOIN employees e ON e.id = dr.employee_id WHERE d.reservation_id = $1 ORDER BY dr.id`, [rv.id]);
  const payments = await many(`SELECT * FROM payment_transactions WHERE reservation_id = $1 ORDER BY created_at`, [rv.id]);
  const verifications = await many(`SELECT pv.*, e.name AS reviewed_by_name FROM payment_verifications pv LEFT JOIN employees e ON e.id = pv.reviewed_by WHERE pv.reservation_id = $1 ORDER BY pv.id`, [rv.id]);
  const logs = await many(`SELECT * FROM activity_logs WHERE entity = 'reservation' AND entity_id = $1 ORDER BY id`, [String(rv.id)]);
  const settings = await getSettings();
  const depositHeld = round2(deposits.filter((d) => ['RECEIVED'].includes(d.status) && d.verification_status === 'VERIFIED').reduce((s, d) => s + Number(d.amount) - Number(d.refunded_amount), 0));
  const cancelPreview = calculateCancellationRefund(depositHeld, rv.start_at, settings.booking.cancellation);
  res.json({ ...rv, deposits, refunds, payments, verifications, logs, depositHeld, cancelPreview });
});

const createSchema = z.object({
  roomId: z.coerce.number().int(),
  startAt: z.string(),
  durationMinutes: z.coerce.number().int().min(30).max(24 * 60),
  customerName: z.string().min(1, 'กรุณากรอกชื่อลูกค้า').max(200),
  phone: z.string().min(9, 'กรุณากรอกเบอร์โทร').max(20),
  memberId: z.coerce.number().int().optional().nullable(),
  guestCount: z.coerce.number().int().min(1).max(500),
  packageId: z.coerce.number().int().optional().nullable(),
  promotionId: z.coerce.number().int().optional().nullable(),
  note: z.string().max(1000).optional().nullable(),
  source: z.enum(['POS', 'PHONE', 'WALK_IN', 'LINE', 'ONLINE']).default('POS'),
  status: z.enum(['PENDING', 'CONFIRMED']).default('CONFIRMED'),
  depositRequired: z.coerce.number().min(0).optional().nullable(),
  deposit: z.object({ amount: z.coerce.number().min(0), method: z.enum(['CASH', 'QR', 'TRANSFER', 'CARD', 'OTHER']), reference: z.string().optional().nullable(), slipUrl: z.string().optional().nullable(), verificationToken: z.string().optional().nullable() }).optional().nullable(),
});

r.post('/reservations', can('booking.manage'), attachShift, idempotent('reservation', { required: false }), async (req, res) => {
  const b = parse(createSchema, req.body);
  const settings = await getSettings();
  const start = new Date(b.startAt);
  const end = new Date(start.getTime() + b.durationMinutes * 60000);
  const out = await tx(async (c) => {
    await expireStaleHolds(c);
    const room = await lockRoom(c, b.roomId);
    if (!room) throw notFound('ไม่พบห้อง');
    await assertRoomFree(c, room.id, start, end);
    const pkg = b.packageId ? (await c.query('SELECT * FROM room_packages WHERE id = $1', [b.packageId])).rows[0] : null;
    const promo = b.promotionId ? (await c.query('SELECT * FROM promotions WHERE id = $1', [b.promotionId])).rows[0] : null;
    const est = estimateReservation({ room, pkg, durationMinutes: b.durationMinutes, guestCount: b.guestCount, settings, promotion: promo, startAt: start });
    const phone = normalizePhone(b.phone);
    let memberId = b.memberId || null;
    if (!memberId) memberId = (await c.query('SELECT id FROM members WHERE phone = $1 AND deleted_at IS NULL', [phone])).rows[0]?.id || null;
    const depositRequired = b.depositRequired ?? est.deposit;
    const rv = (
      await c.query(
        `INSERT INTO reservations(booking_no, branch_id, room_id, room_type_id, member_id, customer_name, phone, guest_count, package_id, promotion_id, start_at, end_at,
           duration_minutes, estimated_total, estimate_snapshot, deposit_required, status, source, note, check_in_token, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING *`,
        [await nextBookingNo(c), room.branch_id, room.id, room.room_type_id, memberId, b.customerName, phone, b.guestCount, pkg?.id || null, promo?.id || null, start, end, b.durationMinutes, est.calc.grandTotal, est.calc, depositRequired, b.status, b.source, b.note, randomToken(18), req.employee.id],
      )
    ).rows[0];
    if (b.deposit && b.deposit.amount > 0) {
      if (!req.shiftId) throw conflict('กรุณาเปิดรอบการขายก่อนรับเงินมัดจำ', 'NO_SHIFT');
      if (['QR', 'TRANSFER'].includes(b.deposit.method)) {
        const v = b.deposit.verificationToken ? verifyToken(b.deposit.verificationToken) : null;
        if (!v || v.typ !== 'slip') throw badRequest('กรุณาตรวจสอบสลิปมัดจำก่อน', 'SLIP_NOT_VERIFIED');
      }
      await c.query(
        `INSERT INTO deposits(deposit_no, reservation_id, member_id, customer_name, phone, amount, method, slip_url, verification_status, status, received_by, shift_id, note, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'VERIFIED','RECEIVED',$9,$10,$11,'POS')`,
        [await nextDepositNo(c), rv.id, memberId, b.customerName, phone, b.deposit.amount, b.deposit.method, b.deposit.slipUrl || null, req.employee.id, req.shiftId, b.deposit.reference],
      );
      await c.query(`UPDATE reservations SET deposit_paid = $2, status = 'DEPOSIT_PAID' WHERE id = $1`, [rv.id, b.deposit.amount]);
    }
    await logActivity(c, req, 'RESERVATION_CREATE', 'reservation', rv.id, { bookingNo: rv.booking_no, room: room.name, start, end, guests: b.guestCount, source: b.source, deposit: b.deposit?.amount || 0 });
    return rv;
  });
  await refreshRoomStatuses(settings);
  emitSync(['reservations', 'rooms']);
  res.json(out);
});

/** Edit / drag & drop: room, time, guests. Double-booking is re-checked server side + DB constraint. */
r.put('/reservations/:id', can('booking.manage'), async (req, res) => {
  const b = parse(
    z.object({
      roomId: z.coerce.number().int().optional(),
      startAt: z.string().optional(),
      endAt: z.string().optional(),
      durationMinutes: z.coerce.number().int().min(30).optional(),
      guestCount: z.coerce.number().int().min(1).optional(),
      customerName: z.string().max(200).optional(),
      phone: z.string().max(20).optional(),
      note: z.string().max(1000).optional().nullable(),
      packageId: z.coerce.number().int().optional().nullable(),
      version: z.coerce.number().int().optional(),
    }),
    req.body,
  );
  const settings = await getSettings();
  const out = await tx(async (c) => {
    const rv = (await c.query('SELECT * FROM reservations WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!rv) throw notFound();
    if (b.version && b.version !== rv.version) throw conflict('รายการนี้ถูกแก้ไขจากเครื่องอื่น กรุณาโหลดข้อมูลใหม่', 'VERSION_CONFLICT');
    if (!['HOLD', 'PENDING', 'CONFIRMED', 'DEPOSIT_PAID', 'WAITING', 'ARRIVED'].includes(rv.status)) throw conflict('ไม่สามารถแก้ไขการจองในสถานะนี้ได้');
    const roomId = b.roomId || rv.room_id;
    const start = b.startAt ? new Date(b.startAt) : new Date(rv.start_at);
    const duration = b.endAt ? Math.round((new Date(b.endAt) - start) / 60000) : b.durationMinutes || rv.duration_minutes;
    if (duration < 30) throw badRequest('ระยะเวลาต้องอย่างน้อย 30 นาที');
    const end = new Date(start.getTime() + duration * 60000);
    const ids = [...new Set([rv.room_id, roomId])].sort((x, y) => x - y);
    for (const id of ids) await lockRoom(c, id);
    await assertRoomFree(c, roomId, start, end, { excludeReservationId: rv.id });
    const room = (await c.query('SELECT * FROM rooms WHERE id = $1', [roomId])).rows[0];
    const pkgId = b.packageId !== undefined ? b.packageId : rv.package_id;
    const pkg = pkgId ? (await c.query('SELECT * FROM room_packages WHERE id = $1', [pkgId])).rows[0] : null;
    const guests = b.guestCount || rv.guest_count;
    const est = estimateReservation({ room, pkg, durationMinutes: duration, guestCount: guests, settings, startAt: start });
    const u = (
      await c.query(
        `UPDATE reservations SET room_id = $2, room_type_id = $3, start_at = $4, end_at = $5, duration_minutes = $6, guest_count = $7, customer_name = COALESCE($8, customer_name),
           phone = COALESCE($9, phone), note = COALESCE($10, note), package_id = $11, estimated_total = $12, estimate_snapshot = $13, version = version + 1, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [rv.id, roomId, room.room_type_id, start, end, duration, guests, b.customerName || null, b.phone ? normalizePhone(b.phone) : null, b.note ?? null, pkgId || null, est.calc.grandTotal, est.calc],
      )
    ).rows[0];
    await logActivity(c, req, 'RESERVATION_UPDATE', 'reservation', rv.id, { before: { room_id: rv.room_id, start_at: rv.start_at, end_at: rv.end_at, guests: rv.guest_count }, after: { room_id: roomId, start_at: start, end_at: end, guests } });
    if ((roomId !== rv.room_id || +start !== +new Date(rv.start_at)) && u.member_id) {
      await queueLineMessage({ memberId: u.member_id, type: 'ROOM_CHANGED', title: 'มีการเปลี่ยนแปลงการจอง', message: bookingMessage('ROOM_CHANGED', { ...u, room_name: room.name }), reservationId: u.id }, c);
    }
    return u;
  });
  await refreshRoomStatuses(settings);
  emitSync(['reservations', 'rooms']);
  res.json(out);
});

const TRANSITIONS = {
  CONFIRMED: ['PENDING', 'HOLD'],
  WAITING: ['PENDING', 'CONFIRMED', 'DEPOSIT_PAID'],
  ARRIVED: ['PENDING', 'CONFIRMED', 'DEPOSIT_PAID', 'WAITING'],
  NO_SHOW: ['PENDING', 'CONFIRMED', 'DEPOSIT_PAID', 'WAITING'],
  PENDING: ['CONFIRMED'],
};

r.post('/reservations/:id/status', can('booking.manage'), async (req, res) => {
  const { status, reason } = parse(z.object({ status: z.enum(['CONFIRMED', 'WAITING', 'ARRIVED', 'NO_SHOW', 'PENDING']), reason: z.string().max(500).optional() }), req.body);
  const settings = await getSettings();
  const out = await tx(async (c) => {
    const rv = (await c.query('SELECT * FROM reservations WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!rv) throw notFound();
    if (!TRANSITIONS[status].includes(rv.status)) throw conflict(`ไม่สามารถเปลี่ยนสถานะจาก ${rv.status} เป็น ${status}`);
    const u = (await c.query(`UPDATE reservations SET status = $2, checked_in_at = CASE WHEN $2 = 'ARRIVED' THEN now() ELSE checked_in_at END, updated_at = now(), version = version + 1 WHERE id = $1 RETURNING *`, [rv.id, status])).rows[0];
    if (status === 'NO_SHOW' && settings.booking.noShowDepositAction === 'FORFEIT') {
      await c.query(`UPDATE deposits SET status = 'FORFEITED' WHERE reservation_id = $1 AND status = 'RECEIVED'`, [rv.id]);
    }
    if (status === 'ARRIVED') await notify({ type: 'CUSTOMER_ARRIVED', level: 'success', title: 'ลูกค้ามาถึงแล้ว', message: `${rv.booking_no} ${rv.customer_name}`, reservationId: rv.id, roomId: rv.room_id }, c);
    await logActivity(c, req, `RESERVATION_${status}`, 'reservation', rv.id, { from: rv.status, to: status, reason });
    return u;
  });
  await refreshRoomStatuses(settings);
  emitSync(['reservations', 'rooms']);
  res.json(out);
});

r.post('/reservations/:id/check-in', can('booking.manage'), async (req, res) => {
  const settings = await getSettings();
  const out = await tx(async (c) => {
    const rv = (await c.query('SELECT * FROM reservations WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!rv) throw notFound();
    if (!['PENDING', 'CONFIRMED', 'DEPOSIT_PAID', 'WAITING'].includes(rv.status)) throw conflict('การจองนี้ไม่อยู่ในสถานะที่ Check-in ได้');
    const u = (await c.query(`UPDATE reservations SET status = 'ARRIVED', checked_in_at = now(), updated_at = now(), version = version + 1 WHERE id = $1 RETURNING *`, [rv.id])).rows[0];
    await notify({ type: 'CUSTOMER_ARRIVED', level: 'success', title: 'ลูกค้ามาถึงแล้ว', message: `${rv.booking_no} ${rv.customer_name}`, reservationId: rv.id, roomId: rv.room_id }, c);
    await logActivity(c, req, 'RESERVATION_CHECK_IN', 'reservation', rv.id, {});
    return u;
  });
  await refreshRoomStatuses(settings);
  emitSync(['reservations', 'rooms']);
  res.json(out);
});

/** Open the room directly from a reservation — all data (customer, member, guests, package, deposit) flows in. */
r.post('/reservations/:id/open', can('room.operate'), attachShift, async (req, res) => {
  const settings = await getSettings();
  const session = await tx(async (c) => {
    const rv = (await c.query('SELECT * FROM reservations WHERE id = $1', [req.params.id])).rows[0];
    if (!rv) throw notFound();
    const pkg = rv.package_id ? (await c.query('SELECT * FROM room_packages WHERE id = $1', [rv.package_id])).rows[0] : null;
    const pkgMin = pkg ? pkg.hours * 60 + pkg.minutes : 0;
    const s = await openSession(
      c,
      req,
      {
        roomId: rv.room_id,
        reservationId: rv.id,
        memberId: rv.member_id,
        customerName: rv.customer_name,
        phone: rv.phone,
        guestCount: req.body?.guestCount || rv.guest_count,
        packageId: rv.package_id,
        minutes: Math.max(0, rv.duration_minutes - pkgMin),
        startMode: 'NOW',
        items: [],
        clientOpId: req.body?.clientOpId || null,
      },
      settings,
    );
    if (rv.promotion_id) await c.query('UPDATE orders SET promotion_ids = $2 WHERE id = $1', [s.order_id, [rv.promotion_id]]);
    await logActivity(c, req, 'RESERVATION_OPEN_ROOM', 'reservation', rv.id, { sessionId: s.id });
    return s;
  });
  await refreshRoomStatuses(settings);
  emitSync(['reservations', 'rooms', 'orders']);
  res.json(session);
});

r.get('/reservations/:id/cancel-preview', async (req, res) => {
  const rv = await one('SELECT * FROM reservations WHERE id = $1', [req.params.id]);
  if (!rv) throw notFound();
  const held = await one(`SELECT COALESCE(SUM(amount - refunded_amount),0) AS amt FROM deposits WHERE reservation_id = $1 AND status = 'RECEIVED' AND verification_status = 'VERIFIED'`, [rv.id]);
  const settings = await getSettings();
  res.json({ deposit: Number(held.amt), ...calculateCancellationRefund(Number(held.amt), rv.start_at, settings.booking.cancellation) });
});

/** Cancel with optional deposit refund (refund is its own transaction; original payment untouched). */
export async function cancelReservation(c, req, rv, { reason, refundAmount = 0, refundMethod = 'CASH', note = null, actor = null }) {
  if (!['HOLD', 'PENDING', 'CONFIRMED', 'DEPOSIT_PAID', 'WAITING', 'ARRIVED'].includes(rv.status)) throw conflict('ไม่สามารถยกเลิกการจองนี้ได้');
  const deposits = (await c.query(`SELECT * FROM deposits WHERE reservation_id = $1 AND status = 'RECEIVED' AND verification_status = 'VERIFIED' FOR UPDATE`, [rv.id])).rows;
  const held = round2(deposits.reduce((s, d) => s + Number(d.amount) - Number(d.refunded_amount), 0));
  if (refundAmount > held + 0.001) throw badRequest(`คืนมัดจำได้สูงสุด ${held} บาท`);
  let remaining = refundAmount;
  for (const d of deposits) {
    if (remaining <= 0) break;
    const avail = Number(d.amount) - Number(d.refunded_amount);
    const take = Math.min(avail, remaining);
    await c.query(
      `INSERT INTO deposit_refunds(refund_no, deposit_id, amount, refund_type, reason, employee_id, shift_id, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [await nextDepositRefundNo(c), d.id, take, refundMethod, reason, req?.employee?.id || null, req?.shiftId || null, note],
    );
    const newRefunded = Number(d.refunded_amount) + take;
    await c.query(`UPDATE deposits SET refunded_amount = $2, status = $3 WHERE id = $1`, [d.id, newRefunded, newRefunded >= Number(d.amount) ? 'REFUNDED' : 'PARTIALLY_REFUNDED']);
    remaining -= take;
  }
  // remaining deposit (not refunded) is forfeited per policy
  await c.query(`UPDATE deposits SET status = 'FORFEITED' WHERE reservation_id = $1 AND status = 'RECEIVED'`, [rv.id]);
  await c.query(`UPDATE payment_transactions SET status = CASE WHEN status = 'PAID' AND $2 > 0 THEN (CASE WHEN $2 >= amount THEN 'REFUNDED' ELSE 'PARTIALLY_REFUNDED' END) WHEN status IN ('PENDING','VERIFYING','MANUAL_REVIEW') THEN 'CANCELLED' ELSE status END, updated_at = now() WHERE reservation_id = $1`, [rv.id, refundAmount]);
  const status = refundAmount > 0 ? 'REFUNDED' : 'CANCELLED';
  const u = (await c.query(`UPDATE reservations SET status = $2, cancelled_at = now(), cancel_reason = $3, updated_at = now(), version = version + 1 WHERE id = $1 RETURNING *`, [rv.id, status, reason])).rows[0];
  await c.query(`UPDATE reservation_holds SET released_at = now(), release_reason = 'CANCELLED' WHERE reservation_id = $1 AND released_at IS NULL`, [rv.id]);
  const full = (await c.query('SELECT r.*, rm.name AS room_name FROM reservations r JOIN rooms rm ON rm.id = r.room_id WHERE r.id = $1', [rv.id])).rows[0];
  if (rv.member_id) {
    await queueLineMessage({ memberId: rv.member_id, type: 'BOOKING_CANCELLED', title: 'ยกเลิกการจอง', message: bookingMessage('BOOKING_CANCELLED', full, { reason }), reservationId: rv.id }, c);
    if (refundAmount > 0) await queueLineMessage({ memberId: rv.member_id, type: 'DEPOSIT_REFUNDED', title: 'คืนเงินมัดจำ', message: bookingMessage('DEPOSIT_REFUNDED', full, { amount: refundAmount }), reservationId: rv.id }, c);
  }
  await logActivity(c, req || { employee: null }, 'RESERVATION_CANCEL', 'reservation', rv.id, { reason, refundAmount, refundMethod, held, actor });
  return u;
}

r.post('/reservations/:id/cancel', can('booking.manage'), attachShift, idempotent('reservation-cancel', { required: false }), async (req, res) => {
  const b = parse(z.object({ reason: z.string().min(1, 'กรุณาระบุเหตุผล').max(500), refundAmount: z.coerce.number().min(0).default(0), refundMethod: z.enum(['CASH', 'TRANSFER', 'QR', 'CARD', 'STORE_CREDIT', 'OTHER']).default('CASH'), note: z.string().max(500).optional(), approvalToken: z.string().optional().nullable() }), req.body);
  if (b.refundAmount > 0 && !hasPerm(req, 'refund.create') && !readApproval(b.approvalToken, 'refund.approve')) throw conflict('การคืนเงินมัดจำต้องได้รับอนุมัติ', 'APPROVAL_REQUIRED');
  if (b.refundAmount > 0 && b.refundMethod === 'CASH') {
    if (!req.shiftId) throw conflict('กรุณาเปิดรอบการขายก่อนคืนเงินสด', 'NO_SHIFT');
  }
  const settings = await getSettings();
  const out = await tx(async (c) => {
    const rv = (await c.query('SELECT * FROM reservations WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!rv) throw notFound();
    return cancelReservation(c, req, rv, b);
  });
  await refreshRoomStatuses(settings);
  emitSync(['reservations', 'rooms']);
  res.json(out);
});

// ───────────── Deposits ─────────────
r.get('/deposits', async (req, res) => {
  res.json(
    await many(
      `SELECT d.*, rv.booking_no, rv.start_at, e.name AS received_by_name, rm.name AS room_name,
              (SELECT json_agg(dr ORDER BY dr.id) FROM deposit_refunds dr WHERE dr.deposit_id = d.id) AS refunds
       FROM deposits d LEFT JOIN reservations rv ON rv.id = d.reservation_id LEFT JOIN employees e ON e.id = d.received_by
       LEFT JOIN rooms rm ON rm.id = rv.room_id
       WHERE ($1::text IS NULL OR d.status = $1) AND ($2::text IS NULL OR d.deposit_no ILIKE '%'||$2||'%' OR rv.booking_no ILIKE '%'||$2||'%' OR d.customer_name ILIKE '%'||$2||'%' OR d.phone LIKE '%'||$2||'%')
       ORDER BY d.id DESC LIMIT 500`,
      [req.query.status || null, req.query.q || null],
    ),
  );
});

r.post('/deposits', can('booking.manage'), attachShift, idempotent('deposit'), async (req, res) => {
  const b = parse(
    z.object({
      reservationId: z.coerce.number().int().optional().nullable(),
      sessionId: z.coerce.number().int().optional().nullable(),
      amount: z.coerce.number().positive(),
      method: z.enum(['CASH', 'QR', 'TRANSFER', 'CARD', 'OTHER']),
      slipUrl: z.string().max(2000).optional().nullable(),
      verificationToken: z.string().optional().nullable(),
      note: z.string().max(500).optional().nullable(),
    }),
    req.body,
  );
  if (!b.reservationId && !b.sessionId) throw badRequest('กรุณาระบุการจองหรือห้อง');
  if (!req.shiftId) throw conflict('กรุณาเปิดรอบการขายก่อนรับเงินมัดจำ', 'NO_SHIFT');
  const settings = await getSettings();
  const out = await tx(async (c) => {
    let rv = null;
    let session = null;
    if (b.reservationId) rv = (await c.query('SELECT * FROM reservations WHERE id = $1 FOR UPDATE', [b.reservationId])).rows[0];
    if (b.sessionId) session = (await c.query('SELECT * FROM room_sessions WHERE id = $1', [b.sessionId])).rows[0];
    const ref = rv || session;
    if (!ref) throw notFound();
    let verified = 'VERIFIED';
    if (['QR', 'TRANSFER'].includes(b.method)) {
      const v = b.verificationToken ? verifyToken(b.verificationToken) : null;
      if (!v || v.typ !== 'slip') verified = 'PENDING';
    }
    const d = (
      await c.query(
        `INSERT INTO deposits(deposit_no, reservation_id, session_id, member_id, customer_name, phone, amount, method, slip_url, verification_status, status, received_by, shift_id, note, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'RECEIVED',$11,$12,$13,$14) RETURNING *`,
        [await nextDepositNo(c), rv?.id || session?.reservation_id || null, session?.id || null, ref.member_id, ref.customer_name, ref.phone, b.amount, b.method, b.slipUrl, verified, req.employee.id, req.shiftId, b.note, req.idempotencyKey],
      )
    ).rows[0];
    if (rv && verified === 'VERIFIED') {
      await c.query(`UPDATE reservations SET deposit_paid = deposit_paid + $2, status = CASE WHEN status IN ('PENDING','CONFIRMED','HOLD') THEN 'DEPOSIT_PAID' ELSE status END, hold_expires_at = NULL, updated_at = now() WHERE id = $1`, [rv.id, b.amount]);
      const full = (await c.query('SELECT r.*, rm.name AS room_name FROM reservations r JOIN rooms rm ON rm.id = r.room_id WHERE r.id = $1', [rv.id])).rows[0];
      if (full.member_id) await queueLineMessage({ memberId: full.member_id, type: 'DEPOSIT_RECEIVED', title: 'รับเงินมัดจำ', message: bookingMessage('DEPOSIT_RECEIVED', full, { amount: b.amount }), reservationId: rv.id }, c);
    }
    await logActivity(c, req, 'DEPOSIT_RECEIVE', 'reservation', rv?.id || session?.reservation_id, { depositNo: d.deposit_no, amount: b.amount, method: b.method, verification: verified });
    return d;
  });
  await refreshRoomStatuses(settings);
  emitSync(['reservations', 'deposits', 'rooms']);
  res.json(out);
});

r.post('/deposits/:id/verify', can('slip.verify'), async (req, res) => {
  const { approve, note } = parse(z.object({ approve: z.boolean(), note: z.string().max(300).optional() }), req.body);
  const out = await tx(async (c) => {
    const d = (await c.query('SELECT * FROM deposits WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!d) throw notFound();
    if (d.verification_status !== 'PENDING') throw conflict('รายการนี้ตรวจสอบแล้ว');
    const u = (await c.query(`UPDATE deposits SET verification_status = $2, status = CASE WHEN $2 = 'REJECTED' THEN 'CANCELLED' ELSE status END WHERE id = $1 RETURNING *`, [d.id, approve ? 'VERIFIED' : 'REJECTED'])).rows[0];
    if (approve && d.reservation_id) await c.query(`UPDATE reservations SET deposit_paid = deposit_paid + $2, status = CASE WHEN status IN ('PENDING','CONFIRMED','HOLD') THEN 'DEPOSIT_PAID' ELSE status END, hold_expires_at = NULL WHERE id = $1`, [d.reservation_id, d.amount]);
    await logActivity(c, req, approve ? 'DEPOSIT_VERIFY' : 'DEPOSIT_REJECT', 'reservation', d.reservation_id, { depositNo: d.deposit_no, note });
    return u;
  });
  emitSync(['reservations', 'deposits']);
  res.json(out);
});

r.post('/deposits/:id/refund', can('refund.create'), attachShift, idempotent('deposit-refund', { required: false }), async (req, res) => {
  const b = parse(z.object({ amount: z.coerce.number().positive(), reason: z.string().min(1, 'กรุณาระบุเหตุผล').max(500), refundType: z.enum(['CASH', 'TRANSFER', 'QR', 'CARD', 'STORE_CREDIT', 'OTHER']).default('CASH'), note: z.string().max(500).optional().nullable(), approvalToken: z.string().optional().nullable() }), req.body);
  const settings = await getSettings();
  const approval = readApproval(b.approvalToken, 'refund.approve');
  if (settings.security.refundRequiresApproval && !hasPerm(req, 'refund.approve') && !approval) throw conflict('การคืนเงินต้องได้รับอนุมัติจากผู้จัดการ', 'APPROVAL_REQUIRED');
  if (b.refundType === 'CASH' && !req.shiftId) throw conflict('กรุณาเปิดรอบการขายก่อนคืนเงินสด', 'NO_SHIFT');
  const out = await tx(async (c) => {
    const d = (await c.query('SELECT * FROM deposits WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!d) throw notFound();
    if (!['RECEIVED', 'PARTIALLY_REFUNDED', 'FORFEITED'].includes(d.status)) throw conflict('มัดจำนี้ไม่สามารถคืนได้');
    const avail = round2(Number(d.amount) - Number(d.refunded_amount));
    if (b.amount > avail + 0.001) throw badRequest(`คืนได้สูงสุด ${avail} บาท`);
    const rf = (
      await c.query(
        `INSERT INTO deposit_refunds(refund_no, deposit_id, amount, refund_type, reason, employee_id, approved_by, shift_id, note, idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [await nextDepositRefundNo(c), d.id, b.amount, b.refundType, b.reason, req.employee.id, approval?.id || req.employee.id, req.shiftId || null, b.note, req.idempotencyKey || null],
      )
    ).rows[0];
    const newRef = round2(Number(d.refunded_amount) + b.amount);
    await c.query(`UPDATE deposits SET refunded_amount = $2, status = $3 WHERE id = $1`, [d.id, newRef, newRef >= Number(d.amount) ? 'REFUNDED' : 'PARTIALLY_REFUNDED']);
    if (d.reservation_id) {
      const rv = (await c.query('SELECT r.*, rm.name AS room_name FROM reservations r JOIN rooms rm ON rm.id = r.room_id WHERE r.id = $1', [d.reservation_id])).rows[0];
      if (rv && ['CANCELLED', 'NO_SHOW'].includes(rv.status)) await c.query(`UPDATE reservations SET status = 'REFUNDED' WHERE id = $1`, [rv.id]);
      if (rv?.member_id) await queueLineMessage({ memberId: rv.member_id, type: 'DEPOSIT_REFUNDED', title: 'คืนเงินมัดจำ', message: bookingMessage('DEPOSIT_REFUNDED', rv, { amount: b.amount }), reservationId: rv.id }, c);
    }
    await logActivity(c, req, 'DEPOSIT_REFUND', 'reservation', d.reservation_id, { depositNo: d.deposit_no, refundNo: rf.refund_no, amount: b.amount, reason: b.reason, method: b.refundType, approvedBy: approval?.name });
    return rf;
  });
  emitSync(['reservations', 'deposits']);
  res.json(out);
});

// ───────────── Online payment verification (manual review) ─────────────
r.get('/payment-verifications', async (req, res) => {
  res.json(
    await many(
      `SELECT pv.*, rv.booking_no, rv.customer_name, rv.phone, pt.amount AS expected_amount, pt.status AS payment_status, e.name AS reviewed_by_name
       FROM payment_verifications pv LEFT JOIN reservations rv ON rv.id = pv.reservation_id LEFT JOIN payment_transactions pt ON pt.id = pv.payment_transaction_id
       LEFT JOIN employees e ON e.id = pv.reviewed_by
       WHERE ($1::text IS NULL OR pv.result = $1) ORDER BY pv.id DESC LIMIT 300`,
      [req.query.result || null],
    ),
  );
});

/** Staff-only view of an uploaded slip (slips are never public). */
r.get('/payment-verifications/:id/slip', can('slip.verify'), async (req, res) => {
  const pv = await one('SELECT slip_path FROM payment_verifications WHERE id = $1', [req.params.id]);
  if (!pv?.slip_path) throw notFound();
  res.sendFile(pv.slip_path);
});

r.post('/payment-verifications/:id/review', can('slip.verify'), async (req, res) => {
  const b = parse(z.object({ approve: z.boolean(), transactionRef: z.string().max(100).optional().nullable(), reason: z.string().max(300).optional() }), req.body);
  const out = await tx(async (c) => {
    const pv = (await c.query('SELECT * FROM payment_verifications WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!pv) throw notFound();
    if (!['MANUAL_REVIEW', 'PENDING', 'FAILED'].includes(pv.result)) throw conflict('รายการนี้ตรวจสอบเสร็จแล้ว');
    const ptx = (await c.query('SELECT * FROM payment_transactions WHERE id = $1 FOR UPDATE', [pv.payment_transaction_id])).rows[0];
    if (!b.approve) {
      await c.query(`UPDATE payment_verifications SET result = 'FAILED', failure_reason = $2, reviewed_by = $3, verified_at = now() WHERE id = $1`, [pv.id, b.reason || 'พนักงานปฏิเสธ', req.employee.id]);
      if (ptx && ptx.status !== 'PAID') await c.query(`UPDATE payment_transactions SET status = 'FAILED', updated_at = now() WHERE id = $1`, [ptx.id]);
      await notify({ type: 'SLIP_FAILED', level: 'error', title: 'Slip Verification Failed', message: `สลิปของการจองถูกปฏิเสธ: ${b.reason || ''}`, reservationId: pv.reservation_id }, c);
      await logActivity(c, req, 'SLIP_REJECT', 'reservation', pv.reservation_id, { verificationId: pv.id, reason: b.reason });
      return { ok: true, result: 'FAILED' };
    }
    if (!ptx) throw notFound('ไม่พบรายการชำระเงิน');
    if (ptx.status === 'PAID') throw conflict('รายการนี้ชำระแล้ว');
    const ref = b.transactionRef || pv.transaction_ref || `MANUAL-${pv.id}`;
    await c.query(`UPDATE payment_verifications SET result = 'PASSED', transaction_ref = $2, reviewed_by = $3, verified_at = now(), failure_reason = NULL WHERE id = $1`, [pv.id, ref, req.employee.id]);
    const rv = (await c.query('SELECT * FROM reservations WHERE id = $1 FOR UPDATE', [ptx.reservation_id])).rows[0];
    if (['EXPIRED', 'CANCELLED'].includes(rv.status)) {
      // the hold expired while waiting for review — re-check availability before reinstating
      const conf = await findConflicts(c, rv.room_id, rv.start_at, rv.end_at, { excludeReservationId: rv.id });
      if (conf.hasConflict) throw conflict('ห้องถูกจองไปแล้วระหว่างรอตรวจสอบ กรุณาติดต่อลูกค้าเพื่อเปลี่ยนห้องหรือคืนเงิน');
      await c.query(`UPDATE reservations SET status = 'PENDING' WHERE id = $1`, [rv.id]);
    }
    await confirmOnlineDeposit(c, { reservation: rv, paymentTx: ptx, amount: Number(ptx.amount), reference: ref, slipPath: pv.slip_path, employeeId: req.employee.id });
    await logActivity(c, req, 'SLIP_APPROVE', 'reservation', rv.id, { verificationId: pv.id, ref });
    return { ok: true, result: 'PASSED' };
  });
  emitSync(['reservations', 'rooms', 'deposits']);
  res.json(out);
});

export default r;

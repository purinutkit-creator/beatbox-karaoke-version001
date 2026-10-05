// Customer Online Booking website API (same backend & database as the POS).
import { Router } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import { pool, tx, many, one } from '../db/index.js';
import { optionalMember, requireMember, createMemberSession, signToken, verifyToken } from '../lib/auth.js';
import { idempotent } from '../lib/idempotency.js';
import { logActivity } from '../lib/activity.js';
import { z, parse } from '../lib/validate.js';
import { notFound, badRequest, conflict, unauthorized, forbidden } from '../lib/errors.js';
import { emitSync } from '../lib/realtime.js';
import { config } from '../config.js';
import { getSettings, publicSettings } from '../services/settings.js';
import { expireStaleHolds, lockRoom, assertRoomFree, searchRooms, suggestAlternatives, withinOpeningHours } from '../services/availability.js';
import { estimateReservation, confirmOnlineDeposit, assertBookable } from '../services/booking.js';
import { nextBookingNo, nextMemberCode, randomToken } from '../services/numbers.js';
import { refreshRoomStatuses } from '../services/rooms.js';
import { notify } from '../services/notifications.js';
import { getSlipProvider, fileHash } from '../providers/slip.js';
import { getPaymentProvider } from '../providers/payment.js';
import { lineLogin } from '../providers/line.js';
import { sendSms } from '../providers/sms.js';
import { redeemReward } from './members.js';
import { calculateCancellationRefund } from '@beatbox/shared/calc.js';
import { normalizePhone, bkkDateTime, fmtDate, fmtTime } from '@beatbox/shared/format.js';
import { round2 } from '@beatbox/shared/money.js';

const r = Router();
const actor = (name) => ({ employee: { id: null, name }, ip: null });

r.get('/settings', async (_req, res) => {
  const s = await getSettings();
  const branches = await many('SELECT id, code, name, address, phone, open_time, close_time FROM branches WHERE is_active ORDER BY sort_order, id');
  res.json({ ...publicSettings(s), branches });
});

r.get('/catalog', async (_req, res) => {
  const [types, rooms, packages, promotions, banners, rewards] = await Promise.all([
    many('SELECT id, code, name, image_url, description, capacity, price_hour, price_half, default_deposit, color, amenities FROM room_types WHERE is_active AND deleted_at IS NULL ORDER BY sort_order, id'),
    many(`SELECT r.id, r.branch_id, r.room_type_id, r.name, r.number, r.image_url, r.zone, r.capacity, r.price_hour, r.price_half, r.deposit, rt.name AS type_name, rt.amenities, rt.color AS type_color
          FROM rooms r JOIN room_types rt ON rt.id = r.room_type_id WHERE r.deleted_at IS NULL AND r.is_active AND r.status NOT IN ('DISABLED','MAINTENANCE') ORDER BY r.sort_order, r.number`),
    many('SELECT id, name, room_type_ids, hours, minutes, price, included_guests, image_url, description, available_days, available_from, available_to, deposit, member_only FROM room_packages WHERE is_active AND is_online AND deleted_at IS NULL ORDER BY sort_order, id'),
    many(`SELECT id, name, type, value_type, value, image_url, description, start_date, end_date, conditions, (code IS NOT NULL) AS needs_code FROM promotions
          WHERE is_active AND is_online AND deleted_at IS NULL AND (end_date IS NULL OR end_date >= (now() AT TIME ZONE 'Asia/Bangkok')::date) ORDER BY id DESC`),
    many('SELECT id, title, image_url, link_url, duration_seconds FROM promotion_images WHERE is_active AND show_on_website ORDER BY sort_order, id'),
    many('SELECT id, name, image_url, description, points_cost, reward_type, value FROM rewards WHERE is_active AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at >= CURRENT_DATE) ORDER BY points_cost'),
  ]);
  res.json({ types, rooms, packages, promotions, banners, rewards });
});

/** Display carousel for the Customer Display (public, no auth). */
r.get('/display/:code', async (req, res) => {
  const d = await one('SELECT id, pair_code, last_state FROM customer_displays WHERE pair_code = $1', [req.params.code]);
  if (!d) throw notFound('ไม่พบรหัสเชื่อมต่อ');
  const images = await many('SELECT id, title, image_url, link_url, duration_seconds FROM promotion_images WHERE is_active AND show_on_display ORDER BY sort_order, id');
  const s = await getSettings();
  res.json({ code: d.pair_code, state: d.last_state, images, settings: publicSettings(s) });
});

function validateWindow(settings, start, end) {
  const b = settings.booking;
  if (!b.enabled) throw badRequest('ปิดรับจองออนไลน์ชั่วคราว');
  const now = Date.now();
  if (start.getTime() < now + Number(b.minAdvanceMinutes || 0) * 60000) throw badRequest(`ต้องจองล่วงหน้าอย่างน้อย ${b.minAdvanceMinutes} นาที`);
  if (start.getTime() > now + Number(b.maxAdvanceDays || 60) * 86400000) throw badRequest(`จองล่วงหน้าได้ไม่เกิน ${b.maxAdvanceDays} วัน`);
  if (!withinOpeningHours(start, end, settings.store.openTime, settings.store.closeTime)) throw badRequest(`ร้านเปิด ${settings.store.openTime}–${settings.store.closeTime} น. กรุณาเลือกเวลาในช่วงเปิดร้าน`);
}

const availSchema = z.object({
  branchId: z.coerce.number().int().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  durationMinutes: z.coerce.number().int().min(30).max(12 * 60),
  guests: z.coerce.number().int().min(1).max(100),
  roomTypeId: z.coerce.number().int().optional(),
});

function resolveStart(date, time, settings) {
  // times after midnight but before closing belong to the "next calendar day" of the selected business day
  let start = bkkDateTime(date, time);
  const [oh] = settings.store.openTime.split(':').map(Number);
  const [h] = time.split(':').map(Number);
  if (h < oh && settings.store.closeTime < settings.store.openTime) start = new Date(start.getTime() + 86400000);
  return start;
}

/** Real-time availability straight from the database (reservations + active sessions). */
r.get('/availability', async (req, res) => {
  const q = parse(availSchema, req.query);
  const settings = await getSettings();
  const start = resolveStart(q.date, q.time, settings);
  const end = new Date(start.getTime() + q.durationMinutes * 60000);
  validateWindow(settings, start, end);
  await expireStaleHolds(pool);
  const rooms = await searchRooms(pool, { branchId: q.branchId || null, startAt: start, endAt: end, guests: q.guests, roomTypeId: q.roomTypeId || null });
  const packages = await many('SELECT * FROM room_packages WHERE is_active AND is_online AND deleted_at IS NULL ORDER BY sort_order');
  const out = rooms
    .filter((x) => x.fits)
    .map((room) => {
      const est = estimateReservation({ room, durationMinutes: q.durationMinutes, guestCount: q.guests, settings, startAt: start });
      const pk = packages.filter((p) => !p.room_type_ids?.length || p.room_type_ids.includes(room.room_type_id));
      return {
        id: room.id,
        name: room.name,
        number: room.number,
        imageUrl: room.image_url || room.type_image_url,
        roomTypeId: room.room_type_id,
        typeName: room.type_name,
        typeColor: room.type_color,
        capacity: room.capacity,
        amenities: room.amenities,
        priceHour: Number(room.price_hour),
        priceHalf: Number(room.price_half),
        available: room.available,
        estimate: est.calc.grandTotal,
        deposit: est.deposit,
        packages: pk.map((p) => ({ id: p.id, name: p.name, price: Number(p.price), minutes: p.hours * 60 + p.minutes })),
      };
    });
  const availableCount = out.filter((x) => x.available).length;
  const suggestions = availableCount ? null : await suggestAlternatives(pool, { branchId: q.branchId || null, startAt: start, durationMinutes: q.durationMinutes, guests: q.guests, roomTypeId: q.roomTypeId || null, openTime: settings.store.openTime, closeTime: settings.store.closeTime });
  res.json({ startAt: start, endAt: end, rooms: out.filter((x) => x.available), unavailable: out.filter((x) => !x.available).map((x) => ({ id: x.id, name: x.name, typeName: x.typeName })), suggestions });
});

/** 30-min slot grid of one room for a day (green = free, red = booked). */
r.get('/rooms/:id/slots', async (req, res) => {
  const { date, durationMinutes } = parse(z.object({ date: z.string(), durationMinutes: z.coerce.number().int().min(30).default(60) }), req.query);
  const settings = await getSettings();
  const room = await one('SELECT * FROM rooms WHERE id = $1 AND deleted_at IS NULL', [req.params.id]);
  if (!room) throw notFound();
  const [oh, om] = settings.store.openTime.split(':').map(Number);
  let open = bkkDateTime(date, settings.store.openTime);
  let close = bkkDateTime(date, settings.store.closeTime);
  if (close <= open) close = new Date(close.getTime() + 86400000);
  const busy = (
    await pool.query(
      `SELECT start_at AS s, end_at AS e FROM reservations WHERE room_id = $1 AND status IN ('HOLD','PENDING','CONFIRMED','DEPOSIT_PAID','WAITING','ARRIVED','IN_USE') AND NOT (status = 'HOLD' AND hold_expires_at < now()) AND tstzrange(start_at,end_at) && tstzrange($2,$3)
       UNION ALL SELECT started_at, GREATEST(scheduled_end_at, now()) FROM room_sessions WHERE room_id = $1 AND status IN ('SCHEDULED','ACTIVE','PAUSED','CLOSED')`,
      [room.id, open, close],
    )
  ).rows;
  const slots = [];
  for (let t = open.getTime(); t + durationMinutes * 60000 <= close.getTime(); t += 30 * 60000) {
    const s = t;
    const e = t + durationMinutes * 60000;
    const taken = busy.some((b) => new Date(b.s).getTime() < e && new Date(b.e).getTime() > s);
    slots.push({ startAt: new Date(s), time: fmtTime(new Date(s)), available: !taken && s > Date.now() + Number(settings.booking.minAdvanceMinutes) * 60000 });
  }
  res.json({ roomId: room.id, date, openTime: `${String(oh).padStart(2, '0')}:${String(om).padStart(2, '0')}`, slots });
});

// ───────────── Holds (temporary room lock) ─────────────
const holdSchema = z.object({
  roomId: z.coerce.number().int(),
  startAt: z.string(),
  durationMinutes: z.coerce.number().int().min(30).max(12 * 60),
  guestCount: z.coerce.number().int().min(1).max(100),
  packageId: z.coerce.number().int().optional().nullable(),
});

r.post('/holds', optionalMember, async (req, res) => {
  const b = parse(holdSchema, req.body);
  const settings = await getSettings();
  const start = new Date(b.startAt);
  const end = new Date(start.getTime() + b.durationMinutes * 60000);
  validateWindow(settings, start, end);
  try {
    const out = await tx(async (c) => {
      await expireStaleHolds(c);
      const room = await lockRoom(c, b.roomId);
      if (!room || !room.is_active || ['MAINTENANCE', 'DISABLED'].includes(room.status)) throw notFound('ไม่พบห้อง');
      if (room.capacity < b.guestCount) throw badRequest(`ห้องนี้รองรับได้ ${room.capacity} คน`);
      await assertRoomFree(c, room.id, start, end);
      const pkg = b.packageId ? (await c.query('SELECT * FROM room_packages WHERE id = $1 AND is_active AND is_online', [b.packageId])).rows[0] : null;
      if (b.packageId && !pkg) throw badRequest('แพ็กเกจนี้ไม่สามารถจองออนไลน์ได้');
      if (pkg && pkg.hours * 60 + pkg.minutes > b.durationMinutes) throw badRequest('ระยะเวลาน้อยกว่าเวลาของแพ็กเกจ');
      const est = estimateReservation({ room: { ...room, type_deposit: 0 }, pkg, durationMinutes: b.durationMinutes, guestCount: b.guestCount, settings, startAt: start });
      const holdMin = Number(settings.booking.holdMinutes || 10);
      const expires = new Date(Date.now() + holdMin * 60000);
      const holdToken = randomToken(24);
      const m = req.member;
      const rv = (
        await c.query(
          `INSERT INTO reservations(booking_no, branch_id, room_id, room_type_id, member_id, customer_name, phone, guest_count, package_id, start_at, end_at, duration_minutes,
             estimated_total, estimate_snapshot, deposit_required, status, source, check_in_token, hold_expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'HOLD','ONLINE',$16,$17) RETURNING *`,
          [await nextBookingNo(c), room.branch_id, room.id, room.room_type_id, m?.id || null, m ? `${m.first_name} ${m.last_name || ''}`.trim() : 'ลูกค้าออนไลน์', m?.phone || '-', b.guestCount, pkg?.id || null, start, end, b.durationMinutes, est.calc.grandTotal, est.calc, est.deposit, randomToken(18), expires],
        )
      ).rows[0];
      await c.query('INSERT INTO reservation_holds(reservation_id, hold_token, expires_at) VALUES ($1,$2,$3)', [rv.id, holdToken, expires]);
      await logActivity(c, actor('ONLINE'), 'ONLINE_HOLD', 'reservation', rv.id, { room: room.name, start, end });
      return { holdToken, expiresAt: expires, bookingNo: rv.booking_no, reservationId: rv.id, estimate: est.calc, deposit: est.deposit };
    });
    emitSync(['reservations', 'availability']);
    res.json(out);
  } catch (e) {
    if (e.code === '23P01' || e.code === 'ROOM_TAKEN') {
      const suggestions = await suggestAlternatives(pool, { startAt: start, durationMinutes: b.durationMinutes, guests: b.guestCount, openTime: settings.store.openTime, closeTime: settings.store.closeTime });
      return res.status(409).json({ error: 'ขออภัย ห้องนี้เพิ่งถูกจอง กรุณาเลือกห้องหรือช่วงเวลาอื่น', code: 'ROOM_TAKEN', suggestions });
    }
    throw e;
  }
});

async function loadHold(c, token, lock = false) {
  const h = (await c.query(`SELECT * FROM reservation_holds WHERE hold_token = $1`, [token])).rows[0];
  if (!h) throw notFound('ไม่พบรายการจอง');
  const rv = (
    await c.query(
      `SELECT rv.*, rm.name AS room_name, rm.capacity AS room_capacity, rm.image_url AS room_image, rt.name AS type_name, p.name AS package_name
       FROM reservations rv JOIN rooms rm ON rm.id = rv.room_id JOIN room_types rt ON rt.id = rv.room_type_id LEFT JOIN room_packages p ON p.id = rv.package_id
       WHERE rv.id = $1 ${lock ? 'FOR UPDATE OF rv' : ''}`,
      [h.reservation_id],
    )
  ).rows[0];
  return { hold: h, reservation: rv };
}

function publicBooking(rv, extra = {}) {
  return {
    bookingNo: rv.booking_no,
    status: rv.status,
    customerName: rv.customer_name,
    phone: rv.phone,
    roomName: rv.room_name,
    typeName: rv.type_name,
    roomImage: rv.room_image,
    packageName: rv.package_name,
    startAt: rv.start_at,
    endAt: rv.end_at,
    durationMinutes: rv.duration_minutes,
    guestCount: rv.guest_count,
    estimatedTotal: Number(rv.estimated_total),
    depositRequired: Number(rv.deposit_required),
    depositPaid: Number(rv.deposit_paid),
    remainingEstimate: round2(Math.max(0, Number(rv.estimated_total) - Number(rv.deposit_paid))),
    holdExpiresAt: rv.hold_expires_at,
    checkInToken: ['CONFIRMED', 'DEPOSIT_PAID', 'WAITING', 'ARRIVED', 'IN_USE', 'PENDING'].includes(rv.status) ? rv.check_in_token : null,
    estimate: rv.estimate_snapshot,
    note: rv.note,
    createdAt: rv.created_at,
    ...extra,
  };
}

r.get('/holds/:token', async (req, res) => {
  await expireStaleHolds(pool);
  const { reservation: rv } = await loadHold(pool, req.params.token);
  const ptx = await one(`SELECT id, amount, status, qr_data, qr_image_url, expires_at, reference FROM payment_transactions WHERE reservation_id = $1 ORDER BY created_at DESC LIMIT 1`, [rv.id]);
  const ver = await one(`SELECT result, failure_reason, created_at FROM payment_verifications WHERE reservation_id = $1 ORDER BY id DESC LIMIT 1`, [rv.id]);
  res.json({ ...publicBooking(rv), payment: ptx, verification: ver, now: Date.now() });
});

r.delete('/holds/:token', async (req, res) => {
  await tx(async (c) => {
    const { hold, reservation: rv } = await loadHold(c, req.params.token, true);
    if (rv.status !== 'HOLD') return;
    await c.query(`UPDATE reservations SET status = 'EXPIRED', updated_at = now() WHERE id = $1`, [rv.id]);
    await c.query(`UPDATE reservation_holds SET released_at = now(), release_reason = 'RELEASED_BY_CUSTOMER' WHERE id = $1`, [hold.id]);
    await c.query(`UPDATE payment_transactions SET status = 'CANCELLED' WHERE reservation_id = $1 AND status IN ('PENDING','FAILED')`, [rv.id]);
  });
  emitSync(['reservations', 'availability']);
  res.json({ ok: true });
});

/** Customer details + promotion → final estimate, deposit and a PromptPay QR payment transaction. */
r.post('/holds/:token/details', optionalMember, async (req, res) => {
  const b = parse(
    z.object({
      customerName: z.string().min(1, 'กรุณากรอกชื่อ').max(200),
      phone: z.string().min(9, 'กรุณากรอกเบอร์โทร').max(20),
      email: z.string().email().optional().nullable().or(z.literal('')),
      note: z.string().max(500).optional().nullable(),
      promotionId: z.coerce.number().int().optional().nullable(),
      promoCode: z.string().max(50).optional().nullable(),
      acceptPolicy: z.literal(true, { message: 'กรุณายอมรับเงื่อนไขการจอง' }),
    }),
    req.body,
  );
  const settings = await getSettings();
  const out = await tx(async (c) => {
    await expireStaleHolds(c);
    const { reservation: rv } = await loadHold(c, req.params.token, true);
    assertBookable(rv);
    if (rv.status !== 'HOLD') throw conflict('รายการนี้ยืนยันแล้ว');
    const phone = normalizePhone(b.phone);
    let memberId = rv.member_id;
    if (req.member) memberId = req.member.id;
    let promo = null;
    if (b.promoCode) {
      promo = (await c.query('SELECT * FROM promotions WHERE upper(code) = upper($1) AND is_active AND is_online AND deleted_at IS NULL', [b.promoCode])).rows[0];
      if (!promo) throw badRequest('Promo Code ไม่ถูกต้องหรือหมดอายุ');
    } else if (b.promotionId) {
      promo = (await c.query('SELECT * FROM promotions WHERE id = $1 AND is_active AND is_online AND code IS NULL AND deleted_at IS NULL', [b.promotionId])).rows[0];
    }
    const room = (await c.query('SELECT r.*, rt.default_deposit AS type_deposit FROM rooms r JOIN room_types rt ON rt.id = r.room_type_id WHERE r.id = $1', [rv.room_id])).rows[0];
    const pkg = rv.package_id ? (await c.query('SELECT * FROM room_packages WHERE id = $1', [rv.package_id])).rows[0] : null;
    const member = memberId ? (await c.query('SELECT * FROM members WHERE id = $1', [memberId])).rows[0] : null;
    const est = estimateReservation({ room, pkg, durationMinutes: rv.duration_minutes, guestCount: rv.guest_count, settings, promotion: promo ? { ...promo, code: b.promoCode || promo.code } : null, member, startAt: rv.start_at });
    if (promo && !est.promotion?.eligible) throw badRequest(`ไม่สามารถใช้โปรโมชั่นนี้ได้: ${est.promotion?.reason || ''}`);
    await c.query(
      `UPDATE reservations SET customer_name = $2, phone = $3, member_id = $4, note = $5, promotion_id = $6, estimated_total = $7, estimate_snapshot = $8, deposit_required = $9, updated_at = now() WHERE id = $1`,
      [rv.id, b.customerName, phone, memberId, b.note || null, promo?.id || null, est.calc.grandTotal, est.calc, est.deposit],
    );
    if (est.deposit <= 0) {
      await c.query(`UPDATE reservations SET status = 'PENDING', hold_expires_at = NULL WHERE id = $1`, [rv.id]);
      await c.query(`UPDATE reservation_holds SET released_at = now(), release_reason = 'CONFIRMED_NO_DEPOSIT' WHERE reservation_id = $1 AND released_at IS NULL`, [rv.id]);
      await notify({ type: 'ONLINE_BOOKING', level: 'info', title: 'Online Booking ใหม่', message: `${rv.booking_no} ${b.customerName} (${rv.room_name}) รอยืนยัน`, reservationId: rv.id, roomId: rv.room_id }, c);
      return { requiresPayment: false };
    }
    // payment transaction (idempotent per amount)
    await c.query(`UPDATE payment_transactions SET status = 'CANCELLED', updated_at = now() WHERE reservation_id = $1 AND status IN ('PENDING','FAILED') AND amount <> $2`, [rv.id, est.deposit]);
    let ptx = (await c.query(`SELECT * FROM payment_transactions WHERE reservation_id = $1 AND status IN ('PENDING','FAILED','VERIFYING','MANUAL_REVIEW') ORDER BY created_at DESC LIMIT 1`, [rv.id])).rows[0];
    if (!ptx) {
      const provider = getPaymentProvider();
      const qr = await provider.createQr({ amount: est.deposit, reference: rv.booking_no, settings });
      ptx = (
        await c.query(
          `INSERT INTO payment_transactions(reservation_id, member_id, purpose, provider, method, amount, reference, qr_data, qr_image_url, expires_at, idempotency_key)
           VALUES ($1,$2,'DEPOSIT',$3,'PROMPTPAY',$4,$5,$6,$7,$8,$9) RETURNING *`,
          [rv.id, memberId, provider.name, est.deposit, rv.booking_no, qr.qrData, qr.qrImageUrl, rv.hold_expires_at, `dep:${rv.id}:${est.deposit}`],
        )
      ).rows[0];
    }
    return { requiresPayment: true, payment: { id: ptx.id, amount: Number(ptx.amount), qrData: ptx.qr_data, qrImageUrl: ptx.qr_image_url, expiresAt: ptx.expires_at, status: ptx.status } };
  });
  const { reservation: fresh } = await loadHold(pool, req.params.token);
  emitSync(['reservations']);
  res.json({ ...out, booking: publicBooking(fresh), paymentInfo: publicSettings(settings).payment });
});

// slips are transaction documents (not store content) — stored privately on the server
const slipUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _f, cb) => {
      const dir = path.join(config.uploadDir, 'slips');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, f, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${path.extname(f.originalname || '.jpg').toLowerCase()}`),
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, f, cb) => (/image\/(jpe?g|png)/.test(f.mimetype) ? cb(null, true) : cb(Object.assign(new Error('รองรับเฉพาะไฟล์ JPG, JPEG, PNG'), { status: 400 }))),
});

r.post('/holds/:token/slip', (req, res, next) => slipUpload.single('slip')(req, res, (err) => (err ? res.status(400).json({ error: err.message }) : next())), async (req, res) => {
  if (!req.file) throw badRequest('กรุณาอัปโหลดสลิป (JPG/PNG)');
  const settings = await getSettings();
  const hash = fileHash(req.file.path);
  // phase 1: validate + create verification record
  const pre = await tx(async (c) => {
    await expireStaleHolds(c);
    const { reservation: rv } = await loadHold(c, req.params.token, true);
    assertBookable(rv);
    if (!['HOLD', 'PENDING'].includes(rv.status)) throw conflict('รายการนี้ชำระเงินแล้ว');
    const ptx = (await c.query(`SELECT * FROM payment_transactions WHERE reservation_id = $1 AND status IN ('PENDING','FAILED') ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [rv.id])).rows[0];
    if (!ptx) throw conflict('ไม่พบรายการชำระเงิน หรือกำลังตรวจสอบอยู่');
    if (ptx.expires_at && new Date(ptx.expires_at) < new Date()) throw conflict('การชำระเงินหมดอายุ', 'HOLD_EXPIRED');
    const dup = (await c.query(`SELECT 1 FROM payment_verifications WHERE slip_hash = $1 AND result = 'PASSED'`, [hash])).rows[0];
    const pv = (
      await c.query(`INSERT INTO payment_verifications(payment_transaction_id, reservation_id, provider, amount, slip_path, slip_hash, result) VALUES ($1,$2,$3,$4,$5,$6,'PENDING') RETURNING *`, [ptx.id, rv.id, getSlipProvider().name, ptx.amount, req.file.path, hash])
    ).rows[0];
    if (dup) {
      await c.query(`UPDATE payment_verifications SET result = 'FAILED', failure_reason = $2, verified_at = now() WHERE id = $1`, [pv.id, 'พบรายการนี้ถูกใช้แล้ว']);
      return { duplicate: true };
    }
    await c.query(`UPDATE payment_transactions SET status = 'VERIFYING', updated_at = now() WHERE id = $1`, [ptx.id]);
    return { rv, ptx, pv };
  });
  if (pre.duplicate) return res.status(422).json({ error: 'พบรายการนี้ถูกใช้แล้ว', code: 'SLIP_DUPLICATE' });
  const { rv, ptx, pv } = pre;
  // phase 2: provider call (outside the DB transaction)
  let v;
  try {
    v = await getSlipProvider().verify({ filePath: req.file.path, expectedAmount: Number(ptx.amount), receiver: settings.payment });
  } catch (e) {
    v = { ok: false, manualReview: true, reason: 'ไม่สามารถเชื่อมต่อระบบตรวจสอบสลิปได้', raw: { error: e.message } };
  }
  if (v.ok) {
    if (Math.abs(Number(v.amount) - Number(ptx.amount)) > 0.009) v = { ...v, ok: false, reason: `ยอดเงินไม่ตรง (สลิป ${v.amount} บาท / ต้องชำระ ${ptx.amount} บาท)` };
    else if (v.paidAt && new Date(v.paidAt).getTime() < new Date(ptx.created_at).getTime() - 30 * 60000) v = { ...v, ok: false, reason: 'วันที่/เวลาในสลิปไม่ตรงกับรายการนี้' };
    else if (v.receiverAccount && settings.payment.accountNumber && !String(v.receiverAccount).replace(/\D/g, '').includes(String(settings.payment.accountNumber).replace(/\D/g, '').slice(-4))) v = { ...v, ok: false, reason: 'บัญชีผู้รับเงินไม่ตรง' };
  }
  // phase 3: record result atomically (unique constraints stop slip reuse / races)
  let result;
  try {
    result = await tx(async (c) => {
      const cur = (await c.query('SELECT * FROM reservations WHERE id = $1 FOR UPDATE', [rv.id])).rows[0];
      if (v.ok) {
        await c.query(`UPDATE payment_verifications SET result = 'PASSED', transaction_ref = $2, amount = $3, verified_at = now(), raw_provider_ref = $4 WHERE id = $1`, [pv.id, v.transactionRef, v.amount, v.raw || {}]);
        if (cur.status === 'EXPIRED') {
          // paid just after expiry: keep money traceable, staff must resolve
          await c.query(`UPDATE payment_transactions SET status = 'PAID', paid_at = now(), provider_reference = $2 WHERE id = $1`, [ptx.id, v.transactionRef]);
          await notify({ type: 'SLIP_LATE', level: 'warning', title: 'ชำระเงินหลังหมดเวลาล็อกห้อง', message: `${cur.booking_no} ชำระ ${ptx.amount} บาท หลังห้องถูกปล่อย กรุณาติดต่อลูกค้า`, reservationId: cur.id }, c);
          return { status: 'PAID_AFTER_EXPIRY' };
        }
        await confirmOnlineDeposit(c, { reservation: cur, paymentTx: ptx, amount: Number(ptx.amount), reference: v.transactionRef, slipPath: req.file.path });
        await notify({ type: 'ONLINE_BOOKING', level: 'success', title: 'Online Booking ใหม่', message: `${cur.booking_no} ${cur.customer_name} ${fmtDate(cur.start_at)} ${fmtTime(cur.start_at)}`, reservationId: cur.id, roomId: cur.room_id }, c);
        await logActivity(c, actor('ONLINE'), 'ONLINE_DEPOSIT_PAID', 'reservation', cur.id, { amount: ptx.amount, ref: v.transactionRef });
        return { status: 'PAID' };
      }
      if (v.manualReview) {
        await c.query(`UPDATE payment_verifications SET result = 'MANUAL_REVIEW', failure_reason = $2, raw_provider_ref = $3 WHERE id = $1`, [pv.id, v.reason, v.raw || {}]);
        await c.query(`UPDATE payment_transactions SET status = 'MANUAL_REVIEW', updated_at = now() WHERE id = $1`, [ptx.id]);
        // keep the room locked while staff reviews
        await c.query(`UPDATE reservations SET hold_expires_at = GREATEST(hold_expires_at, now() + interval '60 minutes') WHERE id = $1 AND status = 'HOLD'`, [cur.id]);
        await c.query(`UPDATE reservation_holds SET expires_at = GREATEST(expires_at, now() + interval '60 minutes') WHERE reservation_id = $1 AND released_at IS NULL`, [cur.id]);
        await notify({ type: 'SLIP_REVIEW', level: 'warning', title: 'สลิปรอตรวจสอบ', message: `${cur.booking_no} ${cur.customer_name} ยอด ${ptx.amount} บาท — ${v.reason || 'รอพนักงานตรวจสอบ'}`, reservationId: cur.id }, c);
        return { status: 'MANUAL_REVIEW' };
      }
      await c.query(`UPDATE payment_verifications SET result = 'FAILED', failure_reason = $2, verified_at = now(), raw_provider_ref = $3, transaction_ref = NULL WHERE id = $1`, [pv.id, v.reason, v.raw || {}]);
      await c.query(`UPDATE payment_transactions SET status = 'FAILED', updated_at = now() WHERE id = $1`, [ptx.id]);
      await notify({ type: 'SLIP_FAILED', level: 'error', title: 'Slip Verification Failed', message: `${cur.booking_no}: ${v.reason}`, reservationId: cur.id }, c);
      return { status: 'FAILED', reason: v.reason };
    });
  } catch (e) {
    if (e.code === '23505') {
      await pool.query(`UPDATE payment_verifications SET result = 'FAILED', failure_reason = 'พบรายการนี้ถูกใช้แล้ว', verified_at = now() WHERE id = $1`, [pv.id]);
      await pool.query(`UPDATE payment_transactions SET status = 'FAILED' WHERE id = $1`, [ptx.id]);
      result = { status: 'FAILED', reason: 'พบรายการนี้ถูกใช้แล้ว' };
    } else throw e;
  }
  await refreshRoomStatuses(settings);
  emitSync(['reservations', 'rooms', 'notifications']);
  const { reservation: fresh } = await loadHold(pool, req.params.token);
  if (result.status === 'FAILED') return res.status(422).json({ error: result.reason || 'ไม่สามารถตรวจสอบรายการได้ กรุณาติดต่อพนักงาน', code: 'SLIP_FAILED', booking: publicBooking(fresh) });
  res.json({ status: result.status, booking: publicBooking(fresh) });
});

// ───────────── Booking lookup / cancel / calendar ─────────────
async function findBooking(bookingNo, phone) {
  const rv = await one(
    `SELECT rv.*, rm.name AS room_name, rm.image_url AS room_image, rt.name AS type_name, p.name AS package_name FROM reservations rv JOIN rooms rm ON rm.id = rv.room_id
     JOIN room_types rt ON rt.id = rv.room_type_id LEFT JOIN room_packages p ON p.id = rv.package_id WHERE upper(rv.booking_no) = upper($1)`,
    [String(bookingNo).trim()],
  );
  if (!rv || rv.phone !== normalizePhone(phone)) throw notFound('ไม่พบการจอง กรุณาตรวจสอบเลขที่จองและเบอร์โทร');
  return rv;
}

r.get('/bookings/lookup', async (req, res) => {
  const { bookingNo, phone } = parse(z.object({ bookingNo: z.string().min(3), phone: z.string().min(9) }), req.query);
  const rv = await findBooking(bookingNo, phone);
  const settings = await getSettings();
  const held = await one(`SELECT COALESCE(SUM(amount - refunded_amount),0) AS amt FROM deposits WHERE reservation_id = $1 AND status = 'RECEIVED' AND verification_status = 'VERIFIED'`, [rv.id]);
  res.json({ ...publicBooking(rv), cancelPreview: calculateCancellationRefund(Number(held.amt), rv.start_at, settings.booking.cancellation), canCancel: settings.booking.cancellation.allowOnline && ['PENDING', 'CONFIRMED', 'DEPOSIT_PAID'].includes(rv.status) && new Date(rv.start_at) > new Date() });
});

r.post('/bookings/:bookingNo/cancel', optionalMember, async (req, res) => {
  const b = parse(z.object({ phone: z.string().min(9), reason: z.string().max(300).default('ลูกค้ายกเลิกผ่านเว็บไซต์'), otpToken: z.string().optional().nullable() }), req.body);
  const settings = await getSettings();
  if (!settings.booking.cancellation.allowOnline) throw forbidden('กรุณาติดต่อร้านเพื่อยกเลิกการจอง');
  const out = await tx(async (c) => {
    const rv0 = await findBooking(req.params.bookingNo, b.phone);
    const rv = (await c.query('SELECT * FROM reservations WHERE id = $1 FOR UPDATE', [rv0.id])).rows[0];
    // ownership: logged-in member or a phone verified by OTP
    const otp = b.otpToken ? verifyToken(b.otpToken) : null;
    const owns = (req.member && req.member.id === rv.member_id) || (otp?.typ === 'otp' && otp.phone === rv.phone);
    if (!owns) throw unauthorized('กรุณายืนยันตัวตนด้วย OTP หรือเข้าสู่ระบบสมาชิก');
    if (!['PENDING', 'CONFIRMED', 'DEPOSIT_PAID'].includes(rv.status) || new Date(rv.start_at) <= new Date()) throw conflict('ไม่สามารถยกเลิกการจองนี้ทางออนไลน์ได้');
    const held = (await c.query(`SELECT COALESCE(SUM(amount - refunded_amount),0) AS amt FROM deposits WHERE reservation_id = $1 AND status = 'RECEIVED' AND verification_status = 'VERIFIED'`, [rv.id])).rows[0];
    const preview = calculateCancellationRefund(Number(held.amt), rv.start_at, settings.booking.cancellation);
    // money must be returned by staff (transfer) → refund request for POS; deposit kept RECEIVED until processed
    await c.query(`UPDATE reservations SET status = 'CANCELLED', cancelled_at = now(), cancel_reason = $2, updated_at = now() WHERE id = $1`, [rv.id, `${b.reason} | คืนตามนโยบาย ${preview.percent}% = ${preview.amount} บาท`]);
    if (preview.amount <= 0) await c.query(`UPDATE deposits SET status = 'FORFEITED' WHERE reservation_id = $1 AND status = 'RECEIVED'`, [rv.id]);
    else await notify({ type: 'REFUND_REQUEST', level: 'warning', title: 'คำขอคืนเงินมัดจำ (ลูกค้ายกเลิกออนไลน์)', message: `${rv.booking_no} ${rv.customer_name} คืน ${preview.amount} บาท (${preview.percent}%)`, reservationId: rv.id, data: { refundAmount: preview.amount } }, c);
    await logActivity(c, actor('ONLINE'), 'ONLINE_CANCEL', 'reservation', rv.id, { reason: b.reason, preview });
    return preview;
  });
  emitSync(['reservations', 'rooms', 'availability']);
  res.json({ ok: true, refund: out });
});

r.get('/bookings/:bookingNo/ics', async (req, res) => {
  const rv = await findBooking(req.params.bookingNo, req.query.phone);
  const s = await getSettings();
  const f = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//BEATBOX//Booking//TH', 'BEGIN:VEVENT',
    `UID:${rv.booking_no}@beatbox`, `DTSTAMP:${f(new Date())}`, `DTSTART:${f(rv.start_at)}`, `DTEND:${f(rv.end_at)}`,
    `SUMMARY:${s.store.name} - ${rv.room_name}`, `DESCRIPTION:เลขที่จอง ${rv.booking_no} จำนวน ${rv.guest_count} ท่าน`, `LOCATION:${(s.store.address || '').replace(/\n/g, ' ')}`,
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${rv.booking_no}.ics"`);
  res.send(ics);
});

r.get('/checkin/:token', async (req, res) => {
  const rv = await one(`SELECT rv.*, rm.name AS room_name, rt.name AS type_name, p.name AS package_name FROM reservations rv JOIN rooms rm ON rm.id = rv.room_id JOIN room_types rt ON rt.id = rv.room_type_id LEFT JOIN room_packages p ON p.id = rv.package_id WHERE rv.check_in_token = $1`, [req.params.token]);
  if (!rv) throw notFound();
  res.json(publicBooking(rv));
});

// ───────────── Member authentication (phone OTP / LINE) ─────────────
r.post('/auth/otp/request', async (req, res) => {
  const { phone, purpose } = parse(z.object({ phone: z.string().min(9).max(20), purpose: z.enum(['LOGIN', 'LINK', 'CANCEL']).default('LOGIN') }), req.body);
  const p = normalizePhone(phone);
  if (!/^0\d{8,9}$/.test(p)) throw badRequest('เบอร์โทรศัพท์ไม่ถูกต้อง');
  const recent = await one(`SELECT COUNT(*) AS n FROM otp_codes WHERE phone = $1 AND created_at > now() - interval '10 minutes'`, [p]);
  if (Number(recent.n) >= 5) throw badRequest('ขอรหัส OTP บ่อยเกินไป กรุณารอ 10 นาที');
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await pool.query(`INSERT INTO otp_codes(phone, purpose, code_hash, expires_at) VALUES ($1,$2,$3, now() + interval '5 minutes')`, [p, purpose, await bcrypt.hash(code, 8)]);
  const s = await getSettings();
  let delivered = false;
  try {
    delivered = (await sendSms(p, `รหัส OTP ${s.store.name}: ${code} (ใช้ได้ 5 นาที)`)).delivered;
  } catch (e) {
    console.warn('[otp] sms failed', e.message);
  }
  res.json({ sent: true, delivered, expiresInSeconds: 300, ...(config.otpDebug ? { debugCode: code } : {}) });
});

async function checkOtp(c, phone, code, purpose) {
  const row = (await c.query(`SELECT * FROM otp_codes WHERE phone = $1 AND purpose = $2 AND consumed_at IS NULL AND expires_at > now() ORDER BY id DESC LIMIT 1 FOR UPDATE`, [phone, purpose])).rows[0];
  if (!row) throw badRequest('รหัส OTP หมดอายุ กรุณาขอรหัสใหม่');
  if (row.attempts >= 5) throw badRequest('ใส่รหัสผิดเกินกำหนด กรุณาขอรหัสใหม่');
  const ok = await bcrypt.compare(String(code), row.code_hash);
  if (!ok) {
    await c.query('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1', [row.id]);
    throw badRequest('รหัส OTP ไม่ถูกต้อง');
  }
  await c.query('UPDATE otp_codes SET consumed_at = now() WHERE id = $1', [row.id]);
}

async function createMember(c, { firstName, lastName, phone, source, birthday = null, email = null }) {
  const tier = (await c.query('SELECT id FROM member_tiers WHERE is_active ORDER BY sort_order LIMIT 1')).rows[0];
  const m = (
    await c.query(
      `INSERT INTO members(member_code, first_name, last_name, phone, tier_id, source, birthday, email) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [await nextMemberCode(c), firstName, lastName || null, phone, tier?.id || null, source, birthday, email],
    )
  ).rows[0];
  await c.query(`INSERT INTO member_auth_identities(member_id, provider, provider_user_id) VALUES ($1,'PHONE',$2)`, [m.id, phone]);
  await notify({ type: 'NEW_MEMBER', level: 'info', title: 'สมาชิกใหม่', message: `${firstName} (${phone}) สมัครผ่าน ${source}`, memberId: m.id }, c);
  return m;
}

async function attachLine(c, memberId, line) {
  const taken = (await c.query(`SELECT member_id FROM member_auth_identities WHERE provider = 'LINE' AND provider_user_id = $1 AND status = 'ACTIVE'`, [line.lineUserId])).rows[0];
  if (taken && taken.member_id !== memberId) throw conflict('บัญชี LINE นี้เชื่อมกับสมาชิกอื่นแล้ว');
  if (!taken) {
    await c.query(`INSERT INTO member_auth_identities(member_id, provider, provider_user_id, display_name, picture_url, last_login_at) VALUES ($1,'LINE',$2,$3,$4,now())`, [memberId, line.lineUserId, line.displayName, line.pictureUrl]);
    await c.query(`INSERT INTO line_connections(member_id, line_user_id, display_name, picture_url, messaging_consent, last_login_at) VALUES ($1,$2,$3,$4,$5,now())`, [memberId, line.lineUserId, line.displayName, line.pictureUrl, !!line.consent]);
    await c.query(`UPDATE members SET photo_url = COALESCE(photo_url, $2) WHERE id = $1`, [memberId, line.pictureUrl]);
  }
}

r.post('/auth/otp/verify', async (req, res) => {
  const b = parse(
    z.object({
      phone: z.string().min(9),
      code: z.string().min(4).max(8),
      purpose: z.enum(['LOGIN', 'LINK', 'CANCEL']).default('LOGIN'),
      firstName: z.string().max(100).optional().nullable(),
      lastName: z.string().max(100).optional().nullable(),
      birthday: z.string().optional().nullable().transform((v) => v || null),
      linkToken: z.string().optional().nullable(),
      consent: z.boolean().optional(),
    }),
    req.body,
  );
  const phone = normalizePhone(b.phone);
  const out = await tx(async (c) => {
    await checkOtp(c, phone, b.code, b.purpose);
    if (b.purpose === 'CANCEL') return { otpToken: signToken({ typ: 'otp', phone }, '15m') };
    let member = (await c.query('SELECT * FROM members WHERE phone = $1 AND deleted_at IS NULL', [phone])).rows[0];
    let line = null;
    if (b.purpose === 'LINK') {
      line = b.linkToken ? verifyToken(b.linkToken) : null;
      if (!line || line.typ !== 'line-link') throw badRequest('ลิงก์เชื่อมบัญชี LINE หมดอายุ กรุณาเข้าสู่ระบบด้วย LINE ใหม่');
    }
    if (!member) {
      if (!b.firstName) {
        // phone verified but no profile yet → allow profile completion without re-sending OTP
        return { needProfile: true, profileToken: signToken({ typ: 'otp-profile', phone, link: b.linkToken || null }, '15m') };
      }
      member = await createMember(c, { firstName: b.firstName, lastName: b.lastName, phone, source: line ? 'LINE' : 'ONLINE', birthday: b.birthday });
    }
    if (member.status !== 'ACTIVE') throw forbidden('บัญชีสมาชิกถูกระงับ กรุณาติดต่อร้าน');
    if (line) await attachLine(c, member.id, { ...line, consent: b.consent });
    await c.query(`UPDATE member_auth_identities SET last_login_at = now() WHERE member_id = $1 AND provider = 'PHONE' AND status = 'ACTIVE'`, [member.id]);
    await logActivity(c, actor('MEMBER'), line ? 'MEMBER_LINE_LINK' : 'MEMBER_LOGIN', 'member', member.id, { method: 'OTP' });
    return { token: await createMemberSession(c, member.id), member: { id: member.id, firstName: member.first_name, memberCode: member.member_code } };
  });
  res.json(out);
});

/** Complete profile after a verified OTP (new member). */
r.post('/auth/profile', async (req, res) => {
  const b = parse(z.object({ profileToken: z.string(), firstName: z.string().min(1).max(100), lastName: z.string().max(100).optional().nullable(), birthday: z.string().optional().nullable().transform((v) => v || null), email: z.string().email().optional().nullable().or(z.literal('')).transform((v) => v || null), consent: z.boolean().optional() }), req.body);
  const p = verifyToken(b.profileToken);
  if (!p || p.typ !== 'otp-profile') throw unauthorized('กรุณายืนยัน OTP ใหม่');
  const out = await tx(async (c) => {
    let member = (await c.query('SELECT * FROM members WHERE phone = $1 AND deleted_at IS NULL', [p.phone])).rows[0];
    const line = p.link ? verifyToken(p.link) : null;
    if (!member) member = await createMember(c, { firstName: b.firstName, lastName: b.lastName, phone: p.phone, source: line ? 'LINE' : 'ONLINE', birthday: b.birthday, email: b.email });
    if (line?.typ === 'line-link') await attachLine(c, member.id, { ...line, consent: b.consent });
    return { token: await createMemberSession(c, member.id), member: { id: member.id, firstName: member.first_name, memberCode: member.member_code } };
  });
  emitSync('members');
  res.json(out);
});

r.get('/auth/line/start', async (req, res) => {
  const redirect = String(req.query.redirect || '/book/account');
  if (!lineLogin.enabled()) {
    if (config.isProd) throw badRequest('ยังไม่ได้ตั้งค่า LINE Login');
    return res.redirect(`/book/line-demo?redirect=${encodeURIComponent(redirect)}`);
  }
  const nonce = randomToken(12);
  const state = signToken({ typ: 'line-state', nonce, redirect }, '10m');
  res.redirect(lineLogin.authorizeUrl(state, nonce));
});

async function handleLineProfile(profile, redirect) {
  return tx(async (c) => {
    const ident = (await c.query(`SELECT * FROM member_auth_identities WHERE provider = 'LINE' AND provider_user_id = $1 AND status = 'ACTIVE'`, [profile.lineUserId])).rows[0];
    if (ident) {
      await c.query(`UPDATE member_auth_identities SET last_login_at = now(), display_name = $2, picture_url = $3 WHERE id = $1`, [ident.id, profile.displayName, profile.pictureUrl]);
      await c.query(`UPDATE line_connections SET last_login_at = now(), display_name = $2, picture_url = $3 WHERE line_user_id = $1 AND status = 'CONNECTED'`, [profile.lineUserId, profile.displayName, profile.pictureUrl]);
      const token = await createMemberSession(c, ident.member_id);
      return `${redirect.startsWith('/') ? redirect : '/book/account'}${redirect.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
    }
    // first LINE login: never auto-merge by name — require phone OTP to link to an existing member or create one
    const link = signToken({ typ: 'line-link', ...profile }, '20m');
    return `/book/line-link?link=${encodeURIComponent(link)}&name=${encodeURIComponent(profile.displayName || '')}&redirect=${encodeURIComponent(redirect)}`;
  });
}

r.get('/auth/line/callback', async (req, res) => {
  const st = verifyToken(String(req.query.state || ''));
  if (!st || st.typ !== 'line-state') return res.redirect('/book/login?error=line_state');
  if (req.query.error) return res.redirect('/book/login?error=line_denied');
  try {
    const tok = await lineLogin.exchangeCode(String(req.query.code));
    const idp = await lineLogin.verifyIdToken(tok.id_token, st.nonce);
    const url = await handleLineProfile({ lineUserId: idp.sub, displayName: idp.name, pictureUrl: idp.picture || null }, st.redirect);
    res.redirect(url);
  } catch (e) {
    console.error('[line] callback', e.message);
    res.redirect('/book/login?error=line_failed');
  }
});

// Development-only LINE simulator (when LINE Login is not configured)
r.post('/auth/line/demo', async (req, res) => {
  if (config.isProd || lineLogin.enabled()) throw forbidden();
  const b = parse(z.object({ lineUserId: z.string().min(3).max(64), displayName: z.string().max(100), redirect: z.string().default('/book/account') }), req.body);
  res.json({ url: await handleLineProfile({ lineUserId: `Udemo${b.lineUserId}`, displayName: b.displayName, pictureUrl: null }, b.redirect) });
});

// ───────────── Member area ─────────────
r.get('/me', requireMember, async (req, res) => {
  const m = await one(
    `SELECT m.id, m.member_code, m.first_name, m.last_name, m.nickname, m.phone, m.birthday, m.gender, m.email, m.photo_url, m.points_balance, m.total_spending, m.visit_count,
            m.total_minutes, m.created_at, m.marketing_consent, t.id AS tier_id, t.name AS tier_name, t.color AS tier_color, t.point_multiplier, t.room_discount_percent, t.product_discount_percent, t.benefits
     FROM members m LEFT JOIN member_tiers t ON t.id = m.tier_id WHERE m.id = $1`,
    [req.member.id],
  );
  const nextTier = await one(`SELECT * FROM member_tiers WHERE is_active AND sort_order > COALESCE((SELECT sort_order FROM member_tiers WHERE id = $1), -1) ORDER BY sort_order LIMIT 1`, [m.tier_id]);
  const line = await one(`SELECT line_user_id, display_name, picture_url, messaging_consent, linked_at, last_login_at, status FROM line_connections WHERE member_id = $1 AND status = 'CONNECTED' ORDER BY id DESC LIMIT 1`, [m.id]);
  res.json({ ...m, nextTier, line, lineLoginEnabled: lineLogin.enabled() || !config.isProd });
});

r.put('/me', requireMember, async (req, res) => {
  const b = parse(
    z.object({
      firstName: z.string().min(1).max(100),
      lastName: z.string().max(100).optional().nullable(),
      nickname: z.string().max(100).optional().nullable(),
      birthday: z.string().optional().nullable().transform((v) => v || null),
      gender: z.string().max(20).optional().nullable(),
      email: z.string().email().optional().nullable().or(z.literal('')).transform((v) => v || null),
      photoUrl: z.string().url().optional().nullable().or(z.literal('')).transform((v) => v || null),
      marketingConsent: z.boolean().optional(),
    }),
    req.body,
  );
  await pool.query(
    `UPDATE members SET first_name=$2, last_name=$3, nickname=$4, birthday=COALESCE(birthday, $5), gender=$6, email=$7, photo_url=$8, marketing_consent=COALESCE($9, marketing_consent), updated_at=now() WHERE id=$1`,
    [req.member.id, b.firstName, b.lastName, b.nickname, b.birthday, b.gender, b.email, b.photoUrl, b.marketingConsent ?? null],
  );
  await logActivity(null, actor('MEMBER'), 'MEMBER_SELF_UPDATE', 'member', req.member.id, b);
  res.json({ ok: true });
});

r.get('/me/bookings', requireMember, async (req, res) => {
  const rows = await many(
    `SELECT rv.*, rm.name AS room_name, rm.image_url AS room_image, rt.name AS type_name, p.name AS package_name FROM reservations rv JOIN rooms rm ON rm.id = rv.room_id JOIN room_types rt ON rt.id = rv.room_type_id
     LEFT JOIN room_packages p ON p.id = rv.package_id WHERE (rv.member_id = $1 OR rv.phone = $2) AND rv.status NOT IN ('EXPIRED') ORDER BY rv.start_at DESC LIMIT 100`,
    [req.member.id, req.member.phone],
  );
  const now = Date.now();
  const list = rows.map((x) => publicBooking(x));
  res.json({
    upcoming: list.filter((x) => new Date(x.endAt).getTime() > now && ['HOLD', 'PENDING', 'CONFIRMED', 'DEPOSIT_PAID', 'WAITING', 'ARRIVED', 'IN_USE'].includes(x.status)).reverse(),
    history: list.filter((x) => !(new Date(x.endAt).getTime() > now && ['HOLD', 'PENDING', 'CONFIRMED', 'DEPOSIT_PAID', 'WAITING', 'ARRIVED', 'IN_USE'].includes(x.status))),
  });
});

r.get('/me/visits', requireMember, async (req, res) => {
  res.json(
    await many(
      `SELECT rc.receipt_no, o.queue_no, o.paid_at, o.grand_total, o.points_earned, o.billed_minutes, rm.name AS room_name FROM orders o LEFT JOIN receipts rc ON rc.order_id = o.id
       LEFT JOIN room_sessions rs ON rs.id = o.session_id LEFT JOIN rooms rm ON rm.id = rs.room_id WHERE o.member_id = $1 AND o.status IN ('PAID','PARTIALLY_REFUNDED') ORDER BY o.paid_at DESC LIMIT 100`,
      [req.member.id],
    ),
  );
});

r.get('/me/points', requireMember, async (req, res) => {
  res.json(await many(`SELECT id, type, points, balance_after, source, reason, expires_at, created_at FROM point_ledgers WHERE member_id = $1 ORDER BY id DESC LIMIT 200`, [req.member.id]));
});

r.get('/me/rewards', requireMember, async (req, res) => {
  const rewards = await many(`SELECT id, name, image_url, description, points_cost, reward_type, value, expires_at, quantity_total, quantity_used, limit_per_member FROM rewards WHERE is_active AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at >= CURRENT_DATE) ORDER BY points_cost`);
  const mine = await many(`SELECT rr.id, rr.code, rr.status, rr.points, rr.issued_at, rr.expires_at, rr.used_at, rw.name AS reward_name, rw.image_url FROM reward_redemptions rr JOIN rewards rw ON rw.id = rr.reward_id WHERE rr.member_id = $1 ORDER BY rr.id DESC LIMIT 100`, [req.member.id]);
  res.json({ rewards, redemptions: mine });
});

r.post('/me/rewards/:id/redeem', requireMember, idempotent('member-redeem'), async (req, res) => {
  const out = await tx(async (c) => {
    const rd = await redeemReward(c, { memberId: req.member.id, rewardId: Number(req.params.id), source: 'ONLINE', idempotencyKey: `m:${req.member.id}:${req.idempotencyKey}` });
    await logActivity(c, actor('MEMBER'), 'REWARD_REDEEM_ONLINE', 'member', req.member.id, { code: rd.code, reward: rd.reward_name });
    return rd;
  });
  emitSync('members');
  res.json(out);
});

r.get('/me/coupons', requireMember, async (req, res) => {
  const m = req.member;
  const promos = await many(
    `SELECT id, name, type, value_type, value, code, image_url, description, start_date, end_date, conditions FROM promotions
     WHERE is_active AND deleted_at IS NULL AND (end_date IS NULL OR end_date >= CURRENT_DATE) AND (type IN ('MEMBER','BIRTHDAY','COUPON') OR (conditions->>'member_only')::boolean IS TRUE)
     ORDER BY id DESC`,
  );
  const month = new Date().getMonth() + 1;
  const isBirthdayMonth = m.birthday && new Date(m.birthday).getMonth() + 1 === month;
  res.json(promos.filter((p) => p.type !== 'BIRTHDAY' || isBirthdayMonth).map((p) => ({ ...p, conditions: { ...p.conditions, tier_ids: undefined } })));
});

r.post('/me/line/disconnect', requireMember, async (req, res) => {
  const { otpCode } = parse(z.object({ otpCode: z.string().min(4) }), req.body);
  await tx(async (c) => {
    const phoneIdent = (await c.query(`SELECT 1 FROM member_auth_identities WHERE member_id = $1 AND provider = 'PHONE' AND status = 'ACTIVE'`, [req.member.id])).rows[0];
    if (!phoneIdent) throw badRequest('ต้องมีเบอร์โทรที่ยืนยันแล้วก่อนยกเลิกการเชื่อม LINE');
    await checkOtp(c, req.member.phone, otpCode, 'LINK');
    await c.query(`UPDATE member_auth_identities SET status = 'DISCONNECTED', disconnected_at = now() WHERE member_id = $1 AND provider = 'LINE' AND status = 'ACTIVE'`, [req.member.id]);
    await c.query(`UPDATE line_connections SET status = 'DISCONNECTED', disconnected_at = now() WHERE member_id = $1 AND status = 'CONNECTED'`, [req.member.id]);
    await logActivity(c, actor('MEMBER'), 'MEMBER_LINE_DISCONNECT', 'member', req.member.id, {});
  });
  res.json({ ok: true });
});

r.post('/me/line/connect', requireMember, async (req, res) => {
  const { linkToken, consent } = parse(z.object({ linkToken: z.string(), consent: z.boolean().default(false) }), req.body);
  const line = verifyToken(linkToken);
  if (!line || line.typ !== 'line-link') throw badRequest('ลิงก์หมดอายุ');
  await tx((c) => attachLine(c, req.member.id, { ...line, consent }));
  res.json({ ok: true });
});

r.post('/me/line/consent', requireMember, async (req, res) => {
  const { consent } = parse(z.object({ consent: z.boolean() }), req.body);
  await pool.query(`UPDATE line_connections SET messaging_consent = $2 WHERE member_id = $1 AND status = 'CONNECTED'`, [req.member.id, consent]);
  res.json({ ok: true });
});

r.post('/me/logout', requireMember, async (req, res) => {
  await pool.query('UPDATE member_sessions SET revoked_at = now() WHERE id = $1', [req.memberSessionId]);
  res.json({ ok: true });
});

export default r;

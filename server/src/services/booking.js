import { priceForMinutes, halfHourPrice } from '@beatbox/shared/roomPricing.js';
import { calculateBill, calculateDeposit } from '@beatbox/shared/calc.js';
import { evaluatePromotion } from '@beatbox/shared/promotions.js';
import { taxSnapshot } from './settings.js';
import { nextDepositNo } from './numbers.js';
import { notify, queueLineMessage, bookingMessage } from './notifications.js';
import { conflict } from '../lib/errors.js';

/** Estimated bill of a reservation using the central Calculation Engine. */
export function estimateReservation({ room, pkg = null, durationMinutes, guestCount = 1, settings, promotion = null, member = null, startAt = new Date() }) {
  const priceHour = Number(room.price_hour);
  const priceHalf = Number(room.price_half) || halfHourPrice(priceHour);
  const pkgMin = pkg ? pkg.hours * 60 + pkg.minutes : 0;
  const rest = Math.max(0, durationMinutes - pkgMin);
  const items = [];
  if (pkg) items.push({ type: 'PACKAGE', name: `แพ็กเกจ ${pkg.name}`, qty: 1, unitPrice: Number(pkg.price) });
  if (rest > 0) {
    const p = priceForMinutes(rest, { priceHour, priceHalf, partialRule: 'ROUND_UP' });
    items.push({ type: 'ROOM', name: `ค่าห้อง ${Math.floor(rest / 60) ? Math.floor(rest / 60) + ' ชม. ' : ''}${rest % 60 ? (rest % 60) + ' นาที' : ''}`.trim(), qty: 1, unitPrice: p.amount, detail: p.breakdown });
  }
  const extra = Math.max(0, Number(guestCount) - Number(room.capacity));
  if (extra > 0 && Number(settings.room.extraGuestFee) > 0) items.push({ type: 'EXTRA_GUEST', name: `ค่าลูกค้าเกินจำนวน ${extra} คน`, qty: extra, unitPrice: Number(settings.room.extraGuestFee) });
  const extraDiscounts = [];
  let promoResult = null;
  if (promotion) {
    const pre = calculateBill({ items });
    promoResult = evaluatePromotion(promotion, {
      lines: pre.lines.map((l) => ({ type: l.type, qty: l.qty, unitPrice: l.unitPrice, net: l.net })),
      subtotal: pre.subtotal,
      roomTypeId: room.room_type_id,
      member: member ? { id: member.id, birthday: member.birthday, tierId: member.tier_id } : null,
      now: startAt,
      code: promotion.code,
      priceHour,
    });
    if (promoResult.eligible) extraDiscounts.push({ name: `โปรโมชั่น: ${promotion.name}`, amount: promoResult.amount, source: 'PROMOTION', promotionId: promotion.id });
  }
  const calc = calculateBill({ items, extraDiscounts, tax: taxSnapshot(settings) });
  const depositSettings = settings.deposit;
  const deposit = settings.booking.requireDeposit
    ? calculateDeposit({
        rule: depositSettings.rule,
        fixedAmount: depositSettings.fixedAmount,
        percent: depositSettings.percent,
        roomTypeDeposit: Number(room.deposit) || Number(room.type_deposit || 0),
        packageDeposit: pkg?.deposit,
        promotionDeposit: promotion?.deposit_amount,
        estimatedTotal: calc.grandTotal,
      })
    : 0;
  return { calc, deposit: Math.min(deposit, calc.grandTotal), promotion: promoResult ? { eligible: promoResult.eligible, reason: promoResult.reason, amount: promoResult.amount } : null };
}

/**
 * Mark a reservation's deposit as paid (after a PASSED verification or staff receipt).
 * Payment → PAID, Deposit → VERIFIED, Booking → DEPOSIT_PAID, sends confirmation & syncs POS.
 */
export async function confirmOnlineDeposit(client, { reservation, paymentTx, amount, method = 'QR', reference, slipPath = null, employeeId = null }) {
  await client.query(`UPDATE payment_transactions SET status = 'PAID', paid_at = now(), provider_reference = $2, updated_at = now() WHERE id = $1`, [paymentTx.id, reference]);
  const existing = (await client.query('SELECT * FROM deposits WHERE payment_transaction_id = $1', [paymentTx.id])).rows[0];
  let deposit = existing;
  if (!existing) {
    deposit = (
      await client.query(
        `INSERT INTO deposits(deposit_no, reservation_id, member_id, customer_name, phone, amount, method, slip_url, verification_status, status, received_by, source, payment_transaction_id, note, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'VERIFIED','RECEIVED',$9,'ONLINE',$10,$11,$12) RETURNING *`,
        [await nextDepositNo(client), reservation.id, reservation.member_id, reservation.customer_name, reservation.phone, amount, method, slipPath, employeeId, paymentTx.id, `อ้างอิง ${reference}`, `ptx:${paymentTx.id}`],
      )
    ).rows[0];
  } else {
    await client.query(`UPDATE deposits SET verification_status = 'VERIFIED' WHERE id = $1`, [existing.id]);
  }
  const res = (
    await client.query(
      `UPDATE reservations SET status = CASE WHEN status IN ('HOLD','PENDING','CONFIRMED') THEN 'DEPOSIT_PAID' ELSE status END, deposit_paid = deposit_paid + $2,
         hold_expires_at = NULL, updated_at = now() WHERE id = $1 RETURNING *`,
      [reservation.id, amount],
    )
  ).rows[0];
  await client.query(`UPDATE reservation_holds SET released_at = now(), release_reason = 'CONFIRMED' WHERE reservation_id = $1 AND released_at IS NULL`, [reservation.id]);
  const full = (await client.query('SELECT r.*, rm.name AS room_name FROM reservations r JOIN rooms rm ON rm.id = r.room_id WHERE r.id = $1', [reservation.id])).rows[0];
  await notify({ type: 'DEPOSIT_RECEIVED', level: 'success', title: 'รับมัดจำสำเร็จ', message: `${full.booking_no} ${full.customer_name} มัดจำ ${amount} บาท (${full.room_name})`, reservationId: full.id, roomId: full.room_id, dedupeKey: `dep:${paymentTx.id}` }, client);
  if (full.member_id) {
    await queueLineMessage({ memberId: full.member_id, type: 'BOOKING_CONFIRMED', title: 'ยืนยันการจอง', message: bookingMessage('BOOKING_CONFIRMED', full), reservationId: full.id, dedupeKey: `line-confirm:${full.id}` }, client);
  }
  return { reservation: res, deposit };
}

export function assertBookable(reservation) {
  if (!reservation) throw conflict('ไม่พบการจอง');
  if (reservation.status === 'EXPIRED') throw conflict('การชำระเงินหมดอายุ ห้องถูกปล่อยให้ลูกค้าท่านอื่นแล้ว', 'HOLD_EXPIRED');
  if (reservation.status === 'HOLD' && reservation.hold_expires_at && new Date(reservation.hold_expires_at) < new Date()) throw conflict('การชำระเงินหมดอายุ ห้องถูกปล่อยให้ลูกค้าท่านอื่นแล้ว', 'HOLD_EXPIRED');
}

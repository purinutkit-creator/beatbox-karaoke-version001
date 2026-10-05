// In-room QR ordering (printed on the customer's room ticket) and room problem reports.
//
// Order lifecycle (room_customer_orders):
//   COUNTER → PLACED immediately (items go on the room bill, kitchen ticket prints, customer pays at checkout)
//   NOW     → AWAITING_PAYMENT (PromptPay QR shown to the customer, nothing on the bill yet)
//           → customer sends the slip → VERIFYING
//               · real slip provider says PASSED → PLACED + VERIFIED (prepayment deducted at checkout)
//               · otherwise the cashier gets a popup; when nobody checks within `autoAcceptSeconds`
//                 the order is PLACED with payment AUTO_ACCEPTED (customer sees "paid", kitchen prints)
//                 but the prepayment only counts after the cashier verifies it — never because a timer ran out.
//               · cashier rejects → AWAITING_PAYMENT again (before acceptance) or the prepayment is rejected and
//                 the items stay on the bill to be paid at the counter (after acceptance).
import { pool } from '../db/index.js';
import { calculateBill } from '@beatbox/shared/calc.js';
import { round2 } from '@beatbox/shared/money.js';
import { addProductItem } from './orders.js';
import { taxSnapshot } from './settings.js';
import { nextDepositNo } from './numbers.js';
import { notify } from './notifications.js';
import { emitStaff, emitSync } from '../lib/realtime.js';
import { conflict } from '../lib/errors.js';

export const LIVE_SESSION = ['SCHEDULED', 'ACTIVE', 'PAUSED'];

/** Price the requested items (same rules as the POS) without touching the bill. */
export async function priceItems(c, items, settings) {
  const lines = [];
  for (const it of items) {
    const p = (
      await c.query(
        `SELECT p.*, c.station, sb.quantity AS stock FROM products p LEFT JOIN categories c ON c.id = p.category_id LEFT JOIN stock_balances sb ON sb.product_id = p.id
         WHERE p.id = $1 AND p.deleted_at IS NULL`,
        [it.productId],
      )
    ).rows[0];
    if (!p || !p.is_available || p.is_sold_out || (p.track_stock && Number(p.stock ?? 0) < Number(it.qty))) {
      throw conflict(`${p?.name || 'สินค้า'} หมดหรือไม่พร้อมขาย`, 'SOLD_OUT');
    }
    let unit = Number(p.price);
    let opts = [];
    if (it.options?.length) {
      opts = (await c.query('SELECT id, name, price_delta FROM product_options WHERE product_id = $1 AND id = ANY($2)', [p.id, it.options.map(Number)])).rows;
      unit += opts.reduce((s, o) => s + Number(o.price_delta), 0);
    }
    lines.push({ productId: p.id, name: opts.length ? `${p.name} (${opts.map((o) => o.name).join(', ')})` : p.name, qty: Number(it.qty), unitPrice: round2(unit), note: it.note || null, options: opts.map((o) => o.id), type: 'PRODUCT', scExempt: p.sc_exempt });
  }
  const calc = calculateBill({ items: lines, tax: taxSnapshot(settings) });
  return { lines, amount: calc.grandTotal };
}

async function openShiftId(c) {
  return (await c.query(`SELECT id FROM shifts WHERE status = 'OPEN' ORDER BY id DESC LIMIT 1`)).rows[0]?.id || null;
}

/** Queue kitchen / bar tickets for new items; one POS device claims and prints each job. */
export async function queueKitchenTickets(c, orderId, { source = 'ROOM_QR', note = null } = {}) {
  const o = (await c.query('SELECT o.*, rm.name AS room_name FROM orders o LEFT JOIN room_sessions rs ON rs.id = o.session_id LEFT JOIN rooms rm ON rm.id = rs.room_id WHERE o.id = $1', [orderId])).rows[0];
  const items = (await c.query(`SELECT * FROM order_items WHERE order_id = $1 AND voided_at IS NULL AND kitchen_status = 'NONE' AND station <> 'NONE' AND item_type = 'PRODUCT'`, [orderId])).rows;
  if (!items.length) return [];
  const byStation = {};
  for (const it of items) (byStation[it.station] ||= []).push(it);
  const jobs = [];
  for (const [station, list] of Object.entries(byStation)) {
    const printer = (await c.query(`SELECT id FROM printers WHERE station = $1 AND is_active ORDER BY is_default DESC, id LIMIT 1`, [station])).rows[0];
    const payload = { station, orderNo: o.order_no, room: o.room_name, time: new Date(), employee: 'ลูกค้าสั่งผ่าน QR', note, items: list.map((i) => ({ name: i.name, qty: Number(i.qty), note: i.note })) };
    jobs.push((await c.query(`INSERT INTO print_jobs(printer_id, job_type, reference, payload, status, source) VALUES ($1,'KITCHEN',$2,$3,'QUEUED',$4) RETURNING id`, [printer?.id || null, o.order_no, payload, source])).rows[0].id);
  }
  await c.query(`UPDATE order_items SET kitchen_status = 'SENT', sent_at = now() WHERE id = ANY($1)`, [items.map((i) => i.id)]);
  return jobs;
}

/** Put the order's items on the room bill + kitchen tickets (+ prepayment deposit when paid in advance). */
export async function placeCustomerOrder(c, rco, { paymentStatus = rco.payment_status, verifiedBy = null } = {}) {
  const order = (await c.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [rco.order_id])).rows[0];
  if (order.status !== 'OPEN') throw conflict('บิลห้องนี้ปิดแล้ว');
  const ids = [];
  for (const it of rco.items) {
    const row = await addProductItem(c, order, { productId: it.productId, qty: it.qty, options: it.options || [], note: it.note ? `${it.note} (QR)` : 'สั่งผ่าน QR', employeeId: null, clientOpId: `rco:${rco.id}:${ids.length}` });
    ids.push(row.id);
  }
  let depositId = rco.deposit_id;
  if (rco.pay_mode === 'NOW' && !depositId) {
    const session = (await c.query('SELECT * FROM room_sessions WHERE id = $1', [rco.session_id])).rows[0];
    const verified = paymentStatus === 'VERIFIED';
    depositId = (
      await c.query(
        `INSERT INTO deposits(deposit_no, session_id, reservation_id, member_id, customer_name, phone, amount, method, slip_url, verification_status, status, received_by, shift_id, source, note, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'QR',$8,$9,'RECEIVED',$10,$11,'ROOM_QR',$12,$13) RETURNING id`,
        [await nextDepositNo(c), session.id, session.reservation_id, session.member_id, session.customer_name, session.phone, rco.amount, rco.slip_ref, verified ? 'VERIFIED' : 'PENDING', verifiedBy, await openShiftId(c), `ชำระล่วงหน้าค่าอาหาร (สั่งผ่าน QR #${rco.id})`, `rco:${rco.id}`],
      )
    ).rows[0].id;
  }
  const u = (
    await c.query(
      `UPDATE room_customer_orders SET status = 'PLACED', payment_status = $2, item_ids = $3, deposit_id = $4, accepted_at = COALESCE(accepted_at, now()),
         verified_by = COALESCE($5, verified_by), verified_at = CASE WHEN $2 = 'VERIFIED' THEN COALESCE(verified_at, now()) ELSE verified_at END
       WHERE id = $1 RETURNING *`,
      [rco.id, paymentStatus, ids, depositId, verifiedBy],
    )
  ).rows[0];
  const jobs = await queueKitchenTickets(c, rco.order_id, { note: rco.pay_mode === 'NOW' ? (paymentStatus === 'VERIFIED' ? 'ชำระเงินแล้ว' : 'ชำระแล้ว (รอแคชเชียร์ตรวจสลิป)') : 'ชำระที่เคาน์เตอร์' });
  return { rco: u, jobs };
}

export function announce(jobs) {
  emitSync(['rooms', 'orders', 'room-service', 'print-jobs']);
  if (jobs?.length) emitStaff('print:queued', { jobIds: jobs });
}

/** Scheduler: customer paid but nobody verified within the configured time → accept the order (payment still pending). */
export async function autoAcceptRoomOrders(settings) {
  const secs = Number(settings.roomService?.autoAcceptSeconds ?? 60);
  if (secs <= 0) return;
  const due = (await pool.query(`SELECT id FROM room_customer_orders WHERE status = 'VERIFYING' AND payment_status = 'PENDING' AND submitted_at < now() - ($1 || ' seconds')::interval`, [String(secs)])).rows;
  for (const { id } of due) {
    const c = await pool.connect();
    let jobs = [];
    try {
      await c.query('BEGIN');
      const rco = (await c.query(`SELECT * FROM room_customer_orders WHERE id = $1 AND status = 'VERIFYING' AND payment_status = 'PENDING' FOR UPDATE SKIP LOCKED`, [id])).rows[0];
      if (rco) {
        const out = await placeCustomerOrder(c, rco, { paymentStatus: 'AUTO_ACCEPTED' });
        jobs = out.jobs;
        const room = (await c.query('SELECT rm.id, rm.name FROM room_sessions rs JOIN rooms rm ON rm.id = rs.room_id WHERE rs.id = $1', [rco.session_id])).rows[0];
        await notify({ type: 'ROOM_PREPAY_AUTO', level: 'warning', title: 'ยังไม่ได้ตรวจสลิป (ยืนยันอัตโนมัติให้ลูกค้าแล้ว)', message: `ห้อง ${room.name} ชำระค่าอาหาร ${rco.amount} บาท — กรุณาตรวจสอบสลิป`, roomId: room.id, data: { roomOrderId: rco.id } }, c);
      }
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      console.error('[room-service] auto accept', e.message);
    } finally {
      c.release();
    }
    announce(jobs);
  }
}

/** Open problems + payments waiting for the cashier, grouped per room (for the room board). */
export async function roomServiceState() {
  const issues = (await pool.query(`SELECT i.*, rm.name AS room_name FROM room_issues i JOIN rooms rm ON rm.id = i.room_id WHERE i.status <> 'RESOLVED' ORDER BY i.id`)).rows;
  const payments = (
    await pool.query(
      `SELECT o.*, rm.id AS room_id, rm.name AS room_name FROM room_customer_orders o JOIN room_sessions rs ON rs.id = o.session_id JOIN rooms rm ON rm.id = rs.room_id
       WHERE o.payment_status IN ('PENDING','AUTO_ACCEPTED') AND o.status IN ('VERIFYING','PLACED') ORDER BY o.id`,
    )
  ).rows;
  return { issues, payments };
}

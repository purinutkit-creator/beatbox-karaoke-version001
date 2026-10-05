import { calculateBill, calculatePoints } from '@beatbox/shared/calc.js';
import { evaluatePromotion } from '@beatbox/shared/promotions.js';
import { round2 } from '@beatbox/shared/money.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { taxSnapshot } from './settings.js';
import { sessionCharges, SESSION_SELECT } from './rooms.js';
import { nextOrderNo, nextReceiptNo, nextQueueNo, nextPaymentNo } from './numbers.js';
import { moveStock } from './stock.js';
import { addPointTx, evaluateTier } from './points.js';
import { readApproval, verifyToken } from '../lib/auth.js';
import { paymentMode } from '../providers/slip.js';

export async function createOrder(client, { sessionId = null, reservationId = null, memberId = null, customerName = null, phone = null, employeeId, deviceId = null, shiftId = null, branchId = null, clientOpId = null }) {
  if (clientOpId) {
    const ex = (await client.query('SELECT * FROM orders WHERE client_op_id = $1', [clientOpId])).rows[0];
    if (ex) return ex;
  }
  const orderNo = await nextOrderNo(client);
  const r = await client.query(
    `INSERT INTO orders(order_no, session_id, reservation_id, member_id, customer_name, phone, created_by, device_id, shift_id, branch_id, client_op_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [orderNo, sessionId, reservationId, memberId, customerName, phone, employeeId, deviceId, shiftId, branchId, clientOpId],
  );
  return r.rows[0];
}

export async function addProductItem(client, order, { productId, qty = 1, options = [], note = null, discountType = null, discountValue = 0, employeeId, clientOpId = null }) {
  if (clientOpId) {
    const ex = (await client.query('SELECT * FROM order_items WHERE client_op_id = $1', [clientOpId])).rows[0];
    if (ex) return ex;
  }
  if (order.status !== 'OPEN') throw conflict('บิลนี้ปิดแล้ว ไม่สามารถเพิ่มสินค้าได้');
  const p = (
    await client.query(
      `SELECT p.*, c.station, sb.quantity AS stock FROM products p LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN stock_balances sb ON sb.product_id = p.id WHERE p.id = $1 AND p.deleted_at IS NULL`,
      [productId],
    )
  ).rows[0];
  if (!p) throw notFound('ไม่พบสินค้า');
  if (!p.is_available) throw badRequest(`${p.name} ไม่พร้อมขาย`);
  if (p.is_sold_out || (p.track_stock && Number(p.stock ?? 0) < Number(qty))) throw badRequest(`${p.name} สินค้าหมด/คงเหลือไม่พอ`);
  let unitPrice = Number(p.price);
  let opts = [];
  if (Array.isArray(options) && options.length) {
    const ids = options.map((o) => Number(o.id ?? o)).filter(Boolean);
    opts = (await client.query('SELECT id, group_name, name, price_delta, is_addon FROM product_options WHERE product_id = $1 AND id = ANY($2)', [productId, ids])).rows;
    unitPrice += opts.reduce((s, o) => s + Number(o.price_delta), 0);
  }
  const name = opts.length ? `${p.name} (${opts.map((o) => o.name).join(', ')})` : p.name;
  // same plain product already in the bill (not yet sent to the kitchen) → increase quantity instead of a new line
  if (!opts.length && !note && !Number(discountValue)) {
    const same = (
      await client.query(
        `SELECT id FROM order_items WHERE order_id = $1 AND product_id = $2 AND voided_at IS NULL AND kitchen_status = 'NONE'
           AND options = '[]'::jsonb AND note IS NULL AND COALESCE(discount_value,0) = 0 AND unit_price = $3 ORDER BY id DESC LIMIT 1 FOR UPDATE`,
        [order.id, p.id, round2(unitPrice)],
      )
    ).rows[0];
    if (same) {
      const u = await client.query('UPDATE order_items SET qty = qty + $2 WHERE id = $1 RETURNING *', [same.id, qty]);
      if (clientOpId) await client.query('UPDATE order_items SET client_op_id = COALESCE(client_op_id, $2) WHERE id = $1', [same.id, clientOpId]).catch(() => {});
      return u.rows[0];
    }
  }
  const r = await client.query(
    `INSERT INTO order_items(order_id, item_type, product_id, category_id, name, qty, unit_price, unit_cost, options, note, discount_type, discount_value,
                             sc_exempt, points_eligible, station, created_by, client_op_id)
     VALUES ($1,'PRODUCT',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
    [order.id, p.id, p.category_id, name, qty, round2(unitPrice), p.cost, JSON.stringify(opts), note, discountType, discountValue || 0, p.sc_exempt, p.points_eligible, p.station || 'NONE', employeeId, clientOpId],
  );
  return r.rows[0];
}

async function loadOrderBundle(client, orderId, { lock = false } = {}) {
  const order = (await client.query(`SELECT * FROM orders WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [orderId])).rows[0];
  if (!order) throw notFound('ไม่พบบิล');
  const items = (await client.query('SELECT * FROM order_items WHERE order_id = $1 ORDER BY id', [orderId])).rows;
  const session = order.session_id ? (await client.query(`${SESSION_SELECT} WHERE rs.id = $1`, [order.session_id])).rows[0] : null;
  const member = order.member_id
    ? (await client.query('SELECT m.*, t.name AS tier_name, t.point_multiplier, t.room_discount_percent, t.product_discount_percent FROM members m LEFT JOIN member_tiers t ON t.id = m.tier_id WHERE m.id = $1', [order.member_id])).rows[0]
    : null;
  return { order, items, session, member };
}

async function availableDeposits(client, order) {
  if (!order.session_id && !order.reservation_id) return [];
  return (
    await client.query(
      `SELECT * FROM deposits WHERE status = 'RECEIVED' AND verification_status = 'VERIFIED'
         AND ((session_id IS NOT NULL AND session_id = $1) OR (reservation_id IS NOT NULL AND reservation_id = $2))`,
      [order.session_id, order.reservation_id],
    )
  ).rows;
}

/**
 * Full bill calculation for an order (room charges computed live from the server clock).
 */
export async function computeOrder(client, orderId, settings, { lock = false, nowMs = Date.now() } = {}) {
  const { order, items, session, member } = await loadOrderBundle(client, orderId, { lock });
  const lines = [];
  let charges = null;
  const frozen = order.status !== 'OPEN';
  if (session && !frozen) {
    charges = sessionCharges(session, settings, nowMs);
    charges.lines.forEach((l, idx) => lines.push({ id: `sys-${l.type}-${idx}`, type: l.type, name: l.name, qty: l.qty, unitPrice: l.unitPrice, detail: l.detail, minutes: l.minutes, isSystem: true }));
  }
  for (const it of items) {
    if (frozen && it.voided_at) continue;
    if (it.is_system && !frozen) continue; // stale system lines are recomputed
    lines.push({
      id: it.id,
      type: it.item_type,
      name: it.name,
      productId: it.product_id,
      categoryId: it.category_id,
      qty: Number(it.qty),
      unitPrice: Number(it.unit_price),
      unitCost: Number(it.unit_cost),
      discountType: it.discount_type,
      discountValue: Number(it.discount_value),
      scExempt: it.sc_exempt,
      pointsEligible: it.points_eligible,
      note: it.note,
      options: it.options,
      station: it.station,
      kitchenStatus: it.kitchen_status,
      voided: !!it.voided_at,
      isSystem: it.is_system,
      detail: it.meta?.detail,
      createdAt: it.created_at,
    });
  }
  if (frozen && order.calc_snapshot) {
    return { order, items: lines, session, member, calc: order.calc_snapshot, charges: null, deposits: [], promotions: [], pendingPrepayments: [] };
  }

  // Discounts: tier benefits, promotions, rewards
  const extraDiscounts = [];
  const pre = calculateBill({ items: lines, tax: { ...taxSnapshot(settings), vatEnabled: false, scEnabled: false } });
  const ctx = {
    lines: pre.lines.map((l) => ({ type: l.type, productId: l.productId, categoryId: l.categoryId, qty: l.qty, unitPrice: l.unitPrice, net: l.net })),
    subtotal: pre.subtotal,
    roomTypeId: session?.room_type_id,
    member: member ? { id: member.id, birthday: member.birthday, tierId: member.tier_id } : null,
    now: new Date(nowMs),
    code: order.promo_code,
    priceHour: session ? Number(session.price_hour) : 0,
  };
  if (member && (Number(member.room_discount_percent) > 0 || Number(member.product_discount_percent) > 0)) {
    const roomBase = pre.byGroup.ROOM + pre.byGroup.PACKAGE;
    const amt = round2((roomBase * Number(member.room_discount_percent)) / 100 + (pre.byGroup.PRODUCT * Number(member.product_discount_percent)) / 100);
    if (amt > 0) extraDiscounts.push({ name: `ส่วนลดสมาชิก ${member.tier_name || ''}`.trim(), amount: amt, source: 'TIER' });
  }
  const promoIds = order.promotion_ids || [];
  const promos = (
    await client.query(
      `SELECT * FROM promotions WHERE deleted_at IS NULL AND is_active AND (id = ANY($1) OR auto_apply OR ($2::text IS NOT NULL AND upper(code) = upper($2)))`,
      [promoIds, order.promo_code],
    )
  ).rows;
  const promotionResults = [];
  for (const p of promos) {
    const res = evaluatePromotion(p, ctx);
    promotionResults.push({ id: p.id, name: p.name, eligible: res.eligible, reason: res.reason, amount: res.amount });
    if (res.eligible) extraDiscounts.push({ name: `โปรโมชั่น: ${p.name}`, amount: res.amount, source: 'PROMOTION', promotionId: p.id });
  }
  const redemptions = (order.redemption_ids || []).length
    ? (
        await client.query(
          `SELECT rr.*, rw.name, rw.reward_type, rw.value, rw.product_id FROM reward_redemptions rr JOIN rewards rw ON rw.id = rr.reward_id WHERE rr.id = ANY($1)`,
          [order.redemption_ids],
        )
      ).rows
    : [];
  let pointsUsed = 0;
  for (const rd of redemptions) {
    let amt = Number(rd.value || 0);
    if (rd.reward_type === 'FREE_HOUR' && session) amt = Number(session.price_hour) * (Number(rd.value) || 1);
    if (rd.reward_type === 'EXTRA_30' && session) amt = Number(session.price_half);
    if (['FREE_DRINK', 'FREE_PRODUCT'].includes(rd.reward_type) && rd.product_id) {
      const line = lines.find((l) => l.productId === rd.product_id && !l.voided);
      amt = line ? line.unitPrice : 0;
    }
    pointsUsed += Number(rd.points);
    if (amt > 0) extraDiscounts.push({ name: `แลกคะแนน: ${rd.name}`, amount: amt, source: 'REWARD', redemptionId: rd.id, points: rd.points });
  }

  const deposits = await availableDeposits(client, order);
  // in-room QR prepayments the cashier has not verified yet (not deducted until verified)
  const pendingPrepayments = order.session_id
    ? (
        await client.query(
          `SELECT rco.id, rco.amount, rco.items, rco.payment_status, rco.slip_ref IS NOT NULL AS has_slip, rco.submitted_at FROM room_customer_orders rco
           WHERE rco.session_id = $1 AND rco.payment_status IN ('PENDING','AUTO_ACCEPTED') AND rco.status IN ('VERIFYING','PLACED') ORDER BY rco.id`,
          [order.session_id],
        )
      ).rows
    : [];
  const depositTotal = round2(deposits.reduce((s, d) => s + Number(d.amount) - Number(d.refunded_amount), 0));
  const calc = calculateBill({
    items: lines,
    billDiscount: order.bill_discount_type ? { type: order.bill_discount_type, value: Number(order.bill_discount_value), reason: order.bill_discount_reason } : null,
    extraDiscounts,
    tax: taxSnapshot(settings),
    deposit: depositTotal,
  });
  calc.pointsUsed = pointsUsed;
  const multiplier = member ? Number(member.point_multiplier || 1) : 1;
  calc.pointsPreview = member ? calculatePoints(calc, settings.points, multiplier).points : 0;
  return { order, items: lines, session, member, calc, charges, deposits, promotions: promotionResults, redemptions, pendingPrepayments };
}

/** Validate whether a discount needs manager approval. */
export function discountNeedsApproval(req, settings, calc) {
  if (!calc) return false;
  const manual = calc.lineDiscountTotal + (calc.discounts || []).filter((d) => d.source === 'MANUAL').reduce((s, d) => s + d.amount, 0);
  if (manual <= 0) return false;
  const percent = calc.grossTotal > 0 ? (manual / calc.grossTotal) * 100 : 0;
  const empLimit = Number(req.employee?.discountLimitPercent ?? 0);
  const limitPct = Math.min(empLimit || Infinity, Number(settings.discount.approvalAbovePercent || 100));
  const limitAmt = Number(settings.discount.approvalAboveAmount || Infinity);
  return percent > limitPct || manual > limitAmt;
}

/**
 * Finalize payment of an order. Idempotent (payments carry idempotency keys), locks the order row,
 * snapshots the calculation, issues receipt / queue, cuts stock, earns points, updates member stats.
 */
export async function payOrder(client, req, settings, orderId, { payments, idempotencyKey, approvalToken = null }) {
  const existing = (await client.query('SELECT id FROM payments WHERE idempotency_key = $1', [`${idempotencyKey}:0`])).rows[0];
  if (existing) {
    const rc = (await client.query('SELECT * FROM receipts WHERE order_id = $1', [orderId])).rows[0];
    if (rc) return { replay: true, receipt: rc };
  }
  const lockRow = (await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId])).rows[0];
  if (!lockRow) throw notFound('ไม่พบบิล');
  if (lockRow.status !== 'OPEN') {
    const rc = (await client.query('SELECT * FROM receipts WHERE order_id = $1', [orderId])).rows[0];
    throw conflict('บิลนี้ชำระเงินแล้ว', 'ALREADY_PAID', { receipt: rc });
  }
  const now = new Date();
  // stop the clock if the session is still running
  if (lockRow.session_id) {
    const s = (await client.query('SELECT * FROM room_sessions WHERE id = $1 FOR UPDATE', [lockRow.session_id])).rows[0];
    if (s && ['ACTIVE', 'PAUSED'].includes(s.status)) {
      let paused = Number(s.total_paused_seconds);
      if (s.paused_at) paused += Math.floor((now - new Date(s.paused_at)) / 1000);
      await client.query(`UPDATE room_sessions SET status = 'CLOSED', ended_at = $2, paused_at = NULL, total_paused_seconds = $3, closed_by = $4 WHERE id = $1`, [s.id, now, paused, req.employee.id]);
    }
  }
  const bundle = await computeOrder(client, orderId, settings, { nowMs: now.getTime() });
  const { calc, session, member, items } = bundle;
  if (bundle.pendingPrepayments?.length) throw conflict('มีการชำระเงินล่วงหน้าจากในห้องที่ยังไม่ได้ตรวจสลิป กรุณาตรวจสอบก่อนชำระเงิน', 'PENDING_PREPAYMENT', { pending: bundle.pendingPrepayments });
  if (!items.some((l) => !l.voided)) throw badRequest('ไม่มีรายการในบิล');

  // manager approval for large discounts
  let approvedBy = lockRow.discount_approved_by;
  if (discountNeedsApproval(req, settings, calc) && !approvedBy) {
    const ap = readApproval(approvalToken, 'discount.approve');
    if (!ap) throw conflict('ส่วนลดเกินวงเงินที่กำหนด ต้องให้ผู้จัดการอนุมัติ', 'APPROVAL_REQUIRED');
    approvedBy = ap.id;
  }

  // validate tenders
  const tenders = (payments || []).map((p) => ({ method: p.method, amount: round2(p.amount), received: p.received != null ? round2(p.received) : null, reference: p.reference || null, verificationToken: p.verificationToken, slipUrl: p.slipUrl || null }));
  if (!tenders.length && calc.netTotal > 0) throw badRequest('กรุณาเลือกช่องทางชำระเงิน');
  for (const t of tenders) {
    if (!['CASH', 'QR', 'TRANSFER', 'CARD', 'CREDIT', 'OTHER'].includes(t.method)) throw badRequest('ช่องทางชำระเงินไม่ถูกต้อง');
    if (settings.payment.methods?.[t.method] === false) throw badRequest(`ช่องทาง ${t.method} ถูกปิดใช้งาน`);
    if (t.amount <= 0) throw badRequest('จำนวนเงินไม่ถูกต้อง');
    if (['QR', 'TRANSFER'].includes(t.method)) {
      const v = t.verificationToken ? verifyToken(t.verificationToken) : null;
      if (!v || v.typ !== 'slip' || Number(v.orderId) !== Number(orderId) || round2(v.amount) < t.amount) {
        throw badRequest('กรุณาตรวจสอบสลิปก่อนยืนยันการชำระเงิน', 'SLIP_NOT_VERIFIED');
      }
      if (v.mode === 'DEMO' && (await paymentMode()) === 'PRODUCTION') throw badRequest('Production Mode ต้องตรวจสลิปจากผู้ให้บริการจริงหรือพนักงานยืนยัน');
      t.reference = t.reference || v.ref;
      t.verifiedBy = v.eid;
    }
  }
  const nonCash = round2(tenders.filter((t) => t.method !== 'CASH').reduce((s, t) => s + t.amount, 0));
  const cash = round2(tenders.filter((t) => t.method === 'CASH').reduce((s, t) => s + (t.received ?? t.amount), 0));
  if (nonCash > calc.netTotal + 0.001) throw badRequest('ยอดชำระที่ไม่ใช่เงินสดเกินยอดสุทธิ');
  if (round2(nonCash + cash) + 0.001 < calc.netTotal) throw badRequest(`ยอดชำระไม่ครบ ขาดอีก ${round2(calc.netTotal - nonCash - cash)} บาท`);
  const change = round2(Math.max(0, nonCash + cash - calc.netTotal));

  // persist computed room lines (snapshot) + extra
  if (session) {
    for (const l of calc.lines.filter((x) => x.isSystem)) {
      await client.query(
        `INSERT INTO order_items(order_id, item_type, name, qty, unit_price, meta, is_system, created_by) VALUES ($1,$2,$3,$4,$5,$6,true,$7)`,
        [orderId, l.type, l.name, l.qty, l.unitPrice, { detail: l.detail, minutes: l.minutes || 0 }, req.employee.id],
      );
    }
  }

  // payments
  const shiftId = req.shiftId || lockRow.shift_id || null;
  const paymentRows = [];
  let i = 0;
  for (const t of tenders) {
    const isCash = t.method === 'CASH';
    const amount = isCash ? round2(Math.max(0, (t.received ?? t.amount) - change)) : t.amount;
    const r = await client.query(
      `INSERT INTO payments(payment_no, purpose, order_id, reservation_id, method, amount, received, change_amount, status, reference, slip_url, verified_by, verified_at, idempotency_key, shift_id, employee_id, paid_at)
       VALUES ($1,'SALE',$2,$3,$4,$5,$6,$7,'PAID',$8,$9,$10,$11,$12,$13,$14,now()) RETURNING *`,
      [await nextPaymentNo(client), orderId, lockRow.reservation_id, t.method, amount, isCash ? t.received ?? t.amount : t.amount, isCash ? change : 0, t.reference, t.slipUrl, t.verifiedBy || null, t.verifiedBy ? now : null, `${idempotencyKey}:${i++}`, shiftId, req.employee.id],
    );
    paymentRows.push(r.rows[0]);
  }

  // deposits applied
  for (const d of bundle.deposits) {
    await client.query(`UPDATE deposits SET status = 'APPLIED', applied_order_id = $2 WHERE id = $1`, [d.id, orderId]);
  }
  // excess deposit (deposit > bill) is recorded for refund
  const excess = calc.depositRefundable;

  // stock
  for (const l of calc.lines) {
    if (l.type === 'PRODUCT' && l.productId) {
      await moveStock(client, { productId: l.productId, type: 'SALE', quantity: l.qty, orderId, reference: lockRow.order_no, employeeId: req.employee.id });
    }
  }

  // rewards used
  for (const rd of bundle.redemptions || []) {
    await client.query(`UPDATE reward_redemptions SET status = 'USED', used_at = now(), used_order_id = $2 WHERE id = $1 AND status = 'ISSUED'`, [rd.id, orderId]);
  }
  // promotions usage
  const usedPromoIds = calc.discounts.filter((d) => d.promotionId).map((d) => d.promotionId);
  if (usedPromoIds.length) await client.query('UPDATE promotions SET used_count = used_count + 1 WHERE id = ANY($1)', [usedPromoIds]);

  // numbers
  const receiptNo = await nextReceiptNo(client, settings);
  const queueNo = await nextQueueNo(client, settings, shiftId);

  // points
  let pointsEarned = 0;
  let pointsBalance = member ? Number(member.points_balance) : null;
  if (member && settings.points.enabled) {
    const pts = calculatePoints(calc, settings.points, Number(member.point_multiplier || 1)).points;
    if (pts > 0) {
      const exp = Number(settings.points.expiryMonths || 0) > 0 ? new Date(now.getTime() + Number(settings.points.expiryMonths) * 30 * 86400000) : null;
      const led = await addPointTx(client, { memberId: member.id, type: 'EARN', points: pts, source: 'POS', orderId, employeeId: req.employee.id, reason: `ใบเสร็จ ${receiptNo}`, expiresAt: exp, idempotencyKey: `earn:${orderId}` });
      pointsEarned = pts;
      pointsBalance = Number(led.balance_after);
    }
  }

  const billedMinutes = calc.lines.filter((l) => ['ROOM', 'PACKAGE', 'EXTENSION', 'OVERTIME'].includes(l.type)).reduce((s, l) => s + Number(l.minutes || 0), 0);
  if (member) {
    await client.query(
      `UPDATE members SET total_spending = total_spending + $2, visit_count = visit_count + $3, total_minutes = total_minutes + $4, updated_at = now() WHERE id = $1`,
      [member.id, calc.grandTotal, session ? 1 : 0, billedMinutes],
    );
    await evaluateTier(client, member.id);
  }

  const extraGuests = calc.lines.filter((l) => l.type === 'EXTRA_GUEST').reduce((s, l) => s + Number(l.qty), 0);
  await client.query(
    `UPDATE orders SET status = 'PAID', paid_at = $2, paid_by = $3, calc_snapshot = $4, settings_snapshot = $5, subtotal = $6, discount_total = $7,
       service_charge = $8, vat = $9, rounding = $10, grand_total = $11, deposit_applied = $12, net_total = $13, paid_total = $14,
       change_amount = $15, points_earned = $16, points_used = $17, queue_no = $18, discount_approved_by = $19,
       room_total = $20, product_total = $21, billed_minutes = $22, extra_guests = $23, guest_count = $24, shift_id = COALESCE(shift_id, $25), version = version + 1
     WHERE id = $1`,
    [orderId, now, req.employee.id, calc, { tax: taxSnapshot(settings), points: settings.points }, calc.subtotal, calc.discountTotal, calc.serviceCharge, calc.vat, calc.rounding, calc.grandTotal, calc.depositApplied, calc.netTotal, round2(nonCash + cash - change), change, pointsEarned, calc.pointsUsed || 0, queueNo, approvedBy, round2(calc.byGroup.ROOM + calc.byGroup.PACKAGE), calc.byGroup.PRODUCT, billedMinutes, extraGuests, session?.guest_count ?? null, shiftId],
  );

  // room & reservation lifecycle
  if (session) {
    await client.query(`UPDATE room_sessions SET status = 'PAID', updated_at = now() WHERE id = $1`, [session.id]);
    await client.query(`UPDATE rooms SET status = 'CLEANING', updated_at = now() WHERE id = $1`, [session.room_id]);
    if (session.reservation_id) await client.query(`UPDATE reservations SET status = 'COMPLETED', updated_at = now() WHERE id = $1`, [session.reservation_id]);
  }

  const employee = req.employee;
  const snapshot = buildReceiptSnapshot({ settings, order: { ...lockRow, queue_no: queueNo, paid_at: now }, calc, session, member, payments: paymentRows, receiptNo, queueNo, employee, pointsEarned, pointsBalance, change, excessDeposit: excess });
  const rc = await client.query(`INSERT INTO receipts(receipt_no, order_id, queue_no, snapshot, employee_id) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [receiptNo, orderId, queueNo, snapshot, employee.id]);
  return { receipt: rc.rows[0], payments: paymentRows, calc, change, pointsEarned };
}

export function buildReceiptSnapshot({ settings, order, calc, session, member, payments, receiptNo, queueNo, employee, pointsEarned, pointsBalance, change, excessDeposit = 0 }) {
  const s = settings.store;
  return {
    receiptNo,
    queueNo,
    orderNo: order.order_no,
    issuedAt: order.paid_at || new Date(),
    store: { name: s.name, branchName: s.branchName, address: s.address, phone: s.phone, taxId: s.taxId, logoUrl: s.logoUrl },
    slogan: settings.receipt.slogan || s.slogan,
    thankYou: settings.receipt.thankYou,
    footerNote: settings.receipt.footerNote,
    showLogo: settings.receipt.showLogo,
    showQr: settings.receipt.showQr,
    showPoints: settings.receipt.showPoints,
    employee: employee?.name,
    customer: {
      name: member ? `${member.first_name} ${member.last_name || ''}`.trim() : order.customer_name || session?.customer_name || null,
      phone: member?.phone || order.phone || session?.phone || null,
      memberCode: member?.member_code || null,
      tier: member?.tier_name || null,
    },
    room: session
      ? {
          name: session.room_name,
          number: session.room_number,
          type: session.type_name,
          guests: session.guest_count,
          capacity: session.room_capacity,
          startedAt: session.started_at,
          endedAt: session.ended_at || new Date(),
          packageName: session.package_name,
          billedMinutes: calc.lines.filter((l) => ['ROOM', 'PACKAGE', 'EXTENSION', 'OVERTIME'].includes(l.type)).reduce((a, l) => a + Number(l.minutes || 0), 0),
        }
      : null,
    lines: calc.lines.map((l) => ({ id: typeof l.id === 'number' ? l.id : null, type: l.type, name: l.name, qty: l.qty, unitPrice: l.unitPrice, gross: l.gross, discount: l.discount, net: l.net, note: l.note, detail: l.detail })),
    discounts: calc.discounts,
    totals: {
      grossTotal: calc.grossTotal,
      subtotal: calc.subtotal,
      lineDiscountTotal: calc.lineDiscountTotal,
      discountTotal: calc.discountTotal,
      serviceCharge: calc.serviceCharge,
      vat: calc.vat,
      beforeVat: calc.beforeVat,
      rounding: calc.rounding,
      grandTotal: calc.grandTotal,
      depositApplied: calc.depositApplied,
      netTotal: calc.netTotal,
      paid: payments.reduce((a, p) => a + Number(p.received ?? p.amount), 0),
      change,
      excessDeposit,
    },
    tax: calc.tax,
    payments: payments.map((p) => ({ method: p.method, amount: Number(p.amount), received: Number(p.received ?? p.amount), reference: p.reference })),
    points: member ? { earned: pointsEarned, balance: pointsBalance, used: calc.pointsUsed || 0 } : null,
  };
}

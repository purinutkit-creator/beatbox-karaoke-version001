// Central Calculation Engine — used identically by POS, Booking website, Customer Display, Receipt and Reports.
//
// Calculation order (documented & fixed):
//  1. Line gross              = qty × unit price
//  2. Line discount           = per-item discount (amount or %)
//  3. Subtotal                = Σ line net
//  4. Bill discounts          = manual bill discount, promotions, rewards (applied in order, never below 0)
//  5. Service Charge          = SC% × (eligible lines after bill-discount allocation)   [if enabled]
//  6. VAT                     = exclusive: VAT% × (subtotal − bill discounts + SC)
//                               inclusive: (subtotal − bill discounts + SC) × VAT% / (100 + VAT%)   [if enabled]
//  7. Rounding                = per rounding setting on the grand total
//  8. Deposit                 = deducted from grand total
//  9. Payments                = deducted from net total → balance / change
import { round2, applyRounding } from './money.js';

const ROOM_TYPES = new Set(['ROOM', 'PACKAGE', 'EXTENSION', 'OVERTIME', 'EXTRA_GUEST']);

export function lineGroup(type) {
  if (ROOM_TYPES.has(type)) return type === 'PACKAGE' ? 'PACKAGE' : 'ROOM';
  if (type === 'SERVICE') return 'OTHER';
  return 'PRODUCT';
}

export function normalizeTaxSettings(s = {}) {
  return {
    vatEnabled: !!s.vatEnabled,
    vatRate: Number(s.vatRate ?? 0),
    vatInclusive: s.vatMode ? s.vatMode === 'INCLUSIVE' : !!s.vatInclusive,
    scEnabled: !!s.scEnabled,
    scRate: Number(s.scRate ?? 0),
    scBase: s.scBase || 'ALL', // ALL | ROOM | PRODUCT
    rounding: s.rounding || { mode: 'NONE', unit: 1 },
  };
}

function lineDiscountAmount(gross, type, value) {
  const v = Number(value || 0);
  if (!v || v < 0) return 0;
  if (type === 'PERCENT') return Math.min(gross, round2((gross * Math.min(v, 100)) / 100));
  return Math.min(gross, round2(v));
}

/**
 * @param {object} input
 * @param {Array} input.items   [{ id, type, name, qty, unitPrice, discountType, discountValue, scExempt, voided }]
 * @param {object} input.billDiscount  { type: 'AMOUNT'|'PERCENT', value, reason }
 * @param {Array} input.extraDiscounts [{ name, amount, source, points }]  (promotions / rewards, already valued)
 * @param {object} input.tax    tax settings snapshot (see normalizeTaxSettings)
 * @param {number} input.deposit deposit available to apply
 * @param {Array} input.payments [{ method, amount }]
 */
export function calculateBill(input = {}) {
  const tax = normalizeTaxSettings(input.tax);
  const items = (input.items || []).filter((i) => !i.voided);

  // 1-3 lines
  const lines = items.map((it) => {
    const qty = Number(it.qty || 0);
    const unitPrice = round2(it.unitPrice);
    const gross = round2(qty * unitPrice);
    const discount = lineDiscountAmount(gross, it.discountType, it.discountValue);
    const net = round2(gross - discount);
    return { ...it, qty, unitPrice, gross, discount, net, group: lineGroup(it.type) };
  });
  const grossTotal = round2(lines.reduce((s, l) => s + l.gross, 0));
  const lineDiscountTotal = round2(lines.reduce((s, l) => s + l.discount, 0));
  const subtotal = round2(lines.reduce((s, l) => s + l.net, 0));

  // 4 bill discounts
  const discounts = [];
  let remaining = subtotal;
  const bd = input.billDiscount;
  if (bd && Number(bd.value) > 0) {
    const amt = Math.min(remaining, bd.type === 'PERCENT' ? round2((subtotal * Math.min(Number(bd.value), 100)) / 100) : round2(bd.value));
    if (amt > 0) {
      discounts.push({ name: bd.reason || (bd.type === 'PERCENT' ? `ส่วนลดท้ายบิล ${bd.value}%` : 'ส่วนลดท้ายบิล'), amount: amt, source: 'MANUAL' });
      remaining = round2(remaining - amt);
    }
  }
  for (const d of input.extraDiscounts || []) {
    const amt = Math.min(remaining, round2(d.amount));
    if (amt > 0) {
      discounts.push({ ...d, amount: amt });
      remaining = round2(remaining - amt);
    }
  }
  const billDiscountTotal = round2(subtotal - remaining);

  // allocate bill discount to lines proportionally (for SC base, points and reports)
  let allocatedSum = 0;
  lines.forEach((l, idx) => {
    let alloc = subtotal > 0 ? round2((billDiscountTotal * l.net) / subtotal) : 0;
    if (idx === lines.length - 1) alloc = round2(billDiscountTotal - allocatedSum);
    allocatedSum = round2(allocatedSum + alloc);
    l.billDiscount = alloc;
    l.afterDiscount = round2(l.net - alloc);
  });

  // 5 service charge
  let scBase = 0;
  if (tax.scEnabled && tax.scRate > 0) {
    for (const l of lines) {
      if (l.scExempt) continue;
      if (tax.scBase === 'ROOM' && !(l.group === 'ROOM' || l.group === 'PACKAGE')) continue;
      if (tax.scBase === 'PRODUCT' && l.group !== 'PRODUCT') continue;
      scBase += l.afterDiscount;
    }
  }
  scBase = round2(scBase);
  const serviceCharge = tax.scEnabled ? round2((scBase * tax.scRate) / 100) : 0;

  // 6 VAT
  const taxable = round2(remaining + serviceCharge);
  let vat = 0;
  let totalBeforeRounding = taxable;
  let beforeVat = taxable;
  if (tax.vatEnabled && tax.vatRate > 0) {
    if (tax.vatInclusive) {
      vat = round2((taxable * tax.vatRate) / (100 + tax.vatRate));
      beforeVat = round2(taxable - vat);
    } else {
      vat = round2((taxable * tax.vatRate) / 100);
      totalBeforeRounding = round2(taxable + vat);
    }
  }

  // 7 rounding
  const grandTotal = applyRounding(totalBeforeRounding, tax.rounding);
  const rounding = round2(grandTotal - totalBeforeRounding);

  // 8 deposit
  const depositApplied = Math.min(round2(input.deposit || 0), grandTotal);
  const netTotal = round2(grandTotal - depositApplied);

  // 9 payments
  const payments = (input.payments || []).map((p) => ({ ...p, amount: round2(p.amount) }));
  const paid = round2(payments.reduce((s, p) => s + p.amount, 0));
  const balance = round2(Math.max(0, netTotal - paid));
  const change = round2(Math.max(0, paid - netTotal));
  const depositRefundable = round2(Math.max(0, (input.deposit || 0) - grandTotal));

  const byGroup = { ROOM: 0, PACKAGE: 0, PRODUCT: 0, OTHER: 0 };
  for (const l of lines) byGroup[l.group] = round2(byGroup[l.group] + l.afterDiscount);

  return {
    lines,
    grossTotal,
    lineDiscountTotal,
    subtotal,
    discounts,
    billDiscountTotal,
    discountTotal: round2(lineDiscountTotal + billDiscountTotal),
    scBase,
    serviceCharge,
    vat,
    beforeVat,
    totalBeforeRounding,
    rounding,
    grandTotal,
    depositApplied,
    depositRefundable,
    netTotal,
    paid,
    balance,
    change,
    byGroup,
    tax: { ...tax },
    steps: [
      `ยอดรวมสินค้า/บริการ ${grossTotal}`,
      lineDiscountTotal ? `ส่วนลดรายการ −${lineDiscountTotal}` : null,
      billDiscountTotal ? `ส่วนลดท้ายบิล −${billDiscountTotal}` : null,
      tax.scEnabled ? `Service Charge ${tax.scRate}% × ${scBase} = ${serviceCharge}` : 'Service Charge ปิดใช้งาน',
      tax.vatEnabled ? `VAT ${tax.vatRate}% (${tax.vatInclusive ? 'รวมในราคา' : 'บวกเพิ่ม'}) = ${vat}` : 'VAT ปิดใช้งาน',
      rounding ? `ปัดเศษ ${rounding > 0 ? '+' : ''}${rounding}` : null,
      `ยอดรวม ${grandTotal}`,
      depositApplied ? `หักมัดจำ −${depositApplied}` : null,
      `ยอดสุทธิ ${netTotal}`,
    ].filter(Boolean),
  };
}

/**
 * Points earned from a calculated bill.
 * cfg: { enabled, amountPerPoint, pointsPerUnit, base: 'BEFORE_DISCOUNT'|'AFTER_DISCOUNT', includeRoom, includeProduct,
 *        includePackage, includeServiceCharge, includeVat }
 */
export function calculatePoints(calc, cfg = {}, multiplier = 1) {
  if (!cfg.enabled || !calc) return { points: 0, base: 0 };
  const per = Number(cfg.amountPerPoint || 25);
  const unit = Number(cfg.pointsPerUnit || 1);
  let base = 0;
  for (const l of calc.lines) {
    const amt = cfg.base === 'BEFORE_DISCOUNT' ? l.gross : l.afterDiscount;
    if (l.group === 'ROOM' && cfg.includeRoom === false) continue;
    if (l.group === 'PACKAGE' && cfg.includePackage === false) continue;
    if (l.group === 'PRODUCT' && cfg.includeProduct === false) continue;
    if (l.pointsEligible === false) continue;
    base += amt;
  }
  if (cfg.includeServiceCharge) base += calc.serviceCharge;
  if (cfg.includeVat && calc.tax && !calc.tax.vatInclusive) base += calc.vat;
  if (!cfg.includeVat && calc.tax && calc.tax.vatInclusive && calc.vat > 0) {
    base = (base * 100) / (100 + Number(calc.tax.vatRate || 0)); // remove VAT portion from inclusive prices
  }
  base = round2(Math.max(0, base));
  const points = Math.floor(((base / per) * unit * Number(multiplier || 1)) + 1e-9);
  return { points, base };
}

/**
 * Deposit amount.
 * rule: FIXED | PERCENT | ROOM_TYPE | PACKAGE | PROMOTION | CUSTOM
 */
export function calculateDeposit({ rule = 'ROOM_TYPE', fixedAmount = 0, percent = 0, roomTypeDeposit = 0, packageDeposit = null, promotionDeposit = null, customAmount = null, estimatedTotal = 0 } = {}) {
  let amount = 0;
  switch (rule) {
    case 'FIXED':
      amount = Number(fixedAmount || 0);
      break;
    case 'PERCENT':
      amount = (Number(estimatedTotal || 0) * Number(percent || 0)) / 100;
      break;
    case 'PACKAGE':
      amount = packageDeposit != null ? Number(packageDeposit) : Number(roomTypeDeposit || 0);
      break;
    case 'PROMOTION':
      amount = promotionDeposit != null ? Number(promotionDeposit) : Number(roomTypeDeposit || 0);
      break;
    case 'CUSTOM':
      amount = Number(customAmount ?? 0);
      break;
    case 'ROOM_TYPE':
    default:
      amount = Number(roomTypeDeposit || 0);
  }
  return Math.ceil(round2(Math.max(0, amount)));
}

/**
 * Cancellation refund amount based on policy tiers.
 * policy: { tiers: [{ hoursBefore: 24, percent: 100 }, { hoursBefore: 6, percent: 50 }], defaultPercent: 0, refundType }
 */
export function calculateCancellationRefund(deposit, startAt, policy = {}, nowMs = Date.now()) {
  const hoursLeft = (new Date(startAt).getTime() - nowMs) / 3600000;
  const tiers = [...(policy.tiers || [])].sort((a, b) => b.hoursBefore - a.hoursBefore);
  let percent = Number(policy.defaultPercent || 0);
  for (const t of tiers) {
    if (hoursLeft >= Number(t.hoursBefore)) {
      percent = Number(t.percent);
      break;
    }
  }
  const amount = round2((Number(deposit || 0) * percent) / 100);
  return { hoursLeft: round2(hoursLeft), percent, amount, refundType: percent >= 100 ? 'FULL' : percent > 0 ? 'PARTIAL' : 'NONE' };
}

export function cashQuickAmounts(total) {
  const t = Math.ceil(Number(total) || 0);
  const set = new Set([t]);
  for (const n of [100, 500, 1000, 2000]) set.add(n);
  for (const step of [100, 500, 1000]) set.add(Math.ceil(t / step) * step);
  return [...set].filter((v) => v >= t).sort((a, b) => a - b).slice(0, 6);
}

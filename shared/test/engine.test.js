import { test } from 'node:test';
import assert from 'node:assert/strict';
import { halfHourPrice, priceForMinutes, computeSessionCharges, calculateBill, calculatePoints, calculateDeposit, calculateCancellationRefund, promptPayPayload, renderNumber, applyRounding, evaluatePromotion } from '../index.js';

test('half hour price rounds up', () => {
  assert.equal(halfHourPrice(399), 200);
  assert.equal(halfHourPrice(400), 200);
  assert.equal(halfHourPrice(299), 150);
});

test('time pricing examples from spec', () => {
  const p = { priceHour: 399, priceHalf: 200 };
  assert.equal(priceForMinutes(60, p).amount, 399);
  assert.equal(priceForMinutes(30, p).amount, 200);
  assert.equal(priceForMinutes(90, p).amount, 599);
  assert.equal(priceForMinutes(150, p).amount, 998);
});

test('partial minute rules', () => {
  const base = { priceHour: 399, priceHalf: 200 };
  assert.equal(priceForMinutes(70, { ...base, partialRule: 'NONE' }).amount, 399);
  assert.equal(priceForMinutes(70, { ...base, partialRule: 'ROUND_UP' }).amount, 599);
  assert.equal(priceForMinutes(70, { ...base, partialRule: 'PER_MINUTE' }).amount, 399 + 67);
  assert.equal(priceForMinutes(70, { ...base, partialRule: 'GRACE', graceMinutes: 10 }).amount, 399);
  assert.equal(priceForMinutes(75, { ...base, partialRule: 'GRACE', graceMinutes: 10 }).amount, 599);
});

test('session charges with extension, overtime and extra guests', () => {
  const start = new Date('2026-10-05T12:00:00Z');
  const s = {
    started_at: start, scheduled_end_at: new Date(start.getTime() + 90 * 60000), ended_at: new Date(start.getTime() + 100 * 60000),
    total_paused_seconds: 0, booked_minutes: 60, extension_minutes: 30, price_hour: 399, price_half: 200,
    guest_count: 9, room_capacity: 6, extra_guest_fee: 50,
  };
  const r = computeSessionCharges(s, { partialRule: 'ROUND_UP' });
  const by = Object.fromEntries(r.lines.map((l) => [l.type, l.qty * l.unitPrice]));
  assert.equal(by.ROOM, 399);
  assert.equal(by.EXTENSION, 200);
  assert.equal(by.OVERTIME, 200); // 10 min rounded up to a 30 min block
  assert.equal(by.EXTRA_GUEST, 150);
});

test('bill engine: exclusive VAT + service charge + deposit', () => {
  const c = calculateBill({
    items: [{ type: 'ROOM', qty: 1, unitPrice: 1000 }, { type: 'PRODUCT', qty: 2, unitPrice: 500 }],
    tax: { vatEnabled: true, vatRate: 7, vatMode: 'EXCLUSIVE', scEnabled: true, scRate: 10, scBase: 'ALL' },
    deposit: 500,
  });
  assert.equal(c.subtotal, 2000);
  assert.equal(c.serviceCharge, 200);
  assert.equal(c.vat, 154);
  assert.equal(c.grandTotal, 2354);
  assert.equal(c.netTotal, 1854);
});

test('bill engine: inclusive VAT, disabled SC, deposit example', () => {
  const c = calculateBill({ items: [{ type: 'ROOM', qty: 1, unitPrice: 2000 }], tax: { vatEnabled: true, vatRate: 7, vatMode: 'INCLUSIVE' }, deposit: 500 });
  assert.equal(c.grandTotal, 2000);
  assert.equal(c.vat, 130.84);
  assert.equal(c.netTotal, 1500);
});

test('bill discount and rounding', () => {
  const c = calculateBill({ items: [{ type: 'PRODUCT', qty: 3, unitPrice: 33.33 }], billDiscount: { type: 'PERCENT', value: 10 }, tax: { rounding: { mode: 'UP', unit: 1 } } });
  assert.equal(c.subtotal, 99.99);
  assert.equal(c.billDiscountTotal, 10);
  assert.equal(c.grandTotal, 90);
});

test('points with multiplier', () => {
  const c = calculateBill({ items: [{ type: 'ROOM', qty: 1, unitPrice: 2000 }] });
  assert.equal(calculatePoints(c, { enabled: true, amountPerPoint: 25 }).points, 80);
  assert.equal(calculatePoints(c, { enabled: true, amountPerPoint: 25 }, 1.5).points, 120);
});

test('deposit & cancellation', () => {
  assert.equal(calculateDeposit({ rule: 'PERCENT', percent: 25, estimatedTotal: 2000 }), 500);
  const now = Date.parse('2026-10-05T00:00:00Z');
  const pol = { tiers: [{ hoursBefore: 24, percent: 100 }, { hoursBefore: 6, percent: 50 }], defaultPercent: 0 };
  assert.equal(calculateCancellationRefund(500, '2026-10-06T01:00:00Z', pol, now).amount, 500);
  assert.equal(calculateCancellationRefund(500, '2026-10-05T10:00:00Z', pol, now).amount, 250);
  assert.equal(calculateCancellationRefund(500, '2026-10-05T03:00:00Z', pol, now).amount, 0);
});

test('promptpay payload has valid structure', () => {
  const p = promptPayPayload('0812345678', 500);
  assert.match(p, /^000201010212/);
  assert.match(p, /0066812345678/);
  assert.match(p, /5406500\.00/);
  assert.equal(p.length - p.indexOf('6304'), 8);
});

test('numbering', () => {
  assert.equal(renderNumber('BK{YYYY}{MM}{DD}{SEQ:3}', 1, { date: new Date('2026-10-05T05:00:00Z') }), 'BK20261005001');
  assert.equal(applyRounding(10.13, { mode: 'NEAREST', unit: 0.25 }), 10.25);
});

test('promotion engine', () => {
  const lines = [{ type: 'ROOM', net: 798, qty: 1, unitPrice: 798 }, { type: 'PRODUCT', productId: 5, net: 120, qty: 2, unitPrice: 60 }];
  const r = evaluatePromotion({ type: 'PERCENT', value_type: 'PERCENT', value: 10, conditions: {} }, { lines, subtotal: 918 });
  assert.equal(r.amount, 91.8);
  const fh = evaluatePromotion({ type: 'FREE_HOURS', value: 1, conditions: {} }, { lines, subtotal: 918, priceHour: 399 });
  assert.equal(fh.amount, 399);
  const code = evaluatePromotion({ type: 'COUPON', code: 'SING50', value_type: 'AMOUNT', value: 50, conditions: {} }, { lines, subtotal: 918, code: 'sing50' });
  assert.equal(code.amount, 50);
  assert.equal(evaluatePromotion({ type: 'COUPON', code: 'SING50', value: 50, conditions: {} }, { lines }).eligible, false);
});

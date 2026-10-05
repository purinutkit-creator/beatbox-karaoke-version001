// End-to-end API tests against a fresh PostgreSQL database.
// Requires a reachable PostgreSQL (TEST_DATABASE_URL, default postgres://postgres:postgres@localhost:5432/beatbox_test).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';

const DB = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/beatbox_test';
process.env.DATABASE_URL = DB;
process.env.DISABLE_SCHEDULER = 'true';
process.env.PAYMENT_MODE = 'DEMO';
process.env.PORT = '4999';

let server;
let base;
let token;
let deviceId;

async function api(method, url, body, { headers = {}, auth = true } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(auth && token ? { Authorization: `Bearer ${token}` } : {}), ...(deviceId ? { 'X-Device-Id': String(deviceId) } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

before(async () => {
  const admin = new pg.Client({ connectionString: DB.replace(/\/[^/]+$/, '/postgres') });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS beatbox_test WITH (FORCE)');
  await admin.query('CREATE DATABASE beatbox_test');
  await admin.end();
  const { start } = await import('../src/index.js');
  process.env.PORT = '4999';
  server = await start();
  base = 'http://localhost:4999/api';
  await new Promise((r) => setTimeout(r, 300));
});

after(async () => {
  server?.close();
  const { pool } = await import('../src/db/index.js');
  await pool.end();
  setTimeout(() => process.exit(0), 200).unref();
});

test('login with 4-digit PIN, wrong PIN rejected', async () => {
  assert.equal((await api('POST', '/auth/login', { pin: '9999' })).status, 401);
  const r = await api('POST', '/auth/login', { pin: '1234' });
  assert.equal(r.status, 200);
  token = r.body.token;
  assert.equal(r.body.employee.role, 'ADMIN');
  const d = await api('POST', '/devices/register', { name: 'POS-1', deviceKey: 'test-device-key-1' });
  deviceId = d.body.id;
});

test('staff without permission cannot open settings', async () => {
  const s = await api('POST', '/auth/login', { pin: '4444' });
  const r = await fetch(base + '/settings/tax', { method: 'PUT', headers: { Authorization: `Bearer ${s.body.token}`, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 403);
});

test('shift must be open before taking money', async () => {
  const r = await api('POST', '/orders', { items: [{ productId: 1, qty: 1 }] });
  assert.equal(r.status, 200);
  const pay = await api('POST', `/orders/${r.body.id}/pay`, { payments: [{ method: 'CASH', amount: 35, received: 35 }] }, { headers: { 'Idempotency-Key': 'k-noshift' } });
  assert.equal(pay.status, 409);
  assert.equal(pay.body.code, 'NO_SHIFT');
  const open = await api('POST', '/shifts/open', { deviceId, openingCash: 1000 });
  assert.equal(open.status, 200);
});

let sessionId;
let orderId;
test('open room, double-open from another device is rejected', async () => {
  const r = await api('POST', '/sessions/open', { roomId: 2, guestCount: 9, minutes: 90, customerName: 'ทดสอบ', phone: '0811111111', deposit: { amount: 500, method: 'CASH' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  sessionId = r.body.id;
  orderId = r.body.order_id;
  const again = await api('POST', '/sessions/open', { roomId: 2, guestCount: 2, minutes: 60 });
  assert.equal(again.status, 409);
});

test('extend, add items, close & pay with deposit deducted; idempotent payment', async () => {
  assert.equal((await api('POST', `/sessions/${sessionId}/extend`, { minutes: 30 })).status, 200);
  assert.equal((await api('POST', `/orders/${orderId}/items`, { productId: 1, qty: 2 })).status, 200);
  const close = await api('POST', `/sessions/${sessionId}/close`);
  assert.equal(close.status, 200);
  const calc = close.body.order.calc;
  // room 2 = Standard 299/hr, capacity 6: 90 min = 299+150, +30 min ext = 599-449 = 150, extra guests 3×50
  const byType = Object.fromEntries(calc.lines.map((l) => [l.type, l.net]));
  assert.equal(byType.ROOM, 449);
  assert.equal(byType.EXTENSION, 149);
  assert.equal(byType.EXTRA_GUEST, 150);
  assert.equal(byType.PRODUCT, 70);
  assert.equal(calc.depositApplied, 500);
  const net = calc.netTotal;
  const p1 = await api('POST', `/orders/${orderId}/pay`, { payments: [{ method: 'CASH', amount: net, received: 1000 }] }, { headers: { 'Idempotency-Key': 'pay-1' } });
  assert.equal(p1.status, 200, JSON.stringify(p1.body));
  assert.equal(p1.body.change, Math.round((1000 - net) * 100) / 100);
  assert.match(p1.body.receipt.queue_no, /^BEATBOX\d{2}$/);
  const p2 = await api('POST', `/orders/${orderId}/pay`, { payments: [{ method: 'CASH', amount: net, received: 1000 }] }, { headers: { 'Idempotency-Key': 'pay-1' } });
  assert.equal(p2.status, 200);
  assert.equal(p2.body.receipt.receipt_no, p1.body.receipt.receipt_no);
  const p3 = await api('POST', `/orders/${orderId}/pay`, { payments: [{ method: 'CASH', amount: net, received: 1000 }] }, { headers: { 'Idempotency-Key': 'pay-2' } });
  assert.equal(p3.status, 409);
  const board = await api('GET', '/rooms/board');
  assert.equal(board.body.rooms.find((x) => x.id === 2).status, 'CLEANING');
});

test('QR payment requires slip verification', async () => {
  const o = await api('POST', '/orders', { items: [{ productId: 3, qty: 1 }] });
  const bad = await api('POST', `/orders/${o.body.id}/pay`, { payments: [{ method: 'QR', amount: 20 }] }, { headers: { 'Idempotency-Key': 'qr-1' } });
  assert.equal(bad.body.code, 'SLIP_NOT_VERIFIED');
});

test('reservations: overlap rejected by server + DB, suggestions offered', async () => {
  const start = new Date(Date.now() + 2 * 86400000);
  start.setUTCHours(12, 0, 0, 0); // 19:00 Bangkok
  const a = await api('POST', '/reservations', { roomId: 5, startAt: start.toISOString(), durationMinutes: 120, customerName: 'ลูกค้า A', phone: '0822222222', guestCount: 6 });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const b = await api('POST', '/reservations', { roomId: 5, startAt: new Date(start.getTime() + 3600000).toISOString(), durationMinutes: 120, customerName: 'ลูกค้า B', phone: '0833333333', guestCount: 6 });
  assert.equal(b.status, 409);
  const look = await api('GET', '/reservations/lookup?q=0822222222');
  assert.equal(look.body[0].booking_no, a.body.booking_no);
  const look2 = await api('GET', `/reservations/lookup?q=${a.body.check_in_token}`);
  assert.equal(look2.body[0].id, a.body.id);
});

test('online booking: hold → details → slip (demo) → confirmed; slip reuse blocked', async () => {
  const start = new Date(Date.now() + 3 * 86400000);
  start.setUTCHours(13, 0, 0, 0); // 20:00 Bangkok
  const d = new Date(start.getTime() + 7 * 3600000).toISOString().slice(0, 10);
  const av = await api('GET', `/public/availability?date=${d}&time=20:00&durationMinutes=120&guests=8`, null, { auth: false });
  assert.equal(av.status, 200, JSON.stringify(av.body));
  // rooms smaller than the group are offered with a per-person extra charge (up to the admin's limit)
  assert.ok(av.body.rooms.every((r) => r.capacity + 10 >= 8 && r.extraGuests === Math.max(0, 8 - r.capacity)));
  const roomId = av.body.rooms.find((r) => r.extraGuests === 0).id;
  const h = await api('POST', '/public/holds', { roomId, startAt: av.body.startAt, durationMinutes: 120, guestCount: 8 }, { auth: false });
  assert.equal(h.status, 200, JSON.stringify(h.body));
  const h2 = await api('POST', '/public/holds', { roomId, startAt: av.body.startAt, durationMinutes: 120, guestCount: 8 }, { auth: false });
  assert.equal(h2.status, 409);
  assert.equal(h2.body.error, 'ขออภัย ห้องนี้เพิ่งถูกจอง กรุณาเลือกห้องหรือช่วงเวลาอื่น');
  const det = await api('POST', `/public/holds/${h.body.holdToken}/details`, { customerName: 'ออนไลน์', phone: '0844444444', acceptPolicy: true }, { auth: false });
  assert.equal(det.status, 200, JSON.stringify(det.body));
  assert.ok(det.body.payment.qrData.startsWith('000201'));
  const slipFile = path.join(os.tmpdir(), `slip-${Date.now()}.png`);
  fs.writeFileSync(slipFile, Buffer.from(`fake-slip-${Date.now()}`));
  const upload = async (token2) => {
    const fd = new FormData();
    fd.append('slip', new Blob([fs.readFileSync(slipFile)], { type: 'image/png' }), 'slip.png');
    const res = await fetch(`${base}/public/holds/${token2}/slip`, { method: 'POST', body: fd });
    return { status: res.status, body: await res.json() };
  };
  const s1 = await upload(h.body.holdToken);
  assert.equal(s1.status, 200, JSON.stringify(s1.body));
  assert.equal(s1.body.booking.status, 'DEPOSIT_PAID');
  assert.ok(s1.body.booking.checkInToken);
  // second booking trying the same slip
  const av2 = await api('GET', `/public/availability?date=${d}&time=20:00&durationMinutes=120&guests=8`, null, { auth: false });
  const h3 = await api('POST', '/public/holds', { roomId: av2.body.rooms[0].id, startAt: av2.body.startAt, durationMinutes: 120, guestCount: 8 }, { auth: false });
  await api('POST', `/public/holds/${h3.body.holdToken}/details`, { customerName: 'ซ้ำ', phone: '0855555555', acceptPolicy: true }, { auth: false });
  const s2 = await upload(h3.body.holdToken);
  assert.equal(s2.status, 422);
  assert.equal(s2.body.error, 'พบรายการนี้ถูกใช้แล้ว');
  // staff sees the booking by phone
  const look = await api('GET', '/reservations/lookup?q=0844444444');
  assert.equal(look.body[0].status, 'DEPOSIT_PAID');
});

test('member OTP signup, points earned after payment', async () => {
  const otp = await api('POST', '/public/auth/otp/request', { phone: '0866666666' }, { auth: false });
  assert.ok(otp.body.debugCode);
  const v = await api('POST', '/public/auth/otp/verify', { phone: '0866666666', code: otp.body.debugCode, firstName: 'สมาชิก' }, { auth: false });
  assert.ok(v.body.token);
  const m = await api('GET', '/members/lookup?phone=0866666666');
  const o = await api('POST', '/orders', { items: [{ productId: 5, qty: 5 }], memberId: m.body.id });
  const det = await api('GET', `/orders/${o.body.id}`);
  const pay = await api('POST', `/orders/${o.body.id}/pay`, { payments: [{ method: 'CASH', amount: det.body.calc.netTotal, received: det.body.calc.netTotal }] }, { headers: { 'Idempotency-Key': 'pay-member' } });
  assert.equal(pay.status, 200, JSON.stringify(pay.body));
  assert.equal(pay.body.pointsEarned, Math.floor(450 / 25));
  const me = await fetch(`${base}/public/me`, { headers: { Authorization: `Bearer ${v.body.token}` } }).then((r) => r.json());
  assert.equal(Number(me.points_balance), 18);
});

test('refund reverses points & stock; shift closes with expected cash', async () => {
  const rc = await api('GET', '/receipts?q=');
  const memberReceipt = rc.body.find((x) => x.member_phone === '0866666666');
  const ref = await api('POST', `/orders/${memberReceipt.order_id}/refunds`, { full: true, reason: 'ทดสอบ', method: 'CASH' });
  assert.equal(ref.status, 200, JSON.stringify(ref.body));
  assert.equal(ref.body.status, 'COMPLETED');
  const shift = await api('GET', `/shifts/current?deviceId=${deviceId}`);
  const sum = await api('GET', `/shifts/${shift.body.id}/summary`);
  assert.ok(sum.body.summary.expectedCash > 1000);
  const close = await api('POST', `/shifts/${shift.body.id}/close`, { countedCash: sum.body.summary.expectedCash - 20, force: true });
  assert.equal(close.status, 200, JSON.stringify(close.body));
  assert.equal(close.body.summary.shortage, 20);
});

test('reports and dashboard respond; CSV export has BOM', async () => {
  assert.equal((await api('GET', '/dashboard')).status, 200);
  for (const t of ['sales', 'room-sales', 'products', 'hours', 'half-hours', 'room-usage', 'vat', 'discounts', 'employees', 'peak-hours', 'stock', 'members', 'voids']) {
    const r = await api('GET', `/reports/${t}`);
    assert.equal(r.status, 200, `${t}: ${JSON.stringify(r.body)}`);
  }
  const csv = new Uint8Array(await fetch(`${base}/reports/sales?format=csv`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.arrayBuffer()));
  assert.deepEqual([...csv.slice(0, 3)], [0xef, 0xbb, 0xbf]);
  const xlsx = await fetch(`${base}/reports/sales?format=xlsx`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(xlsx.status, 200);
});

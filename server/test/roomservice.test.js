// Slip QR decoding, integrations (encrypted secrets), extra mics, room tickets, in-room QR ordering with
// pay-now / counter, cashier slip verification, auto-accept, checkout guard and problem reports.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import QRCode from 'qrcode';

const DB = (process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/beatbox_test').replace(/\/[^/]+$/, '/beatbox_test_rs');
process.env.DATABASE_URL = DB;
process.env.DISABLE_SCHEDULER = 'true';
process.env.PAYMENT_MODE = 'DEMO';
process.env.PORT = '4998';

let server;
let base;
let token;
let deviceId;

async function api(method, url, body, { headers = {}, auth = true, form } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { ...(form ? {} : { 'Content-Type': 'application/json' }), ...(auth && token ? { Authorization: `Bearer ${token}` } : {}), ...(deviceId ? { 'X-Device-Id': String(deviceId) } : {}), ...headers },
    body: form || (body ? JSON.stringify(body) : undefined),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

function slipPayload(transRef, bank = '004') {
  const f = (id, v) => id + String(v.length).padStart(2, '0') + v;
  const inner = f('00', '000001') + f('01', bank) + f('02', transRef);
  return f('00', inner) + f('51', 'TH');
}

before(async () => {
  const admin = new pg.Client({ connectionString: DB.replace(/\/[^/]+$/, '/postgres') });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS beatbox_test_rs WITH (FORCE)');
  await admin.query('CREATE DATABASE beatbox_test_rs');
  await admin.end();
  const { start } = await import('../src/index.js');
  server = await start();
  base = 'http://localhost:4998/api';
  const r = await api('POST', '/auth/login', { pin: '1234' });
  token = r.body.token;
  deviceId = (await api('POST', '/devices/register', { name: 'POS-RS', deviceKey: 'test-device-key-rs' })).body.id;
  await api('POST', '/shifts/open', { deviceId, openingCash: 500 });
});

after(async () => {
  server?.close();
  const { pool } = await import('../src/db/index.js');
  await pool.end();
  setTimeout(() => process.exit(0), 200).unref();
});

test('slip QR: parse payload (CRC) and read it from a slip image', async () => {
  const { crc16 } = await import('@beatbox/shared/promptpay.js');
  const { parseSlipQr, readSlipQr } = await import('../src/providers/slipqr.js');
  const { accountMatches } = await import('../src/providers/slip.js');
  const body = `${slipPayload('016123142310BPM04567')}9104`;
  const payload = body + crc16(body);
  const p = parseSlipQr(payload);
  assert.equal(p.transRef, '016123142310BPM04567');
  assert.equal(p.sendingBank, '004');
  assert.equal(p.crcOk, true);
  const png = await QRCode.toBuffer(payload, { width: 400 });
  const r = readSlipQr(png, 'image/png');
  assert.equal(r.transRef, '016123142310BPM04567');
  assert.equal(parseSlipQr('00020101021129370016A000000677010111'), null); // a PromptPay QR is not a slip
  assert.ok(accountMatches('xxx-x-x6789-x', '123-4-56789-0'));
  assert.ok(!accountMatches('xxx-x-x1111-x', '123-4-56789-0'));
  assert.ok(accountMatches('xxx-xxx-5678', '0812345678'));
});

test('integration secrets are encrypted and masked', async () => {
  const r = await api('PUT', '/integrations/slip', { provider: 'slipok', apiKey: 'sk-live-secret-9876', branchId: '12345' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.slip.apiKey, { set: true, last4: '9876' });
  assert.equal(r.body.slip.branchId, '12345');
  const { pool } = await import('../src/db/index.js');
  const row = (await pool.query(`SELECT config, secrets FROM integration_settings WHERE key = 'slip'`)).rows[0];
  assert.ok(!JSON.stringify(row).includes('sk-live-secret'));
  const { getIntegrations } = await import('../src/services/integrations.js');
  assert.equal((await getIntegrations()).slip.apiKey, 'sk-live-secret-9876');
  // keep (empty) and clear (null)
  await api('PUT', '/integrations/slip', { apiKey: '' });
  assert.equal((await api('GET', '/integrations')).body.slip.apiKey.set, true);
  await api('PUT', '/integrations/slip', { apiKey: null, provider: 'manual' });
  assert.equal((await api('GET', '/integrations')).body.slip.apiKey.set, false);
  // a cashier can't read integrations
  const cashier = await api('POST', '/auth/login', { pin: '3333' });
  const res = await fetch(`${base}/integrations`, { headers: { Authorization: `Bearer ${cashier.body.token}` } });
  assert.equal(res.status, 403);
});

let session;
let orderToken;
test('open room with extra mics → mic charge + room ticket with one-time ordering token', async () => {
  const r = await api('POST', '/sessions/open', { roomId: 3, guestCount: 4, extraMics: 2, minutes: 120, customerName: 'ห้อง QR' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  session = r.body;
  const d = await api('GET', `/sessions/${session.id}`);
  const mic = d.body.charges.lines.find((l) => l.type === 'EXTRA_MIC');
  assert.equal(mic.qty * mic.unitPrice, 100); // 2 × 50 (default)
  const tk = await api('GET', `/sessions/${session.id}/ticket`);
  assert.equal(tk.status, 200);
  assert.equal(tk.body.minutes, 120);
  assert.equal(tk.body.extraMics, 2);
  orderToken = tk.body.orderToken;
  assert.ok(orderToken && orderToken.length > 20);
});

test('in-room order paid at the counter goes straight to the bill and queues a kitchen ticket', async () => {
  const room = await api('GET', `/public/room/${orderToken}`, null, { auth: false });
  assert.equal(room.status, 200);
  assert.ok(room.body.products.length > 0);
  assert.ok(room.body.room.remainingMs > 100 * 60000);
  const o = await api('POST', `/public/room/${orderToken}/orders`, { items: [{ productId: 1, qty: 2 }], payMode: 'COUNTER', clientOpId: 'rco-1' }, { auth: false });
  assert.equal(o.status, 200, JSON.stringify(o.body));
  assert.equal(o.body.order.status, 'PLACED');
  const jobs = await api('GET', '/print-jobs?status=QUEUED');
  const job = jobs.body.find((j) => j.source === 'ROOM_QR');
  assert.ok(job, 'kitchen job queued');
  const c1 = await api('POST', `/print-jobs/${job.id}/claim`, { device: 'a' });
  const c2 = await api('POST', `/print-jobs/${job.id}/claim`, { device: 'b' });
  assert.equal(c1.body.claimed, true);
  assert.equal(c2.body.claimed, false);
  const bill = await api('GET', `/orders/${session.order_id}`);
  assert.equal(bill.body.calc.lines.filter((l) => l.type === 'PRODUCT').reduce((s, l) => s + l.qty, 0), 2);
});

let verifiedOrder;
test('pay-now order: QR → slip → cashier verifies → placed, prepayment deducted', async () => {
  const o = await api('POST', `/public/room/${orderToken}/orders`, { items: [{ productId: 3, qty: 1 }], payMode: 'NOW' }, { auth: false });
  assert.equal(o.body.order.status, 'AWAITING_PAYMENT');
  assert.ok(o.body.payment.qrData.startsWith('000201'));
  verifiedOrder = o.body.order;
  const noSlip = await api('POST', `/public/room/${orderToken}/orders/${verifiedOrder.id}/pay`, {}, { auth: false });
  assert.equal(noSlip.status, 400);
  const fd = new FormData();
  fd.append('slip', new Blob([await QRCode.toBuffer(slipPayload('TESTREF00000000000001'), { width: 300 })], { type: 'image/png' }), 'slip.png');
  const pay = await api('POST', `/public/room/${orderToken}/orders/${verifiedOrder.id}/pay`, null, { auth: false, form: fd });
  assert.equal(pay.status, 200, JSON.stringify(pay.body));
  assert.equal(pay.body.order.status, 'VERIFYING'); // demo mode never auto-verifies money → cashier
  const state = await api('GET', '/room-service');
  assert.ok(state.body.payments.some((p) => p.id === verifiedOrder.id));
  const v = await api('POST', `/room-service/orders/${verifiedOrder.id}/verify`, { approve: true });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal(v.body.status, 'PLACED');
  assert.equal(v.body.payment_status, 'VERIFIED');
  const bill = await api('GET', `/orders/${session.order_id}`);
  assert.equal(bill.body.calc.depositApplied, Number(verifiedOrder.amount));
});

test('nobody checks the slip → customer order auto-accepted, checkout blocked until the cashier decides', async () => {
  await api('PUT', '/settings/roomService', { autoAcceptSeconds: 1 });
  const o = await api('POST', `/public/room/${orderToken}/orders`, { items: [{ productId: 3, qty: 2 }], payMode: 'NOW' }, { auth: false });
  const fd = new FormData();
  fd.append('slip', new Blob([await QRCode.toBuffer(slipPayload('TESTREF00000000000002'), { width: 300 })], { type: 'image/png' }), 'slip.png');
  await api('POST', `/public/room/${orderToken}/orders/${o.body.order.id}/pay`, null, { auth: false, form: fd });
  await new Promise((r) => setTimeout(r, 1300));
  const { autoAcceptRoomOrders } = await import('../src/services/roomService.js');
  const { getSettings } = await import('../src/services/settings.js');
  await autoAcceptRoomOrders(await getSettings());
  const room = await api('GET', `/public/room/${orderToken}`, null, { auth: false });
  const mine = room.body.orders.find((x) => x.id === o.body.order.id);
  assert.equal(mine.status, 'PLACED');
  assert.equal(mine.paymentStatus, 'AUTO_ACCEPTED');
  // not deducted yet, and payment is blocked
  const bill = await api('GET', `/orders/${session.order_id}`);
  assert.equal(bill.body.calc.depositApplied, Number(verifiedOrder.amount));
  assert.equal(bill.body.pendingPrepayments.length, 1);
  await api('POST', `/sessions/${session.id}/close`);
  const blocked = await api('POST', `/orders/${session.order_id}/pay`, { payments: [{ method: 'CASH', amount: 99999, received: 99999 }] }, { headers: { 'Idempotency-Key': 'rs-pay-1' } });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, 'PENDING_PREPAYMENT');
  // cashier: money never arrived → rejected, the food stays on the bill
  const rej = await api('POST', `/room-service/orders/${o.body.order.id}/verify`, { approve: false, reason: 'ยังไม่พบยอดเงินเข้าบัญชี' });
  assert.equal(rej.body.payment_status, 'REJECTED');
  const bill2 = await api('GET', `/orders/${session.order_id}`);
  assert.equal(bill2.body.pendingPrepayments.length, 0);
  assert.equal(bill2.body.calc.depositApplied, Number(verifiedOrder.amount));
  const pay = await api('POST', `/orders/${session.order_id}/pay`, { payments: [{ method: 'CASH', amount: bill2.body.calc.netTotal, received: 5000 }] }, { headers: { 'Idempotency-Key': 'rs-pay-2' } });
  assert.equal(pay.status, 200, JSON.stringify(pay.body));
  // QR expired once the room is closed
  const gone = await api('GET', `/public/room/${orderToken}`, null, { auth: false });
  assert.equal(gone.status, 410);
});

test('customer problem report → room flagged → acknowledge → resolve', async () => {
  const s = await api('POST', '/sessions/open', { roomId: 4, guestCount: 2, minutes: 60 });
  const tk = (await api('GET', `/sessions/${s.body.id}/ticket`)).body.orderToken;
  const other = await api('POST', `/public/room/${tk}/issues`, { category: 'OTHER' }, { auth: false });
  assert.equal(other.status, 400); // "other" needs a description
  const i = await api('POST', `/public/room/${tk}/issues`, { category: 'ไมค์ไม่มีเสียง / ไมค์เสีย', message: 'ไมค์ตัวที่ 2' }, { auth: false });
  assert.equal(i.status, 200);
  let board = await api('GET', '/rooms/board');
  assert.equal(board.body.rooms.find((r) => r.id === 4).issues.length, 1);
  assert.equal((await api('POST', `/room-issues/${i.body.id}/ack`)).body.status, 'ACKNOWLEDGED');
  assert.equal((await api('POST', `/room-issues/${i.body.id}/resolve`, { note: 'เปลี่ยนแบตแล้ว' })).body.status, 'RESOLVED');
  board = await api('GET', '/rooms/board');
  assert.equal(board.body.rooms.find((r) => r.id === 4).issues.length, 0);
});

test('online booking above room capacity is charged per extra person; extra mics priced', async () => {
  const start = new Date(Date.now() + 4 * 86400000);
  start.setUTCHours(13, 0, 0, 0);
  const d = new Date(start.getTime() + 7 * 3600000).toISOString().slice(0, 10);
  const av = await api('GET', `/public/availability?date=${d}&time=20:00&durationMinutes=60&guests=8&extraMics=1`, null, { auth: false });
  const small = av.body.rooms.find((r) => r.capacity === 6);
  assert.equal(small.extraGuests, 2);
  const h = await api('POST', '/public/holds', { roomId: small.id, startAt: av.body.startAt, durationMinutes: 60, guestCount: 8, extraMics: 1 }, { auth: false });
  assert.equal(h.status, 200, JSON.stringify(h.body));
  const types = Object.fromEntries(h.body.estimate.lines.map((l) => [l.type, l.net]));
  assert.equal(types.EXTRA_GUEST, 100);
  assert.equal(types.EXTRA_MIC, 50);
  const tooMany = await api('POST', '/public/holds', { roomId: small.id, startAt: av.body.startAt, durationMinutes: 60, guestCount: 30 }, { auth: false });
  assert.equal(tooMany.status, 400);
});

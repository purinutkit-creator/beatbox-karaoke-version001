// Pay before entering (default) / pay when closing, outstanding check on "ปิดห้อง", automatic receipt data,
// duplicate-click safety, print job queue (idempotent, reprint = copy) and the cross-store reference guard.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const DB = (process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/beatbox_test').replace(/\/[^/]+$/, '/beatbox_test_pay');
process.env.DATABASE_URL = DB;
process.env.DISABLE_SCHEDULER = 'true';
process.env.PAYMENT_MODE = 'DEMO';
process.env.PORT = '4996';

let server;
let base;
let token;
let deviceId;

async function api(method, url, body, { headers = {}, tok = token } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...(deviceId && tok === token ? { 'X-Device-Id': String(deviceId) } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}
const key = (k) => ({ headers: { 'Idempotency-Key': k } });

before(async () => {
  const admin = new pg.Client({ connectionString: DB.replace(/\/[^/]+$/, '/postgres') });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS beatbox_test_pay WITH (FORCE)');
  await admin.query('CREATE DATABASE beatbox_test_pay');
  await admin.end();
  const { start } = await import('../src/index.js');
  server = await start();
  base = 'http://localhost:4996/api';
  token = (await api('POST', '/auth/login', { pin: '1234' })).body.token;
  deviceId = (await api('POST', '/devices/register', { name: 'POS-PAY', deviceKey: 'test-device-key-pay' })).body.id;
  await api('POST', '/shifts/open', { deviceId, openingCash: 1000 });
});

after(async () => {
  server?.close();
  const { pool } = await import('../src/db/index.js');
  await pool.end();
  setTimeout(() => process.exit(0), 200).unref();
});

const board = async () => (await api('GET', '/rooms/board')).body.rooms;

let s1;
test('prepay is the default: the room is held as "รอชำระค่าห้อง" and the clock does not run', async () => {
  assert.equal((await api('GET', '/settings')).body.room.paymentMode, 'PREPAY');
  const r = await api('POST', '/sessions/open', { roomId: 1, guestCount: 2, minutes: 120, customerName: 'จ่ายก่อน' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  s1 = r.body;
  assert.equal(s1.status, 'PENDING_PAYMENT');
  assert.equal(s1.payment_mode, 'PREPAY');
  assert.ok(s1.prepay.amount > 0, 'room charge computed');
  const room = (await board()).find((x) => x.id === 1);
  assert.equal(room.status, 'PENDING_PAYMENT');
  // the held room can't be opened again
  assert.equal((await api('POST', '/sessions/open', { roomId: 1, guestCount: 2, minutes: 60 })).status, 409);
  // extending / closing before paying is not possible
  assert.equal((await api('POST', `/sessions/${s1.id}/extend`, { minutes: 30 })).status, 409);
  const co = await api('POST', `/sessions/${s1.id}/checkout`, {}, key('co-unpaid'));
  assert.equal(co.status, 409);
  assert.equal(co.body.code, 'NOT_PREPAID');
});

test('prepay must be the full room charge; paying starts the clock; replay / double click never charges twice', async () => {
  const wrong = await api('POST', `/sessions/${s1.id}/prepay`, { payments: [{ method: 'CASH', amount: s1.prepay.amount - 1, received: 1000 }] }, key('pp-wrong'));
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.code, 'PREPAY_AMOUNT_MISMATCH');
  // QR without a verified slip is refused
  const qr = await api('POST', `/sessions/${s1.id}/prepay`, { payments: [{ method: 'QR', amount: s1.prepay.amount }] }, key('pp-qr'));
  assert.equal(qr.status, 400);
  assert.equal(qr.body.code, 'SLIP_NOT_VERIFIED');

  const before = Date.now();
  const body = { payments: [{ method: 'CASH', amount: s1.prepay.amount, received: s1.prepay.amount + 100 }] };
  const [a, b] = await Promise.all([api('POST', `/sessions/${s1.id}/prepay`, body, key('pp-1')), api('POST', `/sessions/${s1.id}/prepay`, body, key('pp-1'))]);
  const ok = [a, b].filter((x) => x.status === 200);
  assert.ok(ok.length >= 1, JSON.stringify([a.body, b.body]));
  const done = ok[0].body;
  assert.equal(done.session.status, 'ACTIVE');
  assert.equal(Number(done.session.prepaid_amount), s1.prepay.amount);
  const start = new Date(done.session.started_at).getTime();
  assert.ok(start >= before - 2000, 'clock starts at payment time');
  assert.equal(new Date(done.session.scheduled_end_at).getTime() - start, 120 * 60000);
  // replay with the same key → same result; a new key → refused (already paid)
  const replay = await api('POST', `/sessions/${s1.id}/prepay`, body, key('pp-1'));
  assert.equal(replay.status, 200);
  const again = await api('POST', `/sessions/${s1.id}/prepay`, body, key('pp-2'));
  assert.equal(again.status, 409);
  const { pool, runWithStore } = await import('../src/db/index.js');
  const deps = await runWithStore(1, () => pool.query(`SELECT * FROM deposits WHERE session_id = $1 AND source = 'PREPAY'`, [s1.id]));
  assert.equal(deps.rows.length, 1, 'one prepay record only');
  assert.equal(Number(deps.rows[0].change_amount), 100);
  // the shift shows the prepaid room charges separately, and the cash drawer includes them
  const sh = (await api('GET', `/shifts/current?deviceId=${deviceId}`)).body;
  const sum = (await api('GET', `/shifts/${sh.id}/summary`)).body.summary;
  assert.equal(sum.prepaidReceived, s1.prepay.amount);
  assert.equal(sum.expectedCash, 1000 + s1.prepay.amount);
});

test('"ปิดห้อง" with nothing extra: closes right away, receipt shows prepaid + 0 outstanding + sign-up QR (no member)', async () => {
  const pre = await api('GET', `/sessions/${s1.id}/outstanding`);
  assert.equal(pre.status, 200);
  assert.equal(pre.body.outstanding, 0);
  assert.equal(pre.body.paid.prepaid, s1.prepay.amount);
  const r = await api('POST', `/sessions/${s1.id}/checkout`, {}, key('co-1'));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const snap = r.body.receipt.snapshot;
  assert.equal(snap.room.name.length > 0, true);
  assert.ok(snap.room.number);
  assert.ok(snap.room.type);
  assert.equal(snap.settlement.prepaid, s1.prepay.amount);
  assert.equal(snap.settlement.paidAtClose, 0);
  assert.equal(snap.settlement.outstanding, 0);
  assert.equal(snap.settlement.fullyPaid, true);
  assert.equal(snap.prepayments.length, 1);
  assert.equal(snap.prepayments[0].method, 'CASH');
  assert.ok(snap.memberSignup, 'sign-up QR because the bill has no member');
  assert.match(snap.memberSignup.path, /^\/book\/signup\?store=beatbox$/);
  assert.doesNotMatch(snap.memberSignup.path, /phone|password|08\d/);
  assert.match(snap.memberSignup.note, /4 ตัวท้าย/);
  // second click with another key → the same receipt, nothing new
  const r2 = await api('POST', `/sessions/${s1.id}/checkout`, {}, key('co-2'));
  assert.equal(r2.status, 200);
  assert.equal(r2.body.receipt.receipt_no, r.body.receipt.receipt_no);
  const { pool, runWithStore } = await import('../src/db/index.js');
  const n = await runWithStore(1, () => pool.query('SELECT count(*)::int AS n FROM receipts WHERE order_id = $1', [s1.order_id]));
  assert.equal(n.rows[0].n, 1);
  const pays = await runWithStore(1, () => pool.query('SELECT count(*)::int AS n FROM payments WHERE order_id = $1', [s1.order_id]));
  assert.equal(pays.rows[0].n, 0, 'no second charge');
  assert.equal((await board()).find((x) => x.id === 1).status, 'CLEANING');
});

test('extension + items after prepay → "ปิดห้อง" is refused with the full breakdown until the rest is paid', async () => {
  const o = await api('POST', '/sessions/open', { roomId: 3, guestCount: 2, minutes: 60, customerName: 'เพิ่มเวลา', items: [] });
  assert.equal(o.status, 200);
  const s = o.body;
  assert.equal((await api('POST', `/sessions/${s.id}/prepay`, { payments: [{ method: 'CARD', amount: s.prepay.amount, reference: 'EDC-1234' }] }, key('pp-s2'))).status, 200);
  assert.equal((await api('POST', `/sessions/${s.id}/extend`, { minutes: 30 })).status, 200);
  const it = await api('POST', `/orders/${s.order_id}/items`, { productId: 1, qty: 2 });
  assert.equal(it.status, 200);
  const co = await api('POST', `/sessions/${s.id}/checkout`, {}, key('co-s2'));
  assert.equal(co.status, 409);
  assert.equal(co.body.code, 'OUTSTANDING_BALANCE');
  assert.match(co.body.error, /ห้องนี้มียอดค้างชำระ/);
  assert.ok(co.body.outstanding > 0);
  assert.equal(co.body.paid.prepaid, s.prepay.amount);
  assert.ok(co.body.lines.some((l) => l.type === 'EXTENSION' || /เพิ่ม/.test(l.name)));
  assert.ok(co.body.lines.some((l) => l.type === 'PRODUCT' && l.qty === 2));
  assert.equal(co.body.totals.grandTotal - co.body.paid.applied, co.body.outstanding);
  // nothing changed: the room is still running
  const st = (await api('GET', `/sessions/${s.id}`)).body;
  assert.equal((st.session || st).status, 'ACTIVE');
  // pay only what is left (not the prepaid part again)
  const tooMuch = await api('POST', `/orders/${s.order_id}/pay`, { payments: [{ method: 'CARD', amount: co.body.outstanding + 50 }] }, key('pay-s2-x'));
  assert.equal(tooMuch.status, 400);
  const pay = await api('POST', `/orders/${s.order_id}/pay`, { payments: [{ method: 'CASH', amount: co.body.outstanding, received: co.body.outstanding + 20 }] }, key('pay-s2'));
  assert.equal(pay.status, 200, JSON.stringify(pay.body));
  const snap = pay.body.receipt.snapshot;
  assert.equal(snap.settlement.prepaid, s.prepay.amount);
  assert.equal(snap.settlement.paidAtClose, co.body.outstanding);
  assert.equal(snap.settlement.change, 20);
  assert.equal(snap.prepayments[0].reference, 'EDC-1234');
  assert.equal(snap.totals.grandTotal, co.body.totals.grandTotal);
});

test('postpay mode: enter first, everything goes on the room bill, closing still checks the balance', async () => {
  const room = (await api('GET', '/settings')).body.room;
  assert.equal((await api('PUT', '/settings/room', { ...room, paymentMode: 'POSTPAY' })).status, 200);
  const o = await api('POST', '/sessions/open', { roomId: 4, guestCount: 1, minutes: 60 });
  assert.equal(o.body.status, 'ACTIVE');
  const co = await api('POST', `/sessions/${o.body.id}/checkout`, {}, key('co-post'));
  assert.equal(co.status, 409);
  assert.equal(co.body.code, 'OUTSTANDING_BALANCE');
  assert.equal(co.body.paid.prepaid, 0);
  await api('PUT', '/settings/room', { ...room, paymentMode: 'PREPAY' });
});

test('give up before paying → the held room is released, the empty bill voided', async () => {
  const o = await api('POST', '/sessions/open', { roomId: 5, guestCount: 2, minutes: 60 });
  assert.equal(o.body.status, 'PENDING_PAYMENT');
  assert.equal((await api('POST', `/sessions/${o.body.id}/cancel-pending`, {})).status, 200);
  const room = (await board()).find((x) => x.id === 5);
  assert.equal(room.status, 'AVAILABLE');
  assert.equal(room.session, null);
});

test('room ticket data: room name / type / number, real start-end, ref no, opener; extensions listed', async () => {
  const o = await api('POST', '/sessions/open', { roomId: 6, guestCount: 2, minutes: 60 });
  await api('POST', `/sessions/${o.body.id}/prepay`, { payments: [{ method: 'CASH', amount: o.body.prepay.amount, received: o.body.prepay.amount }] }, key('pp-t'));
  await api('POST', `/sessions/${o.body.id}/extend`, { minutes: 30, reason: 'ลูกค้าขอเพิ่ม' });
  const t = (await api('GET', `/sessions/${o.body.id}/ticket`)).body;
  assert.ok(t.room && t.type && t.roomNumber);
  assert.ok(t.refNo);
  assert.ok(t.employee);
  assert.equal(t.minutes, 90);
  assert.equal(new Date(t.endAt) - new Date(t.startAt), 90 * 60000);
  const ext = t.adjustments.find((a) => a.type === 'EXTEND');
  assert.equal(ext.minutes, 30);
  assert.equal(ext.reason, 'ลูกค้าขอเพิ่ม');
  assert.ok(ext.employee);
});

test('print jobs: one record per client job id, reprint returns the same document marked as a copy', async () => {
  const payload = { docType: 'RECEIPT', data: { receiptNo: 'RC-TEST' } };
  const a = await api('POST', '/print-jobs', { clientJobId: 'job-rc-test', docType: 'RECEIPT', reference: 'RC-TEST', payload, status: 'PRINTING' });
  const b = await api('POST', '/print-jobs', { clientJobId: 'job-rc-test', docType: 'RECEIPT', reference: 'RC-TEST', payload, status: 'PRINTING' });
  assert.equal(a.body.id, b.body.id);
  assert.equal((await api('PATCH', `/print-jobs/${a.body.id}`, { status: 'FAILED', error: 'กระดาษหมด' })).status, 200);
  const list = (await api('GET', '/print-jobs?status=FAILED')).body;
  assert.ok(list.some((j) => j.id === a.body.id && j.error === 'กระดาษหมด'));
  const rp = await api('POST', `/print-jobs/${a.body.id}/reprint`, {});
  assert.equal(rp.status, 200);
  assert.deepEqual(rp.body.payload, payload);
  const copy = await api('POST', '/print-jobs', { clientJobId: 'job-rc-test-copy1', docType: 'RECEIPT', reference: 'RC-TEST', payload, isCopy: true, reprintOf: a.body.id, status: 'PRINTED' });
  assert.equal(copy.body.is_copy, true);
  assert.equal(copy.body.reprint_of, a.body.id);
});

test('printer route check: a direct USB printer prints the store font (raster), printer fonts only when accepted', async () => {
  const usb = await api('POST', '/printers', { name: 'USB store font', connection: 'USB', paperWidth: 80, renderMode: 'DRIVER', usbVendorId: 0x0483, usbProductId: 0x5743, usbSerial: 'ABC1' });
  assert.equal(usb.status, 200, JSON.stringify(usb.body));
  assert.equal(usb.body.render_mode, 'RASTER');
  assert.equal(usb.body.usb_vendor_id, 0x0483);
  assert.equal(usb.body.usb_product_id, 0x5743);
  assert.equal(usb.body.usb_serial, 'ABC1');
  const notAccepted = await api('POST', '/printers', { name: 'USB text', connection: 'USB', paperWidth: 80, renderMode: 'ESCPOS_TEXT', allowPrinterFont: false });
  assert.equal(notAccepted.body.code, 'PRINTER_FONT_NOT_ACCEPTED');
  const ok = await api('POST', '/printers', { name: 'USB text', connection: 'USB', paperWidth: 58, renderMode: 'ESCPOS_TEXT', allowPrinterFont: true, escposCodepage: 26, charsPerLine: 32 });
  assert.equal(ok.status, 200);
  const drv = await api('POST', '/printers', { name: 'Driver 80', connection: 'BROWSER', paperWidth: 80, printableWidthMm: 72, fontScale: 1.2 });
  assert.equal(drv.status, 200);
  assert.equal(Number(drv.body.printable_width_mm), 72);
  assert.equal(drv.body.render_mode, 'DRIVER');
});

test('printer: use for every document, then delete (gone from the list and from routing)', async () => {
  const p = await api('POST', '/printers', { name: 'Xprinter USB', connection: 'USB', paperWidth: 80, renderMode: 'RASTER', usbVendorId: 1155, usbProductId: 22339 });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const all = await api('POST', `/printers/${p.body.id}/use-for-all`);
  assert.equal(all.status, 200, JSON.stringify(all.body));
  const docs = await api('GET', '/documents/settings');
  const routing = docs.body.routing || docs.body.documents?.routing;
  assert.ok(routing && Object.keys(routing).length > 3);
  for (const v of Object.values(routing)) assert.equal(Number(v.printerId), p.body.id);
  let list = await api('GET', '/printers');
  const me = list.body.find((x) => x.id === p.body.id);
  assert.equal(me.is_default, true);
  assert.equal(list.body.filter((x) => x.is_default).length, 1);
  const del = await api('DELETE', `/printers/${p.body.id}`);
  assert.equal(del.status, 200);
  list = await api('GET', '/printers');
  assert.ok(!list.body.some((x) => x.id === p.body.id));
  const docs2 = await api('GET', '/documents/settings');
  const routing2 = docs2.body.routing || docs2.body.documents?.routing;
  for (const v of Object.values(routing2)) assert.notEqual(Number(v.printerId), p.body.id);
  const again = await api('DELETE', `/printers/${p.body.id}`);
  assert.equal(again.status, 404);
});

test('cross-store guard: an id of another store can never be attached (even though the id exists)', async () => {
  const reg = await api('POST', '/platform/register', { storeName: 'ร้านที่สอง', ownerFirstName: 'บี', ownerLastName: 'สอง', email: 'b@pay.test', phone: '0899999999', password: 'password1', confirmPassword: 'password1', planId: 4 }, { tok: null });
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  const tokB = reg.body.token;
  const m = await api('POST', '/members', { firstName: 'สมาชิกร้านบี', phone: '0812223333' }, { tok: tokB });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  // store A tries to put store B's member on a bill → refused by the database
  const o = await api('POST', '/orders', { memberId: m.body.id, items: [{ productId: 1, qty: 1 }] });
  assert.equal(o.status, 400);
  assert.equal(o.body.code, 'INVALID_REFERENCE');
  // and cannot read it
  assert.equal((await api('GET', `/members/${m.body.id}`)).status, 404);
});

// ───── members: phone + password, no OTP ─────
const pub = (method, url, body, tok = null) => api(method, url, body, { tok, headers: { 'X-Store': 'beatbox' } });

let memberId;
test('member sign-up without OTP; same phone → log in instead; leading-zero default password', async () => {
  const r = await pub('POST', '/public/auth/signup', { phone: '081-234-0099', firstName: 'ทดสอบ', lastName: 'สมาชิก' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.message, 'สมัครสมาชิกสำเร็จ รหัสผ่านเริ่มต้นของคุณคือเลข 4 ตัวท้ายของเบอร์โทรศัพท์ กรุณาเปลี่ยนรหัสผ่านเมื่อเข้าสู่ระบบครั้งแรก');
  assert.ok(!JSON.stringify(r.body).includes('0099'), 'the password is never sent back');
  const dup = await pub('POST', '/public/auth/signup', { phone: '0812340099', firstName: 'ซ้ำ', lastName: 'ซ้ำ' });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, 'MEMBER_EXISTS');
  assert.equal(dup.body.login, true);
  // missing last name → validation
  assert.equal((await pub('POST', '/public/auth/signup', { phone: '0812340100', firstName: 'ก' })).status, 400);
});

test('first login with the last 4 digits forces a new password before member data', async () => {
  assert.equal((await pub('POST', '/public/auth/login', { phone: '0812340099', password: '99' })).status, 401);
  const r = await pub('POST', '/public/auth/login', { phone: '0812340099', password: '0099' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.mustChangePassword, true);
  memberId = r.body.member.id;
  const me = await pub('GET', '/public/me', null, r.body.token);
  assert.equal(me.status, 200);
  assert.equal(me.body.mustChangePassword, true);
  assert.equal((await pub('GET', '/public/me/bookings', null, r.body.token)).body.code, 'PASSWORD_CHANGE_REQUIRED');
  assert.equal((await pub('POST', '/public/me/password', { current: '0099', password: '0099' }, r.body.token)).status, 400);
  assert.equal((await pub('POST', '/public/me/password', { current: '1111', password: 'secret99' }, r.body.token)).status, 401);
  assert.equal((await pub('POST', '/public/me/password', { current: '0099', password: 'secret99' }, r.body.token)).status, 200);
  assert.equal((await pub('GET', '/public/me/bookings', null, r.body.token)).status, 200);
  assert.equal((await pub('POST', '/public/auth/login', { phone: '0812340099', password: '0099' })).status, 401, 'default no longer works');
  const r2 = await pub('POST', '/public/auth/login', { phone: '0812340099', password: 'secret99' });
  assert.equal(r2.body.mustChangePassword, false);
  const { pool, runWithStore } = await import('../src/db/index.js');
  const row = (await runWithStore(1, () => pool.query('SELECT password_hash FROM members WHERE id = $1', [memberId]))).rows[0];
  assert.match(row.password_hash, /^\$2[aby]\$/, 'stored hashed');
});

test('member lockout after 5 wrong passwords; staff reset unlocks, back to default, logged with who and when', async () => {
  for (let i = 0; i < 4; i++) assert.equal((await pub('POST', '/public/auth/login', { phone: '0812340099', password: 'wrong' })).status, 401);
  assert.equal((await pub('POST', '/public/auth/login', { phone: '0812340099', password: 'wrong' })).status, 429);
  const locked = await pub('POST', '/public/auth/login', { phone: '0812340099', password: 'secret99' });
  assert.equal(locked.status, 429, 'correct password still refused while locked');
  // staff: status shown, never the password
  const list = await api('GET', '/members?q=0812340099');
  const m = list.body.find((x) => x.id === memberId);
  assert.equal(m.password_is_default, false);
  assert.ok(!('password_hash' in m));
  assert.ok(!JSON.stringify(list.body).includes('$2'), 'no hash in any staff response');
  const rs = await api('POST', `/members/${memberId}/reset-password`, { reason: 'ลูกค้าลืมรหัสผ่าน' });
  assert.equal(rs.status, 200);
  const after = (await api('GET', '/members?q=0812340099')).body.find((x) => x.id === memberId);
  assert.equal(after.password_is_default, true);
  assert.equal(after.must_change_password, true);
  assert.ok(after.password_reset_at);
  assert.ok(after.password_reset_by_name);
  const log = (await api('GET', '/activity-logs?action=MEMBER_PASSWORD_RESET')).body;
  assert.ok(JSON.stringify(log).includes('MEMBER_PASSWORD_RESET'));
  const r = await pub('POST', '/public/auth/login', { phone: '0812340099', password: '0099' });
  assert.equal(r.status, 200);
  assert.equal(r.body.mustChangePassword, true);
});

test('receipt: no sign-up QR when the bill has a member', async () => {
  const o = await api('POST', '/orders', { memberId, items: [{ productId: 1, qty: 1 }] });
  assert.equal(o.status, 200, JSON.stringify(o.body));
  const total = (await api('GET', `/orders/${o.body.id}`)).body.calc.netTotal;
  const pay = await api('POST', `/orders/${o.body.id}/pay`, { payments: [{ method: 'CASH', amount: total, received: total }] }, key('pay-member'));
  assert.equal(pay.status, 200, JSON.stringify(pay.body));
  assert.equal(pay.body.receipt.snapshot.memberSignup, null);
  assert.equal(pay.body.receipt.snapshot.member.code.length > 0, true);
  assert.ok(!JSON.stringify(pay.body).includes('password_hash'));
});

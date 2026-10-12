// Multi-store: registration (no OTP), isolation between stores, plans / features / limits, expiry + renewal,
// in-flight payments after expiry, Super Owner console + "enter store" audit trail.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const DB = (process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/beatbox_test').replace(/\/[^/]+$/, '/beatbox_test_ms');
process.env.DATABASE_URL = DB;
process.env.DISABLE_SCHEDULER = 'true';
process.env.PAYMENT_MODE = 'DEMO';
process.env.PORT = '4997';
process.env.SUPER_OWNER_USERNAME = 'purinut kittikunapong';
process.env.SUPER_OWNER_PASSWORD = '188452PP';

let server;
let base;

async function api(method, url, body, { token, headers = {} } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

let tokenA; // original store admin (PIN)
let tokenB; // registered store owner
let storeB;
let superToken;

before(async () => {
  const admin = new pg.Client({ connectionString: DB.replace(/\/[^/]+$/, '/postgres') });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS beatbox_test_ms WITH (FORCE)');
  await admin.query('CREATE DATABASE beatbox_test_ms');
  await admin.end();
  const { start } = await import('../src/index.js');
  server = await start();
  base = 'http://localhost:4997/api';
  tokenA = (await api('POST', '/auth/login', { pin: '1234' })).body.token;
});

after(async () => {
  server?.close();
  const { pool } = await import('../src/db/index.js');
  await pool.end();
  setTimeout(() => process.exit(0), 200).unref();
});

test('store registration with email + password (no OTP), duplicate email rejected', async () => {
  const pub = await api('GET', '/platform/public');
  assert.equal(pub.body.plans.length, 4);
  const plan = pub.body.plans[1];
  const bad = await api('POST', '/platform/register', { storeName: 'ร้านบี', ownerFirstName: 'บี', ownerLastName: 'เจ้าของ', email: 'b@shop.test', phone: '0812223333', password: 'secret123', confirmPassword: 'nope1234', planId: plan.id });
  assert.equal(bad.status, 400);
  const r = await api('POST', '/platform/register', { storeName: 'Karaoke B Shop', ownerFirstName: 'บี', ownerLastName: 'เจ้าของ', email: 'B@Shop.test', phone: '081-222-3333', password: 'secret123', confirmPassword: 'secret123', planId: plan.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.token);
  assert.equal(r.body.subscription.status, 'TRIAL');
  assert.equal(r.body.subscription.plan.id, plan.id);
  assert.ok(new Date(r.body.subscription.expiresAt) > new Date());
  storeB = r.body.storeId;
  tokenB = r.body.token;
  assert.notEqual(storeB, 1);
  const dup = await api('POST', '/platform/register', { storeName: 'Another', ownerFirstName: 'x', ownerLastName: 'y', email: 'b@shop.test', phone: '0812223334', password: 'secret123', confirmPassword: 'secret123', planId: plan.id });
  assert.equal(dup.status, 409);
  // owner signs in with email + password
  const login = await api('POST', '/auth/owner-login', { email: 'b@shop.test', password: 'secret123' });
  assert.equal(login.status, 200);
  assert.equal(login.body.store.id, storeB);
  assert.equal(login.body.employee.isOwner, true);
});

test('stores are isolated: data, ids, URLs and headers cannot cross stores', async () => {
  const roomsA = (await api('GET', '/rooms', null, { token: tokenA })).body;
  const roomsB = (await api('GET', '/rooms', null, { token: tokenB })).body;
  assert.equal(roomsA.length, 10);
  assert.equal(roomsB.length, 0);
  const typeB = await api('POST', '/room-types', { code: 'STD', name: 'Standard B', capacity: 4, priceHour: 200 }, { token: tokenB });
  assert.equal(typeB.status, 200, JSON.stringify(typeB.body));
  const roomB = await api('POST', '/rooms', { name: 'B-01', number: '01', roomTypeId: typeB.body.id, capacity: 4, priceHour: 200 }, { token: tokenB });
  assert.equal(roomB.status, 200, JSON.stringify(roomB.body));
  // A cannot see / edit B's room by id, B cannot see A's
  assert.ok(!(await api('GET', '/rooms', null, { token: tokenA })).body.some((x) => x.id === roomB.body.id));
  assert.equal((await api('PUT', `/rooms/${roomB.body.id}`, { name: 'hacked', number: '99', roomTypeId: typeB.body.id, capacity: 4, priceHour: 1 }, { token: tokenA })).status, 404);
  assert.equal((await api('PUT', `/rooms/${roomsA[0].id}`, { name: 'hacked', number: '99', roomTypeId: roomsA[0].room_type_id, capacity: 4, priceHour: 1 }, { token: tokenB })).status, 404);
  // a store header cannot override the store in the token
  const viaHeader = await api('GET', '/rooms', null, { token: tokenB, headers: { 'X-Store': 'beatbox' } });
  assert.equal(viaHeader.body.length, 1);
  // members / orders of A are invisible to B
  assert.equal((await api('GET', '/members', null, { token: tokenB })).body.length || 0, 0);
  // public site per store
  const slugB = (await api('GET', '/auth/me', null, { token: tokenB })).body.store.slug;
  const catB = await api('GET', `/public/catalog?store=${slugB}`);
  assert.equal(catB.body.rooms.length, 1);
  assert.equal((await api('GET', '/public/catalog?store=beatbox')).body.rooms.length, 10);
  assert.equal((await api('GET', '/public/catalog?store=does-not-exist')).status, 404);
  // the same document numbers can exist in both stores (numbers are per store)
  const settingsB = (await api('GET', '/settings', null, { token: tokenB })).body;
  assert.equal(settingsB.store.name, 'Karaoke B Shop');
});

test('Super Owner: account from server config, 4 plans with editable price / features / limits', async () => {
  const bad = await api('POST', '/platform/login', { username: 'purinut kittikunapong', password: 'wrong' });
  assert.equal(bad.status, 401);
  const r = await api('POST', '/platform/login', { username: 'purinut kittikunapong', password: '188452PP' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.user.role, 'SUPER_OWNER');
  assert.ok(!JSON.stringify(r.body).includes('188452PP'));
  superToken = r.body.token;
  // a store token is not a platform token
  assert.equal((await api('GET', '/platform/stores', null, { token: tokenB })).status, 401);
  const stores = await api('GET', '/platform/stores', null, { token: superToken });
  assert.equal(stores.body.length, 2);
  const plans = (await api('GET', '/platform/plans', null, { token: superToken })).body.plans;
  assert.equal(plans.length, 4);
  const planB = stores.body.find((s) => s.id === storeB).plan_id;
  const p = plans.find((x) => x.id === planB);
  // turn booking off + limit rooms to 1 for B's plan
  const upd = await api('PUT', `/platform/plans/${p.id}`, { ...p, price: 1234, features: { ...p.features, booking: false }, limits: { ...p.limits, rooms: 1 } }, { token: superToken });
  assert.equal(upd.status, 200, JSON.stringify(upd.body));
  assert.equal(upd.body.price, 1234);
  const noBooking = await api('GET', '/reservations', null, { token: tokenB });
  assert.equal(noBooking.status, 403);
  assert.equal(noBooking.body.code, 'FEATURE_NOT_IN_PLAN');
  const me = (await api('GET', '/auth/me', null, { token: tokenB })).body;
  assert.ok(!me.permissions.includes('booking.manage'));
  const typeId = (await api('GET', '/room-types', null, { token: tokenB })).body[0].id;
  const second = await api('POST', '/rooms', { name: 'B-02', number: '02', roomTypeId: typeId, capacity: 4, priceHour: 200 }, { token: tokenB });
  assert.equal(second.status, 403);
  assert.equal(second.body.code, 'PLAN_LIMIT');
  // restore
  await api('PUT', `/platform/plans/${p.id}`, { ...p, features: { ...p.features, booking: true }, limits: { ...p.limits, rooms: 15 } }, { token: superToken });
  assert.equal((await api('GET', '/reservations', null, { token: tokenB })).status, 200);
});

test('expiry blocks the API (data kept), in-flight payments finish, renewal brings everything back', async () => {
  // prepare a sale in store B with a payment already verified before the expiry
  await api('PUT', '/settings/payment', { slipCheckSeconds: 0 }, { token: tokenB });
  const dev = await api('POST', '/devices/register', { name: 'POS-B', deviceKey: 'store-b-device-1' }, { token: tokenB });
  const devHeaders = { 'X-Device-Id': String(dev.body.id) };
  assert.equal((await api('POST', '/shifts/open', { deviceId: dev.body.id, openingCash: 0 }, { token: tokenB, headers: devHeaders })).status, 200);
  const prod = await api('POST', '/products', { sku: 'B1', name: 'น้ำ B', price: 50, trackStock: false }, { token: tokenB });
  const order = await api('POST', '/orders', { items: [{ productId: prod.body.id, qty: 1 }] }, { token: tokenB, headers: devHeaders });
  assert.equal(order.status, 200, JSON.stringify(order.body));
  const total = (await api('GET', `/orders/${order.body.id}`, null, { token: tokenB })).body.calc.netTotal;
  const slip = await api('POST', '/payments/verify-slip', { orderId: order.body.id, amount: total, method: 'QR' }, { token: tokenB });
  assert.equal(slip.status, 200, JSON.stringify(slip.body));
  // the plan runs out a moment after the payment was started
  const exp = await api('POST', `/platform/stores/${storeB}/subscription`, { action: 'SET_EXPIRY', expiresAt: new Date(Date.now() + 2000).toISOString() }, { token: superToken });
  assert.equal(exp.status, 200, JSON.stringify(exp.body));
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal((await api('GET', '/subscription', null, { token: tokenB })).body.subscription.status, 'EXPIRED');
  const blocked = await api('GET', '/rooms', null, { token: tokenB });
  assert.equal(blocked.status, 402);
  assert.equal(blocked.body.code, 'SUBSCRIPTION_EXPIRED');
  assert.equal((await api('POST', '/categories', { name: 'x' }, { token: tokenB })).status, 402);
  // the subscription screen still works
  const sub = await api('GET', '/subscription', null, { token: tokenB });
  assert.equal(sub.status, 200);
  assert.equal(sub.body.subscription.status, 'EXPIRED');
  // the QR payment verified before expiry is still recorded (exactly once)
  const pay = await api('POST', `/orders/${order.body.id}/pay`, { payments: [{ method: 'QR', amount: total, verificationToken: slip.body.verificationToken }] }, { token: tokenB, headers: { ...devHeaders, 'Idempotency-Key': 'b-pay-1' } });
  assert.equal(pay.status, 200, JSON.stringify(pay.body));
  const replay = await api('POST', `/orders/${order.body.id}/pay`, { payments: [{ method: 'QR', amount: total, verificationToken: slip.body.verificationToken }] }, { token: tokenB, headers: { ...devHeaders, 'Idempotency-Key': 'b-pay-1' } });
  assert.equal(replay.body.receipt.receipt_no, pay.body.receipt.receipt_no);
  // a new cash sale is refused
  assert.equal((await api('POST', '/orders', { items: [{ productId: prod.body.id, qty: 1 }] }, { token: tokenB, headers: devHeaders })).status, 402);
  // store A is not affected
  assert.equal((await api('GET', '/rooms', null, { token: tokenA })).status, 200);
  // the store asks for renewal, the Super Owner renews → old data is back
  assert.equal((await api('POST', '/subscription/renewal-request', { message: 'ต่ออายุ 1 เดือน' }, { token: tokenB })).status, 200);
  const renew = await api('POST', `/platform/stores/${storeB}/subscription`, { action: 'RENEW', planId: sub.body.subscription.plan.id, periods: 1 }, { token: superToken });
  assert.equal(renew.body.subscription.status, 'ACTIVE');
  const rooms = await api('GET', '/rooms', null, { token: tokenB });
  assert.equal(rooms.status, 200);
  assert.equal(rooms.body.length, 1);
  const events = (await api('GET', `/platform/stores/${storeB}/events`, null, { token: superToken })).body;
  assert.deepEqual(events.slice(0, 2).map((e) => e.action), ['RENEW', 'SET_EXPIRY']);
  assert.ok(events.every((e) => e.actor_name && e.created_at));
});

test('suspend / activate, trial days set by the Super Owner', async () => {
  const s = await api('POST', `/platform/stores/${storeB}/subscription`, { action: 'SUSPEND', reason: 'ค้างชำระ' }, { token: superToken });
  assert.equal(s.body.subscription.status, 'SUSPENDED');
  assert.equal((await api('GET', '/rooms', null, { token: tokenB })).status, 402);
  await api('POST', `/platform/stores/${storeB}/subscription`, { action: 'ACTIVATE' }, { token: superToken });
  const t = await api('POST', `/platform/stores/${storeB}/subscription`, { action: 'TRIAL', planId: s.body.subscription.plan.id, days: 30 }, { token: superToken });
  assert.equal(t.body.subscription.status, 'TRIAL');
  const days = (new Date(t.body.subscription.expiresAt) - Date.now()) / 86400000;
  assert.ok(days > 29.9 && days <= 30);
  assert.equal((await api('GET', '/rooms', null, { token: tokenB })).status, 200);
});

test('Super Owner enters a store: banner identity + activity logged as the real Super Owner', async () => {
  const e = await api('POST', `/platform/stores/${storeB}/enter`, {}, { token: superToken });
  assert.equal(e.status, 200, JSON.stringify(e.body));
  assert.equal(e.body.store.id, storeB);
  assert.equal(e.body.employee.superOwnerName, 'purinut kittikunapong');
  const t = e.body.token;
  const cat = await api('POST', '/categories', { name: 'จาก Super Owner' }, { token: t });
  assert.equal(cat.status, 200);
  const logs = (await api('GET', '/activity-logs?action=CATEGORY_CREATE', null, { token: tokenB })).body;
  const row = logs.find((l) => l.entity_id === String(cat.body.id));
  assert.equal(row.actor_type, 'SUPER_OWNER');
  assert.ok(row.platform_user_id);
  assert.match(row.employee_name, /Super Owner/);
  // the hidden helper account is not listed as staff and cannot log in by PIN
  const emps = (await api('GET', '/employees', null, { token: tokenB })).body;
  assert.ok(!emps.some((x) => /Super Owner/.test(x.name)));
  // the enter token belongs to store B only
  assert.equal((await api('GET', '/rooms', null, { token: t })).body.length, 1);
});

test('owner login locks after repeated wrong passwords', async () => {
  for (let i = 0; i < 4; i++) assert.equal((await api('POST', '/auth/owner-login', { email: 'b@shop.test', password: 'bad' })).status, 401);
  const fifth = await api('POST', '/auth/owner-login', { email: 'b@shop.test', password: 'bad' });
  assert.match(fifth.body.error, /15 นาที/);
  assert.equal((await api('POST', '/auth/owner-login', { email: 'b@shop.test', password: 'secret123' })).status, 401);
});

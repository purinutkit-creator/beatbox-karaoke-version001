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
process.env.SEED_STORE_CODE = 'beatbox1';
process.env.ADMIN_PASSWORD = 'Admin12345';
process.env.SUPER_OWNER_USERNAME = 'purinut kittikunapong';
process.env.SUPER_OWNER_PASSWORD = '188452PP';
process.env.SUPER_OWNER_EMAIL = 'purinut.kit@gmail.com';

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

// a device signs in to the store first (store code + store account), then staff use their PIN
let storeSession;
async function pinLogin(pin) {
  storeSession ||= (await api('POST', '/auth/store-login', { storeCode: 'beatbox1', login: 'admin', password: 'Admin12345' })).body.storeSession;
  return api('POST', '/auth/login', { pin }, { headers: { 'X-Store-Session': storeSession } });
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
  tokenA = (await pinLogin('1234')).body.token;
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
  // the Super Admin also signs in with the e-mail (here, and on the store login page), no OTP
  const byEmail = await api('POST', '/platform/login', { username: 'Purinut.Kit@gmail.com', password: '188452PP' });
  assert.equal(byEmail.status, 200);
  assert.equal(byEmail.body.user.email, 'purinut.kit@gmail.com');
  const viaStoreLogin = await api('POST', '/auth/owner-login', { email: 'purinut.kit@gmail.com', password: '188452PP' });
  assert.equal(viaStoreLogin.status, 200);
  assert.equal(viaStoreLogin.body.platform, true);
  assert.ok(viaStoreLogin.body.token);
  assert.ok(!JSON.stringify(viaStoreLogin.body).includes('188452PP'));
  assert.equal((await api('POST', '/auth/owner-login', { email: 'purinut.kit@gmail.com', password: 'nope' })).status, 401);
  // nobody can register a store with the Super Admin's e-mail
  const taken = await api('POST', '/platform/register', { storeName: 'ปลอม', ownerFirstName: 'ก', ownerLastName: 'ข', email: 'purinut.kit@gmail.com', phone: '0811112222', password: 'password1', confirmPassword: 'password1', planId: 1 });
  assert.equal(taken.status, 409);
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

test('store login: store code → store account → staff PIN; a PIN alone never signs in', async () => {
  // store code lookup (step 1)
  const look = await api('GET', '/auth/store/BEATBOX1');
  assert.equal(look.status, 200);
  assert.equal(look.body.name, 'BEATBOX Karaoke');
  assert.equal((await api('GET', '/auth/store/zzzz9999')).status, 404);
  // a PIN without signing the device in to the store is refused
  const noStore = await api('POST', '/auth/login', { pin: '1234' });
  assert.equal(noStore.status, 401);
  assert.equal(noStore.body.code, 'STORE_LOGIN_REQUIRED');
  // wrong password / username
  assert.equal((await api('POST', '/auth/store-login', { storeCode: 'beatbox1', login: 'admin', password: 'wrong-pass' })).status, 401);
  assert.equal((await api('POST', '/auth/store-login', { storeCode: 'beatbox1', login: 'nobody', password: 'Admin12345' })).status, 401);
  // step 2 → store session, step 3 → PIN
  const s = await api('POST', '/auth/store-login', { storeCode: ' beatbox1 ', login: 'ADMIN', password: 'Admin12345' });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.body.store.code, 'beatbox1');
  const owner = await api('POST', '/auth/login', { pin: '1234' }, { headers: { 'X-Store-Session': s.body.storeSession } });
  assert.equal(owner.status, 200);
  assert.equal(owner.body.employee.isOwner, true);
  assert.equal(owner.body.store.code, 'beatbox1');
  // the session of store A cannot be used for PINs of store B: store B's owner PIN 1234 signs in to store A's owner
  const regB = await api('GET', '/auth/me', null, { token: tokenB });
  assert.ok(regB.body.store.code && regB.body.store.code !== 'beatbox1');
});

test('new store: random 8-character code, owner PIN 1234, owner always has every permission', async () => {
  const pub = await api('GET', '/platform/public');
  const r = await api('POST', '/platform/register', { storeName: 'ร้านซี', ownerFirstName: 'ซี', ownerLastName: 'เจ้าของ', email: 'c@shop.test', phone: '0812224444', password: 'secretC123', confirmPassword: 'secretC123', planId: pub.body.plans[3].id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.storeCode, /^[a-z0-9]{8}$/);
  assert.ok(/[0-9]/.test(r.body.storeCode) && /[a-z]/.test(r.body.storeCode));
  assert.equal(r.body.login.pin, '1234');
  assert.ok(r.body.storeSession);
  // the registering device can use the PIN pad straight away
  const pin = await api('POST', '/auth/login', { pin: '1234' }, { headers: { 'X-Store-Session': r.body.storeSession } });
  assert.equal(pin.status, 200);
  assert.equal(pin.body.employee.isOwner, true);
  assert.ok(pin.body.permissions.includes('settings.manage'));
  assert.ok(pin.body.permissions.includes('employee.manage'));
  // sign in on another device with username or e-mail
  const byUser = await api('POST', '/auth/store-login', { storeCode: r.body.storeCode, login: 'admin', password: 'secretC123' });
  const byMail = await api('POST', '/auth/store-login', { storeCode: r.body.storeCode, login: 'C@shop.test', password: 'secretC123' });
  assert.equal(byUser.status, 200);
  assert.equal(byMail.status, 200);
  // a manager cannot delete, switch off or re-permission the owner
  const tok = pin.body.token;
  const roles = (await api('GET', '/roles', null, { token: tok })).body;
  const mgrRole = roles.find((x) => x.code === 'MANAGER');
  const m = await api('POST', '/employees', { name: 'ผู้จัดการ', pin: '5555', roleId: mgrRole.id }, { token: tok });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  await api('PUT', `/employees/${m.body.id}/permissions`, { overrides: [{ code: 'employee.manage', granted: true }] }, { token: tok });
  const mgr = await api('POST', '/auth/login', { pin: '5555' }, { headers: { 'X-Store-Session': r.body.storeSession } });
  const ownerId = pin.body.employee.id;
  assert.equal((await api('DELETE', `/employees/${ownerId}`, null, { token: mgr.body.token })).status, 403);
  assert.equal((await api('PUT', `/employees/${ownerId}`, { name: 'x', roleId: mgrRole.id, isActive: false }, { token: mgr.body.token })).status, 403);
  assert.equal((await api('PUT', `/employees/${ownerId}/permissions`, { overrides: [] }, { token: tok })).status, 400);
  // owner changes own PIN (needs the current PIN); PINs are unique inside the store
  assert.equal((await api('POST', '/auth/my-pin', { current: '0000', pin: '7777' }, { token: tok })).status, 401);
  assert.equal((await api('POST', '/auth/my-pin', { current: '1234', pin: '5555' }, { token: tok })).status, 409);
  assert.equal((await api('POST', '/auth/my-pin', { current: '1234', pin: '7777' }, { token: tok })).status, 200);
  assert.equal((await api('POST', '/auth/login', { pin: '7777' }, { headers: { 'X-Store-Session': r.body.storeSession } })).body.employee.isOwner, true);
});

test('Super Owner sees and resets the starting login; the owner sees and changes everything', async () => {
  const sup = (await api('POST', '/platform/login', { username: 'purinut kittikunapong', password: '188452PP' })).body.token;
  const list = (await api('GET', '/platform/stores', null, { token: sup })).body;
  assert.equal(list.find((x) => x.id === 1).store_code, 'beatbox1');
  // store 1: starting password from the server config, owner PIN 1234
  const acc = await api('GET', '/platform/stores/1/account', null, { token: sup });
  assert.equal(acc.status, 200);
  assert.equal(acc.body.storeCode, 'beatbox1');
  assert.equal(acc.body.owner.username, 'admin');
  assert.equal(acc.body.owner.startingPassword, 'Admin12345');
  assert.equal(acc.body.owner.pin, '1234');
  // the starting secrets never leak through the normal API
  const emps = await api('GET', '/employees', null, { token: tokenA });
  assert.ok(!JSON.stringify(emps.body).includes('initial_password'));
  // reset → new starting password, the old one stops working
  const reset = await api('POST', '/platform/stores/1/reset-password', {}, { token: sup });
  const fresh = reset.body.owner.startingPassword;
  assert.ok(fresh && fresh !== 'Admin12345');
  assert.equal((await api('POST', '/auth/store-login', { storeCode: 'beatbox1', login: 'admin', password: 'Admin12345' })).status, 401);
  assert.equal((await api('POST', '/auth/store-login', { storeCode: 'beatbox1', login: 'admin', password: fresh })).status, 200);
  // the owner sees the same starting password, changes username / code / password
  const mine = await api('GET', '/auth/store-account', null, { token: tokenA });
  assert.equal(mine.body.owner.startingPassword, fresh);
  const upd = await api('PUT', '/auth/store-account', { username: 'beatboxowner', storeCode: 'bb12cd34' }, { token: tokenA });
  assert.equal(upd.status, 200, JSON.stringify(upd.body));
  assert.equal(upd.body.storeCode, 'bb12cd34');
  assert.equal((await api('PUT', '/auth/store-account', { storeCode: 'abc' }, { token: tokenA })).status, 400);
  assert.equal((await api('POST', '/auth/password', { current: fresh, password: 'MyOwnPass99' }, { token: tokenA })).status, 200);
  const after = await api('GET', '/platform/stores/1/account', null, { token: sup });
  assert.equal(after.body.owner.startingPassword, null, 'the owner chose a password → nobody can see it');
  assert.equal(after.body.owner.username, 'beatboxowner');
  const s2 = await api('POST', '/auth/store-login', { storeCode: 'bb12cd34', login: 'beatboxowner', password: 'MyOwnPass99' });
  assert.equal(s2.status, 200);
  // "sign every device out" → old store sessions stop working for PINs
  assert.equal((await api('POST', '/platform/stores/1/sign-out-devices', {}, { token: sup })).status, 200);
  const old = await api('POST', '/auth/login', { pin: '1234' }, { headers: { 'X-Store-Session': s2.body.storeSession } });
  assert.equal(old.status, 401);
  // a staff member (not owner) cannot open the store account
  const staff = await api('POST', '/auth/login', { pin: '4444' }, { headers: { 'X-Store-Session': (await api('POST', '/auth/store-login', { storeCode: 'bb12cd34', login: 'beatboxowner', password: 'MyOwnPass99' })).body.storeSession } });
  assert.equal((await api('GET', '/auth/store-account', null, { token: staff.body.token })).status, 403);
  // owner PIN reset by the Super Owner
  const pinReset = await api('POST', '/platform/stores/1/reset-owner-pin', {}, { token: sup });
  assert.equal(pinReset.body.owner.pin, '1234');
});

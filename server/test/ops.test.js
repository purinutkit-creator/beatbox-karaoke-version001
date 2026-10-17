// Free "+5 นาที" with a reason, automatic kitchen / bar tickets for every order (POS sale + items added to a room).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const DB = (process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/beatbox_test').replace(/\/[^/]+$/, '/beatbox_test_ops');
process.env.DATABASE_URL = DB;
process.env.DISABLE_SCHEDULER = 'true';
process.env.PAYMENT_MODE = 'DEMO';
process.env.PORT = '4995';
process.env.SEED_STORE_CODE = 'beatbox1';
process.env.ADMIN_PASSWORD = 'Admin12345';

let server;
let base;
let token;
let deviceId;

async function api(method, url, body, { headers = {} } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(deviceId ? { 'X-Device-Id': String(deviceId) } : {}), ...headers },
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
const key = (k) => ({ headers: { 'Idempotency-Key': k } });
let db;
const q = async (sql, params) => {
  const { runWithStore } = await import('../src/db/index.js');
  return runWithStore(1, () => db.query(sql, params));
};

before(async () => {
  const admin = new pg.Client({ connectionString: DB.replace(/\/[^/]+$/, '/postgres') });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS beatbox_test_ops WITH (FORCE)');
  await admin.query('CREATE DATABASE beatbox_test_ops');
  await admin.end();
  const { start } = await import('../src/index.js');
  server = await start();
  db = (await import('../src/db/index.js')).pool;
  base = 'http://localhost:4995/api';
  token = (await pinLogin('1234')).body.token;
  deviceId = (await api('POST', '/devices/register', { name: 'POS-OPS', deviceKey: 'test-device-key-ops' })).body.id;
  await api('POST', '/shifts/open', { deviceId, openingCash: 1000 });
});

after(async () => {
  server?.close();
  await db.end();
  setTimeout(() => process.exit(0), 200).unref();
});

test('+5 minutes free needs a reason, moves the end time and adds no charge', async () => {
  const o = await api('POST', '/sessions/open', { roomId: 2, guestCount: 2, minutes: 60, customerName: 'บวกห้านาที', items: [] });
  assert.equal(o.status, 200, JSON.stringify(o.body));
  const s = o.body;
  assert.equal((await api('POST', `/sessions/${s.id}/prepay`, { payments: [{ method: 'CASH', amount: s.prepay.amount, received: s.prepay.amount }] }, key('ops-pp1'))).status, 200);
  const before5 = (await api('GET', `/sessions/${s.id}`)).body;
  const noReason = await api('POST', `/sessions/${s.id}/extend`, { minutes: 5, free: true });
  assert.equal(noReason.status, 400);
  const ok = await api('POST', `/sessions/${s.id}/extend`, { minutes: 5, free: true, reason: 'ไมค์มีปัญหา ชดเชยเวลา' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.bonus_minutes, 5);
  assert.equal(ok.body.extension_minutes, 0);
  const end0 = new Date((before5.session || before5).scheduled_end_at).getTime();
  assert.equal(new Date(ok.body.scheduled_end_at).getTime() - end0, 5 * 60000);
  const after5 = (await api('GET', `/sessions/${s.id}`)).body;
  assert.equal(after5.charges.roomTotal, before5.charges.roomTotal, 'no extra charge');
  const adj = after5.adjustments.find((a) => a.type === 'EXTEND');
  assert.equal(adj.reason, 'ไมค์มีปัญหา ชดเชยเวลา');
  assert.equal(adj.after.free, true);
  // a charged +5 still costs money
  const paid = await api('POST', `/sessions/${s.id}/extend`, { minutes: 5, reason: 'ลูกค้าขอเพิ่ม' });
  assert.equal(paid.body.extension_minutes, 5);
  assert.ok((await api('GET', `/sessions/${s.id}`)).body.charges.roomTotal > before5.charges.roomTotal);
});

const kitchenProduct = async () => (await q(`SELECT p.id FROM products p JOIN categories c ON c.id = p.category_id WHERE c.station = 'KITCHEN' AND p.is_available ORDER BY p.id LIMIT 1`)).rows[0].id;
const jobsFor = async (orderNo) => (await q(`SELECT * FROM print_jobs WHERE job_type = 'KITCHEN' AND reference = $1 ORDER BY id`, [orderNo])).rows;

test('POS sale: the kitchen ticket is queued with the order (printed once by a POS)', async () => {
  const pid = await kitchenProduct();
  const o = await api('POST', '/orders', { items: [{ productId: pid, qty: 2 }], clientOpId: 'ops-pos-1' });
  assert.equal(o.status, 200, JSON.stringify(o.body));
  const jobs = await jobsFor(o.body.order_no);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, 'QUEUED');
  assert.equal(jobs[0].source, 'POS');
  assert.equal(jobs[0].payload.items[0].qty, 2);
  // the same request again (retry) never queues a second ticket
  await api('POST', '/orders', { items: [{ productId: pid, qty: 2 }], clientOpId: 'ops-pos-1' });
  assert.equal((await jobsFor(o.body.order_no)).length, 1);
});

test('items added to a room bill: one ticket per round after the batch time, never twice', async () => {
  const { sweepKitchenTickets } = await import('../src/services/roomService.js');
  const { getSettings } = await import('../src/services/settings.js');
  const { runWithStore } = await import('../src/db/index.js');
  const pid = await kitchenProduct();
  const o = await api('POST', '/sessions/open', { roomId: 4, guestCount: 2, minutes: 60, customerName: 'ครัว', items: [] });
  const s = o.body;
  await api('POST', `/sessions/${s.id}/prepay`, { payments: [{ method: 'CASH', amount: s.prepay.amount, received: s.prepay.amount }] }, key('ops-pp2'));
  await api('POST', `/orders/${s.order_id}/items`, { productId: pid, qty: 1 });
  await api('POST', `/orders/${s.order_id}/items`, { productId: pid, qty: 3, note: 'ไม่เผ็ด' });
  const orderNo = (await q('SELECT order_no FROM orders WHERE id = $1', [s.order_id])).rows[0].order_no;
  const sweep = (batch) => runWithStore(1, async () => sweepKitchenTickets({ ...(await getSettings()), documents: { ...(await getSettings()).documents, kitchenBatchSeconds: batch } }));
  await sweep(60); // still inside the batch window → nothing yet
  assert.equal((await jobsFor(orderNo)).length, 0);
  await sweep(0);
  const jobs = await jobsFor(orderNo);
  assert.equal(jobs.length, 1, 'both items on one ticket');
  assert.equal(jobs[0].payload.items.length, 2);
  assert.equal(jobs[0].status, 'QUEUED');
  await sweep(0);
  assert.equal((await jobsFor(orderNo)).length, 1, 'never printed twice');
  // turned off → no automatic ticket
  await api('PUT', '/documents/settings', { kitchenAuto: false });
  await api('POST', `/orders/${s.order_id}/items`, { productId: pid, qty: 1 });
  await runWithStore(1, async () => sweepKitchenTickets({ ...(await getSettings()), documents: { ...(await getSettings()).documents, kitchenBatchSeconds: 0 } }));
  assert.equal((await jobsFor(orderNo)).length, 1);
});

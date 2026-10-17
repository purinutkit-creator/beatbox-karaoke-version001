// Smart devices (Tuya): signed requests, buttons, and automations on the room clock
// (switch on at start, warning N minutes before the end, cut at time up, switch back on when time is added).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import pg from 'pg';

const DB = (process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/beatbox_test').replace(/\/[^/]+$/, '/beatbox_test_smart');
process.env.DATABASE_URL = DB;
process.env.DISABLE_SCHEDULER = 'true';
process.env.PAYMENT_MODE = 'DEMO';
process.env.PORT = '4994';
process.env.SEED_STORE_CODE = 'beatbox1';
process.env.ADMIN_PASSWORD = 'Admin12345';

const ID = 'testaccessid123';
const SECRET = 'testaccesssecret456';
const commands = [];
let fake;
let fakeUrl;

// fake Tuya cloud: checks every signature exactly like Tuya does
function startFakeTuya() {
  return new Promise((resolve) => {
    fake = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const h = req.headers;
        const sha = crypto.createHash('sha256').update(body).digest('hex');
        const str = [req.method, sha, '', req.url].join('\n');
        const tok = h.access_token || '';
        const sign = crypto.createHmac('sha256', SECRET).update(h.client_id + tok + h.t + str).digest('hex').toUpperCase();
        const send = (o) => res.end(JSON.stringify(o));
        if (h.client_id !== ID || h.sign !== sign) return send({ success: false, code: 1004, msg: 'sign invalid' });
        if (req.url.startsWith('/v1.0/token')) return send({ success: true, result: { access_token: 'tok-1', expire_time: 7200 } });
        if (tok !== 'tok-1') return send({ success: false, code: 1011, msg: 'token invalid' });
        // a fan that only has "switch" (no switch_1); IR remotes have no data points at all
        const fnm = req.url.match(/^\/v1\.0\/iot-03\/devices\/([^/]+)\/functions$/);
        if (fnm) {
          if (fnm[1] === 'fan-1') return send({ success: true, result: { category: 'fs', functions: [{ code: 'switch', type: 'Boolean' }, { code: 'fan_speed_enum', type: 'Enum' }] } });
          return send({ success: true, result: { category: 'infrared_ac', functions: [] } });
        }
        if (req.url === '/v2.0/infrareds/hub-1/remotes') return send({ success: true, result: [{ remote_id: 'ir-ac', category_id: 5, remote_index: 11, remote_name: 'แอร์' }, { remote_id: 'ir-fan', category_id: 8, remote_index: 12, remote_name: 'พัดลม IR' }] });
        if (req.url === '/v2.0/infrareds/hub-1/remotes/ir-fan/keys') return send({ success: true, result: { category_id: 8, key_list: [{ key: 'PowerOn' }, { key: 'PowerOff' }, { key: 'Speed' }] } });
        const ir = req.url.match(/^\/v2\.0\/infrareds\/hub-1\/(air-conditioners|remotes)\/([^/]+)\/command$/);
        if (ir && req.method === 'POST') {
          commands.push({ device: ir[2], ir: JSON.parse(body) });
          return send({ success: true, result: true });
        }
        const m = req.url.match(/^\/v1\.0\/iot-03\/devices\/([^/]+)\/commands$/);
        if (m && req.method === 'POST') {
          if (m[1] === 'offline-dev') return send({ success: false, code: 2017, msg: 'device not found' });
          const cmds = JSON.parse(body).commands;
          if (m[1] === 'fan-1' && cmds[0].code !== 'switch') return send({ success: false, code: 2008, msg: 'command or value not support' });
          if (m[1].startsWith('ir-')) return send({ success: false, code: 2008, msg: 'command or value not support' });
          commands.push({ device: m[1], commands: JSON.parse(body).commands });
          return send({ success: true, result: true });
        }
        if (req.url.startsWith('/v1.0/iot-01/associated-users/devices')) return send({ success: true, result: { devices: [{ id: 'plug-room1', name: 'ปลั๊กห้อง 1', online: true, category: 'cz' }, { id: 'hub-1', name: 'IR Hub', online: true, category: 'wnykq' }], has_more: false } });
        send({ success: false, code: 404, msg: 'not found' });
      });
    });
    fake.listen(0, () => {
      fakeUrl = `http://127.0.0.1:${fake.address().port}`;
      resolve();
    });
  });
}

let server;
let base;
let token;
let deviceId;
async function api(method, url, body, { headers = {} } = {}) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(deviceId ? { 'X-Device-Id': String(deviceId) } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// a device signs in to the store first (store code + store account), then staff use their PIN
let storeSession;
async function pinLogin(pin) {
  storeSession ||= (await api('POST', '/auth/store-login', { storeCode: 'beatbox1', login: 'admin', password: 'Admin12345' })).body.storeSession;
  return api('POST', '/auth/login', { pin }, { headers: { 'X-Store-Session': storeSession } });
}
let tick;
let runWithStore;

before(async () => {
  await startFakeTuya();
  const admin = new pg.Client({ connectionString: DB.replace(/\/[^/]+$/, '/postgres') });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS beatbox_test_smart WITH (FORCE)');
  await admin.query('CREATE DATABASE beatbox_test_smart');
  await admin.end();
  const { start } = await import('../src/index.js');
  server = await start();
  ({ runWithStore } = await import('../src/db/index.js'));
  const { smartTick } = await import('../src/services/smart.js');
  tick = () => runWithStore(1, smartTick);
  base = 'http://localhost:4994/api';
  token = (await pinLogin('1234')).body.token;
  deviceId = (await api('POST', '/devices/register', { name: 'POS-SMART', deviceKey: 'test-device-key-smart' })).body.id;
  await api('POST', '/shifts/open', { deviceId, openingCash: 1000 });
});

after(async () => {
  server?.close();
  fake?.close();
  const { pool } = await import('../src/db/index.js');
  await pool.end();
  setTimeout(() => process.exit(0), 200).unref();
});

let sysOn;
let sysWarn;
let sysCut;
let sysManual;

test('settings: credentials are saved encrypted, never returned, and the connection test signs correctly', async () => {
  const bad = await api('PUT', '/integrations/tuya', { enabled: true, endpoint: fakeUrl, accessId: ID, accessSecret: 'wrong-secret' });
  assert.equal(bad.status, 200);
  assert.equal((await api('POST', '/integrations/tuya/test')).body.ok, false);
  // the test button checks what is typed on the screen, before saving
  const typed = await api('POST', '/integrations/tuya/test', { endpoint: fakeUrl, accessId: ID, accessSecret: SECRET });
  assert.equal(typed.body.ok, true, JSON.stringify(typed.body));
  const ok = await api('PUT', '/integrations/tuya', { accessSecret: SECRET });
  assert.ok(!JSON.stringify(ok.body).includes(SECRET), 'secret never sent back');
  const t = await api('POST', '/integrations/tuya/test');
  assert.equal(t.body.ok, true, JSON.stringify(t.body));
  const devs = await api('GET', '/smart/devices');
  assert.equal(devs.body[0].id, 'plug-room1');
});

test('systems + room devices; the staff button sends the command', async () => {
  const mk = async (b) => (await api('POST', '/smart/systems', b)).body;
  sysOn = await mk({ name: 'เปิดไฟห้อง', trigger: 'ON_START', commands: [{ code: 'switch_1', value: true }] });
  sysWarn = await mk({ name: 'ไฟเตือนใกล้หมดเวลา', trigger: 'BEFORE_END', minutes: 5, commands: [{ code: 'switch_2', value: true }] });
  sysCut = await mk({ name: 'ตัดไฟเมื่อหมดเวลา', trigger: 'AT_END', commands: [{ code: 'switch_1', value: false }] });
  sysManual = await mk({ name: 'เปิดแอร์', trigger: 'MANUAL', commands: [{ code: 'switch', value: true }] });
  for (const s of [sysOn, sysWarn, sysCut]) assert.equal((await api('PUT', '/smart/bindings', { systemId: s.id, roomId: 5, deviceId: 'plug-room5' })).status, 200);
  await api('PUT', '/smart/bindings', { systemId: sysManual.id, roomId: 5, deviceId: 'ac-room5', deviceName: 'แอร์' });
  const run = await api('POST', '/smart/run', { systemId: sysManual.id, roomId: 5 });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.deepEqual(commands.pop(), { device: 'ac-room5', commands: [{ code: 'switch', value: true }] });
  // a room without a device for this system
  assert.equal((await api('POST', '/smart/run', { systemId: sysManual.id, roomId: 6 })).body.code, 'SMART_NOT_BOUND');
  const g = await api('GET', '/smart');
  assert.equal(g.body.systems.length, 4);
  assert.ok(!JSON.stringify(g.body).includes(SECRET));
});

test('a device without switch_1 uses its own switch; IR air conditioner and IR fan go through the IR hub', async () => {
  const mk = async (b) => (await api('POST', '/smart/systems', b)).body;
  const on = await mk({ name: 'เปิดพัดลม', trigger: 'MANUAL', commands: [{ code: 'switch_1', value: true }] });
  const off = await mk({ name: 'ปิดแอร์', trigger: 'MANUAL', commands: [{ code: 'switch_1', value: false }] });
  await api('PUT', '/smart/bindings', { systemId: on.id, roomId: 7, deviceId: 'fan-1' });
  await api('PUT', '/smart/bindings', { systemId: on.id, roomId: 8, deviceId: 'ir-fan' });
  await api('PUT', '/smart/bindings', { systemId: off.id, roomId: 7, deviceId: 'ir-ac' });
  const r1 = await api('POST', '/smart/run', { systemId: on.id, roomId: 7 });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.deepEqual(commands.pop(), { device: 'fan-1', commands: [{ code: 'switch', value: true }] });
  const r2 = await api('POST', '/smart/run', { systemId: off.id, roomId: 7 });
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  assert.deepEqual(commands.pop(), { device: 'ir-ac', ir: { code: 'power', value: 0 } });
  const r3 = await api('POST', '/smart/run', { systemId: on.id, roomId: 8 });
  assert.equal(r3.status, 200, JSON.stringify(r3.body));
  assert.deepEqual(commands.pop(), { device: 'ir-fan', ir: { category_id: 8, remote_index: 12, key: 'PowerOn' } });
  // the settings page can show what a device accepts
  const info = await api('GET', '/smart/devices/fan-1/info');
  assert.equal(info.body.kind, 'dp');
  assert.ok(info.body.functions.some((f) => f.code === 'switch'));
  const irInfo = await api('GET', '/smart/devices/ir-fan/info');
  assert.equal(irInfo.body.kind, 'ir');
  assert.ok(irInfo.body.keys.includes('PowerOn'));
});

test('automations: on at start, warning N min before, cut at time up, back on after adding time — each once', async () => {
  const o = await api('POST', '/sessions/open', { roomId: 5, guestCount: 2, minutes: 60, customerName: 'Tuya', items: [] });
  assert.equal(o.status, 200, JSON.stringify(o.body));
  const s = o.body;
  // not started yet (waiting for payment) → nothing
  await tick();
  assert.equal(commands.length, 0);
  await api('POST', `/sessions/${s.id}/prepay`, { payments: [{ method: 'CASH', amount: s.prepay.amount, received: s.prepay.amount }] }, { headers: { 'Idempotency-Key': 'smart-pp' } });
  await tick();
  assert.deepEqual(commands.map((c) => c.commands[0]), [{ code: 'switch_1', value: true }]);
  await tick();
  assert.equal(commands.length, 1, 'never twice');
  // 3 minutes left → warning
  await api('POST', `/sessions/${s.id}/adjust`, { scheduledEndAt: new Date(Date.now() + 3 * 60000).toISOString(), reason: 'ทดสอบ' });
  await tick();
  assert.deepEqual(commands.at(-1).commands[0], { code: 'switch_2', value: true });
  assert.equal(commands.length, 2);
  // time is up → power cut
  const cut = await api('POST', `/sessions/${s.id}/adjust`, { startedAt: new Date(Date.now() - 70 * 60000).toISOString(), scheduledEndAt: new Date(Date.now() - 60000).toISOString(), reason: 'ทดสอบ' });
  assert.equal(cut.status, 200, JSON.stringify(cut.body));
  await tick();
  assert.deepEqual(commands.at(-1).commands[0], { code: 'switch_1', value: false });
  const n = commands.length;
  await tick();
  assert.equal(commands.length, n);
  // add 30 minutes after the cut → switched back on
  await api('POST', `/sessions/${s.id}/extend`, { minutes: 30 });
  await tick();
  assert.deepEqual(commands.at(-1).commands[0], { code: 'switch_1', value: true });
  const logs = (await api('GET', '/smart/logs?roomId=5')).body;
  assert.ok(logs.length >= 5);
  assert.ok(logs.every((l) => l.ok));
});

test('disabled → no automation and the button refuses; a failing device is logged with the reason', async () => {
  await api('PUT', '/smart/bindings', { systemId: sysManual.id, roomId: 6, deviceId: 'offline-dev' });
  const r = await api('POST', '/smart/run', { systemId: sysManual.id, roomId: 6 });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /ไม่พบอุปกรณ์/);
  await api('PUT', '/integrations/tuya', { enabled: false });
  const n = commands.length;
  assert.equal((await api('POST', '/smart/run', { systemId: sysManual.id, roomId: 5 })).body.code, 'SMART_DISABLED');
  assert.equal(commands.length, n);
});

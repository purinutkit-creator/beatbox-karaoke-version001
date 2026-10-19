// Floor plans and the way to a room: floors, rooms placed on the plan, markers, the GPS position of a room,
// the public guide page (always the plan; GPS only when switched on) and the room card shown after paying.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const DB = (process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/beatbox_test').replace(/\/[^/]+$/, '/beatbox_test_floors');
process.env.DATABASE_URL = DB;
process.env.DISABLE_SCHEDULER = 'true';
process.env.PAYMENT_MODE = 'DEMO';
process.env.PORT = '4992';
process.env.SEED_STORE_CODE = 'beatbox1';
process.env.ADMIN_PASSWORD = 'Admin12345';

let server;
let base;
let token;
async function api(method, url, body, { headers = {}, auth = true } = {}) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

before(async () => {
  const admin = new pg.Client({ connectionString: DB.replace(/\/[^/]+$/, '/postgres') });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS beatbox_test_floors WITH (FORCE)');
  await admin.query('CREATE DATABASE beatbox_test_floors');
  await admin.end();
  const { start } = await import('../src/index.js');
  server = await start();
  base = 'http://localhost:4992/api';
  const storeSession = (await api('POST', '/auth/store-login', { storeCode: 'beatbox1', login: 'admin', password: 'Admin12345' })).body.storeSession;
  token = (await api('POST', '/auth/login', { pin: '1234' }, { headers: { 'X-Store-Session': storeSession } })).body.token;
});

after(async () => {
  server?.close();
  const { pool } = await import('../src/db/index.js');
  await pool.end();
  setTimeout(() => process.exit(0), 200).unref();
});

let floor;
let rooms;

test('a floor with rooms placed on its plan and markers', async () => {
  const f = await api('POST', '/floors', { name: 'ชั้น 2', aspect: 1.6 });
  assert.equal(f.status, 200, JSON.stringify(f.body));
  floor = f.body;
  rooms = (await api('GET', '/floors')).body.rooms;
  assert.ok(rooms.length >= 3);
  assert.ok(rooms.every((r) => r.guide_token && r.guide_token.length >= 20), 'every room has a guide token');
  const lay = await api('PUT', `/floors/${floor.id}/layout`, {
    rooms: [{ id: rooms[0].id, x: 10, y: 10, w: 20, h: 15 }, { id: rooms[1].id, x: 40, y: 10, w: 20, h: 15 }],
    markers: [{ id: 'm1', type: 'ENTRANCE', x: 50, y: 95, label: 'ทางเข้าหลัก' }],
  });
  assert.equal(lay.status, 200, JSON.stringify(lay.body));
  const got = (await api('GET', '/floors')).body;
  assert.equal(got.rooms.filter((r) => r.floor_id === floor.id).length, 2);
  assert.equal(got.floors[0].markers[0].label, 'ทางเข้าหลัก');
  // a room taken off the plan leaves the floor
  await api('PUT', `/floors/${floor.id}/layout`, { rooms: [{ id: rooms[0].id, x: 12, y: 10, w: 20, h: 15 }], markers: [] });
  const after1 = (await api('GET', '/floors')).body.rooms;
  assert.equal(after1.find((r) => r.id === rooms[1].id).floor_id, null);
  assert.equal(Number(after1.find((r) => r.id === rooms[0].id).plan_x), 12);
  assert.equal((await api('PUT', `/floors/${floor.id}/layout`, { rooms: [{ id: rooms[0].id, x: 120, y: 0, w: 5, h: 5 }], markers: [] })).status, 400);
});

test('the public guide page: the plan with the room, no GPS until it is switched on and the room has a position', async () => {
  const room = (await api('GET', '/floors')).body.rooms.find((r) => r.id === rooms[0].id);
  const g = await api('GET', `/public/guide/${room.guide_token}`, null, { auth: false });
  assert.equal(g.status, 200, JSON.stringify(g.body));
  assert.equal(g.body.room.id, room.id);
  assert.equal(g.body.floor.name, 'ชั้น 2');
  assert.equal(g.body.rooms.length, 1);
  assert.equal(g.body.nav, null);
  assert.equal((await api('GET', '/public/guide/not-a-real-token', null, { auth: false })).status, 404);

  const loc = await api('PUT', `/floors/rooms/${room.id}/location`, { lat: 13.7563, lng: 100.5018, accuracy: 6 });
  assert.equal(loc.status, 200, JSON.stringify(loc.body));
  assert.equal((await api('GET', `/public/guide/${room.guide_token}`, null, { auth: false })).body.nav, null, 'still off');
  const gen = (await api('GET', '/settings')).body.general;
  await api('PUT', '/settings/general', { ...gen, roomNavEnabled: true, roomNavArriveM: 8 });
  const on = (await api('GET', `/public/guide/${room.guide_token}`, null, { auth: false })).body.nav;
  assert.deepEqual({ lat: on.lat, lng: on.lng, arriveM: on.arriveM }, { lat: 13.7563, lng: 100.5018, arriveM: 8 });
  // removing the position removes the directions
  await api('PUT', `/floors/rooms/${room.id}/location`, { lat: null, lng: null });
  assert.equal((await api('GET', `/public/guide/${room.guide_token}`, null, { auth: false })).body.nav, null);
});

test('the room card for the customer display, and bookings carry the room picture and floor', async () => {
  const c = await api('GET', `/floors/room-card/${rooms[0].id}`);
  assert.equal(c.body.floor_name, 'ชั้น 2');
  assert.ok(c.body.guide_token);
  const list = await api('GET', '/reservations?limit=5');
  assert.equal(list.status, 200);
  if (list.body.length) assert.ok('room_image' in list.body[0] && 'floor_name' in list.body[0]);
});

test('deleting a floor takes its rooms off the plan (the rooms stay)', async () => {
  const d = await api('DELETE', `/floors/${floor.id}`);
  assert.equal(d.status, 200);
  const r = (await api('GET', '/floors')).body;
  assert.equal(r.floors.length, 0);
  assert.equal(r.rooms.find((x) => x.id === rooms[0].id).floor_id, null);
  assert.equal(r.rooms.length, rooms.length);
});

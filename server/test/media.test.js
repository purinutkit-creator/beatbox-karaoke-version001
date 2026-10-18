// Promotion slides: upload a picture / video, play it back in pieces (byte ranges), and remove files no slide uses.
// Printers: print speed and kitchen alert sounds (built-in, uploaded / recorded).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const DB = (process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/beatbox_test').replace(/\/[^/]+$/, '/beatbox_test_media');
process.env.DATABASE_URL = DB;
process.env.DISABLE_SCHEDULER = 'true';
process.env.PAYMENT_MODE = 'DEMO';
process.env.PORT = '4993';
process.env.SEED_STORE_CODE = 'beatbox1';
process.env.ADMIN_PASSWORD = 'Admin12345';

let server;
let base;
let token;
async function api(method, url, body, { headers = {}, form } = {}) {
  const res = await fetch(base + '/api' + url, { method, headers: { ...(form ? {} : { 'Content-Type': 'application/json' }), Authorization: `Bearer ${token}`, ...headers }, body: form || (body ? JSON.stringify(body) : undefined) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const putChunk = (id, seq, bytes) => fetch(`${base}/api/promotion-images/upload/${id}/chunks/${seq}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${token}` }, body: bytes });
/** start → pieces → finish, like the browser does */
async function uploadFile(name, _type, bytes) {
  const s = await api('POST', '/promotion-images/upload/start', { name, size: bytes.length });
  if (s.status !== 200) return s;
  for (let i = 0; i < s.body.chunks; i++) {
    const r = await putChunk(s.body.id, i, bytes.subarray(i * s.body.chunkSize, (i + 1) * s.body.chunkSize));
    assert.equal(r.status, 200, await r.text());
  }
  return api('POST', `/promotion-images/upload/${s.body.id}/finish`);
}

before(async () => {
  const admin = new pg.Client({ connectionString: DB.replace(/\/[^/]+$/, '/postgres') });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS beatbox_test_media WITH (FORCE)');
  await admin.query('CREATE DATABASE beatbox_test_media');
  await admin.end();
  const { start } = await import('../src/index.js');
  server = await start();
  base = 'http://localhost:4993';
  const storeSession = (await api('POST', '/auth/store-login', { storeCode: 'beatbox1', login: 'admin', password: 'Admin12345' })).body.storeSession;
  token = (await api('POST', '/auth/login', { pin: '1234' }, { headers: { 'X-Store-Session': storeSession } })).body.token;
});

after(async () => {
  server?.close();
  const { pool } = await import('../src/db/index.js');
  await pool.end();
  setTimeout(() => process.exit(0), 200).unref();
});

const video = Buffer.from(Array.from({ length: 1_300_000 }, (_, i) => (i * 7 + (i >> 9)) % 251)); // 3 pieces of 512 KB

test('upload a video and a picture, then show them as slides', async () => {
  const v = await uploadFile('promo.mp4', 'video/mp4', video);
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal(v.body.mediaType, 'VIDEO');
  assert.match(v.body.url, /^\/uploads\/media\/[0-9a-f-]{36}\.mp4$/);
  const p = await uploadFile('banner.png', 'image/png', Buffer.from('fake-png'));
  assert.equal(p.body.mediaType, 'IMAGE');
  const bad = await uploadFile('virus.exe', 'application/octet-stream', Buffer.from('x'));
  assert.equal(bad.status, 400);
  const s = await api('POST', '/promotion-images', { title: 'วิดีโอโปร', imageUrl: v.body.url, mediaType: 'VIDEO' });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.body.media_type, 'VIDEO');
  // the public display carousel gets the slide with its type
  const deviceId = (await api('POST', '/devices/register', { name: 'POS-MEDIA', deviceKey: 'test-device-key-media' })).body.id;
  const code = (await api('POST', '/displays/pair', { deviceId })).body.pair_code;
  const d = await fetch(`${base}/api/public/display/${code}`).then((r) => r.json());
  assert.ok(d.images.some((x) => x.image_url === v.body.url && x.media_type === 'VIDEO'));
});

test('the file is public and answers byte ranges (needed by iPad / Smart TV players)', async () => {
  const slides = (await api('GET', '/promotion-images')).body;
  const url = slides.find((x) => x.media_type === 'VIDEO').image_url;
  const full = await fetch(base + url);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'video/mp4');
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), video);
  const part = await fetch(base + url, { headers: { Range: 'bytes=1000-1999' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 1000-1999/${video.length}`);
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), video.subarray(1000, 2000));
  // a range across two stored pieces (512 KB boundary)
  const cross = await fetch(base + url, { headers: { Range: 'bytes=524000-525999' } });
  assert.deepEqual(Buffer.from(await cross.arrayBuffer()), video.subarray(524000, 526000));
  const tail = await fetch(base + url, { headers: { Range: 'bytes=-500' } });
  assert.deepEqual(Buffer.from(await tail.arrayBuffer()), video.subarray(video.length - 500));
  const out = await fetch(base + url, { headers: { Range: `bytes=${video.length + 10}-` } });
  assert.equal(out.status, 416);
  assert.equal((await fetch(base + '/uploads/media/00000000-0000-0000-0000-000000000000.mp4')).status, 404);
});

test('upload pieces: a repeated piece (retry) is fine, a wrong-size piece is refused, an unfinished file is never served', async () => {
  const bytes = Buffer.alloc(600_000, 7);
  const s = await api('POST', '/promotion-images/upload/start', { name: 'clip.mp4', size: bytes.length });
  assert.equal(s.body.chunks, 2);
  assert.equal((await putChunk(s.body.id, 0, bytes.subarray(0, 1000))).status, 400); // short piece
  assert.equal((await putChunk(s.body.id, 0, bytes.subarray(0, s.body.chunkSize))).status, 200);
  assert.equal((await putChunk(s.body.id, 0, bytes.subarray(0, s.body.chunkSize))).status, 200); // retried
  const early = await api('POST', `/promotion-images/upload/${s.body.id}/finish`);
  assert.equal(early.status, 400);
  assert.equal((await fetch(`${base}/uploads/media/${s.body.id}.mp4`)).status, 404);
  assert.equal((await putChunk(s.body.id, 1, bytes.subarray(s.body.chunkSize))).status, 200);
  const done = await api('POST', `/promotion-images/upload/${s.body.id}/finish`);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual(Buffer.from(await (await fetch(base + done.body.url)).arrayBuffer()), bytes);
  assert.equal((await api('POST', '/promotion-images/upload/start', { name: 'big.mp4', size: 41 * 1024 * 1024 })).status, 400);
  assert.equal((await api('POST', '/promotion-images/upload/start', { name: 'virus.exe', size: 10 })).status, 400);
});

test('files no slide uses any more are removed', async () => {
  const { pool, runAsPlatform } = await import('../src/db/index.js');
  const count = () => runAsPlatform(async () => Number((await pool.query(`SELECT count(*) FROM stored_files WHERE kind = 'PROMO_MEDIA'`)).rows[0].count));
  assert.equal(await count(), 3);
  // pretend the uploads are old (past the grace time that protects a form still being filled in)
  await runAsPlatform(() => pool.query(`UPDATE stored_files SET created_at = now() - interval '2 hours' WHERE kind = 'PROMO_MEDIA'`));
  const slide = (await api('GET', '/promotion-images')).body.find((x) => x.media_type === 'VIDEO');
  await api('DELETE', `/promotion-images/${slide.id}`);
  assert.equal(await count(), 0); // the deleted slide's video and the never-used uploads are gone
  const chunks = await runAsPlatform(async () => Number((await pool.query('SELECT count(*) FROM stored_file_chunks')).rows[0].count));
  assert.equal(chunks, 0, 'pieces are removed with their file');
});

const printerBody = (over = {}) => ({ name: 'ครัว', connection: 'NETWORK', address: '127.0.0.1', port: 9100, station: 'KITCHEN', renderMode: 'RASTER', ...over });

test('printer: speed and kitchen alert settings are saved; an old screen sending only beepKitchen still works', async () => {
  const p = await api('POST', '/printers', printerBody({ speed: 2, kitchenAlert: 'BOTH', alertSound: 'bell', alertVolume: 60, alertOrder: 'AFTER', beepTimes: 2 }));
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.body.speed, 2);
  assert.equal(p.body.kitchen_alert, 'BOTH');
  assert.equal(p.body.beep_kitchen, true);
  assert.equal(p.body.alert_sound, 'bell');
  assert.equal(p.body.alert_order, 'AFTER');
  const old = await api('POST', '/printers', printerBody({ name: 'บาร์', beepKitchen: false }));
  assert.equal(old.body.kitchen_alert, 'OFF');
  assert.equal(old.body.speed, 0); // never changes a printer unless asked
  const bad = await api('PUT', `/printers/${p.body.id}`, printerBody({ alertSound: 'https://evil.example/x.mp3' }));
  assert.equal(bad.status, 400);
  const tooFast = await api('PUT', `/printers/${p.body.id}`, printerBody({ speed: 12 }));
  assert.equal(tooFast.status, 400);
});

test('printer: an uploaded / recorded sound is used, served publicly, and removed once no printer uses it', async () => {
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from('fake-recording')], { type: 'audio/webm' }), 'ออเดอร์มาแล้ว.webm');
  const up = await api('POST', '/printers/sounds', null, { form: fd });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.match(up.body.url, /^\/uploads\/media\/[0-9a-f-]{36}\.webm$/);
  const wrong = new FormData();
  wrong.append('file', new Blob([Buffer.from('x')]), 'notes.txt');
  assert.equal((await api('POST', '/printers/sounds', null, { form: wrong })).status, 400);
  const p = await api('POST', '/printers', printerBody({ name: 'ครัว 2', kitchenAlert: 'DEVICE', alertSound: up.body.url, alertSoundName: 'ออเดอร์มาแล้ว' }));
  assert.equal(p.body.alert_sound, up.body.url);
  assert.equal(p.body.alert_sound_name, 'ออเดอร์มาแล้ว');
  const f = await fetch(base + up.body.url);
  assert.equal(f.status, 200);
  assert.equal(f.headers.get('content-type'), 'audio/webm');
  const { pool, runAsPlatform } = await import('../src/db/index.js');
  const sounds = () => runAsPlatform(async () => Number((await pool.query(`SELECT count(*) FROM stored_files WHERE kind = 'SOUND'`)).rows[0].count));
  await runAsPlatform(() => pool.query(`UPDATE stored_files SET created_at = now() - interval '2 hours' WHERE kind = 'SOUND'`));
  await api('PUT', `/printers/${p.body.id}`, printerBody({ name: 'ครัว 2', kitchenAlert: 'DEVICE', alertSound: up.body.url }));
  assert.equal(await sounds(), 1, 'still used → kept');
  await api('PUT', `/printers/${p.body.id}`, printerBody({ name: 'ครัว 2', kitchenAlert: 'DEVICE', alertSound: 'ding' }));
  assert.equal(await sounds(), 0, 'no printer uses it → removed');
});

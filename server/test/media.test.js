// Promotion slides: upload a picture / video, play it back in pieces (byte ranges), and remove files no slide uses.
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
const uploadFile = (name, type, bytes) => {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type }), name);
  return api('POST', '/promotion-images/upload', null, { form: fd });
};

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

const video = Buffer.from(Array.from({ length: 300000 }, (_, i) => i % 251));

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
  const tail = await fetch(base + url, { headers: { Range: 'bytes=-500' } });
  assert.deepEqual(Buffer.from(await tail.arrayBuffer()), video.subarray(video.length - 500));
  const out = await fetch(base + url, { headers: { Range: `bytes=${video.length + 10}-` } });
  assert.equal(out.status, 416);
  assert.equal((await fetch(base + '/uploads/media/00000000-0000-0000-0000-000000000000.mp4')).status, 404);
});

test('files no slide uses any more are removed', async () => {
  const { pool, runAsPlatform } = await import('../src/db/index.js');
  const count = () => runAsPlatform(async () => Number((await pool.query(`SELECT count(*) FROM stored_files WHERE kind = 'PROMO_MEDIA'`)).rows[0].count));
  assert.equal(await count(), 2);
  // pretend the uploads are old (past the grace time that protects a form still being filled in)
  await runAsPlatform(() => pool.query(`UPDATE stored_files SET created_at = now() - interval '2 hours' WHERE kind = 'PROMO_MEDIA'`));
  const slide = (await api('GET', '/promotion-images')).body.find((x) => x.media_type === 'VIDEO');
  await api('DELETE', `/promotion-images/${slide.id}`);
  assert.equal(await count(), 0); // the deleted slide's video and the never-used picture are gone
});

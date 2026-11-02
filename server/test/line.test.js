// LINE OA chat end to end (LINE's servers are replaced by a recorder): signed webhook only, phone → booking card, a
// booking tied to the first LINE user, confirm → booking pass, cancel, reminders before the start (once), the room card
// when the room opens, the receipt with "collect points" after paying, and collecting the bill's points as a member.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';

const DB = (process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/beatbox_test').replace(/\/[^/]+$/, '/beatbox_test_line');
process.env.DATABASE_URL = DB;
process.env.DISABLE_SCHEDULER = 'true';
process.env.PAYMENT_MODE = 'DEMO';
process.env.PORT = '4983';
process.env.SEED_STORE_CODE = 'beatbox1';
process.env.ADMIN_PASSWORD = 'Admin12345';

const SECRET = 'test-channel-secret';
let server;
let base;
let token;
let deviceId;
const sent = []; // what the server sent to LINE: { kind, body }
const lineCalls = []; // other LINE API calls (rich menu)

async function api(method, url, body, { headers = {}, auth = true, bearer } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(auth && (bearer || token) ? { Authorization: `Bearer ${bearer || token}` } : {}), ...(deviceId ? { 'X-Device-Id': String(deviceId) } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})), type: res.headers.get('content-type') };
}

/** A webhook call as LINE makes it (signed), then wait for the reply the server sends back to LINE. */
async function lineEvent(event, { sign = true } = {}) {
  const body = JSON.stringify({ destination: 'U0', events: [{ replyToken: `rt-${Math.random()}`, timestamp: Date.now(), mode: 'active', ...event }] });
  const sig = crypto.createHmac('sha256', sign ? SECRET : 'wrong').update(body).digest('base64');
  const before = sent.length;
  const res = await fetch(`${base}/public/line/webhook?store=beatbox1`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-line-signature': sig }, body });
  if (res.status !== 200) return { status: res.status };
  for (let i = 0; i < 50 && sent.length === before; i++) await new Promise((r) => setTimeout(r, 40));
  return { status: res.status, reply: sent[sent.length - 1]?.body };
}
const say = (userId, text) => lineEvent({ type: 'message', source: { type: 'user', userId }, message: { type: 'text', id: '1', text } });
const tap = (userId, data) => lineEvent({ type: 'postback', source: { type: 'user', userId }, postback: { data } });
const allText = (msgs) => JSON.stringify(msgs);

async function tick() {
  const { runWithStore } = await import('../src/db/index.js');
  const { reservationTick, roomTick } = await import('../src/services/scheduler.js');
  await runWithStore(1, () => roomTick());
  await runWithStore(1, () => reservationTick());
}
async function db(sql, params) {
  const { pool } = await import('../src/db/index.js');
  const c = await pool.connect();
  try {
    await c.query(`SELECT set_config('app.bypass_rls','on',false)`);
    return (await c.query(sql, params)).rows;
  } finally {
    await c.query(`SELECT set_config('app.bypass_rls','',false)`);
    c.release();
  }
}
const pushesTo = (userId) => sent.filter((s) => s.kind === 'push' && s.body.to === userId);

before(async () => {
  const admin = new pg.Client({ connectionString: DB.replace(/\/[^/]+$/, '/postgres') });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS beatbox_test_line WITH (FORCE)');
  await admin.query('CREATE DATABASE beatbox_test_line');
  await admin.end();
  // LINE's API is recorded instead of called
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const m = String(url).match(/^https:\/\/api\.line\.me\/v2\/bot\/message\/(push|reply)$/);
    if (m) {
      sent.push({ kind: m[1], body: JSON.parse(opts.body) });
      return new Response('{}', { status: 200 });
    }
    if (/^https:\/\/api(-data)?\.line\.me\//.test(String(url))) {
      lineCalls.push({ method: opts.method || 'GET', url: String(url), type: opts.headers?.['Content-Type'], body: opts.body });
      return new Response(/\/richmenu$/.test(String(url)) ? JSON.stringify({ richMenuId: `richmenu-${lineCalls.length}` }) : '{}', { status: 200 });
    }
    return realFetch(url, opts);
  };
  const { start } = await import('../src/index.js');
  server = await start();
  base = 'http://localhost:4983/api';
  const storeSession = (await api('POST', '/auth/store-login', { storeCode: 'beatbox1', login: 'admin', password: 'Admin12345' }, { auth: false })).body.storeSession;
  token = (await api('POST', '/auth/login', { pin: '1234' }, { headers: { 'X-Store-Session': storeSession }, auth: false })).body.token;
  deviceId = (await api('POST', '/devices/register', { name: 'POS-LINE', deviceKey: 'test-device-key-line' })).body.id;
  await api('POST', '/shifts/open', { deviceId, openingCash: 0 });
  const s = (await api('GET', '/settings')).body;
  await api('PUT', '/settings/room', { ...s.room, paymentMode: 'POSTPAY' });
  await api('PUT', '/settings/line', { ...s.line, messagingEnabled: true });
  await api('PUT', '/integrations/line', { messagingAccessToken: 'test-token', messagingChannelSecret: SECRET });
});

after(async () => {
  server?.close();
  const { pool } = await import('../src/db/index.js');
  await pool.end();
  setTimeout(() => process.exit(0), 200).unref();
});

let rv;

test('the webhook only takes calls signed by LINE; the store gets its webhook address', async () => {
  assert.equal((await lineEvent({ type: 'follow', source: { type: 'user', userId: 'Uaaa' } }, { sign: false })).status, 401);
  const follow = await lineEvent({ type: 'follow', source: { type: 'user', userId: 'Uaaa' } });
  assert.equal(follow.status, 200);
  assert.match(allText(follow.reply), /พิมพ์เบอร์มือถือ/);
  const info = (await api('GET', '/integrations/line/webhook')).body;
  assert.match(info.url, /\/api\/public\/line\/webhook\?store=/);
  assert.equal(info.ready, true);
});

test('typing the phone number shows the booking card (room, time, people, name, phone, maps, call, confirm, cancel)', async () => {
  const start = new Date(Date.now() + 10 * 60000);
  const r = await api('POST', '/reservations', { roomId: 5, startAt: start.toISOString(), durationMinutes: 60, customerName: 'คุณไลน์', phone: '0891234567', guestCount: 4 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  rv = r.body;
  const { reply } = await say('Uaaa', '089-123-4567');
  const text = allText(reply);
  assert.equal(reply.messages[0].type, 'flex');
  assert.match(text, /คุณไลน์/);
  assert.match(text, /4 คน/);
  assert.match(text, /0891234567/);
  assert.match(text, new RegExp(rv.booking_no));
  assert.match(text, /google\.com\/maps/);
  assert.match(text, /a=confirm&r=/);
  assert.match(text, /a=cancel&r=/);
  // a second LINE user typing the same number does not see it
  const other = await say('Ubbb', '0891234567');
  assert.match(allText(other.reply), /เชื่อมกับบัญชี LINE อื่นแล้ว/);
  assert.match(allText((await say('Uaaa', '0800000000')).reply), /ไม่พบการจอง/);
});

test('confirm → booking pass (QR + barcode picture); only the tied LINE user can act on the booking', async () => {
  assert.match(allText((await tap('Ubbb', `a=confirm&r=${rv.id}`)).reply), /ไม่พบการจองนี้/);
  const { reply } = await tap('Uaaa', `a=confirm&r=${rv.id}`);
  const text = allText(reply);
  assert.equal(reply.messages.length, 1, 'one message: the pass card (the QR is not sent twice)');
  assert.match(text, /ยืนยันการจองเรียบร้อย/);
  assert.doesNotMatch(text, /อีก \d+ นาที/, 'no frozen countdown in LINE');
  assert.match(text, /ดูเวลาก่อนถึงเวลาของคุณ/);
  assert.match(text, new RegExp(`/pass/${rv.check_in_token}`));
  const page = await api('GET', `/public/line/booking/${rv.check_in_token}`, null, { auth: false });
  assert.equal(page.status, 200);
  assert.equal(page.body.qr, `CHECKIN:${rv.check_in_token}`);
  assert.equal(page.body.confirmed, true);
  assert.match(page.body.phone, /x|\*/i, 'the phone is masked on the public page');
  // (the QR picture is the card's top image once the server has an https address; this test server is http)
  const png = await fetch(`${base}/public/line/pass/${rv.check_in_token}.png`);
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.ok((await png.arrayBuffer()).byteLength > 1000);
  const after = (await api('GET', `/reservations/${rv.id}`)).body;
  assert.ok(after.customer_confirmed_at, 'the staff side sees the customer confirmed');
});

test('reminders: none right after confirming (the pass card was just sent), then "it is time" at the start', async () => {
  await tick();
  assert.equal(pushesTo('Uaaa').length, 0, 'the 15-minute mark is covered by the pass card just sent');
  // the start arrives
  await db(`UPDATE reservations SET start_at = now() - interval '1 minute', end_at = now() + interval '59 minutes' WHERE id = $1`, [rv.id]);
  await tick();
  const p = pushesTo('Uaaa');
  assert.equal(p.length, 1, allText(sent.map((s) => s.kind)));
  assert.match(allText(p[0].body), /ถึงเวลาของคุณแล้ว/);
  await tick();
  assert.equal(pushesTo('Uaaa').length, 1, 'not sent again');
});

test('a booking tied to LINE a moment after it was made still gets its reminder (nothing marked without a receiver)', async () => {
  const m = (await api('POST', '/members', { firstName: 'สมาชิกจอง', phone: '0891230000' })).body;
  const start = new Date(Date.now() + 4 * 60000);
  const r = (await api('POST', '/reservations', { roomId: 7, startAt: start.toISOString(), durationMinutes: 60, customerName: 'สมาชิกจอง', phone: '0891230000', guestCount: 2, memberId: m.id })).body;
  await tick(); // the member has no LINE yet: nobody to tell
  assert.deepEqual((await db('SELECT line_reminders FROM reservations WHERE id = $1', [r.id]))[0].line_reminders, []);
  await say('Uddd', '0891230000'); // the booking is tied to this LINE now
  await tick();
  const p = pushesTo('Uddd');
  assert.equal(p.length, 1);
  assert.match(allText(p[0].body), /อีก [1-4] นาที/);
});

test('the room opens → room card (end time, live countdown page, order food, report a problem)', async () => {
  const open = await api('POST', `/reservations/${rv.id}/open`, {});
  assert.equal(open.status, 200, JSON.stringify(open.body));
  await tick();
  const card = pushesTo('Uaaa').at(-1);
  const text = allText(card.body);
  assert.match(text, /เปิดแล้ว/);
  assert.match(text, /\/order\/[\w-]{20,}\?tab=menu/);
  assert.match(text, /\?issue=1/);
  rv.sessionId = open.body.session?.id || open.body.id;
  rv.orderId = open.body.session?.order_id || open.body.order_id;
});

let receiptToken;
test('after paying → online receipt with "collect points" for the bill', async () => {
  const close = await api('POST', `/sessions/${rv.sessionId}/close`);
  assert.equal(close.status, 200, JSON.stringify(close.body));
  const net = close.body.order.calc.netTotal;
  const pay = await api('POST', `/orders/${rv.orderId}/pay`, { payments: [{ method: 'CASH', amount: net, received: net }] }, { headers: { 'Idempotency-Key': 'line-pay-1' } });
  assert.equal(pay.status, 200, JSON.stringify(pay.body));
  await tick();
  const msg = pushesTo('Uaaa').at(-1);
  const text = allText(msg.body);
  assert.match(text, /ใบเสร็จ/);
  receiptToken = text.match(/\/book\/claim\/([0-9a-f]{32})/)?.[1];
  assert.ok(receiptToken, text);
  assert.match(text, new RegExp(`/r/${receiptToken}`));
  const page = await api('GET', `/public/receipts/${receiptToken}`, null, { auth: false });
  assert.equal(page.status, 200);
  assert.equal(page.body.claim.state, 'OPEN');
  assert.ok(page.body.claim.points > 0);
});

test('collecting the points as a member: once, then the bill is theirs', async () => {
  await api('POST', '/members', { firstName: 'สะสม', phone: '0897770011' });
  const login = await api('POST', '/public/auth/login?store=beatbox1', { phone: '0897770011', password: '0011' }, { auth: false });
  await api('POST', '/public/me/password?store=beatbox1', { current: '0011', password: 'secret99' }, { bearer: login.body.token });
  const member = login.body.token;
  const pre = await api('GET', `/public/receipts/${receiptToken}/claim`, null, { bearer: member });
  assert.equal(pre.body.state, 'OPEN');
  const c = await api('POST', `/public/receipts/${receiptToken}/claim`, {}, { bearer: member });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.state, 'MINE');
  assert.equal(c.body.balance, c.body.points);
  const again = await api('POST', `/public/receipts/${receiptToken}/claim`, {}, { bearer: member });
  assert.equal(again.body.already, true);
  assert.equal(again.body.balance, c.body.points, 'no double points');
  await api('POST', '/members', { firstName: 'คนอื่น', phone: '0897770022' });
  const l2 = await api('POST', '/public/auth/login?store=beatbox1', { phone: '0897770022', password: '0022' }, { auth: false });
  await api('POST', '/public/me/password?store=beatbox1', { current: '0022', password: 'secret99' }, { bearer: l2.body.token });
  assert.equal((await api('POST', `/public/receipts/${receiptToken}/claim`, {}, { bearer: l2.body.token })).status, 409);
});

test('cancel from LINE asks first, then cancels', async () => {
  const start = new Date(Date.now() + 3 * 86400000);
  const r2 = (await api('POST', '/reservations', { roomId: 6, startAt: start.toISOString(), durationMinutes: 60, customerName: 'คุณยกเลิก', phone: '0891239999', guestCount: 2 })).body;
  await say('Uccc', '0891239999');
  assert.match(allText((await tap('Uccc', `a=cancel&r=${r2.id}`)).reply), /ยืนยันยกเลิก/);
  assert.equal((await api('GET', `/reservations/${r2.id}`)).body.status, r2.status, 'not cancelled before the second tap');
  assert.match(allText((await tap('Uccc', `a=cancel_yes&r=${r2.id}`)).reply), /ยกเลิกการจอง .* แล้ว/s);
  assert.equal((await api('GET', `/reservations/${r2.id}`)).body.status, 'CANCELLED');
});

test('rich menu "booking website": picture checked, created, made the default, the old one replaced', async () => {
  const { PNG } = await import('pngjs');
  const png = (w, h) => PNG.sync.write(new PNG({ width: w, height: h }));
  const post = (buf) => fetch(`${base}/integrations/line/richmenu?bar=${encodeURIComponent('จองห้อง')}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/png' }, body: buf });
  assert.equal((await post(png(800, 300))).status, 400, 'wrong size refused');
  const r1 = await post(png(2500, 843));
  const b1 = await r1.json();
  assert.equal(r1.status, 200, JSON.stringify(b1));
  assert.match(b1.uri, /\/book\?store=/);
  const create = lineCalls.find((c) => c.method === 'POST' && /\/v2\/bot\/richmenu$/.test(c.url));
  const menu = JSON.parse(create.body);
  assert.equal(menu.areas[0].action.type, 'uri');
  assert.equal(menu.areas[0].action.uri, b1.uri);
  assert.equal(menu.chatBarText, 'จองห้อง');
  assert.ok(lineCalls.some((c) => c.url.includes(`api-data.line.me/v2/bot/richmenu/${b1.richMenuId}/content`) && c.type === 'image/png'));
  assert.ok(lineCalls.some((c) => c.url.endsWith(`/v2/bot/user/all/richmenu/${b1.richMenuId}`)));
  const r2 = await (await post(png(2500, 843))).json();
  assert.ok(lineCalls.some((c) => c.method === 'DELETE' && c.url.endsWith(`/richmenu/${b1.richMenuId}`)), 'the old menu is removed');
  assert.equal((await api('GET', '/integrations')).body.line.richMenuId, r2.richMenuId);
});

test('rich menu has three buttons: booking website | check a booking | the member page', async () => {
  const create = lineCalls.filter((c) => c.method === 'POST' && /\/v2\/bot\/richmenu$/.test(c.url)).at(-1);
  const areas = JSON.parse(create.body).areas;
  assert.equal(areas.length, 3);
  assert.equal(areas[0].action.type, 'uri');
  assert.equal(areas[1].action.data, 'a=check');
  assert.equal(areas[2].action.type, 'uri');
  assert.match(areas[2].action.uri, /\/book\/account\?store=/);
  assert.equal(areas.reduce((w, a) => w + a.bounds.width, 0), 2500);
});

test('"ตรวจสอบการจอง" asks for the phone number; "สมาชิก" links the member account, then shows the member card', async () => {
  assert.match(allText((await tap('Ueee', 'a=check')).reply), /พิมพ์เบอร์มือถือที่ใช้จอง/);
  const link = await tap('Ueee', 'a=member');
  const url = allText(link.reply).match(/\/book\/line-link\?link=([^&"]+)/);
  assert.ok(url, allText(link.reply));
  await api('POST', '/members', { firstName: 'ไลน์เมมเบอร์', phone: '0897771234' });
  const login = await api('POST', '/public/auth/login?store=beatbox1', { phone: '0897771234', password: '1234', linkToken: decodeURIComponent(url[1]), consent: true }, { auth: false });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  await tick();
  assert.match(allText(pushesTo('Ueee').at(-1)?.body), /เชื่อมบัญชีสมาชิก ไลน์เมมเบอร์ กับ LINE เรียบร้อย/);
  const card = await say('Ueee', 'สมาชิก');
  const text = allText(card.reply);
  assert.match(text, /ไลน์เมมเบอร์/);
  assert.match(text, /แต้ม/);
  assert.match(text, /\/book\/points\?store=/);
  // the same LINE cannot be linked to a second member
  await api('POST', '/members', { firstName: 'คนที่สอง', phone: '0897775678' });
  const second = await api('POST', '/public/auth/login?store=beatbox1', { phone: '0897775678', password: '5678', linkToken: decodeURIComponent(url[1]), consent: true }, { auth: false });
  assert.equal(second.status, 409);
  // a linked member checking bookings does not need to type the phone
  const start = new Date(Date.now() + 2 * 86400000);
  await api('POST', '/reservations', { roomId: 8, startAt: start.toISOString(), durationMinutes: 60, customerName: 'ไลน์เมมเบอร์', phone: '0897771234', guestCount: 3 });
  assert.match(allText((await tap('Ueee', 'a=check')).reply), /ไลน์เมมเบอร์/);
});

test('SMS delivery-report webhook: store key required, a failure report marks the SMS failed', async () => {
  const { url } = (await api('GET', '/integrations/sms/webhook')).body;
  assert.match(url, /\/api\/public\/sms\/webhook\?store=.+&key=[\w-]{20,}/);
  assert.equal((await api('GET', '/integrations/sms/webhook')).body.url, url, 'the same address every time');
  const path = url.replace(/^https?:\/\/[^/]+\/api/, '');
  await db(`INSERT INTO notifications(store_id, channel, type, title, message, data, status) VALUES (1, 'SMS', 'BOOKING_REMINDER', 't', 'm', '{"phone":"0891112233"}', 'SENT')`);
  const bad = await fetch(`${base}${path.replace(/key=[^&]+/, 'key=wrong')}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ msisdn: '66891112233', status: 'FAILED' }) });
  assert.equal(bad.status, 401);
  const ok = await (await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ msisdn: '66891112233', status: 'UNDELIVERED' }) })).json();
  assert.equal(ok.matched, 1);
  const row = (await db(`SELECT status, error, data FROM notifications WHERE channel = 'SMS' AND data->>'phone' = '0891112233'`))[0];
  assert.equal(row.status, 'FAILED');
  assert.equal(row.data.delivery.status, 'UNDELIVERED');
  // Twilio style: form post
  const tw = await (await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'To=%2B66891112233&MessageStatus=delivered&MessageSid=SM1' })).json();
  assert.equal(tw.matched, 1);
});

test('sign up from LINE: phone only, no password, signed in with LINE (no password change asked)', async () => {
  const link = await tap('Ufff', 'a=member');
  const token = decodeURIComponent(allText(link.reply).match(/\/book\/line-link\?link=([^&"]+)/)[1]);
  const r = await api('POST', '/public/auth/signup?store=beatbox1', { phone: '0896660001', firstName: 'ไลน์ใหม่', linkToken: token, consent: true }, { auth: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.token, 'signed in at once');
  const me = (await api('GET', '/public/me', null, { bearer: r.body.token })).body;
  assert.equal(me.mustChangePassword, false);
  assert.equal(me.signedInWithLine, true);
  assert.equal((await api('GET', '/public/me/points', null, { bearer: r.body.token })).status, 200, 'member pages open without a password');
  // a sign-up without LINE still needs the last name and gets no session
  const plain = await api('POST', '/public/auth/signup?store=beatbox1', { phone: '0896660002', firstName: 'ธรรมดา' }, { auth: false });
  assert.equal(plain.status, 400);
  // the LINE user is now this member in the chat
  assert.match(allText((await say('Ufff', 'สมาชิก')).reply), /ไลน์ใหม่/);
});

test('a member with two LINE ids (LINE Login in another Provider): messages go to the id the OA knows; the test warns', async () => {
  const m = (await api('POST', '/members', { firstName: 'สองไอดี', phone: '0895550001' })).body;
  await say('Uggg', 'สวัสดี'); // the OA knows Uggg
  await db(`INSERT INTO line_connections(store_id, member_id, line_user_id, messaging_consent, linked_at) VALUES (1, $1, 'Uggg', true, now() - interval '1 day'), (1, $1, 'Ulogin-other-provider', true, now())`, [m.id]);
  await db(`INSERT INTO member_auth_identities(store_id, member_id, provider, provider_user_id) VALUES (1, $1, 'LINE', 'Ulogin-other-provider')`, [m.id]);
  const { memberLine } = await import('../src/services/lineFlow.js');
  const { runWithStore } = await import('../src/db/index.js');
  assert.equal(await runWithStore(1, () => memberLine(m.id)), 'Uggg');
  const t = (await api('POST', '/integrations/line/test', {})).body;
  assert.ok(t.results.some((r) => /คนละ Provider/.test(r.message)), JSON.stringify(t.results));
});

test('changing the LINE Login channel unlinks LINE ids from the old one that the OA never saw; the warning goes', async () => {
  await api('PUT', '/integrations/line', { loginChannelId: '1111111111' });
  await db(`UPDATE member_auth_identities SET status = 'ACTIVE' WHERE provider_user_id = 'Ulogin-other-provider'`);
  const r = await api('PUT', '/integrations/line', { loginChannelId: '2222222222' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await db(`SELECT status FROM member_auth_identities WHERE provider_user_id = 'Ulogin-other-provider'`))[0].status, 'DISCONNECTED');
  assert.equal((await db(`SELECT status FROM line_connections WHERE line_user_id = 'Uggg'`))[0].status, 'CONNECTED', 'the id the OA knows stays');
  const t = (await api('POST', '/integrations/line/test', {})).body;
  assert.ok(!t.results.some((x) => /คนละ Provider/.test(x.message)), JSON.stringify(t.results));
});

// Member cards: random member number = card number, first card on print, "ออกบัตรใหม่" (new number, old card stops
// working), "ซิงค์บัตร" (an existing card read at the counter becomes the number), lookups by the card, card settings.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const DB = (process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/beatbox_test').replace(/\/[^/]+$/, '/beatbox_test_cards');
process.env.DATABASE_URL = DB;
process.env.DISABLE_SCHEDULER = 'true';
process.env.PAYMENT_MODE = 'DEMO';
process.env.PORT = '4993';
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
  await admin.query('DROP DATABASE IF EXISTS beatbox_test_cards WITH (FORCE)');
  await admin.query('CREATE DATABASE beatbox_test_cards');
  await admin.end();
  const { start } = await import('../src/index.js');
  server = await start();
  base = 'http://localhost:4993/api';
  const storeSession = (await api('POST', '/auth/store-login', { storeCode: 'beatbox1', login: 'admin', password: 'Admin12345' })).body.storeSession;
  token = (await api('POST', '/auth/login', { pin: '1234' }, { headers: { 'X-Store-Session': storeSession } })).body.token;
});

after(async () => {
  server?.close();
  const { pool } = await import('../src/db/index.js');
  await pool.end();
  setTimeout(() => process.exit(0), 200).unref();
});


let member;

test('new members get a random 12-digit number', async () => {
  const a = await api('POST', '/members', { firstName: 'บัตร', phone: '0891110001' });
  const b = await api('POST', '/members', { firstName: 'บัตรสอง', phone: '0891110002' });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.match(a.body.member_code, /^[1-9]\d{11}$/);
  assert.notEqual(a.body.member_code, b.body.member_code);
  member = a.body;
});

test('printing gives the first card with the member number and counts prints', async () => {
  const p = await api('POST', '/members/cards/print', { memberIds: [member.id] });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.body[0].member_code, member.member_code, 'a random number is kept as the card number');
  assert.equal(p.body[0].card_kind, 'ISSUED');
  assert.equal(p.body[0].card_print_count, 1);
  const again = await api('POST', '/members/cards/print', { memberIds: [member.id] });
  assert.equal(again.body[0].card_print_count, 2);
  const d = (await api('GET', `/members/${member.id}`)).body;
  assert.equal(d.cards.length, 1);
});

test('an old style number (M000001) gets a random card number on its first card', async () => {
  const { pool } = await import('../src/db/index.js');
  const c = await pool.connect();
  await c.query(`SELECT set_config('app.bypass_rls','on',false)`);
  const m2 = (await api('GET', '/members?q=0891110002')).body[0];
  await c.query(`UPDATE members SET member_code = 'M009999' WHERE id = $1`, [m2.id]);
  c.release();
  const p = await api('POST', '/members/cards/print', { memberIds: [m2.id] });
  assert.match(p.body[0].member_code, /^\d{12}$/);
});

test('"ออกบัตรใหม่" changes the number; the old card no longer finds the member', async () => {
  const old = member.member_code;
  const r = await api('POST', `/members/${member.id}/card/issue`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.notEqual(r.body.card_no, old);
  assert.equal((await api('GET', `/members/lookup?q=${old}`)).body, null);
  const found = (await api('GET', `/members/lookup?q=MEMBER:${r.body.card_no}`)).body;
  assert.equal(found.id, member.id, 'the member QR (MEMBER:…) finds the member');
  const d = (await api('GET', `/members/${member.id}`)).body;
  assert.equal(d.cards.filter((x) => x.status === 'ACTIVE').length, 1);
  assert.equal(d.cards.length, 2);
});

test('"ซิงค์บัตร": an existing card number becomes the member number; a card of someone else is refused', async () => {
  const owner = (await api('GET', '/members/card-owner?no=0012345678')).body;
  assert.equal(owner.valid, true);
  assert.equal(owner.owner, null);
  const s = await api('POST', `/members/${member.id}/card/sync`, { cardNo: ' 0012345678 ' });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.body.kind, 'SYNCED');
  const found = (await api('GET', '/members/lookup?q=0012345678')).body;
  assert.equal(found.id, member.id);
  assert.equal(found.member_code, '0012345678');
  const other = (await api('GET', '/members?q=0891110002')).body[0];
  const clash = await api('POST', `/members/${other.id}/card/sync`, { cardNo: '0012345678' });
  assert.equal(clash.status, 409);
  const bad = await api('POST', `/members/${other.id}/card/sync`, { cardNo: 'ab' });
  assert.equal(bad.status, 400);
  assert.equal((await api('GET', '/members/card-owner?no=0012345678')).body.owner.id, member.id);
});

test('card settings: digits used for new numbers, links validated', async () => {
  const s = (await api('GET', '/settings')).body.memberCard;
  assert.equal(s.numberDigits, 12);
  const put = await api('PUT', '/settings/memberCard', { ...s, numberDigits: 8, back: { ...s.back, links: [{ label: 'LINE', url: 'https://line.me/R/ti/p/@beatbox' }] } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const m = await api('POST', '/members', { firstName: 'แปดหลัก', phone: '0891110003' });
  assert.match(m.body.member_code, /^[1-9]\d{7}$/);
  const bad = await api('PUT', '/settings/memberCard', { ...s, numberDigits: 3 });
  assert.equal(bad.status, 400);
  const lay = await api('PUT', '/settings/memberCard', { ...s, print: { ...s.print, layout: 'SAME_SIDE', flip: 'NONE' } });
  assert.equal(lay.status, 200, JSON.stringify(lay.body));
  assert.equal(lay.body.memberCard.print.layout, 'SAME_SIDE');
  assert.equal((await api('PUT', '/settings/memberCard', { ...s, print: { ...s.print, layout: 'SIDEWAYS' } })).status, 400);
});

// The store's LINE OA talking with customers (Messaging API webhook). A customer types the phone number they booked
// with → the booking card (room photo, time, people, name, phone, Google Maps, call the store, confirm / cancel). The
// first LINE user to look a booking up is tied to it: only they can confirm or cancel it, and they get its booking
// pass, the reminders, the room card and the receipt. Phone look-ups are limited per LINE user.
import { Router } from 'express';
import { pool, tx, one, many, currentStoreId } from '../db/index.js';
import { signToken } from '../lib/auth.js';
import { config } from '../config.js';
import { useStoreOf } from '../lib/tenant.js';
import { emitSync } from '../lib/realtime.js';
import { logActivity } from '../lib/activity.js';
import { notFound } from '../lib/errors.js';
import { getSettings } from '../services/settings.js';
import { getIntegrations } from '../services/integrations.js';
import { notify } from '../services/notifications.js';
import { lineMessaging } from '../providers/line.js';
import { cancelOnline, cancelPreview, canCancelOnline } from '../services/booking.js';
import { bookingCodePng } from '../services/bookingCode.js';
import { bookingsMessage, passMessages, helpMessage, mapsUrl, memberMessage, linkMessage, ACTIVE_BOOKING } from '../services/lineFlex.js';
import { reminderMarks, minutesLeft } from '../services/lineFlow.js';
import { normalizePhone, maskPhone } from '@beatbox/shared/format.js';

export const MAX_LOOKUPS = 8; // phone look-ups per LINE user …
const LOOKUP_WINDOW_MIN = 30; // … within this many minutes

export const BOOKING_ROWS = `SELECT rv.*, rm.name AS room_name, COALESCE(rm.image_url, rt.image_url) AS room_image, rt.name AS type_name, f.name AS floor_name
  FROM reservations rv JOIN rooms rm ON rm.id = rv.room_id JOIN room_types rt ON rt.id = rm.room_type_id LEFT JOIN floors f ON f.id = rm.floor_id`;

/** The picture of a booking pass (LINE downloads it; the random check-in token is the key). */
export const codePath = (rv) => `/api/public/line/pass/${rv.check_in_token}.png`;

const r = Router();

r.get('/line/pass/:token.png', async (req, res) => {
  const token = String(req.params.token);
  if (!(await useStoreOf('reservations', 'check_in_token', token))) throw notFound();
  const rv = await one('SELECT booking_no, check_in_token FROM reservations WHERE check_in_token = $1', [token]);
  if (!rv) throw notFound();
  res.set('Content-Type', 'image/png').set('Cache-Control', 'public, max-age=86400').send(bookingCodePng(`CHECKIN:${rv.check_in_token}`, rv.booking_no));
});

/** The booking pass page (link in LINE): live countdown, QR / barcode, room, store contacts. The token is the key. */
/** The member's QR + barcode picture (the member number is printed on their card anyway). */
r.get('/line/member/:code.png', async (req, res) => {
  const code = String(req.params.code).toUpperCase();
  if (!/^[A-Z0-9-]{4,32}$/.test(code)) throw notFound();
  res.set('Content-Type', 'image/png').set('Cache-Control', 'public, max-age=86400').send(bookingCodePng(`MEMBER:${code}`, code, { accent: [22, 163, 74] }));
});

r.get('/line/booking/:token', async (req, res) => {
  const token = String(req.params.token);
  if (!(await useStoreOf('reservations', 'check_in_token', token))) throw notFound('ไม่พบการจอง');
  const rv = await one(`${BOOKING_ROWS} WHERE rv.check_in_token = $1`, [token]);
  if (!rv) throw notFound('ไม่พบการจอง');
  const s = await getSettings();
  const usable = [...ACTIVE_BOOKING, 'ARRIVED', 'IN_USE'].includes(rv.status);
  res.json({
    bookingNo: rv.booking_no,
    status: rv.status,
    confirmed: !!rv.customer_confirmed_at,
    customerName: rv.customer_name,
    phone: maskPhone(rv.phone),
    guests: rv.guest_count,
    room: { name: rv.room_name, image: rv.room_image, type: rv.type_name, floor: rv.floor_name },
    startAt: rv.start_at,
    endAt: rv.end_at,
    qr: usable ? `CHECKIN:${rv.check_in_token}` : null,
    store: { name: s.store.name, logoUrl: s.store.logoUrl, phone: s.store.phone, address: s.store.address, slug: s.store.slug, mapUrl: mapsUrl(s) },
  });
});

r.post('/line/webhook', async (req, res) => {
  // LINE checks the URL with an empty event list; anything else must carry LINE's signature
  if (!(await lineMessaging.verifySignature(req.rawBody, req.headers['x-line-signature']))) return res.status(401).json({ error: 'bad signature' });
  res.json({ ok: true }); // answer LINE at once; the replies go through the reply API
  const settings = await getSettings();
  for (const ev of req.body?.events || []) {
    try {
      await handleEvent(ev, settings);
    } catch (e) {
      console.error('[line] event', ev.type, e.message);
    }
  }
});

async function chatUser(userId) {
  return one(
    `INSERT INTO line_chat_users(line_user_id) VALUES ($1)
     ON CONFLICT (store_id, line_user_id) DO UPDATE SET last_seen_at = now() RETURNING *`,
    [userId],
  );
}

const reply = (ev, messages) => (ev.replyToken ? lineMessaging.reply(ev.replyToken, Array.isArray(messages) ? messages : [messages]) : null);
const textMsg = (text, settings) => helpMessage(settings, text);

/** The member this LINE user is linked to (connected), with the tier. */
export function lineMember(userId) {
  return one(
    `SELECT m.*, t.name AS tier_name, t.color AS tier_color FROM line_connections lc JOIN members m ON m.id = lc.member_id LEFT JOIN member_tiers t ON t.id = m.tier_id
     WHERE lc.line_user_id = $1 AND lc.status = 'CONNECTED' AND m.deleted_at IS NULL ORDER BY lc.linked_at DESC LIMIT 1`,
    [userId],
  );
}

const storeUrl = (path, settings) => `${config.publicUrl}${path}${path.includes('?') ? '&' : '?'}store=${encodeURIComponent(settings.store?.slug || '')}`;

export function memberCard(m, settings) {
  return memberMessage(m, settings, {
    codeUrl: `/api/public/line/member/${encodeURIComponent(m.member_code)}.png`,
    pointsUrl: storeUrl('/book/points', settings),
    rewardsUrl: storeUrl('/book/rewards', settings),
    bookUrl: storeUrl('/book', settings),
  });
}

/** "สมาชิก": the member card, or the link to sign in / sign up with this LINE. */
async function onMember(ev, userId, settings) {
  const m = await lineMember(userId);
  if (m) return reply(ev, memberCard(m, settings));
  const p = (await lineMessaging.profile(userId)) || {};
  const link = signToken({ typ: 'line-link', via: 'chat', lineUserId: userId, displayName: p.displayName || 'LINE', pictureUrl: p.pictureUrl || null, st: currentStoreId() }, '30m');
  const url = storeUrl(`/book/line-link?link=${encodeURIComponent(link)}&name=${encodeURIComponent(p.displayName || '')}&redirect=${encodeURIComponent('/book/account')}`, settings);
  return reply(ev, linkMessage(url, settings));
}

/** "ตรวจสอบการจอง": a linked member sees their bookings at once; anyone else is asked for the phone number. */
async function onCheck(ev, userId, settings) {
  const m = await lineMember(userId);
  if (m) {
    const rows = await many(`${BOOKING_ROWS} WHERE (rv.member_id = $1 OR rv.phone = $2) AND rv.status = ANY($3) AND rv.end_at > now() ORDER BY rv.start_at LIMIT 10`, [m.id, m.phone, ACTIVE_BOOKING]);
    const mine = rows.filter((x) => !x.line_user_id || x.line_user_id === userId);
    if (mine.length) {
      await pool.query('UPDATE reservations SET line_user_id = $2 WHERE id = ANY($1::int[]) AND line_user_id IS NULL', [mine.map((x) => x.id), userId]);
      return reply(ev, bookingsMessage(mine, settings));
    }
    return reply(ev, textMsg(`คุณ${m.first_name} ยังไม่มีการจองที่กำลังจะถึง\nจองห้องได้ที่ปุ่ม "จองห้อง" หรือพิมพ์เบอร์โทรอื่นที่ใช้จอง`, settings));
  }
  return reply(ev, textMsg('📱 พิมพ์เบอร์มือถือที่ใช้จองในช่องแชทได้เลย (เช่น 0812345678)', settings));
}

export async function handleEvent(ev, settings) {
  const userId = ev.source?.userId;
  if (!userId) return;
  if (ev.type === 'unfollow') return pool.query('UPDATE line_chat_users SET followed = false WHERE line_user_id = $1', [userId]);
  await chatUser(userId);
  if (ev.type === 'follow') {
    await pool.query('UPDATE line_chat_users SET followed = true WHERE line_user_id = $1', [userId]);
    return reply(ev, helpMessage(settings));
  }
  if (settings.line?.chatBooking === false) return;
  if (ev.type === 'message' && ev.message?.type === 'text') return onText(ev, userId, settings);
  if (ev.type === 'postback') return onPostback(ev, userId, settings);
}

async function onText(ev, userId, settings) {
  const raw = String(ev.message.text || '').trim();
  if (/^(ตรวจสอบการจอง|เช็คการจอง|เช็กการจอง|การจองของฉัน)$/.test(raw)) return onCheck(ev, userId, settings);
  if (/^(สมาชิก|บัตรสมาชิก|แต้ม|แต้มสะสม)$/.test(raw)) return onMember(ev, userId, settings);
  const phone = normalizePhone(raw);
  const looksLikePhone = /^[\d\s+()-]+$/.test(raw) && /^0\d{8,9}$/.test(phone);
  if (!looksLikePhone) return reply(ev, helpMessage(settings));
  // limit how many numbers one LINE user can try (nobody can go through phone numbers to see other people's bookings)
  const u = await one(
    `UPDATE line_chat_users SET lookups = CASE WHEN lookups_since < now() - ($2 || ' minutes')::interval THEN 1 ELSE lookups + 1 END,
       lookups_since = CASE WHEN lookups_since < now() - ($2 || ' minutes')::interval THEN now() ELSE lookups_since END, last_phone = $3
     WHERE line_user_id = $1 RETURNING lookups`,
    [userId, String(LOOKUP_WINDOW_MIN), phone],
  );
  if (u.lookups > MAX_LOOKUPS) return reply(ev, textMsg(`ค้นหาบ่อยเกินไป กรุณาลองใหม่ใน ${LOOKUP_WINDOW_MIN} นาที หรือโทรหาร้าน`, settings));
  const rows = await many(`${BOOKING_ROWS} WHERE rv.phone = $1 AND rv.status = ANY($2) AND rv.end_at > now() ORDER BY rv.start_at LIMIT 10`, [phone, ACTIVE_BOOKING]);
  const mine = rows.filter((x) => !x.line_user_id || x.line_user_id === userId);
  if (!mine.length) {
    const other = rows.length > 0;
    return reply(ev, textMsg(other ? `การจองของเบอร์ ${maskPhone(phone)} เชื่อมกับบัญชี LINE อื่นแล้ว หากเป็นการจองของคุณ กรุณาโทรหาร้าน` : `ไม่พบการจองที่กำลังจะถึงของเบอร์ ${maskPhone(phone)}\nตรวจสอบเบอร์อีกครั้ง หรือจองห้องได้ที่ปุ่ม "จองห้อง"`, settings));
  }
  await pool.query('UPDATE reservations SET line_user_id = $2 WHERE id = ANY($1::int[]) AND line_user_id IS NULL', [mine.map((x) => x.id), userId]);
  return reply(ev, bookingsMessage(mine, settings));
}

async function onPostback(ev, userId, settings) {
  const p = new URLSearchParams(ev.postback?.data || '');
  const id = Number(p.get('r'));
  const a = p.get('a');
  if (a === 'check') return onCheck(ev, userId, settings);
  if (a === 'member') return onMember(ev, userId, settings);
  const rv = id ? await one(`${BOOKING_ROWS} WHERE rv.id = $1`, [id]) : null;
  if (!rv || rv.line_user_id !== userId) return reply(ev, textMsg('ไม่พบการจองนี้ในบัญชี LINE ของคุณ พิมพ์เบอร์โทรที่ใช้จองเพื่อค้นหาอีกครั้ง', settings));
  const codeUrl = codePath(rv);
  if (a === 'confirm') {
    if (!ACTIVE_BOOKING.includes(rv.status)) return reply(ev, textMsg(`การจอง ${rv.booking_no} ไม่สามารถยืนยันได้แล้ว (สถานะปัจจุบัน) กรุณาติดต่อร้าน`, settings));
    if (!rv.customer_confirmed_at) {
      await tx(async (c) => {
        await c.query('UPDATE reservations SET customer_confirmed_at = now(), updated_at = now() WHERE id = $1 AND customer_confirmed_at IS NULL', [rv.id]);
        // the pass card shows the time left: reminders for marks already reached count as sent (not "it is time")
        const left = minutesLeft(rv.start_at);
        const reached = reminderMarks(settings).filter((m) => m > 0 && m >= left);
        if (reached.length) await c.query(`UPDATE reservations SET line_reminders = (SELECT jsonb_agg(DISTINCT x) FROM jsonb_array_elements(line_reminders || $2::jsonb) x) WHERE id = $1`, [rv.id, JSON.stringify(reached)]);
        await logActivity(c, { employee: { id: null, name: 'LINE' }, ip: null }, 'LINE_CONFIRM', 'reservation', rv.id, { bookingNo: rv.booking_no });
        await notify({ type: 'BOOKING_CUSTOMER_CONFIRMED', level: 'info', title: 'ลูกค้ายืนยันการจองผ่าน LINE', message: `${rv.booking_no} ${rv.customer_name} · ${rv.room_name}`, reservationId: rv.id, roomId: rv.room_id, dedupeKey: `line-confirm-customer:${rv.id}` }, c);
      });
      emitSync(['reservations', 'notifications']);
    }
    // one message: the pass card (QR + barcode, time left, live countdown) says it is confirmed
    return reply(ev, passMessages(rv, settings, codeUrl, { justConfirmed: true }));
  }
  if (a === 'pass') {
    if (![...ACTIVE_BOOKING, 'ARRIVED'].includes(rv.status)) return reply(ev, textMsg(`การจอง ${rv.booking_no} ใช้งานไม่ได้แล้ว`, settings));
    return reply(ev, passMessages(rv, settings, codeUrl));
  }
  if (a === 'cancel') {
    if (!canCancelOnline(rv, settings)) return reply(ev, textMsg('การจองนี้ยกเลิกทาง LINE ไม่ได้ กรุณาโทรหาร้าน', settings));
    const pv = await tx((c) => cancelPreview(c, rv, settings));
    const money = pv.amount > 0 ? `\nได้รับเงินมัดจำคืน ${pv.amount} บาท (${pv.percent}%) ร้านจะติดต่อกลับเพื่อคืนเงิน` : pv.held > 0 ? '\nตามนโยบายการยกเลิก จะไม่ได้รับเงินมัดจำคืน' : '';
    return reply(ev, {
      type: 'text',
      text: `ยืนยันยกเลิกการจอง ${rv.booking_no}\nห้อง ${rv.room_name}?${money}`,
      quickReply: { items: [{ type: 'action', action: { type: 'postback', label: 'ยืนยันยกเลิก', data: `a=cancel_yes&r=${rv.id}`, displayText: 'ยืนยันยกเลิกการจอง' } }, { type: 'action', action: { type: 'postback', label: 'ไม่ยกเลิก', data: `a=keep&r=${rv.id}`, displayText: 'ไม่ยกเลิก' } }] },
    });
  }
  if (a === 'cancel_yes') {
    let pv;
    try {
      pv = await tx(async (c) => {
        const locked = (await c.query('SELECT * FROM reservations WHERE id = $1 FOR UPDATE', [rv.id])).rows[0];
        return cancelOnline(c, locked, { reason: 'ลูกค้ายกเลิกผ่าน LINE', settings, source: 'LINE' });
      });
    } catch (e) {
      return reply(ev, textMsg(`ยกเลิกไม่สำเร็จ: ${e.message}`, settings));
    }
    emitSync(['reservations', 'rooms', 'availability', 'notifications']);
    return reply(ev, textMsg(`ยกเลิกการจอง ${rv.booking_no} แล้ว${pv.amount > 0 ? `\nร้านจะคืนเงินมัดจำ ${pv.amount} บาท` : ''}\nขอบคุณค่ะ`, settings));
  }
  if (a === 'keep') return reply(ev, textMsg('ไม่ได้ยกเลิก การจองยังอยู่ตามเดิมค่ะ', settings));
}

/** The webhook address to paste into LINE Developers (one per store). */
export async function webhookInfo(publicUrl, slug) {
  const integ = await getIntegrations();
  return { url: `${publicUrl}/api/public/line/webhook?store=${encodeURIComponent(slug || '')}`, ready: !!(integ.line.messagingAccessToken && integ.line.messagingChannelSecret) };
}

export default r;

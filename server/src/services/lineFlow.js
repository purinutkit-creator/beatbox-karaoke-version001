// Everything the customer's LINE gets after the booking chat, checked every scheduler tick: "time to come" before the
// booking starts, the room card when the room is open, "time almost up", and the online receipt with "collect points".
// Who gets it: the LINE user tied to the booking in the chat, else the member's connected LINE (if they agreed).
import { pool, many, one } from '../db/index.js';
import { config } from '../config.js';
import { lineMessaging } from '../providers/line.js';
import { queueLinePush } from './notifications.js';
import { LIVE_SESSION } from './roomService.js';
import { reminderMessage, roomOpenMessage, timeLeftMessage, receiptMessage, ACTIVE_BOOKING } from './lineFlex.js';
import { BOOKING_ROWS, codePath } from '../routes/line.js';
import { calculatePoints } from '@beatbox/shared/calc.js';

/** The connected LINE of a member who agreed to messages. */
async function memberLine(memberId) {
  if (!memberId) return null;
  const c = await one(`SELECT line_user_id FROM line_connections WHERE member_id = $1 AND status = 'CONNECTED' AND messaging_consent ORDER BY linked_at DESC LIMIT 1`, [memberId]);
  return c?.line_user_id || null;
}
const target = async (lineUserId, memberId) => lineUserId || (await memberLine(memberId));

const storeLink = (path, settings) => `${config.publicUrl}${path}${path.includes('?') ? '&' : '?'}store=${encodeURIComponent(settings.store?.slug || '')}`;

async function reminders(settings) {
  const marks = [...new Set((settings.line.remindMinutes || []).map(Number).filter((m) => m > 0 && m <= 180))].sort((a, b) => b - a);
  if (!marks.length) return;
  const rows = await many(
    `${BOOKING_ROWS} WHERE rv.status = ANY($1) AND rv.start_at > now() AND rv.start_at <= now() + ($2 || ' minutes')::interval
       AND (rv.line_user_id IS NOT NULL OR rv.member_id IS NOT NULL)`,
    [ACTIVE_BOOKING, String(marks[0])],
  );
  for (const rv of rows) {
    const left = Math.max(1, Math.ceil((new Date(rv.start_at) - Date.now()) / 60000));
    const sent = (rv.line_reminders || []).map(Number);
    const due = marks.filter((m) => m >= left && !sent.includes(m));
    if (!due.length) continue;
    // one message with the real time left; every mark at or above it counts as sent (no "15" and "5" together)
    await pool.query('UPDATE reservations SET line_reminders = $2 WHERE id = $1', [rv.id, JSON.stringify([...new Set([...sent, ...marks.filter((m) => m >= left)])])]);
    const to = await target(rv.line_user_id, rv.member_id);
    if (to) await queueLinePush({ lineUserId: to, type: 'LINE_REMINDER', title: `อีก ${left} นาที ถึงเวลาจอง`, messages: [reminderMessage(rv, left, settings, codePath(rv))], memberId: rv.member_id, reservationId: rv.id, dedupeKey: `line-remind:${rv.id}:${Math.min(...due)}` });
  }
}

const SESSION_ROWS = `SELECT s.*, rm.name AS room_name, COALESCE(rm.image_url, rt.image_url) AS room_image, rm.guide_token, rv.line_user_id AS rv_line_user_id
  FROM room_sessions s JOIN rooms rm ON rm.id = s.room_id JOIN room_types rt ON rt.id = rm.room_type_id LEFT JOIN reservations rv ON rv.id = s.reservation_id`;

async function roomCards(settings) {
  const open = await many(`${SESSION_ROWS} WHERE s.line_open_sent_at IS NULL AND s.status = ANY($1) AND s.started_at > now() - interval '6 hours' AND s.order_token IS NOT NULL`, [LIVE_SESSION]);
  for (const s of open) {
    await pool.query('UPDATE room_sessions SET line_open_sent_at = now() WHERE id = $1', [s.id]);
    const to = settings.line.notifyRoomOpen !== false && (await target(s.rv_line_user_id, s.member_id));
    if (to) await queueLinePush({ lineUserId: to, type: 'LINE_ROOM_OPEN', title: `ห้อง ${s.room_name} เปิดแล้ว`, messages: [roomOpenMessage(s, settings)], memberId: s.member_id, reservationId: s.reservation_id, roomId: s.room_id, dedupeKey: `line-room:${s.id}` });
  }
  const mins = Number(settings.line.timeLeftMinutes || 0);
  if (mins <= 0) return;
  const ending = await many(
    `${SESSION_ROWS} WHERE s.status = 'ACTIVE' AND s.scheduled_end_at > now() AND s.scheduled_end_at <= now() + ($1 || ' minutes')::interval AND s.order_token IS NOT NULL`,
    [String(mins)],
  );
  for (const s of ending) {
    // once per end time: after adding time the room gets the message again before its new end
    const mark = `timeLeft:${new Date(s.scheduled_end_at).toISOString()}`;
    if ((s.line_alerts || []).includes(mark)) continue;
    await pool.query(`UPDATE room_sessions SET line_alerts = line_alerts || $2::jsonb WHERE id = $1`, [s.id, JSON.stringify([mark])]);
    const left = Math.max(1, Math.ceil((new Date(s.scheduled_end_at) - Date.now()) / 60000));
    const to = await target(s.rv_line_user_id, s.member_id);
    if (to) await queueLinePush({ lineUserId: to, type: 'LINE_TIME_LEFT', title: `ห้อง ${s.room_name} เหลือ ${left} นาที`, messages: [timeLeftMessage(s, left)], memberId: s.member_id, roomId: s.room_id, dedupeKey: `line-${s.id}-${mark}` });
  }
}

/** The receipt message of one receipt (also used by "send receipt" on the receipts page). */
export async function receiptLine(rc, settings) {
  const receiptUrl = `${config.publicUrl}/r/${rc.public_token}`;
  let pointsUrl = null;
  let pointsLabel = null;
  let pointsText = null;
  if (settings.points?.enabled) {
    if (rc.member_id) {
      pointsUrl = storeLink('/book/points', settings);
      pointsLabel = '⭐ ดูแต้มสะสมของฉัน';
      pointsText = Number(rc.points_earned) > 0 ? `ได้รับ ${Number(rc.points_earned)} แต้มจากบิลนี้แล้ว` : null;
    } else {
      const pts = rc.calc_snapshot ? calculatePoints(rc.calc_snapshot, settings.points, 1).points : 0;
      if (pts > 0) {
        pointsUrl = storeLink(`/book/claim/${rc.public_token}`, settings);
        pointsLabel = `⭐ สะสมแต้ม (+${pts} แต้ม)`;
        pointsText = `บิลนี้สะสมได้ ${pts} แต้ม กดปุ่มด้านล่างเพื่อรับแต้ม`;
      }
    }
  }
  return receiptMessage(rc, settings, { receiptUrl, pointsUrl, pointsLabel, pointsText });
}

export const RECEIPT_ROWS = `SELECT rc.*, o.member_id, o.points_earned, o.calc_snapshot, o.status AS order_status, s.reservation_id, rv.line_user_id AS rv_line_user_id
  FROM receipts rc JOIN orders o ON o.id = rc.order_id LEFT JOIN room_sessions s ON s.id = o.session_id LEFT JOIN reservations rv ON rv.id = s.reservation_id`;

export async function receiptTarget(rc) {
  return target(rc.rv_line_user_id, rc.member_id);
}

async function receipts(settings) {
  const rows = await many(`${RECEIPT_ROWS} WHERE rc.line_sent_at IS NULL AND rc.issued_at > now() - interval '2 hours' AND o.status = 'PAID'`);
  for (const rc of rows) {
    await pool.query('UPDATE receipts SET line_sent_at = now() WHERE id = $1', [rc.id]);
    const to = settings.line.notifyReceipt !== false && (await receiptTarget(rc));
    if (to) await queueLinePush({ lineUserId: to, type: 'LINE_RECEIPT', title: `ใบเสร็จ ${rc.receipt_no}`, messages: [await receiptLine(rc, settings)], memberId: rc.member_id, reservationId: rc.reservation_id, dedupeKey: `line-receipt:${rc.id}` });
  }
}

/** One scheduler tick (per store). Nothing is read when the store does not send LINE messages. */
export async function lineTick(settings) {
  if (!settings.line?.messagingEnabled || !(await lineMessaging.enabled())) return;
  await reminders(settings);
  await roomCards(settings);
  await receipts(settings);
}

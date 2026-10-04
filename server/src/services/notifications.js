import { pool } from '../db/index.js';
import { emitStaff } from '../lib/realtime.js';
import { getSettings } from './settings.js';
import { lineMessaging } from '../providers/line.js';
import { fmtDate, fmtTime } from '@beatbox/shared/format.js';

/** POS Notification Center entry (synced to every device). */
export async function notify({ type, level = 'info', title, message, data = {}, roomId = null, reservationId = null, memberId = null, dedupeKey = null }, client = pool) {
  const r = await client.query(
    `INSERT INTO notifications(channel, type, level, title, message, data, room_id, reservation_id, member_id, status, sent_at, dedupe_key)
     VALUES ('POS',$1,$2,$3,$4,$5,$6,$7,$8,'SENT',now(),$9)
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING *`,
    [type, level, title, message, data, roomId, reservationId, memberId, dedupeKey],
  );
  if (r.rows[0]) emitStaff('notification:new', r.rows[0]);
  return r.rows[0] || null;
}

const LINE_TYPE_SETTING = {
  BOOKING_CONFIRMED: 'notifyBookingConfirmed',
  DEPOSIT_RECEIVED: 'notifyDeposit',
  BOOKING_REMINDER: 'notifyReminder',
  ROOM_CHANGED: 'notifyRoomChange',
  BOOKING_CANCELLED: 'notifyCancel',
  DEPOSIT_REFUNDED: 'notifyRefund',
  POINTS_EARNED: 'notifyPoints',
  REWARD: 'notifyRewards',
  PROMOTION: 'notifyPromotions',
};

/** Queue an outbound LINE message (respects member consent + settings). Status recorded as PENDING/SENT/FAILED/SKIPPED. */
export async function queueLineMessage({ memberId, type, title, message, reservationId = null, dedupeKey = null }, client = pool) {
  if (!memberId) return null;
  const settings = await getSettings();
  const conn = (
    await client.query(`SELECT line_user_id, messaging_consent FROM line_connections WHERE member_id = $1 AND status = 'CONNECTED' ORDER BY linked_at DESC LIMIT 1`, [memberId])
  ).rows[0];
  if (!conn) return null;
  let status = 'PENDING';
  let error = null;
  if (!settings.line.messagingEnabled) [status, error] = ['SKIPPED', 'ปิดการส่งข้อความ LINE ในการตั้งค่า'];
  else if (!conn.messaging_consent) [status, error] = ['SKIPPED', 'ลูกค้าไม่ได้ให้ความยินยอมรับข้อความ'];
  else if (LINE_TYPE_SETTING[type] && settings.line[LINE_TYPE_SETTING[type]] === false) [status, error] = ['SKIPPED', 'ปิดการแจ้งเตือนประเภทนี้'];
  const r = await client.query(
    `INSERT INTO notifications(channel, type, title, message, data, member_id, reservation_id, status, error, dedupe_key)
     VALUES ('LINE',$1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [type, title, message, { lineUserId: conn.line_user_id }, memberId, reservationId, status, error, dedupeKey],
  );
  return r.rows[0]?.id || null;
}

/** Worker: deliver pending LINE messages with retry. */
export async function dispatchPendingMessages() {
  const rows = (
    await pool.query(`SELECT * FROM notifications WHERE channel = 'LINE' AND status = 'PENDING' AND attempts < 5 ORDER BY id LIMIT 20`)
  ).rows;
  for (const n of rows) {
    try {
      await lineMessaging.push(n.data.lineUserId, n.message);
      await pool.query(`UPDATE notifications SET status = 'SENT', sent_at = now(), attempts = attempts + 1, error = NULL WHERE id = $1`, [n.id]);
    } catch (e) {
      const attempts = n.attempts + 1;
      await pool.query(`UPDATE notifications SET status = $3, attempts = $2, error = $4 WHERE id = $1`, [n.id, attempts, attempts >= 5 ? 'FAILED' : 'PENDING', String(e.message).slice(0, 500)]);
    }
  }
}

export function bookingMessage(kind, b, extra = {}) {
  const time = `${fmtTime(b.start_at)}–${fmtTime(b.end_at)} น.`;
  const base = `เลขที่จอง: ${b.booking_no}\nห้อง: ${b.room_name || ''}\nวันที่: ${fmtDate(b.start_at)}\nเวลา: ${time}\nจำนวน: ${b.guest_count} ท่าน`;
  switch (kind) {
    case 'BOOKING_CONFIRMED':
      return `การจองของคุณได้รับการยืนยันแล้ว\n\n${base}\nมัดจำ: ${Number(b.deposit_paid || 0).toLocaleString('th-TH')} บาท\n\nกรุณามาถึงก่อนเวลา ${extra.arriveEarly || 10} นาที`;
    case 'DEPOSIT_RECEIVED':
      return `ได้รับเงินมัดจำ ${Number(extra.amount || 0).toLocaleString('th-TH')} บาท เรียบร้อยแล้ว\n\n${base}`;
    case 'BOOKING_REMINDER':
      return `แจ้งเตือนการจองของคุณกำลังจะถึง\n\n${base}`;
    case 'ROOM_CHANGED':
      return `มีการเปลี่ยนแปลงการจองของคุณ\n\n${base}`;
    case 'BOOKING_CANCELLED':
      return `การจองของคุณถูกยกเลิก\n\n${base}${extra.reason ? `\nเหตุผล: ${extra.reason}` : ''}`;
    case 'DEPOSIT_REFUNDED':
      return `คืนเงินมัดจำ ${Number(extra.amount || 0).toLocaleString('th-TH')} บาท สำหรับการจอง ${b.booking_no} เรียบร้อยแล้ว`;
    default:
      return base;
  }
}

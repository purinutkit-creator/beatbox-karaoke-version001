// Server-side scheduler: the server (not the browser) decides room states, alerts, hold expiry and no-shows.
import { pool } from '../db/index.js';
import { getSettings } from './settings.js';
import { refreshRoomStatuses } from './rooms.js';
import { expireStaleHolds } from './availability.js';
import { notify, dispatchPendingMessages, queueLineMessage, bookingMessage, sendBookingSms } from './notifications.js';
import { emitStaff, emitSync } from '../lib/realtime.js';
import { sessionTiming } from '@beatbox/shared/roomPricing.js';
import { runBackup } from './backup.js';
import { addPointTx } from './points.js';
import { logActivity } from '../lib/activity.js';
import { autoAcceptRoomOrders } from './roomService.js';

let running = false;

async function roomTick() {
  const settings = await getSettings();
  await autoAcceptRoomOrders(settings).catch((e) => console.error('[scheduler] room orders', e.message));
  // activate scheduled sessions
  const act = await pool.query(`UPDATE room_sessions SET status = 'ACTIVE', updated_at = now() WHERE status = 'SCHEDULED' AND started_at <= now() RETURNING id`);
  if (act.rows.length) emitSync(['rooms']);

  const sessions = (
    await pool.query(
      `SELECT rs.*, r.name AS room_name, r.number AS room_number FROM room_sessions rs JOIN rooms r ON r.id = rs.room_id WHERE rs.status = 'ACTIVE'`,
    )
  ).rows;
  const thresholds = [...new Set((settings.room.alertMinutes || []).map(Number))].sort((a, b) => b - a);
  for (const s of sessions) {
    const t = sessionTiming(s);
    const remainingMin = t.remainingMs / 60000;
    const sent = new Set((s.alerts_sent || []).map(String));
    const toSend = [];
    if (remainingMin <= 0) {
      if (!sent.has('END')) toSend.push('END', ...thresholds.map(String));
    } else {
      // only the most specific threshold crossed (avoid 4 alerts at once)
      const crossed = thresholds.filter((m) => remainingMin <= m && !sent.has(String(m)));
      if (crossed.length) toSend.push(String(Math.min(...crossed)), ...crossed.map(String));
    }
    if (!toSend.length) continue;
    const marks = [...new Set([...sent, ...toSend])];
    // atomic claim (multiple server instances never double-alert)
    const claim = await pool.query(`UPDATE room_sessions SET alerts_sent = $2 WHERE id = $1 AND alerts_sent = $3::jsonb RETURNING id`, [s.id, JSON.stringify(marks), JSON.stringify(s.alerts_sent || [])]);
    if (!claim.rows[0]) continue;
    const key = toSend[0];
    const isEnd = key === 'END';
    const roomLabel = `${s.room_name}${s.room_number && !s.room_name.includes(s.room_number) ? ` (${s.room_number})` : ''}`;
    const title = isEnd ? `ห้อง ${roomLabel} หมดเวลาแล้ว` : `ห้อง ${roomLabel} เหลือเวลา ${key} นาที`;
    const speech = isEnd
      ? (settings.room.speechTemplate || 'ห้อง {room} หมดเวลาแล้ว').replace('{room}', s.room_name)
      : (settings.room.nearSpeechTemplate || 'ห้อง {room} เหลือเวลา {minutes} นาที').replace('{room}', s.room_name).replace('{minutes}', key);
    await notify({ type: isEnd ? 'ROOM_TIME_UP' : 'ROOM_NEAR_END', level: isEnd ? 'error' : 'warning', title, message: isEnd ? 'กรุณาตรวจสอบห้อง' : `ลูกค้า ${s.customer_name || '-'}`, data: { sessionId: s.id, minutes: isEnd ? 0 : Number(key), speech }, roomId: s.room_id, dedupeKey: `alert:${s.id}:${key}:${s.scheduled_end_at.getTime?.() || s.scheduled_end_at}` });
    emitStaff('room:alert', { kind: isEnd ? 'TIME_UP' : 'NEAR_END', minutes: isEnd ? 0 : Number(key), roomId: s.room_id, roomName: s.room_name, roomNumber: s.room_number, sessionId: s.id, customerName: s.customer_name, speech, soundUrl: settings.room.alertSoundUrl || null, useSpeech: settings.room.useSpeech });
  }
  await refreshRoomStatuses(settings);
}

async function reservationTick() {
  const settings = await getSettings();
  await expireStaleHolds(pool);
  // reservation start passed, not checked-in → WAITING
  const w = await pool.query(
    `UPDATE reservations SET status = 'WAITING', updated_at = now() WHERE status IN ('PENDING','CONFIRMED','DEPOSIT_PAID') AND start_at <= now() RETURNING id, booking_no, customer_name, room_id`,
  );
  for (const r of w.rows) await notify({ type: 'BOOKING_WAITING', level: 'info', title: 'ถึงเวลาจองแล้ว รอลูกค้า', message: `${r.booking_no} ${r.customer_name}`, reservationId: r.id, roomId: r.room_id, dedupeKey: `waiting:${r.id}` });
  if (w.rows.length) emitSync(['reservations', 'rooms']);

  // upcoming in 15 min → notify staff
  const soon = await pool.query(`SELECT id, booking_no, customer_name, room_id, start_at FROM reservations WHERE status IN ('PENDING','CONFIRMED','DEPOSIT_PAID') AND start_at BETWEEN now() AND now() + interval '15 minutes'`);
  for (const r of soon.rows) await notify({ type: 'BOOKING_SOON', level: 'info', title: 'ลูกค้าใกล้ถึงเวลาจอง', message: `${r.booking_no} ${r.customer_name}`, reservationId: r.id, roomId: r.room_id, dedupeKey: `soon:${r.id}` });

  // no-show handling (grace period)
  const grace = Number(settings.booking.gracePeriodMinutes || 15);
  const late = await pool.query(`SELECT * FROM reservations WHERE status = 'WAITING' AND start_at < now() - ($1 || ' minutes')::interval AND no_show_notified_at IS NULL`, [String(grace)]);
  for (const r of late.rows) {
    await pool.query('UPDATE reservations SET no_show_notified_at = now() WHERE id = $1', [r.id]);
    if (settings.booking.autoNoShow) {
      // only when explicitly enabled in settings
      await pool.query(`UPDATE reservations SET status = 'NO_SHOW', updated_at = now() WHERE id = $1 AND status = 'WAITING'`, [r.id]);
      if (settings.booking.noShowDepositAction === 'FORFEIT') await pool.query(`UPDATE deposits SET status = 'FORFEITED' WHERE reservation_id = $1 AND status = 'RECEIVED'`, [r.id]);
      await logActivity(null, { employee: { name: 'SYSTEM' } }, 'RESERVATION_AUTO_NO_SHOW', 'reservation', r.id, { grace });
      await notify({ type: 'NO_SHOW', level: 'warning', title: 'ยกเลิกอัตโนมัติ (ไม่มาตามนัด)', message: `${r.booking_no} ${r.customer_name}`, reservationId: r.id, roomId: r.room_id });
      emitSync(['reservations', 'rooms']);
    } else {
      await notify({ type: 'NO_SHOW_WARNING', level: 'warning', title: 'ลูกค้ายังไม่มาเกิน Grace Period', message: `${r.booking_no} ${r.customer_name} — เลยเวลา ${grace} นาที`, reservationId: r.id, roomId: r.room_id });
    }
  }

  // LINE reminders before booking time
  const hours = Number(settings.booking.reminderHours || 0);
  if (hours > 0) {
    const rem = await pool.query(
      `SELECT r.*, rm.name AS room_name FROM reservations r JOIN rooms rm ON rm.id = r.room_id WHERE r.status IN ('CONFIRMED','DEPOSIT_PAID')
         AND r.reminder_sent_at IS NULL AND r.start_at BETWEEN now() AND now() + ($1 || ' hours')::interval`,
      [String(hours)],
    );
    for (const r of rem.rows) {
      await pool.query('UPDATE reservations SET reminder_sent_at = now() WHERE id = $1', [r.id]);
      if (r.member_id) await queueLineMessage({ memberId: r.member_id, type: 'BOOKING_REMINDER', title: 'แจ้งเตือนการจอง', message: bookingMessage('BOOKING_REMINDER', r), reservationId: r.id, dedupeKey: `remind:${r.id}` });
      sendBookingSms('BOOKING_REMINDER', r).catch((e) => console.error('[sms] reminder', e.message));
    }
  }
  await dispatchPendingMessages();
}

async function dailyTick() {
  const settings = await getSettings();
  const bkkHour = new Date(Date.now() + 7 * 3600000).getUTCHours();
  const today = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
  if (settings.backup.enabled && bkkHour === Number(settings.backup.hour || 4)) {
    const done = await pool.query(`SELECT 1 FROM backups WHERE file_name LIKE 'beatbox-auto-%' AND (created_at AT TIME ZONE 'Asia/Bangkok')::date = $1`, [today]);
    if (!done.rows[0]) await runBackup('AUTO');
  }
  // expire points (FIFO lots past expiry)
  const lots = await pool.query(`SELECT id, member_id, remaining FROM point_ledgers WHERE type = 'EARN' AND remaining > 0 AND expires_at IS NOT NULL AND expires_at < now() LIMIT 500`);
  for (const lot of lots.rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const m = (await client.query('SELECT points_balance FROM members WHERE id = $1 FOR UPDATE', [lot.member_id])).rows[0];
      const amt = Math.min(Number(lot.remaining), Number(m.points_balance));
      await client.query('UPDATE point_ledgers SET remaining = 0 WHERE id = $1', [lot.id]);
      if (amt > 0) await addPointTx(client, { memberId: lot.member_id, type: 'EXPIRE', points: -amt, source: 'SYSTEM', reason: 'คะแนนหมดอายุ', idempotencyKey: `expire:${lot.id}` });
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('[scheduler] point expiry', e.message);
    } finally {
      client.release();
    }
  }
  await pool.query(`DELETE FROM idempotency_keys WHERE created_at < now() - interval '7 days'`);
  await pool.query(`DELETE FROM otp_codes WHERE created_at < now() - interval '1 day'`);
}

function loop(fn, ms, name) {
  const run = async () => {
    try {
      await fn();
    } catch (e) {
      console.error(`[scheduler:${name}]`, e.message);
    } finally {
      if (running) setTimeout(run, ms);
    }
  };
  setTimeout(run, 1000);
}

export function startScheduler() {
  if (running || process.env.DISABLE_SCHEDULER === 'true') return;
  running = true;
  loop(roomTick, 5000, 'rooms');
  loop(reservationTick, 15000, 'reservations');
  loop(dailyTick, 10 * 60000, 'daily');
}

export function stopScheduler() {
  running = false;
}

export { roomTick, reservationTick };

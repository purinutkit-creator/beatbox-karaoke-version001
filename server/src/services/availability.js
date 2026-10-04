// Room inventory — shared by POS (walk-in / reservations) and the Online Booking website.
import { RESERVATION_BLOCKING } from '@beatbox/shared/constants.js';
import { conflict } from '../lib/errors.js';
import { emitSync } from '../lib/realtime.js';

const ACTIVE_SESSION = ['SCHEDULED', 'ACTIVE', 'PAUSED', 'CLOSED'];

/** Release online holds whose timer elapsed (also enforced inside every booking transaction). */
export async function expireStaleHolds(client) {
  const r = await client.query(
    `UPDATE reservations SET status = 'EXPIRED', updated_at = now()
     WHERE status = 'HOLD' AND hold_expires_at < now() RETURNING id`,
  );
  if (r.rows.length) {
    await client.query(
      `UPDATE reservation_holds SET released_at = now(), release_reason = 'EXPIRED'
       WHERE reservation_id = ANY($1) AND released_at IS NULL`,
      [r.rows.map((x) => x.id)],
    );
    await client.query(`UPDATE payment_transactions SET status = 'EXPIRED', updated_at = now() WHERE reservation_id = ANY($1) AND status = 'PENDING'`, [r.rows.map((x) => x.id)]);
    emitSync(['reservations', 'rooms']);
  }
  return r.rows.length;
}

/** Serialize all inventory changes for a room (row lock). */
export async function lockRoom(client, roomId) {
  const r = await client.query('SELECT * FROM rooms WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [roomId]);
  return r.rows[0] || null;
}

const SESSION_END_SQL = `GREATEST(rs.scheduled_end_at + CASE WHEN rs.paused_at IS NOT NULL THEN now() - rs.paused_at ELSE interval '0' END, CASE WHEN rs.status IN ('ACTIVE','PAUSED','CLOSED') THEN now() + interval '1 minute' ELSE rs.scheduled_end_at END)`;

export async function findConflicts(client, roomId, startAt, endAt, { excludeReservationId = null, excludeSessionId = null } = {}) {
  const reservations = (
    await client.query(
      `SELECT id, booking_no, customer_name, start_at, end_at, status FROM reservations
       WHERE room_id = $1 AND status = ANY($2) AND tstzrange(start_at, end_at, '[)') && tstzrange($3, $4, '[)')
         AND ($5::int IS NULL OR id <> $5) AND NOT (status = 'HOLD' AND hold_expires_at < now())`,
      [roomId, RESERVATION_BLOCKING, startAt, endAt, excludeReservationId],
    )
  ).rows;
  const sessions = (
    await client.query(
      `SELECT rs.id, rs.session_no, rs.customer_name, rs.started_at, ${SESSION_END_SQL} AS end_at, rs.status FROM room_sessions rs
       WHERE rs.room_id = $1 AND rs.status = ANY($2) AND ($5::int IS NULL OR rs.id <> $5)
         AND tstzrange(rs.started_at, ${SESSION_END_SQL}, '[)') && tstzrange($3, $4, '[)')`,
      [roomId, ACTIVE_SESSION, startAt, endAt, excludeSessionId],
    )
  ).rows;
  return { reservations, sessions, hasConflict: reservations.length > 0 || sessions.length > 0 };
}

export async function assertRoomFree(client, roomId, startAt, endAt, opts = {}) {
  const c = await findConflicts(client, roomId, startAt, endAt, opts);
  if (c.hasConflict) {
    const r = c.reservations[0];
    const msg = r
      ? `ช่วงเวลานี้ทับซ้อนกับการจอง ${r.booking_no} (${r.customer_name})`
      : `ห้องนี้มีลูกค้าใช้งานอยู่ในช่วงเวลาดังกล่าว`;
    throw conflict(msg, 'ROOM_TAKEN', { conflicts: c });
  }
}

/**
 * Rooms with availability flag for a time range.
 */
export async function searchRooms(client, { branchId = null, startAt, endAt, guests = 0, roomTypeId = null, onlineOnly = false }) {
  const r = await client.query(
    `SELECT r.*, rt.name AS type_name, rt.code AS type_code, rt.color AS type_color, rt.amenities, rt.description AS type_description,
            rt.image_url AS type_image_url, rt.default_deposit AS type_deposit,
       EXISTS (SELECT 1 FROM reservations x WHERE x.room_id = r.id AND x.status = ANY($3)
               AND NOT (x.status = 'HOLD' AND x.hold_expires_at < now())
               AND tstzrange(x.start_at, x.end_at, '[)') && tstzrange($1, $2, '[)')) AS reserved,
       EXISTS (SELECT 1 FROM room_sessions rs WHERE rs.room_id = r.id AND rs.status = ANY($4)
               AND tstzrange(rs.started_at, ${SESSION_END_SQL}, '[)') && tstzrange($1, $2, '[)')) AS in_use
     FROM rooms r JOIN room_types rt ON rt.id = r.room_type_id
     WHERE r.deleted_at IS NULL AND r.is_active AND rt.is_active AND rt.deleted_at IS NULL
       AND r.status NOT IN ('MAINTENANCE','DISABLED')
       AND ($5::int IS NULL OR r.branch_id = $5) AND ($6::int IS NULL OR r.room_type_id = $6)
     ORDER BY r.sort_order, r.number`,
    [startAt, endAt, RESERVATION_BLOCKING, ACTIVE_SESSION, branchId, roomTypeId],
  );
  const nowMs = Date.now();
  return r.rows.map((room) => {
    // a room still being cleaned is not available for an immediate start
    const cleaningNow = room.status === 'CLEANING' && new Date(startAt).getTime() < nowMs + 15 * 60000;
    const fits = Number(room.capacity) >= Number(guests || 0);
    return { ...room, fits, available: !room.reserved && !room.in_use && !cleaningNow };
  });
}

function toMin(t) {
  const [h, m] = String(t || '00:00').split(':').map(Number);
  return h * 60 + (m || 0);
}

/** Is [start, end) within the branch opening hours (supports closing after midnight)? */
export function withinOpeningHours(startAt, endAt, openTime, closeTime) {
  const open = toMin(openTime);
  let close = toMin(closeTime);
  if (close <= open) close += 1440;
  const s = new Date(new Date(startAt).getTime() + 7 * 3600000);
  let sMin = s.getUTCHours() * 60 + s.getUTCMinutes();
  if (sMin < open && sMin + 1440 < close) sMin += 1440; // after midnight portion
  const dur = (new Date(endAt) - new Date(startAt)) / 60000;
  return sMin >= open && sMin + dur <= close;
}

/**
 * Suggestions when nothing fits: nearby times, other room types, nearest other days.
 */
export async function suggestAlternatives(client, { branchId, startAt, durationMinutes, guests, roomTypeId, openTime, closeTime }) {
  const start = new Date(startAt);
  const dur = durationMinutes * 60000;
  const out = { nearbyTimes: [], otherTypes: [], otherDays: [] };
  for (const off of [30, -30, 60, -60, 90, -90, 120, -120, 180]) {
    const s = new Date(start.getTime() + off * 60000);
    if (s.getTime() < Date.now()) continue;
    const e = new Date(s.getTime() + dur);
    if (openTime && !withinOpeningHours(s, e, openTime, closeTime)) continue;
    const rooms = (await searchRooms(client, { branchId, startAt: s, endAt: e, guests, roomTypeId })).filter((r) => r.available && r.fits);
    if (rooms.length) out.nearbyTimes.push({ startAt: s, endAt: e, rooms: rooms.length, roomTypeIds: [...new Set(rooms.map((r) => r.room_type_id))] });
    if (out.nearbyTimes.length >= 4) break;
  }
  if (roomTypeId) {
    const rooms = (await searchRooms(client, { branchId, startAt: start, endAt: new Date(start.getTime() + dur), guests })).filter((r) => r.available && r.fits && r.room_type_id !== Number(roomTypeId));
    const byType = new Map();
    for (const r of rooms) if (!byType.has(r.room_type_id)) byType.set(r.room_type_id, { roomTypeId: r.room_type_id, typeName: r.type_name, rooms: 0, priceHour: r.price_hour });
    for (const r of rooms) byType.get(r.room_type_id).rooms++;
    out.otherTypes = [...byType.values()];
  }
  for (let d = 1; d <= 14 && out.otherDays.length < 3; d++) {
    const s = new Date(start.getTime() + d * 86400000);
    const e = new Date(s.getTime() + dur);
    const rooms = (await searchRooms(client, { branchId, startAt: s, endAt: e, guests, roomTypeId })).filter((r) => r.available && r.fits);
    if (rooms.length) out.otherDays.push({ startAt: s, endAt: e, rooms: rooms.length });
  }
  return out;
}

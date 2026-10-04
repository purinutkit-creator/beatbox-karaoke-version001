import { computeSessionCharges, sessionTiming } from '@beatbox/shared/roomPricing.js';
import { pool } from '../db/index.js';
import { emitSync } from '../lib/realtime.js';

export const SESSION_SELECT = `
  SELECT rs.*, r.name AS room_name, r.number AS room_number, r.capacity AS current_room_capacity, rt.name AS type_name, rt.color AS type_color,
         e.name AS opened_by_name, m.member_code, m.first_name AS member_first_name, m.last_name AS member_last_name, m.points_balance AS member_points,
         m.tier_id AS member_tier_id, m.birthday AS member_birthday
  FROM room_sessions rs
  JOIN rooms r ON r.id = rs.room_id
  JOIN room_types rt ON rt.id = rs.room_type_id
  LEFT JOIN employees e ON e.id = rs.opened_by
  LEFT JOIN members m ON m.id = rs.member_id`;

export function chargeSettings(settings) {
  return { partialRule: settings.room.partialRule, graceMinutes: settings.room.graceMinutes, extraGuestFee: settings.room.extraGuestFee };
}

export function sessionCharges(session, settings, nowMs = Date.now()) {
  return computeSessionCharges(session, chargeSettings(settings), nowMs);
}

/** Status shown on the room card (server is the authority, clients only render). */
export function deriveRoomStatus(room, session, nextReservation, settings, nowMs = Date.now()) {
  if (session && ['ACTIVE', 'PAUSED', 'CLOSED', 'SCHEDULED'].includes(session.status)) {
    if (session.status === 'SCHEDULED') return 'RESERVED';
    if (session.status === 'CLOSED') return 'TIME_UP';
    const t = sessionTiming(session, nowMs);
    if (t.remainingMs <= 0) return 'TIME_UP';
    if (t.remainingMs <= Number(settings.room.nearEndMinutes || 10) * 60000) return 'NEAR_END';
    return 'IN_USE';
  }
  if (['CLEANING', 'MAINTENANCE', 'DISABLED'].includes(room.status)) return room.status;
  if (!room.is_active) return 'DISABLED';
  if (nextReservation) {
    const start = new Date(nextReservation.start_at).getTime();
    if (start <= nowMs) return 'WAITING';
    if (start - nowMs <= Number(settings.room.upcomingReservationMinutes || 60) * 60000) return 'RESERVED';
  }
  return 'AVAILABLE';
}

/** Rooms board: rooms + running session + live charges + next reservation + order totals. */
export async function getRoomBoard(settings, { branchId = null } = {}) {
  const rooms = (
    await pool.query(
      `SELECT r.*, rt.name AS type_name, rt.code AS type_code, rt.color AS type_color, rt.amenities
       FROM rooms r JOIN room_types rt ON rt.id = r.room_type_id
       WHERE r.deleted_at IS NULL AND ($1::int IS NULL OR r.branch_id = $1)
       ORDER BY r.sort_order, r.number`,
      [branchId],
    )
  ).rows;
  const sessions = (await pool.query(`${SESSION_SELECT} WHERE rs.status IN ('SCHEDULED','ACTIVE','PAUSED','CLOSED')`)).rows;
  const reservations = (
    await pool.query(
      `SELECT DISTINCT ON (room_id) id, booking_no, room_id, customer_name, phone, start_at, end_at, status, guest_count, deposit_paid
       FROM reservations WHERE status IN ('PENDING','CONFIRMED','DEPOSIT_PAID','WAITING','ARRIVED')
         AND end_at > now() AND start_at < now() + interval '24 hours'
       ORDER BY room_id, start_at`,
    )
  ).rows;
  const orderTotals = (
    await pool.query(
      `SELECT o.session_id, o.id AS order_id,
              COALESCE(SUM(oi.qty * oi.unit_price) FILTER (WHERE oi.voided_at IS NULL AND oi.item_type = 'PRODUCT'), 0) AS product_total,
              COUNT(oi.id) FILTER (WHERE oi.voided_at IS NULL AND oi.item_type = 'PRODUCT') AS item_count
       FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id
       WHERE o.status = 'OPEN' AND o.session_id IS NOT NULL GROUP BY o.id`,
    )
  ).rows;
  const deposits = (
    await pool.query(
      `SELECT d.session_id, d.reservation_id, SUM(d.amount - d.refunded_amount) AS amount FROM deposits d
       WHERE d.status = 'RECEIVED' AND d.verification_status = 'VERIFIED' GROUP BY d.session_id, d.reservation_id`,
    )
  ).rows;
  const now = Date.now();
  return rooms.map((room) => {
    const session = sessions.find((s) => s.room_id === room.id) || null;
    const nextReservation = reservations.find((x) => x.room_id === room.id) || null;
    let live = null;
    if (session) {
      const ch = sessionCharges(session, settings, now);
      const ot = orderTotals.find((o) => o.session_id === session.id);
      const dep = deposits
        .filter((d) => d.session_id === session.id || (session.reservation_id && d.reservation_id === session.reservation_id))
        .reduce((s, d) => s + Number(d.amount), 0);
      const productTotal = Number(ot?.product_total || 0);
      live = {
        roomTotal: ch.roomTotal,
        productTotal,
        total: ch.roomTotal + productTotal,
        deposit: dep,
        balance: Math.max(0, ch.roomTotal + productTotal - dep),
        itemCount: Number(ot?.item_count || 0),
        orderId: ot?.order_id || session.order_id,
        scheduledMinutes: ch.scheduledMinutes,
        overtimeMinutes: ch.overtimeMinutes,
      };
    }
    return { ...room, status: deriveRoomStatus(room, session, nextReservation, settings, now), stored_status: room.status, session, live, nextReservation };
  });
}

/** Persist derived status (called by the scheduler and after every room mutation). */
export async function refreshRoomStatuses(settings) {
  const board = await getRoomBoard(settings);
  const changed = [];
  for (const r of board) {
    if (r.status !== r.stored_status) {
      await pool.query('UPDATE rooms SET status = $2, updated_at = now() WHERE id = $1', [r.id, r.status]);
      changed.push(r.id);
    }
  }
  if (changed.length) emitSync(['rooms'], { roomIds: changed });
  return board;
}

// Room time pricing. Single source of truth for POS, Booking website, Customer Display, Receipt and Reports.
import { round2 } from './money.js';

/**
 * Half-hour price = half of the hourly price, always rounded UP to a whole number when there are decimals.
 * 399 → 199.5 → 200
 */
export function halfHourPrice(hourly) {
  const h = Number(hourly) || 0;
  const half = round2(h / 2);
  return Number.isInteger(half) ? half : Math.ceil(half);
}

/** Resolve effective prices for a room (room override → type → auto half price). */
export function resolveRoomPrices(room = {}, type = {}) {
  const priceHour = Number(room.price_hour ?? type.price_hour ?? 0) || Number(type.price_hour) || 0;
  let priceHalf;
  if (room.price_half != null && room.half_price_manual) priceHalf = Number(room.price_half);
  else if (room.price_hour == null && type.price_half != null && type.half_price_manual) priceHalf = Number(type.price_half);
  else priceHalf = halfHourPrice(priceHour);
  return { priceHour, priceHalf };
}

export const PARTIAL_RULES = {
  NONE: 'ไม่คิดเงินเพิ่ม',
  ROUND_UP: 'ปัดขึ้นเป็น 30 นาที',
  PER_MINUTE: 'คิดตามจำนวนนาทีจริง',
  GRACE: 'มี Grace Period',
};

/**
 * Price for a number of minutes.
 * - every full hour = hourly price
 * - every 30 min block = half price (rounded up)
 * - remaining minutes (< 30) follow the partial rule
 */
export function priceForMinutes(minutes, { priceHour, priceHalf, partialRule = 'ROUND_UP', graceMinutes = 0 } = {}) {
  const m = Math.max(0, Math.floor(Number(minutes) || 0));
  const ph = Number(priceHour) || 0;
  const half = priceHalf != null ? Number(priceHalf) : halfHourPrice(ph);
  const hours = Math.floor(m / 60);
  let rest = m - hours * 60;
  let halves = 0;
  if (rest >= 30) {
    halves = 1;
    rest -= 30;
  }
  let partialCharge = 0;
  let partialNote = '';
  if (rest > 0) {
    switch (partialRule) {
      case 'NONE':
        partialNote = `เศษ ${rest} นาที ไม่คิดเงิน`;
        break;
      case 'PER_MINUTE':
        partialCharge = Math.ceil(round2((ph / 60) * rest));
        partialNote = `เศษ ${rest} นาที × ${round2(ph / 60)} = ${partialCharge}`;
        break;
      case 'GRACE':
        if (rest <= Number(graceMinutes || 0)) partialNote = `เศษ ${rest} นาที อยู่ใน Grace Period ${graceMinutes} นาที`;
        else {
          partialCharge = half;
          partialNote = `เศษ ${rest} นาที เกิน Grace Period คิดเป็น 30 นาที`;
        }
        break;
      case 'ROUND_UP':
      default:
        partialCharge = half;
        partialNote = `เศษ ${rest} นาที ปัดขึ้นเป็น 30 นาที`;
    }
  }
  const amount = round2(hours * ph + halves * half + partialCharge);
  const parts = [];
  if (hours) parts.push(`${hours} ชม. × ${ph} = ${round2(hours * ph)}`);
  if (halves) parts.push(`30 นาที = ${half}`);
  if (partialNote) parts.push(partialNote);
  return { minutes: m, hours, halves, partialMinutes: rest, partialCharge, amount, breakdown: parts.join(' + ') || '0' };
}

/** Minutes (+ partial) expressed as sold units: hours and 30-minute blocks. */
export function soldUnits(minutes) {
  const m = Math.max(0, Math.floor(minutes || 0));
  return { hours: round2(m / 60), halfHourBlocks: Math.ceil(m / 30) };
}

/**
 * Time accounting of a room session (server-authoritative fields).
 * session: { started_at, scheduled_end_at, paused_at, total_paused_seconds, ended_at, status }
 */
export function sessionTiming(session, nowMs = Date.now()) {
  const start = new Date(session.started_at).getTime();
  const scheduledEnd = new Date(session.scheduled_end_at).getTime();
  const pausedSec = Number(session.total_paused_seconds || 0);
  let effectiveNow = nowMs;
  if (session.ended_at) effectiveNow = new Date(session.ended_at).getTime();
  else if (session.paused_at) effectiveNow = new Date(session.paused_at).getTime();
  const usedMs = Math.max(0, effectiveNow - start - pausedSec * 1000);
  // While paused the end time is pushed forward by the current pause duration
  let endMs = scheduledEnd;
  if (session.paused_at && !session.ended_at) endMs = scheduledEnd + (nowMs - new Date(session.paused_at).getTime());
  const remainingMs = endMs - (session.ended_at ? new Date(session.ended_at).getTime() : nowMs);
  return {
    startMs: start,
    endMs,
    usedMs,
    usedMinutes: Math.floor(usedMs / 60000),
    remainingMs,
    isPaused: !!session.paused_at && !session.ended_at,
    isOver: remainingMs <= 0,
  };
}

/**
 * Compute the room charge lines of a session.
 * session needs: package_id, package_name, package_minutes, package_price, booked_minutes, extension_minutes,
 * price_hour, price_half, guest_count, room_capacity, extra_guest_fee + timing fields.
 */
export function computeSessionCharges(session, settings = {}, nowMs = Date.now()) {
  const timing = sessionTiming(session, nowMs);
  const rule = settings.partialRule || 'ROUND_UP';
  const grace = Number(settings.graceMinutes || 0);
  const prices = { priceHour: Number(session.price_hour), priceHalf: Number(session.price_half), partialRule: rule, graceMinutes: grace };
  const pkgMin = Number(session.package_minutes || 0);
  const booked = Number(session.booked_minutes || 0);
  const ext = Number(session.extension_minutes || 0);
  const scheduled = pkgMin + booked + ext;
  const overtime = Math.max(0, timing.usedMinutes - scheduled);
  const lines = [];

  if (session.package_id || pkgMin > 0) {
    lines.push({
      type: 'PACKAGE',
      name: `แพ็กเกจ ${session.package_name || ''}`.trim(),
      qty: 1,
      unitPrice: round2(session.package_price || 0),
      minutes: pkgMin,
      detail: `แพ็กเกจ ${formatMinutesShort(pkgMin)}`,
    });
  }
  const pBooked = priceForMinutes(booked, prices);
  if (booked > 0) {
    lines.push({ type: 'ROOM', name: `ค่าห้อง ${formatMinutesShort(booked)}`, qty: 1, unitPrice: pBooked.amount, minutes: booked, detail: pBooked.breakdown });
  }
  if (ext > 0) {
    const pBoth = priceForMinutes(booked + ext, prices);
    const amount = round2(pBoth.amount - pBooked.amount);
    lines.push({ type: 'EXTENSION', name: `เวลาเพิ่มเติม ${formatMinutesShort(ext)}`, qty: 1, unitPrice: amount, minutes: ext, detail: `(${pBoth.breakdown}) − ค่าห้องเดิม ${pBooked.amount}` });
  }
  if (overtime > 0) {
    const base = priceForMinutes(booked + ext, prices);
    const all = priceForMinutes(booked + ext + overtime, prices);
    const amount = round2(all.amount - base.amount);
    lines.push({ type: 'OVERTIME', name: `เวลาเกิน ${formatMinutesShort(overtime)}`, qty: 1, unitPrice: amount, minutes: overtime, detail: `${PARTIAL_RULES[rule] || rule}: ${all.breakdown}` });
  }
  const capacity = Number(session.room_capacity || 0);
  const guests = Number(session.guest_count || 0);
  const fee = Number(session.extra_guest_fee ?? settings.extraGuestFee ?? 50);
  const extra = capacity > 0 ? Math.max(0, guests - capacity) : 0;
  if (extra > 0 && fee > 0) {
    lines.push({ type: 'EXTRA_GUEST', name: `ค่าลูกค้าเกินจำนวน ${extra} คน`, qty: extra, unitPrice: fee, detail: `ห้องรองรับ ${capacity} คน ลูกค้า ${guests} คน เกิน ${extra} × ${fee} = ${extra * fee}` });
  }
  const totalMinutes = Math.max(scheduled, timing.usedMinutes);
  const roomTotal = round2(lines.reduce((s, l) => s + l.qty * l.unitPrice, 0));
  return { lines, timing, scheduledMinutes: scheduled, overtimeMinutes: overtime, billedMinutes: totalMinutes, extraGuests: extra, roomTotal };
}

export function formatMinutesShort(min) {
  const m = Math.max(0, Math.round(min || 0));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h && r) return `${h} ชม. ${r} นาที`;
  if (h) return `${h} ชม.`;
  return `${r} นาที`;
}

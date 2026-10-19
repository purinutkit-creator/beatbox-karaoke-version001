// POS → Customer Display realtime state (paired by connection code).
import { api, LS } from './api.js';
import { getSocket } from './socket.js';

let code = LS.get('bb_display_code');
let last = null;

export async function ensurePairCode(regenerate = false) {
  const deviceId = LS.get('bb_device_id');
  if (!deviceId) return null;
  const r = await api.post('/displays/pair', { deviceId, regenerate });
  code = r.pair_code;
  LS.set('bb_display_code', code);
  return r;
}

export function getPairCode() {
  return code;
}

// A screen the customer needs time with (their room and the QR to the way there) is "held": it stays until staff
// press "เสร็จสิ้น" (releaseDisplay). Automatic returns to idle are ignored meanwhile; anything else pushed for the next
// customer (a cart, a payment …) replaces it.
let held = null;
const holdListeners = new Set();
const setHeld = (v) => {
  held = v;
  holdListeners.forEach((f) => f(held));
};
/** Keep the current room screen on the customer display until releaseDisplay(); label = what the POS bar shows. */
export function holdDisplay(label) {
  setHeld(label || true);
}
/** "เสร็จสิ้น": back to the normal (promotion) screen. */
export function releaseDisplay() {
  if (!held) return;
  setHeld(null);
  idleDisplay({ force: true });
}
export function onDisplayHold(fn) {
  holdListeners.add(fn);
  fn(held);
  return () => holdListeners.delete(fn);
}

/** opts.passive: a background refresh (e.g. a room's bill reloading) that must not replace a held room screen. */
export function pushDisplay(state, { passive = false } = {}) {
  if (held && passive) return;
  const roomScreen = state.mode === 'ROOM_READY' || (state.mode === 'SUCCESS' && state.room);
  if (held && !roomScreen && !(state.mode === 'IDLE' && state.force)) setHeld(null);
  last = { ...state, at: Date.now() };
  const s = getSocket();
  if (!code) ensurePairCode().then(() => s?.emit('display:state', { code, state: last })).catch(() => {});
  else s?.emit('display:state', { code, state: last });
}

export function idleDisplay({ force = false } = {}) {
  if (held && !force) return; // a held room screen waits for "เสร็จสิ้น"
  pushDisplay({ mode: 'IDLE', force });
}

/**
 * The room of a session for the customer display: picture, type, floor, START → END and the link to the room's
 * guide page (floor plan with the room blinking). Null when it cannot be loaded (the display then shows no room).
 */
export async function roomForDisplay(session) {
  if (!session?.room_id) return null;
  try {
    const c = await api.get(`/floors/room-card/${session.room_id}`, { passive: true });
    const startAt = session.started_at || null;
    const endAt = session.scheduled_end_at || null;
    return {
      name: c.name,
      number: c.number,
      typeName: c.type_name,
      imageUrl: c.image_url,
      floorName: c.floor_name,
      startAt,
      endAt,
      minutes: startAt && endAt ? Math.round((new Date(endAt) - new Date(startAt)) / 60000) : 0,
      guideUrl: c.guide_token ? `${window.location.origin}/guide/${c.guide_token}` : null,
    };
  } catch {
    return null;
  }
}

/** Map a computed order (from /orders/:id) to a display payload. */
export function orderToDisplay(o, extra = {}) {
  if (!o?.calc) return { mode: 'IDLE' };
  const c = o.calc;
  const roomLines = c.lines.filter((l) => ['ROOM', 'PACKAGE', 'EXTENSION', 'OVERTIME', 'EXTRA_GUEST', 'EXTRA_MIC'].includes(l.type));
  return {
    mode: 'CART',
    queueNo: o.order?.queue_no,
    roomName: o.session?.room_name,
    roomType: o.session?.type_name,
    minutes: roomLines.reduce((s, l) => s + Number(l.minutes || 0), 0),
    roomCharge: roomLines.reduce((s, l) => s + l.net, 0),
    items: c.lines.map((l) => ({ name: l.name, qty: l.qty, unitPrice: l.unitPrice, total: l.net, type: l.type })),
    subtotal: c.grossTotal,
    discount: c.discountTotal,
    serviceCharge: c.serviceCharge,
    vat: c.vat,
    total: c.grandTotal,
    deposit: c.depositApplied,
    net: c.netTotal,
    customer: o.member ? `${o.member.first_name}` : o.order?.customer_name,
    points: o.member ? Number(o.member.points_balance) : null,
    ...extra,
  };
}

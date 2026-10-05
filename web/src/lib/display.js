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

export function pushDisplay(state) {
  last = { ...state, at: Date.now() };
  const s = getSocket();
  if (!code) ensurePairCode().then(() => s?.emit('display:state', { code, state: last })).catch(() => {});
  else s?.emit('display:state', { code, state: last });
}

export function idleDisplay() {
  pushDisplay({ mode: 'IDLE' });
}

/** Map a computed order (from /orders/:id) to a display payload. */
export function orderToDisplay(o, extra = {}) {
  if (!o?.calc) return { mode: 'IDLE' };
  const c = o.calc;
  const roomLines = c.lines.filter((l) => ['ROOM', 'PACKAGE', 'EXTENSION', 'OVERTIME', 'EXTRA_GUEST'].includes(l.type));
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

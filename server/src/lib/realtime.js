import { Server } from 'socket.io';
import { authenticateToken } from './auth.js';
import { pool } from '../db/index.js';

let io = null;
const displayPresence = new Map(); // pairCode -> Set(socketId)

export function initRealtime(httpServer, corsOrigins) {
  io = new Server(httpServer, { cors: { origin: corsOrigins?.length ? corsOrigins : true, credentials: true }, pingInterval: 10000, pingTimeout: 8000 });

  io.on('connection', async (socket) => {
    const { token, kind } = socket.handshake.auth || {};
    socket.emit('server:time', { now: Date.now() });

    if (kind === 'staff' && token) {
      const auth = await authenticateToken(token).catch(() => null);
      if (auth && !auth.expired) {
        socket.data.employee = auth.employee;
        socket.join('staff');
      } else {
        socket.emit('auth:expired');
      }
    }
    if (kind === 'public') socket.join('public');

    socket.on('time:sync', (clientTs, ack) => {
      if (typeof ack === 'function') ack({ clientTs, serverTs: Date.now() });
    });

    // ── Customer Display pairing ──
    socket.on('display:join', async ({ code, clientId } = {}, ack) => {
      const c = String(code || '').trim();
      const d = await pool.query('SELECT id, pair_code, last_state FROM customer_displays WHERE pair_code = $1', [c]).catch(() => ({ rows: [] }));
      const display = d.rows[0];
      if (!display) return typeof ack === 'function' && ack({ ok: false, error: 'ไม่พบรหัสเชื่อมต่อ' });
      socket.data.displayCode = c;
      socket.join(`display:${c}`);
      if (!displayPresence.has(c)) displayPresence.set(c, new Set());
      displayPresence.get(c).add(socket.id);
      await pool.query(`UPDATE customer_displays SET status = 'ONLINE', last_seen_at = now() WHERE id = $1`, [display.id]).catch(() => {});
      await pool
        .query(`INSERT INTO display_pairings(display_id, client_id, user_agent, last_seen_at) VALUES ($1,$2,$3,now())`, [display.id, String(clientId || socket.id), socket.handshake.headers['user-agent'] || ''])
        .catch(() => {});
      io.to('staff').emit('display:presence', { code: c, online: true, count: displayPresence.get(c).size });
      if (typeof ack === 'function') ack({ ok: true, state: display.last_state });
    });

    // POS pushes state → server stores & relays to every display paired with the same code
    socket.on('display:state', async ({ code, state } = {}) => {
      if (!socket.data.employee || !code) return;
      const c = String(code);
      io.to(`display:${c}`).emit('display:state', state);
      await pool.query('UPDATE customer_displays SET last_state = $2, last_seen_at = now() WHERE pair_code = $1', [c, state]).catch(() => {});
    });

    // Customer Display → POS: the customer scanned their booking QR or typed their phone on the display
    socket.on('display:checkin', ({ requestId, kind, value } = {}) => {
      const c = socket.data.displayCode;
      if (!c || !value) return;
      io.to('staff').emit('display:checkin', { code: c, requestId: String(requestId || ''), kind: kind === 'PHONE' ? 'PHONE' : 'SCAN', value: String(value).slice(0, 200) });
    });

    socket.on('display:watch', ({ code } = {}, ack) => {
      if (!socket.data.employee) return;
      const c = String(code || '');
      if (typeof ack === 'function') ack({ online: (displayPresence.get(c)?.size || 0) > 0 });
    });

    socket.on('disconnect', async () => {
      const c = socket.data.displayCode;
      if (c && displayPresence.has(c)) {
        displayPresence.get(c).delete(socket.id);
        const online = displayPresence.get(c).size > 0;
        if (!online) {
          await pool.query(`UPDATE customer_displays SET status = 'OFFLINE' WHERE pair_code = $1`, [c]).catch(() => {});
          setTimeout(async () => {
            if ((displayPresence.get(c)?.size || 0) === 0) {
              const { notify } = await import('../services/notifications.js');
              notify({ type: 'DISPLAY_OFFLINE', level: 'warning', title: 'Customer Display Offline', message: `หน้าจอลูกค้า (รหัส ${c}) ขาดการเชื่อมต่อ`, dedupeKey: `display-offline:${c}:${Math.floor(Date.now() / 600000)}` }).catch(() => {});
            }
          }, 15000);
        }
        io.to('staff').emit('display:presence', { code: c, online, count: displayPresence.get(c).size });
      }
    });
  });
  return io;
}

/** Tell every connected client that data changed (clients refetch). */
export function emitSync(topics, payload = {}) {
  if (!io) return;
  const list = Array.isArray(topics) ? topics : [topics];
  io.to('staff').emit('sync', { topics: list, ...payload, at: Date.now() });
  if (list.some((t) => ['rooms', 'reservations', 'availability'].includes(t))) io.to('public').emit('availability:changed', { at: Date.now() });
}

export function emitStaff(event, payload) {
  if (io) io.to('staff').emit(event, payload);
}

export function emitDisplay(code, state) {
  if (io && code) io.to(`display:${code}`).emit('display:state', state);
}

export function displayOnline(code) {
  return (displayPresence.get(String(code))?.size || 0) > 0;
}

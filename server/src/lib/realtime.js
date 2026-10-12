import { Server } from 'socket.io';
import { authenticateToken, verifyToken } from './auth.js';
import { pool, runWithStore, runAsPlatform, currentStoreId } from '../db/index.js';
import { defaultStoreId, resolveStoreRef } from './tenant.js';

let io = null;
const displayPresence = new Map(); // pairCode -> Set(socketId)

export function initRealtime(httpServer, corsOrigins) {
  io = new Server(httpServer, { cors: { origin: corsOrigins?.length ? corsOrigins : true, credentials: true }, pingInterval: 10000, pingTimeout: 8000 });

  io.on('connection', async (socket) => {
    const { token, kind, store } = socket.handshake.auth || {};
    socket.emit('server:time', { now: Date.now() });
    // every socket belongs to one store; all its events run in that store's context
    const p = token ? verifyToken(token) : null;
    socket.data.storeId = (p?.typ === 'employee' && Number(p.st)) || (store && (await resolveStoreRef(store).catch(() => null))) || (await defaultStoreId());
    const inStore = (fn) => (...args) => runWithStore(socket.data.storeId, () => fn(...args));

    if (kind === 'staff' && token) {
      const auth = await runWithStore(socket.data.storeId, () => authenticateToken(token)).catch(() => null);
      if (auth && !auth.expired) {
        socket.data.employee = auth.employee;
        socket.join(`staff:${socket.data.storeId}`);
      } else {
        socket.emit('auth:expired');
      }
    }
    if (kind === 'public') socket.join(`public:${socket.data.storeId}`);

    socket.on('time:sync', (clientTs, ack) => {
      if (typeof ack === 'function') ack({ clientTs, serverTs: Date.now() });
    });

    // ── Customer Display pairing ──
    socket.on('display:join', async ({ code, clientId } = {}, ack) => {
      const c = String(code || '').trim();
      // pair codes are unique across stores: the code decides the store of this display
      const d = await runAsPlatform(() => pool.query('SELECT id, pair_code, last_state, store_id FROM customer_displays WHERE pair_code = $1', [c])).catch(() => ({ rows: [] }));
      const display = d.rows[0];
      if (!display) return typeof ack === 'function' && ack({ ok: false, error: 'ไม่พบรหัสเชื่อมต่อ' });
      socket.data.storeId = display.store_id;
      await runWithStore(display.store_id, () => joinDisplay(socket, c, display, clientId));
      if (typeof ack === 'function') ack({ ok: true, state: display.last_state });
    });

    async function joinDisplay(socket, c, display, clientId) {
      socket.data.displayCode = c;
      socket.join(`display:${c}`);
      if (!displayPresence.has(c)) displayPresence.set(c, new Set());
      displayPresence.get(c).add(socket.id);
      await pool.query(`UPDATE customer_displays SET status = 'ONLINE', last_seen_at = now() WHERE id = $1`, [display.id]).catch(() => {});
      await pool
        .query(`INSERT INTO display_pairings(display_id, client_id, user_agent, last_seen_at) VALUES ($1,$2,$3,now())`, [display.id, String(clientId || socket.id), socket.handshake.headers['user-agent'] || ''])
        .catch(() => {});
      io.to(`staff:${display.store_id}`).emit('display:presence', { code: c, online: true, count: displayPresence.get(c).size });
    }

    // POS pushes state → server stores & relays to every display paired with the same code
    socket.on('display:state', inStore(async ({ code, state } = {}) => {
      if (!socket.data.employee || !code) return;
      const c = String(code);
      // only displays of this store (row-level security hides other stores' codes)
      const own = await pool.query('UPDATE customer_displays SET last_state = $2, last_seen_at = now() WHERE pair_code = $1 RETURNING id', [c, state]).catch(() => ({ rows: [] }));
      if (own.rows[0]) io.to(`display:${c}`).emit('display:state', state);
    }));

    // Customer Display → POS: the customer scanned their booking QR or typed their phone on the display
    socket.on('display:checkin', ({ requestId, kind, value } = {}) => {
      const c = socket.data.displayCode;
      if (!c || !value) return;
      io.to(`staff:${socket.data.storeId}`).emit('display:checkin', { code: c, requestId: String(requestId || ''), kind: kind === 'PHONE' ? 'PHONE' : 'SCAN', value: String(value).slice(0, 200) });
    });

    socket.on('display:watch', ({ code } = {}, ack) => {
      if (!socket.data.employee) return;
      const c = String(code || '');
      if (typeof ack === 'function') ack({ online: (displayPresence.get(c)?.size || 0) > 0 });
    });

    socket.on('disconnect', inStore(async () => {
      const c = socket.data.displayCode;
      if (c && displayPresence.has(c)) {
        displayPresence.get(c).delete(socket.id);
        const online = displayPresence.get(c).size > 0;
        if (!online) {
          await pool.query(`UPDATE customer_displays SET status = 'OFFLINE' WHERE pair_code = $1`, [c]).catch(() => {});
          const sid = socket.data.storeId;
          setTimeout(() => runWithStore(sid, async () => {
            if ((displayPresence.get(c)?.size || 0) === 0) {
              const { notify } = await import('../services/notifications.js');
              notify({ type: 'DISPLAY_OFFLINE', level: 'warning', title: 'Customer Display Offline', message: `หน้าจอลูกค้า (รหัส ${c}) ขาดการเชื่อมต่อ`, dedupeKey: `display-offline:${c}:${Math.floor(Date.now() / 600000)}` }).catch(() => {});
            }
          }), 15000);
        }
        io.to(`staff:${socket.data.storeId}`).emit('display:presence', { code: c, online, count: displayPresence.get(c).size });
      }
    }));
  });
  return io;
}

/** Tell every connected client of the current store that data changed (clients refetch). */
export function emitSync(topics, payload = {}, storeId = currentStoreId()) {
  if (!io || !storeId) return;
  const list = Array.isArray(topics) ? topics : [topics];
  io.to(`staff:${storeId}`).emit('sync', { topics: list, ...payload, at: Date.now() });
  if (list.some((t) => ['rooms', 'reservations', 'availability'].includes(t))) io.to(`public:${storeId}`).emit('availability:changed', { at: Date.now() });
}

export function emitStaff(event, payload, storeId = currentStoreId()) {
  if (io && storeId) io.to(`staff:${storeId}`).emit(event, payload);
}

export function emitDisplay(code, state) {
  if (io && code) io.to(`display:${code}`).emit('display:state', state);
}

export function displayOnline(code) {
  return (displayPresence.get(String(code))?.size || 0) > 0;
}

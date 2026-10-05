// Realtime layer: Socket.IO + server clock offset (countdowns always use SERVER time, never the device clock).
import { io } from 'socket.io-client';
import { useEffect, useRef, useState, useCallback } from 'react';
import { LS } from './api.js';

let socket = null;
let offset = 0;
const syncHandlers = new Set();

export function serverNow() {
  return Date.now() + offset;
}

function syncClock() {
  if (!socket?.connected) return;
  const t0 = Date.now();
  socket.timeout(5000).emit('time:sync', t0, (err, res) => {
    if (err || !res) return;
    const t1 = Date.now();
    offset = res.serverTs - (t0 + t1) / 2;
  });
}

export function connectSocket(kind = 'staff') {
  if (socket) {
    if (socket.auth?.kind === kind && socket.auth?.token === (kind === 'staff' ? LS.get('bb_token') : null)) return socket;
    socket.disconnect();
  }
  socket = io({ path: '/socket.io', auth: { kind, token: kind === 'staff' ? LS.get('bb_token') : null }, transports: ['websocket', 'polling'] });
  socket.on('connect', syncClock);
  socket.on('server:time', ({ now }) => (offset = now - Date.now()));
  socket.on('sync', (msg) => syncHandlers.forEach((h) => h(msg)));
  setInterval(syncClock, 60000);
  return socket;
}

export function getSocket() {
  return socket;
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
}

/** Subscribe to server "sync" topics. */
export function useSync(topics, handler) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const h = (msg) => {
      if (!topics || msg.topics.some((t) => topics.includes(t))) ref.current(msg);
    };
    syncHandlers.add(h);
    return () => syncHandlers.delete(h);
  }, [topics?.join(',')]);
}

export function useSocketEvent(event, handler) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const s = socket;
    if (!s) return;
    const h = (p) => ref.current(p);
    s.on(event, h);
    return () => s.off(event, h);
  }, [event, socket]);
}

/** Ticking server clock (ms). */
export function useServerNow(interval = 1000) {
  const [now, setNow] = useState(serverNow());
  useEffect(() => {
    const id = setInterval(() => setNow(serverNow()), interval);
    return () => clearInterval(id);
  }, [interval]);
  return now;
}

/** Fetch + auto refetch on realtime topics (+ optional polling fallback). */
export function useLive(fetcher, topics = [], deps = [], { poll = 0 } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const fn = useRef(fetcher);
  fn.current = fetcher;
  const reload = useCallback(async () => {
    try {
      const d = await fn.current();
      setData(d);
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    setLoading(true);
    reload();
  }, deps);
  useSync(topics, () => reload());
  useEffect(() => {
    if (!poll) return;
    const id = setInterval(reload, poll);
    return () => clearInterval(id);
  }, [poll]);
  return { data, error, loading, reload, setData };
}

// API client: auth headers, device id, idempotency keys and an offline queue for allowed operations.
import { translate, translatePhrase } from './i18n.jsx';

const LS = {
  get: (k, d = null) => {
    try {
      const v = localStorage.getItem(k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set: (k, v) => {
    try {
      if (v == null) localStorage.removeItem(k);
      else localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* storage unavailable */
    }
  },
};
export { LS };

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

export function getDeviceKey() {
  let k = LS.get('bb_device_key');
  if (!k) {
    k = `dev-${uid()}`;
    LS.set('bb_device_key', k);
  }
  return k;
}

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.code = data?.code;
    this.data = data;
  }
}

const QUEUE_KEY = 'bb_offline_queue';
const listeners = new Set();
export const offlineQueue = {
  list: () => LS.get(QUEUE_KEY, []),
  size: () => LS.get(QUEUE_KEY, []).length,
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  push(op) {
    const q = LS.get(QUEUE_KEY, []);
    q.push(op);
    LS.set(QUEUE_KEY, q);
    listeners.forEach((f) => f(q.length));
  },
  async flush() {
    const q = LS.get(QUEUE_KEY, []);
    if (!q.length || !navigator.onLine) return 0;
    const rest = [];
    let done = 0;
    for (const op of q) {
      try {
        await request(op.method, op.url, op.body, { idempotencyKey: op.key, noQueue: true });
        done++;
      } catch (e) {
        // network still down → keep; business error → drop (it was rejected by the server, never applied twice)
        if (e.status === 0) rest.push(op);
      }
    }
    LS.set(QUEUE_KEY, rest);
    listeners.forEach((f) => f(rest.length));
    return done;
  },
};
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => offlineQueue.flush());
  setInterval(() => offlineQueue.flush(), 15000);
}

export async function request(method, url, body, opts = {}) {
  const headers = {};
  // queueable operations always carry an idempotency key so a retry/offline sync can never apply twice
  if (opts.queueable && !opts.idempotencyKey) opts = { ...opts, idempotencyKey: uid() };
  const token = opts.member ? LS.get('bb_member_token') : LS.get('bb_token');
  if (token && opts.auth !== false) headers.Authorization = `Bearer ${token}`;
  const deviceId = LS.get('bb_device_id');
  if (deviceId) headers['X-Device-Id'] = String(deviceId);
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  if (opts.passive) headers['X-Passive'] = '1';
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url.startsWith('http') ? url : `/api${url}`, { method, headers, body: payload });
  } catch {
    if (opts.queueable && !opts.noQueue) {
      const key = opts.idempotencyKey || uid();
      offlineQueue.push({ method, url, body, key, at: Date.now(), label: opts.queueLabel || url });
      return { queued: true };
    }
    throw new ApiError(translate('ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ (Offline)'), 0, { code: 'OFFLINE' });
  }
  if (opts.raw) return res;
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok) {
    if (res.status === 401 && !opts.member && opts.auth !== false) window.dispatchEvent(new CustomEvent('bb:unauthorized', { detail: data?.error }));
    throw new ApiError(translatePhrase(data?.error || `Error ${res.status}`), res.status, data);
  }
  return data;
}

export const api = {
  get: (u, o) => request('GET', u, undefined, o),
  post: (u, b, o) => request('POST', u, b ?? {}, o),
  put: (u, b, o) => request('PUT', u, b ?? {}, o),
  patch: (u, b, o) => request('PATCH', u, b ?? {}, o),
  del: (u, b, o) => request('DELETE', u, b, o),
};

export async function download(url, filename) {
  const res = await request('GET', url, undefined, { raw: true });
  if (!res.ok) throw new ApiError(translate('ดาวน์โหลดไม่สำเร็จ'), res.status);
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

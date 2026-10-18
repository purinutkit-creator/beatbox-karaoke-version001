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

/**
 * Which store (tenant) this browser talks to when no staff token says it:
 *  - a public link may carry ?store=<slug> (booking site, member signup QR) → remembered for this tab
 *  - a POS device remembers the store it was set up for (bb_store)
 * Staff / member tokens always carry their own store on the server side, so this is only a hint for public pages.
 */
export function storeRef() {
  try {
    const q = new URLSearchParams(window.location.search).get('store');
    if (q) {
      sessionStorage.setItem('bb_store_q', q);
      return q;
    }
    return sessionStorage.getItem('bb_store_q') || LS.get('bb_store') || '';
  } catch {
    return LS.get('bb_store') || '';
  }
}
export function setDeviceStore(store) {
  if (!store) return;
  const prev = LS.get('bb_store_id');
  // device registrations (bb_device_id) belong to one store → forget them when this device moves to another store
  if (prev && Number(prev) !== Number(store.id)) {
    ['bb_device_id', 'bb_device'].forEach((k) => LS.set(k, null));
  }
  LS.set('bb_store_id', store.id);
  LS.set('bb_store', store.slug);
  try {
    sessionStorage.removeItem('bb_store_q');
  } catch {
    /* ignore */
  }
}

/**
 * Store sign-in of this device (store code + store account). Staff PIN logins only work with it.
 * bb_store_session = signed token, bb_store_login = { id, code, slug, name, logoUrl } for the PIN screen.
 */
export const storeSession = {
  get: () => LS.get('bb_store_session'),
  info: () => LS.get('bb_store_login'),
  set(token, store) {
    LS.set('bb_store_session', token);
    LS.set('bb_store_login', store);
    setDeviceStore(store);
  },
  clear() {
    LS.set('bb_store_session', null);
    LS.set('bb_store_login', null);
  },
};

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

function authHeaders(opts) {
  const headers = {};
  const token = opts.member ? LS.get('bb_member_token') : LS.get('bb_token');
  if (token && opts.auth !== false) headers.Authorization = `Bearer ${token}`;
  if (opts.platform) {
    const pt = LS.get('bb_platform_token');
    if (pt) headers.Authorization = `Bearer ${pt}`;
  }
  const ref = opts.store || storeRef();
  if (ref) headers['X-Store'] = String(ref);
  const deviceId = LS.get('bb_device_id');
  if (deviceId && !opts.platform) headers['X-Device-Id'] = String(deviceId);
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  if (opts.storeSession && storeSession.get()) headers['X-Store-Session'] = storeSession.get();
  if (opts.passive) headers['X-Passive'] = '1';
  return headers;
}

export async function request(method, url, body, opts = {}) {
  // queueable operations always carry an idempotency key so a retry/offline sync can never apply twice
  if (opts.queueable && !opts.idempotencyKey) opts = { ...opts, idempotencyKey: uid() };
  const headers = authHeaders(opts);
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
    if (res.status === 401 && opts.platform) window.dispatchEvent(new CustomEvent('bb:platform-unauthorized'));
    else if (res.status === 401 && !opts.member && opts.auth !== false) window.dispatchEvent(new CustomEvent('bb:unauthorized', { detail: data?.error }));
    // the store's package expired / was suspended → every open screen switches to the "package expired" page
    if (res.status === 402 && data?.code === 'SUBSCRIPTION_EXPIRED') window.dispatchEvent(new CustomEvent('bb:subscription-expired', { detail: data }));
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

/** POST a file (FormData) and report the upload progress (0–1) — for large files such as videos. */
export function upload(url, form, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api${url}`);
    for (const [k, v] of Object.entries(authHeaders({}))) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onerror = () => reject(new ApiError(translate('ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ (Offline)'), 0, { code: 'OFFLINE' }));
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* not json */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(translatePhrase(data?.error || (xhr.status === 413 ? 'ไฟล์ใหญ่เกินไป' : `Error ${xhr.status}`)), xhr.status, data));
    };
    xhr.send(form);
  });
}

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

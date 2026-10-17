// Tuya Cloud (IoT Core OpenAPI) client: smart plugs / switches / lights that the store links to its rooms.
// Credentials come from the store's integration settings (Access ID + Access Secret of a Tuya cloud project).
// Request signing follows Tuya's HMAC-SHA256 scheme (as Tuya's own connectors do): client_id [+ access_token] + t + stringToSign,
// stringToSign = METHOD \n SHA256(body) \n (no signed headers) \n path?sorted-query.
import crypto from 'node:crypto';
import { getIntegrations } from '../services/integrations.js';
import { currentStoreId } from '../db/index.js';

export const TUYA_REGIONS = [
  { value: 'https://openapi.tuyaus.com', label: 'Western America (US) — แอป Smart Life / Tuya ในไทยส่วนใหญ่' },
  { value: 'https://openapi-sg.iotbing.com', label: 'Singapore' },
  { value: 'https://openapi.tuyaeu.com', label: 'Central Europe' },
  { value: 'https://openapi-weaz.tuyaeu.com', label: 'Western Europe' },
  { value: 'https://openapi-ueaz.tuyaus.com', label: 'Eastern America' },
  { value: 'https://openapi.tuyain.com', label: 'India' },
  { value: 'https://openapi.tuyacn.com', label: 'China' },
];

const tokens = new Map(); // store → { key, token, expiresAt }

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (s, secret) => crypto.createHmac('sha256', secret).update(s).digest('hex').toUpperCase();

/** Path + query with sorted parameters, exactly as Tuya signs it. */
function signedUrl(path, query) {
  const keys = Object.keys(query || {}).filter((k) => query[k] !== undefined && query[k] !== null).sort();
  return keys.length ? `${path}?${keys.map((k) => `${k}=${query[k]}`).join('&')}` : path;
}

function headersFor(cfg, method, url, body, accessToken = '') {
  const t = String(Date.now());
  const stringToSign = [method, sha256(body || ''), '', url].join('\n');
  const sign = hmac(cfg.accessId + accessToken + t + stringToSign, cfg.accessSecret);
  return { client_id: cfg.accessId, sign, t, sign_method: 'HMAC-SHA256', ...(accessToken ? { access_token: accessToken } : {}), 'Content-Type': 'application/json' };
}

async function call(cfg, method, url, bodyObj, accessToken) {
  const body = bodyObj ? JSON.stringify(bodyObj) : '';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(cfg.endpoint.replace(/\/+$/, '') + url, { method, headers: headersFor(cfg, method, url, body, accessToken), body: body || undefined, signal: ctrl.signal });
    const json = await res.json().catch(() => ({}));
    if (!json.success) {
      const err = new Error(tuyaMessage(json));
      err.code = json.code;
      throw err;
    }
    return json.result;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Tuya ไม่ตอบกลับภายใน 10 วินาที');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Human message for common Tuya errors. */
function tuyaMessage(json) {
  const m = {
    1004: 'Access Secret ไม่ถูกต้อง (sign invalid)',
    1010: 'token หมดอายุ',
    1011: 'token ไม่ถูกต้อง',
    1106: 'ไม่มีสิทธิ์ใช้อุปกรณ์นี้ — ตรวจสอบว่าเชื่อมบัญชีแอป Smart Life/Tuya กับ Cloud Project แล้ว',
    2009: 'Access ID ไม่ถูกต้อง หรือเลือก Data Center ไม่ตรงกับโปรเจกต์',
    2017: 'ไม่พบอุปกรณ์ (Device ID ไม่ถูกต้อง)',
    28841105: 'ยังไม่ได้เปิดสิทธิ์ API ของโปรเจกต์ (IoT Core) ใน Tuya Developer',
    28841002: 'ยังไม่ได้เปิดสิทธิ์ API ของโปรเจกต์ (IoT Core) ใน Tuya Developer',
  }[json.code];
  return `Tuya: ${m || json.msg || 'เชื่อมต่อไม่สำเร็จ'}${json.code ? ` (code ${json.code})` : ''}`;
}

export async function tuyaConfig() {
  const cfg = (await getIntegrations()).tuya || {};
  return { enabled: !!cfg.enabled, endpoint: cfg.endpoint || TUYA_REGIONS[0].value, accessId: cfg.accessId || '', accessSecret: cfg.accessSecret || '' };
}

async function token(cfg, force = false) {
  const key = `${currentStoreId() || 0}`;
  const cacheKey = `${cfg.endpoint}|${cfg.accessId}|${sha256(cfg.accessSecret)}`;
  const hit = tokens.get(key);
  if (!force && hit && hit.key === cacheKey && hit.expiresAt > Date.now() + 60000) return hit.token;
  const r = await call(cfg, 'GET', signedUrl('/v1.0/token', { grant_type: 1 }));
  tokens.set(key, { key: cacheKey, token: r.access_token, expiresAt: Date.now() + Number(r.expire_time || 3600) * 1000 });
  return r.access_token;
}

/** Signed business request; refreshes the token once when it expired. */
async function request(method, path, { query, body, cfg } = {}) {
  const c = cfg || (await tuyaConfig());
  if (!c.accessId || !c.accessSecret) throw new Error('ยังไม่ได้ตั้งค่า Tuya Access ID / Access Secret');
  const url = signedUrl(path, query);
  try {
    return await call(c, method, url, body, await token(c));
  } catch (e) {
    if ([1010, 1011].includes(e.code)) return call(c, method, url, body, await token(c, true));
    throw e;
  }
}

/**
 * Connection test: gets a token with the given values (what is typed on the screen, falling back to the saved ones).
 * "sign invalid" can mean a wrong secret OR a project in another data center → the other data centers are tried too.
 */
export async function tuyaTest(override = {}) {
  const saved = await tuyaConfig();
  const cfg = {
    endpoint: override.endpoint || saved.endpoint,
    accessId: (override.accessId ?? saved.accessId ?? '').trim(),
    accessSecret: (override.accessSecret || saved.accessSecret || '').trim(),
  };
  if (!cfg.accessId || !cfg.accessSecret) return { ok: false, message: 'กรุณากรอก Access ID และ Access Secret' };
  try {
    await token(cfg, true);
    return { ok: true, message: 'เชื่อมต่อ Tuya Cloud สำเร็จ', endpoint: cfg.endpoint };
  } catch (e) {
    if (![1004, 1005, 2009].includes(e.code)) return { ok: false, message: e.message };
    for (const r of TUYA_REGIONS.filter((x) => x.value !== cfg.endpoint)) {
      try {
        await call({ ...cfg, endpoint: r.value }, 'GET', signedUrl('/v1.0/token', { grant_type: 1 }));
        return { ok: false, message: `Access ID / Secret ถูกต้อง แต่โปรเจกต์อยู่ Data Center อื่น — เลือก "${r.label}" แล้วกดบันทึก`, suggestEndpoint: r.value };
      } catch {
        /* try the next data center */
      }
    }
    return {
      ok: false,
      message: `${e.message} — ตรวจสอบว่าคัดลอก Access Secret / Client Secret ครบทั้ง ${cfg.accessSecret.length === 32 ? '32' : `32 ตัว (ตอนนี้ ${cfg.accessSecret.length} ตัว)`} จากหน้า Overview ของ Cloud Project (ไม่ใช่รหัสผ่านบัญชี Tuya) และ Access ID ตรงกับโปรเจกต์เดียวกัน`,
    };
  }
}

/** Send data-point commands to one device, e.g. [{ code: 'switch_1', value: false }]. */
export async function tuyaSend(deviceId, commands) {
  return request('POST', `/v1.0/iot-03/devices/${encodeURIComponent(deviceId)}/commands`, { body: { commands } });
}

export async function tuyaStatus(deviceId) {
  return request('GET', `/v1.0/iot-03/devices/${encodeURIComponent(deviceId)}/status`);
}

/** Devices of the app accounts linked to the cloud project (for picking a device instead of typing its ID). */
export async function tuyaDevices() {
  const out = [];
  let lastRowKey;
  for (let page = 0; page < 10; page++) {
    const r = await request('GET', '/v1.0/iot-01/associated-users/devices', { query: { size: 100, last_row_key: lastRowKey } });
    for (const d of r?.devices || []) out.push({ id: d.id, name: d.name, category: d.category, online: d.online, product: d.product_name });
    if (!r?.has_more || !r?.last_row_key) break;
    lastRowKey = r.last_row_key;
  }
  return out;
}

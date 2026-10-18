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

// ── sending commands: normal Wi-Fi devices (data points) and devices behind an IR remote hub ──
const resolved = new Map(); // "store:device" → { kind: 'dp', switchCode } | { kind: 'ir', hub, remote, categoryId, remoteIndex, keys }
const SWITCH_CODES = ['switch_1', 'switch', 'switch_led', 'switch_on', 'power', 'switch_2', 'switch_3', 'switch_4'];
const IR_HUB_CATEGORIES = ['wnykq', 'hwktwkq', 'qt'];
const cacheKey = (deviceId) => `${currentStoreId() || 0}:${deviceId}`;

/** Data points (functions) a device accepts: [{ code, type, values, name }]. */
export async function tuyaFunctions(deviceId) {
  const r = await request('GET', `/v1.0/iot-03/devices/${encodeURIComponent(deviceId)}/functions`);
  return { category: r?.category || null, functions: r?.functions || [] };
}

/** Is this device a remote paired with an IR hub? → { hub, remote, categoryId, remoteIndex, name } */
async function findIrRemote(deviceId) {
  const devices = await tuyaDevices().catch(() => []);
  const hubs = devices.filter((d) => IR_HUB_CATEGORIES.includes(d.category) && d.id !== deviceId);
  for (const h of hubs) {
    const remotes = await request('GET', `/v2.0/infrareds/${encodeURIComponent(h.id)}/remotes`).catch(() => []);
    const r = (Array.isArray(remotes) ? remotes : remotes?.list || []).find((x) => x.remote_id === deviceId);
    if (r) return { hub: h.id, remote: r.remote_id, categoryId: Number(r.category_id), remoteIndex: r.remote_index, name: r.remote_name };
  }
  return null;
}

async function irKeys(ir) {
  const r = await request('GET', `/v2.0/infrareds/${encodeURIComponent(ir.hub)}/remotes/${encodeURIComponent(ir.remote)}/keys`).catch(() => null);
  return (r?.key_list || []).map((k) => k.key);
}

/** How to talk to a device (looked up once, then cached for 10 minutes). */
async function resolveDevice(deviceId) {
  const k = cacheKey(deviceId);
  const hit = resolved.get(k);
  if (hit && Date.now() - hit.at < 600000) return hit;
  let out = null;
  const fn = await tuyaFunctions(deviceId).catch(() => ({ functions: [] }));
  if (fn.functions.length) {
    const bools = fn.functions.filter((f) => String(f.type).toLowerCase() === 'boolean').map((f) => f.code);
    out = { kind: 'dp', codes: fn.functions.map((f) => f.code), switchCode: SWITCH_CODES.find((c) => bools.includes(c)) || bools[0] || null, category: fn.category };
  } else {
    const ir = await findIrRemote(deviceId);
    if (ir) out = { kind: 'ir', ...ir, keys: ir.categoryId === 5 ? [] : await irKeys(ir) };
  }
  if (out) resolved.set(k, { ...out, at: Date.now() });
  return out;
}

const pickKey = (keys, on) => {
  const want = on === true ? ['PowerOn', 'power_on', 'Power', 'power'] : on === false ? ['PowerOff', 'power_off', 'Power', 'power'] : ['Power', 'power'];
  return want.find((w) => keys.includes(w)) || keys.find((x) => /power/i.test(x)) || null;
};
const TOGGLE = 'toggle';
const lastIrState = new Map(); // remotes without a readable state: remember what we sent last (for toggling PowerOn/PowerOff)

/** Every request to Tuya while running a command is kept (path, body, answer) so the log shows exactly what happened. */
async function traced(trace, method, path, body) {
  try {
    const result = await request(method, path, body ? { body } : {});
    trace.push({ method, path, body: body || null, ok: true, result: result ?? null });
    return result;
  } catch (e) {
    trace.push({ method, path, body: body || null, ok: false, error: e.message, code: e.code ?? null });
    e.trace = trace;
    throw e;
  }
}

async function irAcPower(ir, trace) {
  const st = await traced(trace, 'GET', `/v2.0/infrareds/${encodeURIComponent(ir.hub)}/remotes/${encodeURIComponent(ir.remote)}/ac/status`).catch(() => null);
  return st && st.power != null ? String(st.power) === '1' : null;
}

async function sendIr(ir, commands, trace) {
  for (const c of commands) {
    if (ir.categoryId === 5) {
      // air conditioner: power 1 / 0 (toggle reads the remembered state first), or mode / temp / wind with their numbers
      const isPower = typeof c.value === 'boolean' || c.value === TOGGLE; // on / off / toggle of an air conditioner = its power
      let value = c.value;
      if (c.value === TOGGLE) value = (await irAcPower(ir, trace)) ? 0 : 1;
      else if (typeof c.value === 'boolean') value = c.value ? 1 : 0;
      await traced(trace, 'POST', `/v2.0/infrareds/${encodeURIComponent(ir.hub)}/air-conditioners/${encodeURIComponent(ir.remote)}/command`, { code: isPower ? 'power' : c.code, value });
    } else {
      // fan / TV / other remotes: press a key of the remote
      let key;
      if (typeof c.value === 'string' && c.value !== TOGGLE) key = c.value; // a key typed as the value
      else if (ir.keys.includes(c.code) && c.value !== false && c.value !== TOGGLE) key = c.code; // a key typed as the command
      else if (c.value === TOGGLE) {
        const k = cacheKey(ir.remote);
        key = ir.keys.includes('Power') || ir.keys.includes('power') ? pickKey(ir.keys, null) : pickKey(ir.keys, !lastIrState.get(k));
      } else key = pickKey(ir.keys, c.value);
      if (!key) throw Object.assign(new Error(`Tuya: รีโมตนี้ไม่มีปุ่ม Power (ปุ่มที่มี: ${ir.keys.slice(0, 15).join(', ') || '-'})`), { trace });
      await traced(trace, 'POST', `/v2.0/infrareds/${encodeURIComponent(ir.hub)}/remotes/${encodeURIComponent(ir.remote)}/command`, { category_id: ir.categoryId, remote_index: ir.remoteIndex, key });
      if (/on$/i.test(key)) lastIrState.set(cacheKey(ir.remote), true);
      else if (/off$/i.test(key)) lastIrState.set(cacheKey(ir.remote), false);
      else if (/power/i.test(key)) lastIrState.set(cacheKey(ir.remote), !lastIrState.get(cacheKey(ir.remote)));
    }
  }
  return { via: 'ir', remote: { categoryId: ir.categoryId, keys: ir.keys }, trace };
}

/** Current on/off of a Wi-Fi device's switch (null when unknown). */
async function dpSwitchState(deviceId, code, trace) {
  const st = await traced(trace, 'GET', `/v1.0/iot-03/devices/${encodeURIComponent(deviceId)}/status`).catch(() => null);
  const v = (Array.isArray(st) ? st : []).find((x) => x.code === code);
  return v ? v.value === true || v.value === 'true' || v.value === 1 : null;
}

/**
 * Send commands to one device, e.g. [{ code: 'switch_1', value: false }] or { value: 'toggle' } (switch on ↔ off).
 * A Wi-Fi device without that data point uses its own on/off switch (switch, switch_led …);
 * a remote behind an IR hub (air conditioner, fan, TV) is controlled through Tuya's IR API.
 * Returns { trace } — every request and answer, kept in the log.
 */
export async function tuyaSend(deviceId, commands) {
  const trace = [];
  const needsDevice = commands.some((c) => c.value === TOGGLE);
  let dev = resolved.get(cacheKey(deviceId));
  if (!dev && needsDevice) dev = await resolveDevice(deviceId);
  if (dev?.kind === 'ir') return sendIr(dev, commands, trace);
  const send = (cmds) => traced(trace, 'POST', `/v1.0/iot-03/devices/${encodeURIComponent(deviceId)}/commands`, { commands: cmds });
  const remap = async (d) => {
    const out = [];
    for (const c of commands) {
      const code = d.codes.includes(c.code) || !d.switchCode || (typeof c.value !== 'boolean' && c.value !== TOGGLE) ? c.code : d.switchCode;
      let value = c.value;
      if (value === TOGGLE) value = !((await dpSwitchState(deviceId, code, trace)) ?? false);
      out.push({ code, value });
    }
    return out;
  };
  if (dev?.kind === 'dp') {
    await send(await remap(dev));
    return { via: 'dp', trace };
  }
  try {
    await send(commands);
    return { via: 'dp', trace };
  } catch (e) {
    if (![2008, 2007, 1109, 2001].includes(e.code)) throw e;
    dev = await resolveDevice(deviceId);
    if (dev?.kind === 'ir') return sendIr(dev, commands, trace);
    if (dev?.kind === 'dp') {
      const fixed = await remap(dev);
      if (JSON.stringify(fixed) === JSON.stringify(commands)) throw Object.assign(new Error(`${e.message} — คำสั่งที่อุปกรณ์รองรับ: ${dev.codes.join(', ')}`), { trace });
      await send(fixed);
      return { via: 'dp', trace };
    }
    throw e;
  }
}

/** On / off right now of each device (Wi-Fi switch or IR air conditioner); null when the device can't tell. */
export async function tuyaPowerState(deviceId) {
  const dev = await resolveDevice(deviceId).catch(() => null);
  const trace = [];
  if (dev?.kind === 'dp' && dev.switchCode) return dpSwitchState(deviceId, dev.switchCode, trace);
  if (dev?.kind === 'ir' && dev.categoryId === 5) return irAcPower(dev, trace);
  if (dev?.kind === 'ir') return lastIrState.has(cacheKey(dev.remote)) ? lastIrState.get(cacheKey(dev.remote)) : null;
  return null;
}

/** For the settings page: what a device accepts (data points, or the IR remote and its keys). */
export async function tuyaDeviceInfo(deviceId) {
  resolved.delete(cacheKey(deviceId));
  const fn = await tuyaFunctions(deviceId).catch((e) => ({ functions: [], error: e.message }));
  if (fn.functions.length) return { kind: 'dp', category: fn.category, functions: fn.functions.map((f) => ({ code: f.code, type: f.type, name: f.name, values: f.values })) };
  const ir = await findIrRemote(deviceId);
  if (ir) return { kind: 'ir', categoryId: ir.categoryId, name: ir.name, keys: ir.categoryId === 5 ? ['power', 'mode', 'temp', 'wind'] : await irKeys(ir) };
  return { kind: 'unknown', error: fn.error || null };
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

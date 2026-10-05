// Integration settings (LINE / SMS / slip verification / payment terminal) managed from the admin UI.
// Secrets are encrypted at rest (AES-256-GCM) and never sent back to the browser — the UI only sees "set / last 4".
// Environment variables remain as fallbacks so existing deployments keep working.
import crypto from 'node:crypto';
import { pool } from '../db/index.js';
import { config } from '../config.js';

const env = process.env;

/** Field definitions. secret: true → encrypted, masked in the UI. */
export const INTEGRATION_FIELDS = {
  line: {
    loginEnabled: { def: false },
    loginChannelId: { def: () => config.lineLoginChannelId },
    loginChannelSecret: { secret: true, def: () => config.lineLoginChannelSecret },
    callbackUrl: { def: () => env.LINE_LOGIN_CALLBACK_URL || '' },
    messagingAccessToken: { secret: true, def: () => config.lineMessagingToken },
    oaBasicId: { def: '' },
  },
  sms: {
    enabled: { def: () => !!config.smsProvider },
    provider: { def: () => config.smsProvider || 'thsms' }, // thsms | thaibulksms | smsmkt | twilio | webhook
    apiKey: { secret: true, def: () => config.smsApiKey },
    apiSecret: { secret: true, def: '' },
    accountSid: { def: '' },
    sender: { def: () => config.smsSender || 'BEATBOX' },
    webhookUrl: { def: '' },
    otpTemplate: { def: 'รหัส OTP {store}: {code} (ใช้ได้ {minutes} นาที)' },
    sendBookingConfirm: { def: false },
    bookingConfirmTemplate: { def: '{store} ยืนยันการจอง {booking} ห้อง {room} วันที่ {date} เวลา {time} จำนวน {guests} ท่าน' },
    sendReminder: { def: false },
    reminderTemplate: { def: '{store} แจ้งเตือน: การจอง {booking} ห้อง {room} เวลา {time} วันนี้' },
    otpDebug: { def: () => config.otpDebug },
  },
  slip: {
    mode: { def: () => config.paymentMode || 'DEMO' }, // DEMO | PRODUCTION
    provider: { def: () => (['slipok', 'easyslip', 'manual'].includes(config.slipProvider) ? config.slipProvider : 'manual') }, // manual | slipok | easyslip | rdcw | scb | webhook
    apiKey: { secret: true, def: () => config.slipApiKey },
    apiSecret: { secret: true, def: '' },
    branchId: { def: () => config.slipBranchId },
    apiUrl: { def: () => config.slipApiUrl },
    scbSandbox: { def: true },
    checkReceiver: { def: true },
    receiverAccounts: { def: '' }, // extra accounts / PromptPay IDs accepted as receiver (comma separated)
    maxSlipAgeMinutes: { def: 1440 },
    requireSlipQr: { def: true },
  },
  terminal: {
    provider: { def: 'none' }, // none | beam | http | manual
    useForQr: { def: true },
    useForCard: { def: true },
    beamMerchantId: { def: '' },
    beamApiKey: { secret: true, def: '' },
    beamBaseUrl: { def: 'https://api.beamcheckout.com' },
    beamAmountUnit: { def: 'SATANG' }, // SATANG | BAHT
    beamQrMethod: { def: 'QR_PROMPT_PAY' },
    beamCardMethod: { def: 'CARD_PRESENT' },
    httpUrl: { def: '' },
    httpToken: { secret: true, def: '' },
    timeoutSeconds: { def: 180 },
  },
};

function key() {
  return crypto.createHash('sha256').update(env.SETTINGS_ENCRYPTION_KEY || `${config.jwtSecret}:integrations`).digest();
}

export function encryptJson(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

export function decryptJson(text) {
  if (!text) return {};
  try {
    const [, iv, tag, data] = text.split(':');
    const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8'));
  } catch {
    console.error('[integrations] cannot decrypt stored secrets (encryption key changed?) — re-enter them in Settings');
    return {};
  }
}

const resolveDef = (f) => (typeof f.def === 'function' ? f.def() : f.def);

let cache = null;
let cacheAt = 0;

async function loadRows() {
  return (await pool.query('SELECT key, config, secrets, updated_at FROM integration_settings')).rows;
}

/** Full integration settings with decrypted secrets — server-side only. */
export async function getIntegrations() {
  if (cache && Date.now() - cacheAt < 5000) return cache;
  const rows = await loadRows();
  const out = {};
  for (const [section, fields] of Object.entries(INTEGRATION_FIELDS)) {
    const row = rows.find((r) => r.key === section);
    const cfg = row?.config || {};
    const sec = decryptJson(row?.secrets);
    out[section] = {};
    for (const [name, f] of Object.entries(fields)) {
      const stored = f.secret ? sec[name] : cfg[name];
      out[section][name] = stored !== undefined && stored !== null && stored !== '' ? stored : resolveDef(f);
    }
  }
  out.line.callbackUrl = out.line.callbackUrl || `${config.publicUrl}/api/public/auth/line/callback`;
  cache = out;
  cacheAt = Date.now();
  return out;
}

export function invalidateIntegrations() {
  cache = null;
}

const mask = (v) => (v ? { set: true, last4: String(v).slice(-4) } : { set: false });

/** Safe view for the admin UI: secrets replaced by { set, last4 }. */
export async function maskedIntegrations() {
  const all = await getIntegrations();
  const out = {};
  for (const [section, fields] of Object.entries(INTEGRATION_FIELDS)) {
    out[section] = {};
    for (const [name, f] of Object.entries(fields)) out[section][name] = f.secret ? mask(all[section][name]) : all[section][name];
  }
  out.meta = {
    lineCallbackUrl: all.line.callbackUrl,
    beamWebhookUrl: `${config.publicUrl}/api/public/terminal/beam/webhook`,
    publicUrl: config.publicUrl,
  };
  return out;
}

/**
 * Save one section. For secret fields: a non-empty string replaces the value, null clears it,
 * undefined / '' keeps the stored value.
 */
export async function saveIntegration(client, section, body, employeeId) {
  const fields = INTEGRATION_FIELDS[section];
  if (!fields) throw new Error('unknown section');
  const row = (await client.query('SELECT config, secrets FROM integration_settings WHERE key = $1 FOR UPDATE', [section])).rows[0];
  const cfg = { ...(row?.config || {}) };
  const sec = decryptJson(row?.secrets);
  const changed = [];
  for (const [name, f] of Object.entries(fields)) {
    if (!(name in body)) continue;
    const v = body[name];
    if (f.secret) {
      if (v === null) {
        delete sec[name];
        changed.push(name);
      } else if (typeof v === 'string' && v.trim()) {
        sec[name] = v.trim();
        changed.push(name);
      }
    } else {
      cfg[name] = typeof v === 'string' ? v.trim() : v;
      changed.push(name);
    }
  }
  await client.query(
    `INSERT INTO integration_settings(key, config, secrets, updated_by) VALUES ($1,$2,$3,$4)
     ON CONFLICT (key) DO UPDATE SET config = $2, secrets = $3, updated_by = $4, updated_at = now()`,
    [section, cfg, Object.keys(sec).length ? encryptJson(sec) : null, employeeId || null],
  );
  invalidateIntegrations();
  return changed;
}

/** Fill {placeholders} in a message template. */
export function fillTemplate(tpl, vars) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
}

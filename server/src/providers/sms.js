// SMS adapters (OTP, booking confirmation, reminders). Provider + keys are set in Admin → การเชื่อมต่อ → SMS.
// Without an enabled provider nothing is sent; the OTP is only shown on screen when "แสดง OTP บนหน้าจอ" is on (demo).
import { getIntegrations } from '../services/integrations.js';

/** 0812345678 → 66812345678 */
export function toMsisdn(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('66')) return d;
  if (d.startsWith('0')) return `66${d.slice(1)}`;
  return d;
}

async function post(url, init, label) {
  const r = await fetch(url, init);
  const text = await r.text();
  if (!r.ok) throw new Error(`${label} ${r.status}: ${text.slice(0, 200)}`);
  return text;
}

const PROVIDERS = {
  // https://thsms.com — Bearer token
  thsms: (c, phone, text) =>
    post('https://thsms.com/api/send-sms', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.apiKey}` }, body: JSON.stringify({ sender: c.sender, msisdn: [phone.replace(/\D/g, '')], message: text }) }, 'THSMS'),
  // https://www.thaibulksms.com — API key + secret (Basic auth)
  thaibulksms: (c, phone, text) =>
    post(
      'https://api-v2.thaibulksms.com/sms',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${c.apiKey}:${c.apiSecret}`).toString('base64')}` }, body: new URLSearchParams({ msisdn: phone.replace(/\D/g, ''), message: text, sender: c.sender }) },
      'ThaiBulkSMS',
    ),
  // https://www.smsmkt.com — api_key + secret_key headers
  smsmkt: (c, phone, text) =>
    post('https://portal-otp.smsmkt.com/api/send-message', { method: 'POST', headers: { 'Content-Type': 'application/json', api_key: c.apiKey, secret_key: c.apiSecret }, body: JSON.stringify({ message: text, phone: phone.replace(/\D/g, ''), sender: c.sender }) }, 'SMSMKT'),
  // Twilio — Account SID + Auth Token
  twilio: (c, phone, text) =>
    post(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(c.accountSid)}/Messages.json`,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${c.accountSid}:${c.apiKey}`).toString('base64')}` }, body: new URLSearchParams({ To: `+${toMsisdn(phone)}`, From: c.sender, Body: text }) },
      'Twilio',
    ),
  // Any other gateway: POST JSON { to, msisdn, message, sender } with Bearer token
  webhook: (c, phone, text) =>
    post(c.webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {}) }, body: JSON.stringify({ to: phone, msisdn: toMsisdn(phone), message: text, sender: c.sender }) }, 'Webhook'),
};

export const SMS_PROVIDERS = Object.keys(PROVIDERS);

export async function smsConfig() {
  return (await getIntegrations()).sms;
}

export async function sendSms(phone, text, { force = false } = {}) {
  const c = await smsConfig();
  if (!force && !c.enabled) return { delivered: false, reason: 'SMS ปิดใช้งาน' };
  const fn = PROVIDERS[c.provider];
  if (!fn) return { delivered: false, reason: `ไม่รู้จักผู้ให้บริการ SMS ${c.provider}` };
  if (c.provider === 'webhook' ? !c.webhookUrl : !c.apiKey) return { delivered: false, reason: 'ยังไม่ได้ตั้งค่า API Key ของผู้ให้บริการ SMS' };
  await fn(c, phone, text);
  return { delivered: true };
}

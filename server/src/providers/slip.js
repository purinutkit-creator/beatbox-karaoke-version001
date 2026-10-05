// Slip verification. Business logic only sees the normalized result:
// { ok, transactionRef, amount, paidAt, receiver: { name, account, proxy }, sender, raw, reason, manualReview, mode, qr }
//
// How a slip is checked (PRODUCTION):
//  1. Read the bank's mini QR on the slip → real transaction reference + sending bank (no third party needed).
//     A slip without that QR is rejected (setting), a reference already used is rejected (also enforced by a DB unique index).
//  2. Ask the bank / a slip verification service whether that transaction really exists:
//     SlipOK · EasySlip · RDCW Slip Verify · SCB Open API (bank, verifies slips of every Thai bank) · custom webhook.
//     "manual" = staff compare the slip with the bank app before approving.
//  3. Check amount, receiving account / PromptPay, and slip date against the order.
import crypto from 'node:crypto';
import { pool } from '../db/index.js';
import { getIntegrations } from '../services/integrations.js';
import { readSlipQr } from './slipqr.js';

export function fileHash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

const digits = (v) => String(v ?? '').replace(/[^0-9xX*]/g, '');

/** Compare a (possibly masked, e.g. "xxx-x-x5678-x") account from the provider with a known account / PromptPay ID. */
export function accountMatches(masked, known) {
  const a = digits(masked).toLowerCase().replace(/\*/g, 'x');
  let b = String(known ?? '').replace(/\D/g, '');
  if (!a || !b) return false;
  // PromptPay phone 0812345678 may come back as 66812345678
  if (b.startsWith('0') && a.length === b.length + 1) b = `66${b.slice(1)}`;
  const n = Math.min(a.length, b.length);
  let compared = 0;
  for (let i = 1; i <= n; i++) {
    const ca = a[a.length - i];
    if (ca === 'x') continue;
    if (ca !== b[b.length - i]) return false;
    compared++;
  }
  return compared >= 3;
}

// ── providers ──
async function json(r) {
  return r.json().catch(() => ({}));
}

const demoProvider = {
  name: 'demo',
  isReal: false,
  async verify({ buffer, qr, expectedAmount }) {
    // Demo Mode: no money is checked. The reference comes from the slip QR (or file hash) so re-using a slip is still detected.
    await new Promise((r) => setTimeout(r, 1500));
    const ref = qr?.transRef || `DEMO-${fileHash(buffer || Buffer.from(String(Date.now()))).slice(0, 20).toUpperCase()}`;
    return { ok: true, transactionRef: ref, amount: Number(expectedAmount), paidAt: new Date().toISOString(), raw: { demo: true } };
  },
};

const manualProvider = {
  name: 'manual',
  isReal: true,
  async verify() {
    return { ok: false, manualReview: true, reason: 'รอพนักงานตรวจสอบสลิปกับบัญชีธนาคาร' };
  },
};

// SlipOK https://slipok.com — branch ID + API key (x-authorization)
const slipOkProvider = {
  name: 'slipok',
  isReal: true,
  async verify({ buffer, qr, expectedAmount, dryRun = false }, c) {
    const url = c.apiUrl || `https://api.slipok.com/api/line/apikey/${encodeURIComponent(c.branchId)}`;
    let init;
    if (qr?.payload) init = { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-authorization': c.apiKey }, body: JSON.stringify({ data: qr.payload, log: !dryRun, amount: Number(expectedAmount) }) };
    else {
      const form = new FormData();
      form.append('files', new Blob([buffer]), 'slip.jpg');
      form.append('log', dryRun ? 'false' : 'true');
      form.append('amount', String(expectedAmount));
      init = { method: 'POST', headers: { 'x-authorization': c.apiKey }, body: form };
    }
    const r = await fetch(url, init);
    const j = await json(r);
    if (!r.ok || !j.success) {
      const code = j.code;
      let reason = j.message || 'ไม่สามารถตรวจสอบรายการได้';
      if (code === 1012) reason = 'พบรายการนี้ถูกใช้แล้ว';
      if (code === 1013) reason = 'ยอดเงินไม่ตรง';
      if (code === 1014) reason = 'บัญชีผู้รับเงินไม่ตรงกับบัญชีร้าน';
      if (code === 1010 || code === 1008) reason = 'ไม่พบรายการโอนนี้ในระบบธนาคาร (สลิปปลอมหรือรอธนาคารอัปเดต)';
      return { ok: false, reason, raw: j, manualReview: !code || r.status >= 500 };
    }
    const d = j.data || {};
    return { ok: true, transactionRef: d.transRef, amount: Number(d.amount), paidAt: d.transTimestamp || null, receiver: { name: d.receiver?.displayName || d.receiver?.name, account: d.receiver?.account?.value, proxy: d.receiver?.proxy?.value }, sender: { name: d.sender?.displayName || d.sender?.name, bank: d.sendingBank }, raw: d };
  },
};

// EasySlip https://easyslip.com — Bearer API key
const easySlipProvider = {
  name: 'easyslip',
  isReal: true,
  async verify({ buffer, qr }, c) {
    const base = c.apiUrl || 'https://developer.easyslip.com/api/v1/verify';
    let r;
    if (qr?.payload) r = await fetch(`${base}?payload=${encodeURIComponent(qr.payload)}&checkDuplicate=true`, { headers: { Authorization: `Bearer ${c.apiKey}` } });
    else {
      const form = new FormData();
      form.append('file', new Blob([buffer]), 'slip.jpg');
      form.append('checkDuplicate', 'true');
      r = await fetch(base, { method: 'POST', headers: { Authorization: `Bearer ${c.apiKey}` }, body: form });
    }
    const j = await json(r);
    if (!r.ok || j.status !== 200) {
      const m = j.message;
      const reason = m === 'duplicate_slip' ? 'พบรายการนี้ถูกใช้แล้ว' : m === 'slip_not_found' ? 'ไม่พบรายการโอนนี้ในระบบธนาคาร (สลิปปลอมหรือรอธนาคารอัปเดต)' : m === 'invalid_payload' || m === 'qrcode_not_found' ? 'อ่าน QR บนสลิปไม่ได้' : `ไม่สามารถตรวจสอบรายการได้${m ? ` (${m})` : ''}`;
      return { ok: false, reason, raw: j, manualReview: r.status >= 500 || m === 'unauthorized' || m === 'quota_exceeded' };
    }
    const d = j.data || {};
    const acc = d.receiver?.account || {};
    return { ok: true, transactionRef: d.transRef, amount: Number(d.amount?.amount), paidAt: d.date, receiver: { name: acc.name?.th || acc.name?.en, account: acc.bank?.account, proxy: acc.proxy?.account }, sender: { name: d.sender?.account?.name?.th, bank: d.sender?.bank?.short }, raw: d };
  },
};

function thaiDateTime(date, time) {
  // "20240131" + "12:34:56" (Asia/Bangkok)
  if (!date) return null;
  const s = String(date).replace(/\D/g, '');
  if (s.length !== 8) return null;
  return new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${time || '00:00:00'}+07:00`).toISOString();
}

// RDCW Slip Verify https://slip.rdcw.co.th — Client ID / Client Secret (Basic auth), takes the slip QR payload
const rdcwProvider = {
  name: 'rdcw',
  isReal: true,
  needsQr: true,
  async verify({ qr }, c) {
    const r = await fetch(c.apiUrl || 'https://suba.rdcw.co.th/v1/inquiry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`${c.apiKey}:${c.apiSecret}`).toString('base64')}` },
      body: JSON.stringify({ payload: qr.payload }),
    });
    const j = await json(r);
    if (!r.ok || j.valid === false || !j.data) return { ok: false, reason: j.message || j.error || 'ไม่พบรายการโอนนี้ในระบบธนาคาร', raw: j, manualReview: r.status >= 500 || r.status === 401 };
    const d = j.data;
    return { ok: true, transactionRef: d.transRef, amount: Number(d.amount), paidAt: thaiDateTime(d.transDate, d.transTime), receiver: { name: d.receiver?.displayName || d.receiver?.name, account: d.receiver?.account?.value, proxy: d.receiver?.proxy?.value }, sender: { name: d.sender?.displayName, bank: d.sendingBank }, raw: d };
  },
};

// SCB Open API (bank) — Slip Verification works for transfers from every Thai bank. Needs an SCB API app (key + secret).
let scbToken = null;
const scbProvider = {
  name: 'scb',
  isReal: true,
  needsQr: true,
  base(c) {
    return c.apiUrl || (c.scbSandbox ? 'https://api-sandbox.partners.scb/partners/sandbox' : 'https://api.partners.scb/partners');
  },
  async token(c) {
    if (scbToken && scbToken.key === c.apiKey && scbToken.exp > Date.now() + 60000) return scbToken.value;
    const r = await fetch(`${this.base(c)}/v1/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', resourceOwnerId: c.apiKey, requestUId: crypto.randomUUID(), 'accept-language': 'EN' },
      body: JSON.stringify({ applicationKey: c.apiKey, applicationSecret: c.apiSecret }),
    });
    const j = await json(r);
    if (!r.ok || !j.data?.accessToken) throw new Error(`SCB OAuth ${r.status}: ${j.status?.description || ''}`);
    scbToken = { key: c.apiKey, value: j.data.accessToken, exp: Date.now() + Number(j.data.expiresIn || 1800) * 1000 };
    return scbToken.value;
  },
  async verify({ qr }, c) {
    const token = await this.token(c);
    const r = await fetch(`${this.base(c)}/v1/payment/billpayment/transactions/${encodeURIComponent(qr.transRef)}?sendingBank=${encodeURIComponent(qr.sendingBank || '')}`, {
      headers: { authorization: `Bearer ${token}`, requestUId: crypto.randomUUID(), resourceOwnerId: c.apiKey, 'accept-language': 'EN' },
    });
    const j = await json(r);
    if (!r.ok || Number(j.status?.code) !== 1000 || !j.data) return { ok: false, reason: `ธนาคารไม่พบรายการโอนนี้${j.status?.description ? ` (${j.status.description})` : ''}`, raw: j, manualReview: r.status >= 500 };
    const d = j.data;
    return { ok: true, transactionRef: d.transRef, amount: Number(d.amount), paidAt: thaiDateTime(d.transDate, d.transTime), receiver: { name: d.receiver?.displayName || d.receiver?.name, account: d.receiver?.account?.value, proxy: d.receiver?.proxy?.value }, sender: { name: d.sender?.displayName, bank: d.sendingBank }, raw: d };
  },
};

// Custom service: POST { payload, transRef, sendingBank, amount, image (base64 when no QR) } → { ok, transRef, amount, paidAt, receiverAccount, receiverName, reason }
const webhookProvider = {
  name: 'webhook',
  isReal: true,
  async verify({ buffer, qr, expectedAmount }, c) {
    const r = await fetch(c.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {}) },
      body: JSON.stringify({ payload: qr?.payload || null, transRef: qr?.transRef || null, sendingBank: qr?.sendingBank || null, amount: Number(expectedAmount), image: qr?.payload ? undefined : buffer?.toString('base64') }),
    });
    const j = await json(r);
    if (!r.ok || !j.ok) return { ok: false, reason: j.reason || j.message || 'ไม่สามารถตรวจสอบรายการได้', raw: j, manualReview: r.status >= 500 };
    return { ok: true, transactionRef: j.transRef, amount: Number(j.amount), paidAt: j.paidAt || null, receiver: { name: j.receiverName, account: j.receiverAccount, proxy: j.receiverProxy }, raw: j };
  },
};

const PROVIDERS = { slipok: slipOkProvider, easyslip: easySlipProvider, rdcw: rdcwProvider, scb: scbProvider, webhook: webhookProvider, manual: manualProvider };

export async function slipConfig() {
  return (await getIntegrations()).slip;
}

export async function paymentMode() {
  return (await slipConfig()).mode === 'PRODUCTION' ? 'PRODUCTION' : 'DEMO';
}

/** The provider that will be used right now (demo in Demo Mode, manual when a provider is not fully configured). */
export async function getSlipProvider() {
  const c = await slipConfig();
  if (c.mode !== 'PRODUCTION') return demoProvider;
  const p = PROVIDERS[c.provider];
  if (!p || p === manualProvider) return manualProvider;
  const configured = c.provider === 'webhook' ? !!c.apiUrl : c.provider === 'slipok' ? !!(c.apiKey && (c.branchId || c.apiUrl)) : ['rdcw', 'scb'].includes(c.provider) ? !!(c.apiKey && c.apiSecret) : !!c.apiKey;
  return configured ? p : manualProvider;
}

/** Amount / receiver / date rules applied to every provider result. */
export function checkSlipRules(v, { expectedAmount, notBefore, settings, cfg }) {
  if (!v.ok) return v;
  if (expectedAmount != null && Math.abs(Number(v.amount) - Number(expectedAmount)) > 0.009) return { ...v, ok: false, reason: `ยอดเงินไม่ตรง (สลิป ${v.amount} บาท / ต้องชำระ ${expectedAmount} บาท)` };
  if (v.paidAt) {
    const paid = new Date(v.paidAt).getTime();
    const maxAge = Number(cfg.maxSlipAgeMinutes || 0) * 60000;
    if (maxAge && Date.now() - paid > maxAge) return { ...v, ok: false, reason: 'สลิปนี้เก่าเกินกว่าที่กำหนด' };
    if (notBefore && paid < new Date(notBefore).getTime() - 30 * 60000) return { ...v, ok: false, reason: 'วันที่/เวลาในสลิปไม่ตรงกับรายการนี้' };
  }
  if (cfg.checkReceiver !== false && (v.receiver?.account || v.receiver?.proxy)) {
    const known = [settings.payment.accountNumber, settings.payment.promptPayId, ...String(cfg.receiverAccounts || '').split(',')].map((x) => String(x || '').trim()).filter(Boolean);
    if (known.length && !known.some((k) => accountMatches(v.receiver.account, k) || accountMatches(v.receiver.proxy, k))) return { ...v, ok: false, reason: 'บัญชีผู้รับเงินไม่ตรงกับบัญชีร้าน' };
  }
  return v;
}

/**
 * Verify one slip image end-to-end.
 * @returns normalized result with { mode: 'DEMO' | 'PROVIDER' | 'MANUAL_REVIEW', provider, qr, hash }
 */
export async function verifySlip({ buffer, mime, expectedAmount, notBefore = null, settings, dryRun = false }) {
  const cfg = await slipConfig();
  const hash = buffer ? fileHash(buffer) : null;
  const qr = buffer ? readSlipQr(buffer, mime) : null;
  const slipQr = qr?.transRef ? qr : null;
  const provider = await getSlipProvider();
  const base = { provider: provider.name, qr: slipQr, hash };
  if (provider === demoProvider) return { ...base, ...(await demoProvider.verify({ buffer, qr: slipQr, expectedAmount })), mode: 'DEMO' };

  if (!slipQr && cfg.requireSlipQr !== false) return { ...base, ok: false, reason: 'ไม่พบ QR Code ของธนาคารบนสลิป กรุณาอัปโหลดสลิปจริงจากแอปธนาคาร (ภาพชัด ไม่ครอป)', mode: 'PROVIDER' };
  if (slipQr) {
    const used = (await pool.query(`SELECT 1 FROM payment_verifications WHERE transaction_ref = $1 AND result = 'PASSED'`, [slipQr.transRef])).rows[0];
    if (used) return { ...base, ok: false, reason: 'พบรายการนี้ถูกใช้แล้ว', duplicate: true, mode: 'PROVIDER' };
  }
  if (provider === manualProvider) return { ...base, ok: false, manualReview: true, reason: 'รอพนักงานตรวจสอบสลิปกับบัญชีธนาคาร', transactionRef: slipQr?.transRef || null, mode: 'MANUAL_REVIEW' };
  if (provider.needsQr && !slipQr) return { ...base, ok: false, manualReview: true, reason: 'อ่าน QR บนสลิปไม่ได้ ต้องให้พนักงานตรวจสอบ', mode: 'MANUAL_REVIEW' };
  let v;
  try {
    v = await provider.verify({ buffer, qr: slipQr, expectedAmount, dryRun }, cfg);
  } catch (e) {
    v = { ok: false, manualReview: true, reason: 'ไม่สามารถเชื่อมต่อระบบตรวจสอบสลิปได้', raw: { error: e.message } };
  }
  v = checkSlipRules(v, { expectedAmount, notBefore, settings, cfg });
  if (v.ok && slipQr && v.transactionRef && v.transactionRef !== slipQr.transRef) v = { ...v, ok: false, reason: 'เลขอ้างอิงในสลิปไม่ตรงกับข้อมูลธนาคาร' };
  return { ...base, ...v, transactionRef: v.transactionRef || slipQr?.transRef || null, mode: v.ok ? 'PROVIDER' : v.manualReview ? 'MANUAL_REVIEW' : 'PROVIDER' };
}

/** Admin "test connection" — calls the provider with a dummy payload to validate credentials. */
export async function testSlipProvider() {
  const cfg = await slipConfig();
  const p = PROVIDERS[cfg.provider];
  if (!p || p === manualProvider) return { ok: true, message: 'โหมดพนักงานตรวจสอบเอง ไม่ต้องเชื่อมต่อบริการภายนอก' };
  const dummy = { payload: '004100060000010103014022000000000000000000005102TH91040000', transRef: '000000000000000000000', sendingBank: '014' };
  try {
    if (p === scbProvider) {
      scbToken = null;
      await scbProvider.token(cfg);
      return { ok: true, message: 'เชื่อมต่อ SCB API สำเร็จ (ได้รับ Access Token)' };
    }
    const v = await p.verify({ qr: dummy, buffer: Buffer.from('test'), expectedAmount: 1, dryRun: true }, cfg);
    const raw = JSON.stringify(v.raw || {});
    if (/unauthori[sz]ed|invalid.*(key|token)|forbidden|401|403/i.test(raw) || /unauthori/i.test(v.reason || '')) return { ok: false, message: `API Key ไม่ถูกต้อง: ${v.reason}` };
    return { ok: true, message: `เชื่อมต่อ ${p.name} ได้ (ทดสอบด้วยสลิปจำลอง: ${v.reason || 'ok'})` };
  } catch (e) {
    return { ok: false, message: `เชื่อมต่อไม่สำเร็จ: ${e.message}` };
  }
}

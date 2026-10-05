// Slip verification providers. Business logic only sees the normalized result:
// { ok, transactionRef, amount, paidAt, receiverAccount, raw, reason, manualReview }
import crypto from 'node:crypto';
import { config } from '../config.js';

export function fileHash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

const demoProvider = {
  name: 'demo',
  isReal: false,
  async verify({ buffer, expectedAmount }) {
    // Demo Mode: simulates provider latency and returns a deterministic reference derived from the file,
    // so re-uploading the same slip is detected as a duplicate.
    await new Promise((r) => setTimeout(r, 2500));
    const ref = 'DEMO-' + fileHash(buffer).slice(0, 20).toUpperCase();
    return { ok: true, transactionRef: ref, amount: Number(expectedAmount), paidAt: new Date().toISOString(), receiverAccount: null, raw: { demo: true } };
  },
};

const manualProvider = {
  name: 'manual',
  isReal: true,
  async verify() {
    return { ok: false, manualReview: true, reason: 'รอพนักงานตรวจสอบสลิป' };
  },
};

// SlipOK (https://slipok.com) adapter
const slipOkProvider = {
  name: 'slipok',
  isReal: true,
  async verify({ buffer, expectedAmount }) {
    const form = new FormData();
    form.append('files', new Blob([buffer]), 'slip.jpg');
    form.append('log', 'true');
    form.append('amount', String(expectedAmount));
    const url = config.slipApiUrl || `https://api.slipok.com/api/line/apikey/${config.slipBranchId}`;
    const r = await fetch(url, { method: 'POST', headers: { 'x-authorization': config.slipApiKey }, body: form });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.success) {
      const code = j.code;
      let reason = j.message || 'ไม่สามารถตรวจสอบรายการได้';
      if (code === 1012) reason = 'พบรายการนี้ถูกใช้แล้ว';
      if (code === 1013) reason = 'ยอดเงินไม่ตรง';
      return { ok: false, reason, raw: j, manualReview: !code || code >= 1000 && code < 1010 };
    }
    const d = j.data || {};
    return { ok: true, transactionRef: d.transRef, amount: Number(d.amount), paidAt: d.transTimestamp || d.transDate, receiverAccount: d.receiver?.account?.value, raw: d };
  },
};

// EasySlip (https://easyslip.com) adapter
const easySlipProvider = {
  name: 'easyslip',
  isReal: true,
  async verify({ buffer }) {
    const form = new FormData();
    form.append('file', new Blob([buffer]), 'slip.jpg');
    const r = await fetch(config.slipApiUrl || 'https://developer.easyslip.com/api/v1/verify', { method: 'POST', headers: { Authorization: `Bearer ${config.slipApiKey}` }, body: form });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.status !== 200) return { ok: false, reason: j.message === 'duplicate_slip' ? 'พบรายการนี้ถูกใช้แล้ว' : 'ไม่สามารถตรวจสอบรายการได้', raw: j, manualReview: r.status >= 500 };
    const d = j.data || {};
    return { ok: true, transactionRef: d.transRef, amount: Number(d.amount?.amount), paidAt: d.date, receiverAccount: d.receiver?.account?.bank?.account, raw: d };
  },
};

export function getSlipProvider() {
  if (config.paymentMode !== 'PRODUCTION') return demoProvider;
  if (config.slipProvider === 'slipok' && config.slipApiKey) return slipOkProvider;
  if (config.slipProvider === 'easyslip' && config.slipApiKey) return easySlipProvider;
  return manualProvider; // production without provider → always manual review, never auto-PAID
}

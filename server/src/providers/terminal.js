// Payment terminal adapters — show the amount / QR on an EDC or Beam Bolt+ instead of the Customer Display.
//
//  beam   Beam Checkout "Bolt Intent" API (POST /api/v1/bolt-intents, Basic auth merchantId:apiKey).
//         The response carries mode.deepLink.deepLinkUrl which opens the payment on the Beam Bolt+ device.
//         Payment results arrive by webhook (/api/public/terminal/beam/webhook) and are also polled.
//  http   Local bridge for bank EDCs (KBank / SCB / KTB … use proprietary ECR serial/LAN protocols):
//         POST {url}/sale { reference, amount, method } → { id, status }, GET {url}/sale/{id} → { status, approvalCode, reference }.
//  manual Customer pays on any EDC; the cashier confirms the approval code (logged).
import { getIntegrations } from '../services/integrations.js';
import { config } from '../config.js';

export async function terminalConfig() {
  return (await getIntegrations()).terminal;
}

/** Which tender methods go to the terminal ([] = none → QR on Customer Display). */
export async function terminalMethods() {
  const c = await terminalConfig();
  if (!c.provider || c.provider === 'none') return [];
  if (c.provider === 'beam' && !(c.beamMerchantId && c.beamApiKey)) return [];
  if (c.provider === 'http' && !c.httpUrl) return [];
  return [c.useForQr !== false && 'QR', c.useForCard !== false && 'CARD'].filter(Boolean);
}

const STATUS_MAP = {
  SUCCEEDED: 'APPROVED', SUCCESS: 'APPROVED', PAID: 'APPROVED', COMPLETED: 'APPROVED', APPROVED: 'APPROVED', CHARGED: 'APPROVED',
  FAILED: 'DECLINED', DECLINED: 'DECLINED', REJECTED: 'DECLINED',
  CANCELLED: 'CANCELLED', CANCELED: 'CANCELLED', VOIDED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
};
export const mapStatus = (s) => STATUS_MAP[String(s || '').toUpperCase()] || 'PENDING';

function beamAuth(c) {
  return `Basic ${Buffer.from(`${c.beamMerchantId}:${c.beamApiKey}`).toString('base64')}`;
}

const beam = {
  async create(c, { amount, method, reference, paymentId }) {
    const value = c.beamAmountUnit === 'BAHT' ? Number(amount) : Math.round(Number(amount) * 100);
    const body = {
      amount: value,
      currency: 'THB',
      referenceId: reference,
      paymentMethod: { paymentMethodType: method === 'CARD' ? c.beamCardMethod : c.beamQrMethod },
      mode: { deepLink: { returnUrl: `${config.publicUrl}/admin/pos?terminal=${paymentId}` } },
    };
    const r = await fetch(`${c.beamBaseUrl.replace(/\/$/, '')}/api/v1/bolt-intents`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: beamAuth(c) }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Beam ${r.status}: ${j.message || j.error || JSON.stringify(j).slice(0, 200)}`);
    return { providerRef: j.id || j.boltIntentId, deepLink: j.mode?.deepLink?.deepLinkUrl || j.deepLinkUrl || null, status: mapStatus(j.status), raw: j };
  },
  async status(c, providerRef) {
    const r = await fetch(`${c.beamBaseUrl.replace(/\/$/, '')}/api/v1/bolt-intents/${encodeURIComponent(providerRef)}`, { headers: { Authorization: beamAuth(c) } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { status: 'PENDING', raw: j };
    const st = j.status || j.state || j.paymentStatus || j.charge?.status;
    return { status: mapStatus(st), approvalCode: j.chargeId || j.charge?.id || j.transactionId || null, raw: j };
  },
  async cancel(c, providerRef) {
    await fetch(`${c.beamBaseUrl.replace(/\/$/, '')}/api/v1/bolt-intents/${encodeURIComponent(providerRef)}/cancel`, { method: 'POST', headers: { Authorization: beamAuth(c) } }).catch(() => {});
  },
  async test(c) {
    if (!c.beamMerchantId || !c.beamApiKey) return { ok: false, message: 'กรุณากรอก Merchant ID และ API Key' };
    const r = await fetch(`${c.beamBaseUrl.replace(/\/$/, '')}/api/v1/bolt-intents/connection-test`, { headers: { Authorization: beamAuth(c) } }).catch((e) => ({ ok: false, status: 0, text: async () => e.message }));
    if (r.status === 401 || r.status === 403) return { ok: false, message: 'Beam ปฏิเสธ Merchant ID / API Key' };
    if (r.status === 0) return { ok: false, message: `เชื่อมต่อ Beam ไม่ได้: ${await r.text()}` };
    return { ok: true, message: `เชื่อมต่อ Beam API ได้ (HTTP ${r.status}) — ทดลองชำระเงินจริง 1 บาทเพื่อยืนยัน` };
  },
};

const http = {
  headers(c) {
    return { 'Content-Type': 'application/json', ...(c.httpToken ? { Authorization: `Bearer ${c.httpToken}` } : {}) };
  },
  async create(c, { amount, method, reference }) {
    const r = await fetch(`${c.httpUrl.replace(/\/$/, '')}/sale`, { method: 'POST', headers: this.headers(c), body: JSON.stringify({ reference, amount: Number(amount), method }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`EDC bridge ${r.status}: ${j.error || j.message || ''}`);
    return { providerRef: String(j.id || reference), status: mapStatus(j.status), approvalCode: j.approvalCode || null, raw: j };
  },
  async status(c, providerRef) {
    const r = await fetch(`${c.httpUrl.replace(/\/$/, '')}/sale/${encodeURIComponent(providerRef)}`, { headers: this.headers(c) });
    const j = await r.json().catch(() => ({}));
    return { status: r.ok ? mapStatus(j.status) : 'PENDING', approvalCode: j.approvalCode || j.reference || null, raw: j };
  },
  async cancel(c, providerRef) {
    await fetch(`${c.httpUrl.replace(/\/$/, '')}/sale/${encodeURIComponent(providerRef)}/cancel`, { method: 'POST', headers: this.headers(c) }).catch(() => {});
  },
  async test(c) {
    if (!c.httpUrl) return { ok: false, message: 'กรุณากรอก URL ของ EDC Bridge' };
    const r = await fetch(`${c.httpUrl.replace(/\/$/, '')}/status`, { headers: this.headers(c) }).catch((e) => ({ ok: false, status: 0, statusText: e.message }));
    return r.ok ? { ok: true, message: 'เชื่อมต่อ EDC Bridge สำเร็จ' } : { ok: false, message: `เชื่อมต่อ EDC Bridge ไม่ได้ (${r.status} ${r.statusText || ''})` };
  },
};

const manual = {
  async create(_c, { reference }) {
    return { providerRef: reference, status: 'PENDING', raw: {} };
  },
  async status() {
    return { status: 'PENDING' };
  },
  async cancel() {},
  async test() {
    return { ok: true, message: 'โหมดยืนยันด้วยตนเอง: แคชเชียร์กรอกรหัสอนุมัติจากเครื่อง EDC' };
  },
};

export const TERMINALS = { beam, http, manual };

export async function getTerminal() {
  const c = await terminalConfig();
  return { cfg: c, adapter: TERMINALS[c.provider] || null };
}

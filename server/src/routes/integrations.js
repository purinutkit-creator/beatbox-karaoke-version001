// Admin → การเชื่อมต่อ: LINE, SMS, slip verification and payment terminal credentials + "test" buttons,
// and the POS endpoints that push a payment to the terminal (EDC / Beam Bolt).
import crypto from 'node:crypto';
import express, { Router } from 'express';
import { config } from '../config.js';
import multer from 'multer';
import { pool, tx, one } from '../db/index.js';
import { requireAuth, can, signToken } from '../lib/auth.js';
import { logActivity } from '../lib/activity.js';
import { z, parse } from '../lib/validate.js';
import { notFound, badRequest, conflict } from '../lib/errors.js';
import { emitSync } from '../lib/realtime.js';
import { useStoreOf } from '../lib/tenant.js';
import { getSettings, invalidateSettings } from '../services/settings.js';
import { maskedIntegrations, saveIntegration, INTEGRATION_FIELDS, fillTemplate, getIntegrations } from '../services/integrations.js';
import { tuyaTest } from '../providers/tuya.js';
import { lineLogin, lineMessaging } from '../providers/line.js';
import { webhookInfo } from './line.js';
import { sendSms, smsConfig } from '../providers/sms.js';
import { verifySlip, testSlipProvider } from '../providers/slip.js';
import { getTerminal, terminalMethods } from '../providers/terminal.js';

const r = Router();
r.use(requireAuth);

r.get('/integrations', can('settings.manage'), async (_req, res) => res.json(await maskedIntegrations()));

const SCHEMAS = {
  line: z.object({ loginEnabled: z.boolean().optional(), loginChannelId: z.string().max(100).optional(), loginChannelSecret: z.string().max(200).nullable().optional(), callbackUrl: z.string().max(500).optional(), messagingAccessToken: z.string().max(1000).nullable().optional(), messagingChannelSecret: z.string().max(200).nullable().optional(), oaBasicId: z.string().max(100).optional() }),
  sms: z.object({
    enabled: z.boolean().optional(),
    provider: z.enum(['thsms', 'thaibulksms', 'smsmkt', 'twilio', 'webhook']).optional(),
    apiKey: z.string().max(500).nullable().optional(),
    apiSecret: z.string().max(500).nullable().optional(),
    accountSid: z.string().max(100).optional(),
    sender: z.string().max(30).optional(),
    webhookUrl: z.string().max(500).optional(),
    otpTemplate: z.string().max(300).optional(),
    sendBookingConfirm: z.boolean().optional(),
    bookingConfirmTemplate: z.string().max(500).optional(),
    sendReminder: z.boolean().optional(),
    reminderTemplate: z.string().max(500).optional(),
    otpDebug: z.boolean().optional(),
  }),
  slip: z.object({
    mode: z.enum(['DEMO', 'PRODUCTION']).optional(),
    provider: z.enum(['manual', 'slipok', 'easyslip', 'rdcw', 'scb', 'webhook']).optional(),
    apiKey: z.string().max(500).nullable().optional(),
    apiSecret: z.string().max(500).nullable().optional(),
    branchId: z.string().max(100).optional(),
    apiUrl: z.string().max(500).optional(),
    scbSandbox: z.boolean().optional(),
    checkReceiver: z.boolean().optional(),
    receiverAccounts: z.string().max(500).optional(),
    maxSlipAgeMinutes: z.coerce.number().int().min(0).max(60 * 24 * 30).optional(),
    requireSlipQr: z.boolean().optional(),
  }),
  tuya: z.object({
    enabled: z.boolean().optional(),
    endpoint: z.string().url().max(200).optional(),
    accessId: z.string().trim().max(100).optional(),
    accessSecret: z.string().trim().max(200).nullable().optional(),
  }),
  terminal: z.object({
    provider: z.enum(['none', 'beam', 'http', 'manual']).optional(),
    useForQr: z.boolean().optional(),
    useForCard: z.boolean().optional(),
    beamMerchantId: z.string().max(100).optional(),
    beamApiKey: z.string().max(500).nullable().optional(),
    beamBaseUrl: z.string().url().optional(),
    beamAmountUnit: z.enum(['SATANG', 'BAHT']).optional(),
    beamQrMethod: z.string().max(50).optional(),
    beamCardMethod: z.string().max(50).optional(),
    httpUrl: z.string().max(500).optional(),
    httpToken: z.string().max(500).nullable().optional(),
    timeoutSeconds: z.coerce.number().int().min(30).max(900).optional(),
  }),
};

r.put('/integrations/:section', can('settings.manage'), async (req, res) => {
  const section = req.params.section;
  if (!SCHEMAS[section]) throw notFound();
  const body = parse(SCHEMAS[section], req.body);
  await tx(async (c) => {
    const changed = await saveIntegration(c, section, body, req.employee.id);
    // never log secret values — only which fields changed
    const safe = Object.fromEntries(Object.entries(body).filter(([k]) => !INTEGRATION_FIELDS[section][k]?.secret));
    await logActivity(c, req, 'INTEGRATION_UPDATE', 'integration', section, { changed, values: safe });
  });
  invalidateSettings();
  emitSync('settings');
  res.json(await maskedIntegrations());
});

/** LINE OA chat: the webhook address of this store to paste into LINE Developers, and whether it can answer yet. */
r.get('/integrations/line/webhook', can('settings.manage'), async (_req, res) => {
  const s = await getSettings();
  res.json(await webhookInfo(config.publicUrl, s.store.slug));
});

/**
 * LINE rich menu: the picture (made on the settings page, or the store's own, three equal columns) is sent as the body.
 * Left: the booking website · middle: check a booking (in the chat) · right: the member page of the website.
 */
r.post('/integrations/line/richmenu', can('settings.manage'), express.raw({ type: ['image/jpeg', 'image/png'], limit: '1mb' }), async (req, res) => {
  const type = String(req.headers['content-type'] || '').split(';')[0];
  if (!Buffer.isBuffer(req.body) || !req.body.length || !['image/jpeg', 'image/png'].includes(type)) throw badRequest('กรุณาเลือกรูป JPG หรือ PNG ขนาดไม่เกิน 1 MB');
  const size = imageSize(req.body, type);
  if (!size || size.width !== 2500 || ![843, 1686].includes(size.height)) throw badRequest('รูปริชเมนูต้องมีขนาด 2500 × 843 หรือ 2500 × 1686 พิกเซล');
  const s = await getSettings();
  const integ = await getIntegrations();
  const label = 'จองห้อง';
  const uri = `${config.publicUrl}/book?store=${encodeURIComponent(s.store.slug || '')}`;
  const memberUri = `${config.publicUrl}/book/account?store=${encodeURIComponent(s.store.slug || '')}`;
  const menu = {
    size: { width: 2500, height: size.height },
    selected: true,
    name: `${s.store.name} booking`.slice(0, 300),
    chatBarText: String(req.query.bar || 'จองห้อง').slice(0, 14),
    // three equal buttons: จองห้อง (the booking website) | ตรวจสอบการจอง (answered in the chat) | สมาชิก (the member page)
    areas: [
      { bounds: { x: 0, y: 0, width: 833, height: size.height }, action: { type: 'uri', label, uri } },
      { bounds: { x: 833, y: 0, width: 834, height: size.height }, action: { type: 'postback', label: 'ตรวจสอบการจอง', data: 'a=check', displayText: 'ตรวจสอบการจอง' } },
      { bounds: { x: 1667, y: 0, width: 833, height: size.height }, action: { type: 'uri', label: 'สมาชิก', uri: memberUri } },
    ],
  };
  let id;
  try {
    id = await lineMessaging.publishRichMenu({ menu, image: req.body, contentType: type, replaces: integ.line.richMenuId || null });
  } catch (e) {
    throw badRequest(e.message);
  }
  await tx(async (c) => {
    await saveIntegration(c, 'line', { richMenuId: id }, req.employee.id);
    await logActivity(c, req, 'LINE_RICHMENU', 'integration', 'line', { richMenuId: id, uri });
  });
  res.json({ ok: true, richMenuId: id, uri });
});

r.delete('/integrations/line/richmenu', can('settings.manage'), async (req, res) => {
  const integ = await getIntegrations();
  await lineMessaging.removeRichMenu(integ.line.richMenuId);
  await tx(async (c) => {
    await saveIntegration(c, 'line', { richMenuId: '' }, req.employee.id);
    await logActivity(c, req, 'LINE_RICHMENU_REMOVE', 'integration', 'line', {});
  });
  res.json({ ok: true });
});

/** Width / height of a PNG or JPEG (enough to check a rich menu picture before LINE does). */
function imageSize(buf, type) {
  if (type === 'image/png') return buf.length > 24 ? { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) } : null;
  for (let i = 2; i < buf.length - 9; ) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

/** SMS delivery-report address of this store (the key is made the first time). */
r.get('/integrations/sms/webhook', can('settings.manage'), async (req, res) => {
  let key = (await getIntegrations()).sms.callbackKey;
  if (!key) {
    key = crypto.randomBytes(18).toString('base64url');
    await tx((c) => saveIntegration(c, 'sms', { callbackKey: key }, req.employee.id));
  }
  const s = await getSettings();
  res.json({ url: `${config.publicUrl}/api/public/sms/webhook?store=${encodeURIComponent(s.store.slug || '')}&key=${key}` });
});

r.post('/integrations/:section/test', can('settings.manage'), async (req, res) => {
  const section = req.params.section;
  let out;
  if (section === 'line') {
    const login = await lineLogin.test().catch((e) => ({ ok: false, message: e.message }));
    const msg = await lineMessaging.test().catch((e) => ({ ok: false, message: e.message }));
    out = { ok: login.ok || msg.ok, results: [login, msg] };
    if (req.body?.lineUserId && msg.ok) {
      await lineMessaging.push(req.body.lineUserId, 'ทดสอบการส่งข้อความจากระบบ BEATBOX POS');
      out.results.push({ ok: true, message: 'ส่งข้อความทดสอบแล้ว' });
    }
  } else if (section === 'sms') {
    const { phone } = parse(z.object({ phone: z.string().min(9).max(20) }), req.body);
    const s = await getSettings();
    const c = await smsConfig();
    try {
      const sent = await sendSms(phone, fillTemplate(c.otpTemplate, { store: s.store.name, code: '123456', minutes: 5 }), { force: true });
      out = { ok: sent.delivered, results: [{ ok: sent.delivered, message: sent.delivered ? `ส่ง SMS ทดสอบไปที่ ${phone} แล้ว` : sent.reason }] };
    } catch (e) {
      out = { ok: false, results: [{ ok: false, message: e.message }] };
    }
  } else if (section === 'slip') {
    const t = await testSlipProvider();
    out = { ok: t.ok, results: [t] };
  } else if (section === 'tuya') {
    // test what is typed on the screen (saved values fill in what was left empty)
    const b = parse(z.object({ endpoint: z.string().url().max(200).optional(), accessId: z.string().max(100).optional(), accessSecret: z.string().max(200).optional().nullable() }), req.body || {});
    const t = await tuyaTest({ endpoint: b.endpoint, accessId: b.accessId, accessSecret: b.accessSecret || undefined });
    out = { ok: t.ok, results: [t] };
  } else if (section === 'terminal') {
    const { cfg, adapter } = await getTerminal();
    const t = adapter ? await adapter.test(cfg).catch((e) => ({ ok: false, message: e.message })) : { ok: true, message: 'ไม่ได้ใช้เครื่องชำระเงิน — QR จะแสดงบนจอลูกค้า' };
    out = { ok: t.ok, results: [t] };
  } else throw notFound();
  await logActivity(null, req, 'INTEGRATION_TEST', 'integration', section, { ok: out.ok });
  res.json(out);
});

// Upload a real slip to see what the system reads from it (QR, bank, provider answer) — nothing is saved.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
r.post('/integrations/slip/test-image', can('settings.manage'), upload.single('slip'), async (req, res) => {
  if (!req.file) throw badRequest('กรุณาเลือกรูปสลิป');
  const settings = await getSettings();
  const v = await verifySlip({ buffer: req.file.buffer, mime: req.file.mimetype, expectedAmount: req.body.amount ? Number(req.body.amount) : null, settings, dryRun: true });
  res.json({ ok: v.ok, mode: v.mode, provider: v.provider, reason: v.reason || null, qr: v.qr, transactionRef: v.transactionRef, amount: v.amount ?? null, paidAt: v.paidAt ?? null, receiver: v.receiver || null, sender: v.sender || null });
});

// ── Payment terminal (EDC / Beam Bolt) ──
r.get('/terminal/methods', async (_req, res) => {
  const { cfg } = await getTerminal();
  res.json({ provider: cfg.provider, methods: await terminalMethods() });
});

function terminalToken(row, employeeId) {
  return signToken({ typ: 'slip', orderId: row.order_id, depositRef: null, amount: Number(row.amount), method: row.method === 'CARD' ? 'CARD' : 'QR', mode: 'TERMINAL', ref: row.approval_code || row.provider_ref || row.id, eid: employeeId }, '30m');
}

async function refreshTerminal(row) {
  if (row.status !== 'PENDING' || !row.provider_ref) return row;
  const { cfg, adapter } = await getTerminal();
  if (!adapter || row.provider !== cfg.provider) return row;
  const st = await adapter.status(cfg, row.provider_ref).catch(() => ({ status: 'PENDING' }));
  const expired = Date.now() - new Date(row.created_at).getTime() > Number(cfg.timeoutSeconds || 180) * 1000 + 60000;
  const status = st.status !== 'PENDING' ? st.status : expired && row.provider !== 'manual' ? 'EXPIRED' : 'PENDING';
  if (status === row.status) return row;
  return (await one(`UPDATE terminal_payments SET status = $2, approval_code = COALESCE($3, approval_code), raw = COALESCE($4, raw), updated_at = now() WHERE id = $1 AND status = 'PENDING' RETURNING *`, [row.id, status, st.approvalCode || null, st.raw || null])) || row;
}

r.post('/terminal/payments', can('pos.access'), async (req, res) => {
  const b = parse(z.object({ orderId: z.coerce.number().int().optional().nullable(), amount: z.coerce.number().positive(), method: z.enum(['QR', 'CARD']), reference: z.string().max(100).optional().nullable() }), req.body);
  const { cfg, adapter } = await getTerminal();
  if (!adapter || !(await terminalMethods()).includes(b.method)) throw conflict('ยังไม่ได้ตั้งค่าเครื่องชำระเงินสำหรับช่องทางนี้');
  const order = b.orderId ? await one('SELECT id, order_no, status FROM orders WHERE id = $1', [b.orderId]) : null;
  if (b.orderId && (!order || order.status !== 'OPEN')) throw conflict('บิลนี้ชำระเงินแล้วหรือไม่พบบิล');
  let row = await one(`INSERT INTO terminal_payments(provider, order_id, reference, amount, method, employee_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [cfg.provider, b.orderId || null, b.reference || order?.order_no || null, b.amount, b.method, req.employee.id]);
  try {
    const out = await adapter.create(cfg, { amount: b.amount, method: b.method, reference: `${row.reference || 'POS'}-${row.id.slice(0, 8)}`, paymentId: row.id });
    row = await one(`UPDATE terminal_payments SET provider_ref = $2, deep_link = $3, status = $4, approval_code = $5, raw = $6, updated_at = now() WHERE id = $1 RETURNING *`, [row.id, out.providerRef, out.deepLink || null, out.status || 'PENDING', out.approvalCode || null, out.raw || {}]);
  } catch (e) {
    await pool.query(`UPDATE terminal_payments SET status = 'ERROR', error = $2, updated_at = now() WHERE id = $1`, [row.id, e.message]);
    throw badRequest(`ส่งยอดไปเครื่องชำระเงินไม่สำเร็จ: ${e.message}`);
  }
  await logActivity(null, req, 'TERMINAL_PAYMENT_START', 'order', b.orderId, { provider: cfg.provider, amount: b.amount, method: b.method, id: row.id });
  res.json({ ...row, verificationToken: row.status === 'APPROVED' ? terminalToken(row, req.employee.id) : null });
});

r.get('/terminal/payments/:id', can('pos.access'), async (req, res) => {
  let row = await one('SELECT * FROM terminal_payments WHERE id = $1', [req.params.id]);
  if (!row) throw notFound();
  row = await refreshTerminal(row);
  res.json({ ...row, raw: undefined, verificationToken: row.status === 'APPROVED' ? terminalToken(row, req.employee.id) : null });
});

/** Cashier confirms a terminal payment manually (approval code from the EDC slip). Logged. */
r.post('/terminal/payments/:id/confirm', can('slip.verify'), async (req, res) => {
  const { approvalCode } = parse(z.object({ approvalCode: z.string().trim().min(3, 'กรุณากรอกรหัสอนุมัติ (Approval Code) จากเครื่อง EDC').max(50) }), req.body);
  const row = await one(`UPDATE terminal_payments SET status = 'APPROVED', approval_code = $2, confirmed_manually_by = $3, updated_at = now() WHERE id = $1 AND status IN ('PENDING','ERROR','EXPIRED') RETURNING *`, [req.params.id, approvalCode, req.employee.id]);
  if (!row) throw conflict('รายการนี้ไม่สามารถยืนยันได้');
  await logActivity(null, req, 'TERMINAL_PAYMENT_MANUAL_CONFIRM', 'order', row.order_id, { id: row.id, approvalCode, amount: row.amount });
  res.json({ ...row, raw: undefined, verificationToken: terminalToken(row, req.employee.id) });
});

r.post('/terminal/payments/:id/cancel', can('pos.access'), async (req, res) => {
  const row = await one(`UPDATE terminal_payments SET status = 'CANCELLED', updated_at = now() WHERE id = $1 AND status = 'PENDING' RETURNING *`, [req.params.id]);
  if (row?.provider_ref) {
    const { cfg, adapter } = await getTerminal();
    if (adapter && row.provider === cfg.provider) await adapter.cancel(cfg, row.provider_ref);
  }
  res.json({ ok: true });
});

/** Beam webhook: the payload is not trusted — it only triggers a status re-check against the Beam API. */
export const terminalPublic = Router();
terminalPublic.post('/terminal/beam/webhook', async (req, res) => {
  const b = req.body || {};
  const ids = [b.id, b.boltIntentId, b.data?.id, b.data?.boltIntentId, b.data?.referenceId, b.referenceId].filter((x) => typeof x === 'string' && x.length < 200);
  for (const id of ids) {
    if (!(await useStoreOf('terminal_payments', 'provider_ref', id))) continue;
    const row = await one(`SELECT * FROM terminal_payments WHERE provider = 'beam' AND provider_ref = $1`, [id]);
    if (row) {
      const u = await refreshTerminal(row);
      if (u.status !== row.status) emitSync(['terminal'], { terminalPaymentId: u.id, status: u.status });
    }
  }
  res.json({ received: true });
});

/**
 * SMS delivery reports (DLR): the provider calls this address after each SMS (POST JSON / form, or GET). The random key
 * in the address proves the call is for this store. The report is kept on the matching SMS (same phone, last 2 days):
 * delivered stays SENT, a failure turns it FAILED with the provider's reason.
 */
const pick = (o, keys) => keys.map((k) => o?.[k]).find((v) => v != null && v !== '');
async function smsReport(req, res) {
  const integ = await getIntegrations();
  const key = String(req.query.key || '');
  const want = integ.sms.callbackKey || '';
  if (!want || key.length !== want.length || !crypto.timingSafeEqual(Buffer.from(key), Buffer.from(want))) return res.status(401).json({ error: 'bad key' });
  const items = Array.isArray(req.body) ? req.body : Array.isArray(req.body?.data) ? req.body.data : [{ ...req.query, ...(req.body || {}) }];
  let matched = 0;
  for (const it of items.slice(0, 100)) {
    const raw = String(pick(it, ['msisdn', 'to', 'To', 'phone', 'number', 'destination', 'recipient', 'mobile']) || '').replace(/\D/g, '');
    if (raw.length < 9) continue;
    const phone = raw.startsWith('66') ? `0${raw.slice(2)}` : raw;
    const status = String(pick(it, ['status', 'Status', 'MessageStatus', 'SmsStatus', 'delivery_status', 'dlr_status', 'state']) || 'unknown');
    const failed = /fail|undeliv|reject|expired|error|invalid|blocked/i.test(status);
    const n = await one(
      `UPDATE notifications SET data = data || $2::jsonb, status = CASE WHEN $3 THEN 'FAILED' ELSE status END, error = CASE WHEN $3 THEN $4 ELSE error END
       WHERE id = (SELECT id FROM notifications WHERE channel = 'SMS' AND data->>'phone' = $1 AND created_at > now() - interval '2 days' ORDER BY id DESC LIMIT 1) RETURNING id`,
      [phone, JSON.stringify({ delivery: { status, at: new Date().toISOString(), id: pick(it, ['id', 'message_id', 'MessageSid', 'messageId', 'sms_id']) || null } }), failed, `ผู้ให้บริการ SMS แจ้ง: ${status}`],
    );
    if (n) matched++;
  }
  res.json({ ok: true, matched });
}
terminalPublic.post('/sms/webhook', express.urlencoded({ extended: false, limit: '256kb' }), smsReport);
terminalPublic.get('/sms/webhook', smsReport);

export { refreshTerminal };
export default r;

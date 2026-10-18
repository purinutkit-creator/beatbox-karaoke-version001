import { Router } from 'express';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import multer from 'multer';
import { pool, many, one, runAsPlatform } from '../db/index.js';
import { requireAuth, can } from '../lib/auth.js';
import { logActivity } from '../lib/activity.js';
import { z, parse } from '../lib/validate.js';
import { notFound, badRequest } from '../lib/errors.js';
import { emitSync } from '../lib/realtime.js';
import { notify } from '../services/notifications.js';
import { getSettings, saveSettingsSection } from '../services/settings.js';
import { DOC_TYPES, DEFAULT_ROUTING } from '@beatbox/shared/documents.js';
import { saveFile } from '../services/files.js';

// built-in kitchen alert sounds (played by the web app); anything else is an uploaded / recorded file
export const ALERT_SOUNDS = ['beep', 'ding', 'bell', 'chime', 'alarm', 'pop', 'speech'];
const SOUND_FILE = /^\/uploads\/media\/[0-9a-f-]{36}\.\w+$/i;

const r = Router();
r.use(requireAuth);

const schema = z.object({
  name: z.string().min(1).max(100),
  connection: z.enum(['BROWSER', 'USB', 'BLUETOOTH', 'SERIAL', 'NETWORK']),
  address: z.string().max(200).optional().nullable(),
  port: z.coerce.number().int().min(1).max(65535).default(9100),
  station: z.enum(['MAIN', 'KITCHEN', 'BAR', 'PREP']).default('MAIN'),
  paperWidth: z.coerce.number().int().default(80),
  density: z.coerce.number().int().min(1).max(15).default(8),
  // 0 = leave the printer as it is · 1 slowest … 9 fastest (ESC/POS speed command + paced sending)
  speed: z.coerce.number().int().min(0).max(9).default(0),
  marginMm: z.coerce.number().min(0).max(10).default(2),
  copies: z.coerce.number().int().min(1).max(5).default(1),
  autoPrint: z.boolean().default(true),
  autoCut: z.boolean().default(true),
  openDrawer: z.boolean().default(true),
  isDefault: z.boolean().default(false),
  isActive: z.boolean().default(true),
  deviceId: z.coerce.number().int().optional().nullable(),
  // real paper geometry (fixes receipts printing too small): paper width, printable width, margins, font scale
  printableWidthMm: z.coerce.number().min(20).max(210).optional().nullable(),
  marginLeftMm: z.coerce.number().min(0).max(20).default(0),
  marginRightMm: z.coerce.number().min(0).max(20).default(0),
  marginTopMm: z.coerce.number().min(0).max(30).default(0),
  marginBottomMm: z.coerce.number().min(0).max(30).default(3),
  fontScale: z.coerce.number().min(0.5).max(3).default(1),
  // DRIVER = OS driver (real text with the store's font); ESCPOS_TEXT = printer's own built-in fonts (needs explicit acceptance)
  // DRIVER = OS driver (real text); RASTER = direct USB/Serial/Bluetooth/Network with the store font (sent as an image, like before);
  // ESCPOS_TEXT = printer's own fonts
  renderMode: z.enum(['DRIVER', 'RASTER', 'ESCPOS_TEXT']).default('DRIVER'),
  usbVendorId: z.coerce.number().int().optional().nullable(),
  usbProductId: z.coerce.number().int().optional().nullable(),
  usbSerial: z.string().max(200).optional().nullable(),
  allowPrinterFont: z.boolean().default(false),
  escposCodepage: z.coerce.number().int().min(0).max(255).optional().nullable(),
  charsPerLine: z.coerce.number().int().min(16).max(80).optional().nullable(),
  model: z.string().max(100).optional().nullable(),
  beepKitchen: z.boolean().default(true),
  beepTimes: z.coerce.number().int().min(1).max(9).default(3),
  // kitchen / bar ticket alert: printer buzzer, a sound on the device that prints, both, or none
  kitchenAlert: z.enum(['OFF', 'PRINTER', 'DEVICE', 'BOTH']).optional(),
  alertSound: z.string().trim().max(300).refine((v) => ALERT_SOUNDS.includes(v) || SOUND_FILE.test(v), 'เสียงแจ้งเตือนไม่ถูกต้อง').default('beep'),
  alertSoundName: z.string().trim().max(80).optional().nullable(),
  alertVolume: z.coerce.number().int().min(0).max(100).default(80),
  alertOrder: z.enum(['BEFORE', 'AFTER']).default('BEFORE'),
});
const cols = (b) => [
  b.name, b.connection, b.address, b.port, b.station, b.paperWidth, b.density, b.speed, b.marginMm, b.copies, b.autoPrint, b.autoCut, b.openDrawer, b.isDefault, b.isActive, b.deviceId ?? null,
  b.printableWidthMm ?? null, b.marginLeftMm, b.marginRightMm, b.marginTopMm, b.marginBottomMm, b.fontScale, b.renderMode, b.allowPrinterFont, b.escposCodepage ?? null, b.charsPerLine ?? null, b.model || null,
  b.usbVendorId ?? null, b.usbProductId ?? null, b.usbSerial || null, b.beepKitchen, b.beepTimes,
  b.kitchenAlert, b.alertSound, SOUND_FILE.test(b.alertSound) ? b.alertSoundName || null : null, b.alertVolume, b.alertOrder,
];

/** Pick a print route that works for the connection (never refuse a USB printer like the previous update did). */
function checkRoute(b) {
  // older screens only send beepKitchen
  b.kitchenAlert ??= b.beepKitchen ? 'PRINTER' : 'OFF';
  b.beepKitchen = ['PRINTER', 'BOTH'].includes(b.kitchenAlert);
  if (b.paperWidth < 30 || b.paperWidth > 210) throw badRequest('ความกว้างกระดาษต้องอยู่ระหว่าง 30–210 มม.');
  if (b.printableWidthMm && b.printableWidthMm > b.paperWidth) throw badRequest('พื้นที่พิมพ์ต้องไม่กว้างกว่ากระดาษ');
  const raw = b.connection !== 'BROWSER';
  // a direct connection prints the store font as before; the OS-driver connection always uses the driver
  if (raw && b.renderMode === 'DRIVER') b.renderMode = 'RASTER';
  if (!raw) b.renderMode = 'DRIVER';
  if (b.renderMode === 'ESCPOS_TEXT' && !b.allowPrinterFont) {
    throw badRequest('โหมด ESC/POS ข้อความจะพิมพ์ด้วยฟอนต์ในเครื่องพิมพ์ ไม่ใช่ฟอนต์ที่ตั้งไว้ กรุณายืนยัน "ยอมรับการใช้ฟอนต์ของเครื่องพิมพ์" ก่อน', 'PRINTER_FONT_NOT_ACCEPTED');
  }
}

r.get('/printers', async (_req, res) => res.json(await many('SELECT * FROM printers WHERE deleted_at IS NULL ORDER BY is_default DESC, id')));

r.post('/printers', can('settings.manage'), async (req, res) => {
  const b = parse(schema, req.body);
  if (b.connection === 'NETWORK' && !b.address) throw badRequest('กรุณาระบุ IP Address');
  checkRoute(b);
  if (b.isDefault) await pool.query('UPDATE printers SET is_default = false WHERE station = $1', [b.station]);
  const row = await one(
    `INSERT INTO printers(name, connection, address, port, station, paper_width, density, speed, margin_mm, copies, auto_print, auto_cut, open_drawer, is_default, is_active, device_id,
       printable_width_mm, margin_left_mm, margin_right_mm, margin_top_mm, margin_bottom_mm, font_scale, render_mode, allow_printer_font, escpos_codepage, chars_per_line, model,
       usb_vendor_id, usb_product_id, usb_serial, beep_kitchen, beep_times, kitchen_alert, alert_sound, alert_sound_name, alert_volume, alert_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37) RETURNING *`,
    cols(b),
  );
  await logActivity(null, req, 'PRINTER_CREATE', 'printer', row.id, b);
  emitSync('printers');
  res.json(row);
});

r.put('/printers/:id', can('settings.manage'), async (req, res) => {
  const b = parse(schema, req.body);
  checkRoute(b);
  if (b.isDefault) await pool.query('UPDATE printers SET is_default = false WHERE station = $1 AND id <> $2', [b.station, req.params.id]);
  const row = await one(
    `UPDATE printers SET name=$2, connection=$3, address=$4, port=$5, station=$6, paper_width=$7, density=$8, speed=$9, margin_mm=$10, copies=$11,
       auto_print=$12, auto_cut=$13, open_drawer=$14, is_default=$15, is_active=$16, device_id=$17,
       printable_width_mm=$18, margin_left_mm=$19, margin_right_mm=$20, margin_top_mm=$21, margin_bottom_mm=$22, font_scale=$23, render_mode=$24,
       allow_printer_font=$25, escpos_codepage=$26, chars_per_line=$27, model=$28,
       usb_vendor_id=COALESCE($29, usb_vendor_id), usb_product_id=COALESCE($30, usb_product_id), usb_serial=COALESCE($31, usb_serial),
       beep_kitchen=$32, beep_times=$33, kitchen_alert=$34, alert_sound=$35, alert_sound_name=$36, alert_volume=$37, alert_order=$38
     WHERE id=$1 AND deleted_at IS NULL RETURNING *`,
    [req.params.id, ...cols(b)],
  );
  if (!row) throw notFound();
  await logActivity(null, req, 'PRINTER_UPDATE', 'printer', req.params.id, b);
  await cleanupSounds();
  emitSync('printers');
  res.json(row);
});

// ── Kitchen alert sounds: uploaded files or recordings made in the browser (served at /uploads/media like slides) ──
const SOUND_MIME = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.webm': 'audio/webm' };
const soundUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (_req, f, cb) => (SOUND_MIME[path.extname(f.originalname).toLowerCase()] ? cb(null, true) : cb(Object.assign(new Error('รองรับเฉพาะไฟล์เสียง .mp3 .wav .ogg .m4a .aac .webm'), { status: 400 }))),
});

/** Remove sound files no printer of any store uses any more (kept for an hour so a form still open can be saved). */
async function cleanupSounds() {
  await runAsPlatform(() =>
    pool.query(
      `DELETE FROM stored_files f WHERE f.kind = 'SOUND' AND f.created_at < now() - interval '1 hour'
       AND NOT EXISTS (SELECT 1 FROM printers p WHERE p.deleted_at IS NULL AND p.alert_sound LIKE '/uploads/media/' || f.id || '.%')`,
    ),
  );
}

r.post('/printers/sounds', can('settings.manage'), (req, res, next) => soundUpload.single('file')(req, res, (e) => (e ? res.status(400).json({ error: e.code === 'LIMIT_FILE_SIZE' ? 'ไฟล์เสียงใหญ่เกินไป (ไม่เกิน 3 MB)' : e.message }) : next())), async (req, res) => {
  if (!req.file) throw badRequest('กรุณาเลือกไฟล์เสียง');
  const ext = path.extname(req.file.originalname).toLowerCase();
  await cleanupSounds();
  const file = await saveFile(null, { kind: 'SOUND', name: req.file.originalname, mime: SOUND_MIME[ext], buffer: req.file.buffer });
  await logActivity(null, req, 'ALERT_SOUND_UPLOAD', 'printer', null, { name: req.file.originalname, size: req.file.size });
  res.json({ url: `/uploads/media/${file.id}${ext}`, name: String(req.body?.name || req.file.originalname.replace(/\.[^.]+$/, '')).slice(0, 80) });
});

/** Delete a printer: it disappears from every list and from document routing (past print jobs keep their history). */
r.delete('/printers/:id', can('settings.manage'), async (req, res) => {
  const p = await one('UPDATE printers SET deleted_at = now(), is_active = false, is_default = false WHERE id = $1 AND deleted_at IS NULL RETURNING id, name', [req.params.id]);
  if (!p) throw notFound('ไม่พบเครื่องพิมพ์');
  const s = await getSettings();
  const routing = { ...(s.documents?.routing || {}) };
  let changed = false;
  for (const [k, v] of Object.entries(routing)) {
    if (Number(v?.printerId) === p.id) {
      routing[k] = { ...v, printerId: null };
      changed = true;
    }
  }
  if (changed) await saveSettingsSection(pool, 'documents', { ...s.documents, routing }, req.employee.id);
  await logActivity(null, req, 'PRINTER_DELETE', 'printer', p.id, { name: p.name });
  emitSync(['printers', 'settings']);
  res.json({ ok: true });
});

/** "ใช้เครื่องนี้กับทุกเอกสาร": the main printer of the store and the route of every document type. */
r.post('/printers/:id/use-for-all', can('settings.manage'), async (req, res) => {
  const p = await one('SELECT * FROM printers WHERE id = $1 AND deleted_at IS NULL', [req.params.id]);
  if (!p) throw notFound('ไม่พบเครื่องพิมพ์');
  await pool.query('UPDATE printers SET is_default = (id = $1) WHERE deleted_at IS NULL', [p.id]);
  await pool.query(`UPDATE printers SET is_active = true, station = 'MAIN' WHERE id = $1`, [p.id]);
  const s = await getSettings();
  const routing = Object.fromEntries(DOC_TYPES.map((d) => [d.key, { ...DEFAULT_ROUTING[d.key], ...(s.documents?.routing?.[d.key] || {}), printerId: p.id }]));
  await saveSettingsSection(pool, 'documents', { ...s.documents, routing }, req.employee.id);
  await logActivity(null, req, 'PRINTER_USE_FOR_ALL', 'printer', p.id, { name: p.name });
  emitSync(['printers', 'settings']);
  res.json({ ok: true, routing });
});

function tcpProbe(host, port, timeout = 1200) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host, port });
    const done = (ok) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeout, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}

function tcpSend(host, port, data, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ host, port }, () => {
      s.end(data, () => resolve(true));
    });
    s.setTimeout(timeout, () => {
      s.destroy();
      reject(new Error('หมดเวลาเชื่อมต่อเครื่องพิมพ์'));
    });
    s.on('error', (e) => reject(new Error(`เชื่อมต่อเครื่องพิมพ์ไม่ได้: ${e.message}`)));
  });
}

/** Status check (Network printers are probed from the server; others report via the browser). */
r.post('/printers/:id/status', async (req, res) => {
  const p = await one('SELECT * FROM printers WHERE id = $1', [req.params.id]);
  if (!p) throw notFound();
  let status = req.body?.status || 'UNKNOWN';
  if (p.connection === 'NETWORK') status = (await tcpProbe(p.address, p.port)) ? 'ONLINE' : 'OFFLINE';
  await pool.query('UPDATE printers SET status = $2, last_seen_at = CASE WHEN $2 = \'ONLINE\' THEN now() ELSE last_seen_at END WHERE id = $1', [p.id, status]);
  if (status === 'OFFLINE' && p.status !== 'OFFLINE') await notify({ type: 'PRINTER_OFFLINE', level: 'error', title: 'Printer Offline', message: `เครื่องพิมพ์ ${p.name} ไม่ได้เชื่อมต่อ`, dedupeKey: `printer-offline:${p.id}:${Math.floor(Date.now() / 600000)}` });
  emitSync('printers');
  res.json({ status });
});

/** Discover network (ESC/POS RAW :9100) printers on the server's local subnet. */
r.post('/printers/discover', can('settings.manage'), async (req, res) => {
  let base = req.body?.subnet;
  if (!base) {
    const ifs = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
    base = ifs ? ifs.address.split('.').slice(0, 3).join('.') : '192.168.1';
  }
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(base)) throw badRequest('Subnet ไม่ถูกต้อง เช่น 192.168.1');
  const port = Number(req.body?.port || 9100);
  const hosts = Array.from({ length: 254 }, (_, i) => `${base}.${i + 1}`);
  const found = [];
  for (let i = 0; i < hosts.length; i += 64) {
    const batch = hosts.slice(i, i + 64);
    const results = await Promise.all(batch.map((h) => tcpProbe(h, port, 600).then((ok) => (ok ? h : null))));
    found.push(...results.filter(Boolean));
  }
  res.json({ subnet: base, port, printers: found.map((ip) => ({ name: `Network Printer ${ip}`, connection: 'NETWORK', address: ip, port })) });
});

/**
 * Send ESC/POS *text* bytes (base64, built by the browser from the document: printer-resident fonts, native QR command)
 * to a network printer. Nothing is rasterized here; the job row is the one the browser queue created.
 */
r.post('/printers/:id/raw', async (req, res) => {
  const { data, jobId } = parse(z.object({ data: z.string().min(1), jobId: z.coerce.number().int().optional().nullable() }), req.body);
  const p = await one('SELECT * FROM printers WHERE id = $1', [req.params.id]);
  if (!p) throw notFound();
  if (p.connection !== 'NETWORK') throw badRequest('เครื่องพิมพ์นี้ไม่ใช่ Network Printer');
  if (p.render_mode === 'DRIVER') throw badRequest('เครื่องพิมพ์นี้ตั้งเป็นไดรเวอร์ระบบ', 'PRINT_ROUTE_UNSUPPORTED');
  try {
    await tcpSend(p.address, p.port, Buffer.from(data, 'base64'));
    await pool.query(`UPDATE printers SET status = 'ONLINE', last_seen_at = now() WHERE id = $1`, [p.id]);
    res.json({ ok: true, jobId: jobId || null });
  } catch (e) {
    await pool.query(`UPDATE printers SET status = 'OFFLINE' WHERE id = $1`, [p.id]);
    await notify({ type: 'PRINTER_OFFLINE', level: 'error', title: 'Printer Offline', message: `${p.name}: ${e.message}`, dedupeKey: `printer-offline:${p.id}:${Math.floor(Date.now() / 600000)}` });
    res.status(502).json({ error: e.message, code: 'PRINTER_OFFLINE', jobId: jobId || null });
  }
});

r.get('/print-jobs', async (req, res) => {
  const rows = await many(
    `SELECT pj.id, pj.printer_id, pj.job_type, pj.doc_type, pj.reference, pj.is_copy, pj.status, pj.error, pj.copies, pj.attempts, pj.reprint_of, pj.source,
            pj.created_at, pj.printed_at, pj.updated_at, pj.client_job_id, p.name AS printer_name, e.name AS employee_name,
            CASE WHEN $2 THEN pj.payload END AS payload
     FROM print_jobs pj LEFT JOIN printers p ON p.id = pj.printer_id LEFT JOIN employees e ON e.id = pj.employee_id
     WHERE ($1::text IS NULL OR pj.status = ANY(string_to_array($1, ','))) ORDER BY pj.id DESC LIMIT 200`,
    [req.query.status || null, req.query.payload === '1' || req.query.status === 'QUEUED'],
  );
  res.json(rows);
});

const jobSchema = z.object({
  clientJobId: z.string().max(120).optional().nullable(),
  printerId: z.coerce.number().int().optional().nullable(),
  jobType: z.string().max(40).optional(),
  docType: z.string().max(40).optional().nullable(),
  reference: z.string().max(120).optional().nullable(),
  isCopy: z.boolean().default(false),
  copies: z.coerce.number().int().min(1).max(10).default(1),
  status: z.enum(['PRINTED', 'FAILED', 'QUEUED', 'PRINTING']).default('PRINTING'),
  error: z.string().max(1000).optional().nullable(),
  payload: z.any().optional(),
  reprintOf: z.coerce.number().int().optional().nullable(),
});

/** Record a print job (the browser queue prints jobs one by one, in order). clientJobId makes it idempotent (no duplicates). */
r.post('/print-jobs', async (req, res) => {
  const b = parse(jobSchema, req.body);
  if (b.clientJobId) {
    const ex = await one('SELECT * FROM print_jobs WHERE client_job_id = $1', [b.clientJobId]);
    if (ex) return res.json({ ...ex, duplicate: true });
  }
  const row = await one(
    `INSERT INTO print_jobs(printer_id, job_type, doc_type, reference, is_copy, copies, status, error, payload, employee_id, device_id, client_job_id, reprint_of, attempts, printed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, CASE WHEN $7 IN ('PRINTING','PRINTED','FAILED') THEN 1 ELSE 0 END, CASE WHEN $7 = 'PRINTED' THEN now() END)
     ON CONFLICT (store_id, client_job_id) WHERE client_job_id IS NOT NULL DO UPDATE SET updated_at = now() RETURNING *`,
    [b.printerId || null, b.jobType || b.docType || 'DOCUMENT', b.docType || null, b.reference, b.isCopy, b.copies, b.status, b.error, b.payload ?? null, req.employee.id, req.deviceId || null, b.clientJobId || null, b.reprintOf || null],
  );
  if (b.status === 'FAILED') await printerFailed(b.printerId, b.error);
  emitSync('print-jobs');
  res.json(row);
});

async function printerFailed(printerId, error) {
  if (!printerId) return;
  await pool.query(`UPDATE printers SET status = 'OFFLINE' WHERE id = $1`, [printerId]);
  await notify({ type: 'PRINTER_OFFLINE', level: 'error', title: 'พิมพ์ไม่สำเร็จ', message: error || 'พิมพ์ไม่สำเร็จ', dedupeKey: `printer-offline:${printerId}:${Math.floor(Date.now() / 600000)}` });
}

/** Reprint: the same document data again, marked "สำเนา". Never creates a bill, a payment or a room opening. */
r.post('/print-jobs/:id/reprint', async (req, res) => {
  const job = await one('SELECT * FROM print_jobs WHERE id = $1', [req.params.id]);
  if (!job) throw notFound();
  if (!job.payload) throw badRequest('งานพิมพ์นี้ไม่มีข้อมูลเอกสารให้พิมพ์ซ้ำ');
  if ((job.doc_type || job.job_type) === 'RECEIPT' && !req.permissions.has('receipt.reprint')) throw badRequest('คุณไม่มีสิทธิ์พิมพ์ใบเสร็จซ้ำ', 'FORBIDDEN');
  await logActivity(null, req, 'PRINT_REPRINT', 'print_job', job.id, { docType: job.doc_type, reference: job.reference });
  res.json({ id: job.id, docType: job.doc_type || job.job_type, reference: job.reference, payload: job.payload, printerId: job.printer_id, copies: job.copies });
});

/** A POS device claims a server-queued job (e.g. kitchen ticket of an in-room QR order) so it prints exactly once. */
r.post('/print-jobs/:id/claim', async (req, res) => {
  const device = String(req.body?.device || req.deviceId || req.employee.id).slice(0, 100);
  const row = await one(`UPDATE print_jobs SET status = 'PRINTING', claimed_by = $2, claimed_at = now() WHERE id = $1 AND (status = 'QUEUED' OR (status = 'PRINTING' AND claimed_at < now() - interval '2 minutes')) RETURNING *`, [req.params.id, device]);
  res.json(row ? { claimed: true, job: row } : { claimed: false });
});

r.patch('/print-jobs/:id', async (req, res) => {
  const b = parse(z.object({ status: z.enum(['PRINTING', 'PRINTED', 'FAILED', 'CANCELLED']), error: z.string().max(1000).optional().nullable(), printerId: z.coerce.number().int().optional().nullable() }), req.body);
  const row = await one(
    `UPDATE print_jobs SET status = $2, error = $3, printer_id = COALESCE($4, printer_id), attempts = attempts + CASE WHEN $2 = 'PRINTING' THEN 1 ELSE 0 END,
       printed_at = CASE WHEN $2 = 'PRINTED' THEN now() ELSE printed_at END, updated_at = now() WHERE id = $1 RETURNING *`,
    [req.params.id, b.status, b.error || null, b.printerId || null],
  );
  if (!row) throw notFound();
  if (b.status === 'FAILED') await printerFailed(row.printer_id, b.error);
  if (b.status === 'PRINTED' && row.printer_id) await pool.query(`UPDATE printers SET status = 'ONLINE', last_seen_at = now() WHERE id = $1`, [row.printer_id]);
  emitSync('print-jobs');
  res.json(row);
});

export default r;

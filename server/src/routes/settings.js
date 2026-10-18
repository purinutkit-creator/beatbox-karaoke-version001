import { Router } from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import multer from 'multer';
import { pool, tx, many, one, runAsPlatform } from '../db/index.js';
import { requireAuth, can } from '../lib/auth.js';
import { logActivity } from '../lib/activity.js';
import { z, parse, zUrl } from '../lib/validate.js';
import { getSettings, saveSettingsSection, DEFAULT_SETTINGS, invalidateSettings } from '../services/settings.js';
import { emitSync, displayOnline } from '../lib/realtime.js';
import { notFound, badRequest, forbidden } from '../lib/errors.js';
import { getSubscription, hasFeature, assertLimit } from '../services/subscription.js';
import { runBackup, listBackups } from '../services/backup.js';
import { saveFile } from '../services/files.js';

const r = Router();
r.use(requireAuth);

r.get('/settings', async (_req, res) => {
  res.json(await getSettings());
});

r.put('/settings/store', can('settings.manage'), async (req, res) => {
  const b = parse(
    z.object({
      name: z.string().min(1).max(200),
      logoUrl: zUrl,
      address: z.string().max(500).optional().nullable(),
      phone: z.string().max(50).optional().nullable(),
      taxId: z.string().max(30).optional().nullable(),
      slogan: z.string().max(300).optional().nullable(),
      currency: z.string().max(10).default('THB'),
      branchName: z.string().max(200).optional(),
      openTime: z.string().regex(/^\d{2}:\d{2}$/),
      closeTime: z.string().regex(/^\d{2}:\d{2}$/),
    }),
    req.body,
  );
  await tx(async (c) => {
    const before = await getSettings(c);
    await c.query(`UPDATE stores SET name=$1, logo_url=$2, address=$3, phone=$4, tax_id=$5, slogan=$6, currency=$7, updated_at=now() WHERE id = (SELECT id FROM stores ORDER BY id LIMIT 1)`, [b.name, b.logoUrl, b.address, b.phone, b.taxId, b.slogan, b.currency]);
    await c.query(`UPDATE branches SET name = COALESCE($1, name), open_time = $2, close_time = $3, address = $4, phone = $5 WHERE id = (SELECT id FROM branches ORDER BY sort_order, id LIMIT 1)`, [b.branchName || null, b.openTime, b.closeTime, b.address, b.phone]);
    await logActivity(c, req, 'SETTINGS_UPDATE', 'settings', 'store', { before: before.store, after: b });
  });
  invalidateSettings();
  emitSync('settings');
  res.json(await getSettings());
});

const isBadPaymentMode = (v) => v && v.paymentMode !== undefined && !['PREPAY', 'POSTPAY'].includes(v.paymentMode);

r.put('/settings/:section', can('settings.manage'), async (req, res) => {
  const section = req.params.section;
  if (!(section in DEFAULT_SETTINGS)) throw notFound('ไม่พบหมวดการตั้งค่า');
  // documents have their own validated endpoint (plan feature "receipt settings")
  if (section === 'documents') throw badRequest('กรุณาบันทึกผ่านหน้าออกแบบเอกสาร');
  const sectionFeature = { memberSignup: 'members', booking: 'booking', calendar: 'booking', receipt: 'receipt_settings' }[section];
  if (sectionFeature && !hasFeature(req.subscription, sectionFeature)) throw forbidden('แพ็กเกจปัจจุบันไม่รวมฟังก์ชันนี้ กรุณาอัปเกรดแพ็กเกจ');
  if (section === 'room' && isBadPaymentMode(req.body)) throw badRequest('โหมดการชำระค่าห้องไม่ถูกต้อง');
  const value = req.body || {};
  if (section === 'tax') {
    const t = parse(
      z.object({
        vatEnabled: z.boolean(),
        vatRate: z.coerce.number().min(0).max(100),
        vatMode: z.enum(['INCLUSIVE', 'EXCLUSIVE']),
        scEnabled: z.boolean(),
        scRate: z.coerce.number().min(0).max(100),
        scBase: z.enum(['ALL', 'ROOM', 'PRODUCT']),
        rounding: z.object({ mode: z.enum(['NONE', 'NEAREST', 'UP', 'DOWN']), unit: z.coerce.number().positive().max(100) }),
      }),
      value,
    );
    Object.assign(value, t);
  }
  if (section === 'queue') {
    parse(z.object({ prefix: z.string().max(20), digits: z.coerce.number().int().min(1).max(8), start: z.coerce.number().int().min(0), resetMode: z.enum(['DAILY', 'SHIFT', 'NEVER']) }).passthrough(), value);
  }
  if (section === 'payment' && value.qrImageUrl) parse(z.object({ qrImageUrl: zUrl }).passthrough(), value);
  if (section === 'general' && value.backgroundUrl) parse(z.object({ backgroundUrl: zUrl }).passthrough(), value);
  await tx(async (c) => {
    const before = (await getSettings(c))[section];
    await saveSettingsSection(c, section, value, req.employee.id);
    await logActivity(c, req, 'SETTINGS_UPDATE', 'settings', section, { before, after: value });
  });
  emitSync('settings');
  res.json(await getSettings());
});

/** Set the current / last queue number manually or reset it. */
r.post('/settings/queue/set', can('settings.manage'), async (req, res) => {
  const { lastNumber } = parse(z.object({ lastNumber: z.coerce.number().int().min(0) }), req.body);
  const s = await getSettings();
  const d = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
  const shift = await one(`SELECT id FROM shifts WHERE status = 'OPEN' ORDER BY id DESC LIMIT 1`);
  const period = s.queue.resetMode === 'DAILY' ? d : s.queue.resetMode === 'SHIFT' ? `shift-${shift?.id || 0}` : 'ALL';
  await pool.query(`INSERT INTO counters(name, period, value) VALUES ('queue',$1,$2) ON CONFLICT (store_id, name, period) DO UPDATE SET value = $2, updated_at = now()`, [period, lastNumber]);
  await logActivity(null, req, 'QUEUE_SET', 'settings', 'queue', { lastNumber, period });
  res.json({ ok: true, period, lastNumber });
});

r.get('/settings/queue/current', async (_req, res) => {
  const rows = await many(`SELECT period, value FROM counters WHERE name = 'queue' ORDER BY updated_at DESC LIMIT 1`);
  res.json(rows[0] || null);
});

// ── Branches ──
r.get('/branches', async (_req, res) => res.json(await many('SELECT * FROM branches ORDER BY sort_order, id')));
r.post('/branches', can('settings.manage'), async (req, res) => {
  const b = parse(z.object({ code: z.string().min(1), name: z.string().min(1), address: z.string().optional(), phone: z.string().optional(), openTime: z.string().default('12:00'), closeTime: z.string().default('02:00') }), req.body);
  const sub = await getSubscription();
  const count = Number((await one('SELECT count(*) AS n FROM branches')).n);
  if (count >= 1 && !hasFeature(sub, 'multi_branch')) throw forbidden('แพ็กเกจนี้ไม่รวมฟังก์ชันหลายสาขา กรุณาอัปเกรดแพ็กเกจ');
  await assertLimit(pool, 'branches', 'SELECT count(*) AS n FROM branches');
  const row = await one(`INSERT INTO branches(store_id, code, name, address, phone, open_time, close_time) VALUES (bb_current_store(),$1,$2,$3,$4,$5,$6) RETURNING *`, [b.code, b.name, b.address, b.phone, b.openTime, b.closeTime]);
  await logActivity(null, req, 'BRANCH_CREATE', 'branch', row.id, b);
  res.json(row);
});
r.put('/branches/:id', can('settings.manage'), async (req, res) => {
  const b = parse(z.object({ name: z.string().min(1), address: z.string().optional().nullable(), phone: z.string().optional().nullable(), openTime: z.string(), closeTime: z.string(), isActive: z.boolean().default(true) }), req.body);
  const row = await one(`UPDATE branches SET name=$2, address=$3, phone=$4, open_time=$5, close_time=$6, is_active=$7 WHERE id=$1 RETURNING *`, [req.params.id, b.name, b.address, b.phone, b.openTime, b.closeTime, b.isActive]);
  invalidateSettings();
  await logActivity(null, req, 'BRANCH_UPDATE', 'branch', req.params.id, b);
  res.json(row);
});

// ── POS devices ──
r.get('/devices', async (_req, res) => res.json(await many('SELECT d.*, cd.pair_code, cd.status AS display_status FROM pos_devices d LEFT JOIN customer_displays cd ON cd.device_id = d.id ORDER BY d.id')));

r.post('/devices/register', async (req, res) => {
  const b = parse(z.object({ name: z.string().min(1).max(100), deviceKey: z.string().min(8).max(100) }), req.body);
  const branch = await one('SELECT id FROM branches ORDER BY sort_order, id LIMIT 1');
  if (!(await one('SELECT id FROM pos_devices WHERE device_key = $1', [b.deviceKey]))) await assertLimit(pool, 'devices', 'SELECT count(*) AS n FROM pos_devices');
  const row = await one(
    `INSERT INTO pos_devices(name, device_key, branch_id, last_seen_at) VALUES ($1,$2,$3,now())
     ON CONFLICT (store_id, device_key) DO UPDATE SET last_seen_at = now(), name = COALESCE(NULLIF($1,''), pos_devices.name) RETURNING *`,
    [b.name, b.deviceKey, branch?.id || null],
  );
  res.json(row);
});

// ── Customer Display pairing ──
async function newPairCode(c) {
  for (let i = 0; i < 20; i++) {
    const code = String(crypto.randomInt(1000, 999999)).padStart(4, '0').slice(0, i < 10 ? 4 : 6);
    // pair codes are global (a display finds its store by the code) → check across all stores
    const ex = await runAsPlatform(() => pool.query('SELECT 1 FROM customer_displays WHERE pair_code = $1', [code]));
    if (!ex.rows[0]) return code;
  }
  throw badRequest('ไม่สามารถสร้างรหัสเชื่อมต่อได้');
}

r.get('/displays', async (_req, res) => {
  const rows = await many('SELECT cd.*, d.name AS device_name FROM customer_displays cd LEFT JOIN pos_devices d ON d.id = cd.device_id ORDER BY cd.id');
  res.json(rows.map((x) => ({ ...x, online: displayOnline(x.pair_code), last_state: undefined })));
});

/** Get (or create) the pair code of a POS device. regenerate=true rotates it. */
r.post('/displays/pair', async (req, res) => {
  const { deviceId, regenerate } = parse(z.object({ deviceId: z.coerce.number().int(), regenerate: z.boolean().default(false) }), req.body);
  const row = await tx(async (c) => {
    const ex = (await c.query('SELECT * FROM customer_displays WHERE device_id = $1', [deviceId])).rows[0];
    if (ex && !regenerate) return ex;
    const code = await newPairCode(c);
    if (ex) return (await c.query('UPDATE customer_displays SET pair_code = $2 WHERE id = $1 RETURNING *', [ex.id, code])).rows[0];
    return (await c.query('INSERT INTO customer_displays(device_id, pair_code, name) VALUES ($1,$2,$3) RETURNING *', [deviceId, code, `Display ${deviceId}`])).rows[0];
  });
  await pool.query('UPDATE pos_devices SET display_code = $2 WHERE id = $1', [deviceId, row.pair_code]);
  if (regenerate) await logActivity(null, req, 'DISPLAY_CODE_ROTATE', 'customer_display', row.id, { code: row.pair_code });
  res.json({ ...row, online: displayOnline(row.pair_code) });
});

// ── Promotion images (Customer Display / website banners) ──
const imgSchema = z.object({
  title: z.string().max(200).optional().nullable(),
  imageUrl: z.string().trim().min(1, 'กรุณาใส่ URL รูปภาพหรือวิดีโอ').max(2000).refine((v) => /^https?:\/\//i.test(v) || v.startsWith('/'), 'ต้องเป็น URL รูปภาพหรือวิดีโอ (http/https)'),
  mediaType: z.enum(['IMAGE', 'VIDEO']).default('IMAGE'),
  linkUrl: z.string().max(1000).optional().nullable(),
  durationSeconds: z.coerce.number().int().min(2).max(300).default(8),
  sortOrder: z.coerce.number().int().default(0),
  showOnDisplay: z.boolean().default(true),
  showOnWebsite: z.boolean().default(true),
  isActive: z.boolean().default(true),
});
// Pictures / videos uploaded for promotion slides. Kept in the database (the app server keeps nothing on disk)
// and served publicly at /uploads/media/<id>.<ext> — they are shown on the Customer Display and the website.
const MEDIA_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' };
const MEDIA_MAX = { IMAGE: 10 * 1024 * 1024, VIDEO: 40 * 1024 * 1024 };
const MEDIA_TOTAL_MAX = 500 * 1024 * 1024; // all uploaded slides together (the database has limited space)
const mediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MEDIA_MAX.VIDEO },
  fileFilter: (_req, f, cb) => (MEDIA_MIME[path.extname(f.originalname).toLowerCase()] ? cb(null, true) : cb(Object.assign(new Error('รองรับเฉพาะรูป .jpg .png .webp .gif หรือวิดีโอ .mp4 .webm .mov'), { status: 400 }))),
});
const mediaFileId = (url) => /^\/uploads\/media\/([0-9a-f-]{36})\.\w+$/i.exec(url || '')?.[1] || null;

/** Remove uploaded slide files no slide of any store uses any more (a replaced / deleted slide, or a cancelled form). */
async function cleanupMedia(graceMinutes = 60) {
  await runAsPlatform(() =>
    pool.query(
      `DELETE FROM stored_files f WHERE f.kind = 'PROMO_MEDIA' AND f.created_at < now() - make_interval(mins => $1)
       AND NOT EXISTS (SELECT 1 FROM promotion_images p WHERE p.image_url LIKE '/uploads/media/' || f.id || '.%')`,
      [graceMinutes],
    ),
  );
}

/** Public handler for /uploads/media — answers byte ranges, which iPad / Smart TV browsers need to play a video. */
export async function serveMedia(req, res, next) {
  const id = mediaFileId(`/uploads/media/${req.params.name}`);
  if (!id) return next();
  const f = await one(`SELECT mime, octet_length(data) AS size FROM stored_files WHERE id = $1 AND kind = 'PROMO_MEDIA'`, [id]).catch(() => null);
  if (!f) return next();
  const size = Number(f.size);
  res.set({ 'Content-Type': f.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=31536000, immutable', 'Access-Control-Allow-Origin': '*' });
  let start = 0;
  let end = size - 1;
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] !== '' || m[2] !== '')) {
    if (m[1] === '') start = Math.max(0, size - Number(m[2]));
    else {
      start = Number(m[1]);
      if (m[2] !== '') end = Math.min(end, Number(m[2]));
    }
    end = Math.min(end, start + 4 * 1024 * 1024 - 1); // at most 4 MB per answer, the player asks for the rest
    if (start >= size || start > end) return res.status(416).set('Content-Range', `bytes */${size}`).end();
    res.status(206).set('Content-Range', `bytes ${start}-${end}/${size}`);
  }
  res.set('Content-Length', String(end - start + 1));
  if (req.method === 'HEAD') return res.end();
  const part = await one('SELECT substring(data FROM $2 FOR $3) AS d FROM stored_files WHERE id = $1', [id, start + 1, end - start + 1]);
  res.end(part.d);
}

r.post('/promotion-images/upload', can('settings.manage'), (req, res, next) => mediaUpload.single('file')(req, res, (e) => (e ? res.status(400).json({ error: e.code === 'LIMIT_FILE_SIZE' ? 'ไฟล์ใหญ่เกินไป (วิดีโอไม่เกิน 40 MB)' : e.message }) : next())), async (req, res) => {
  if (!req.file) throw badRequest('กรุณาเลือกไฟล์รูปหรือวิดีโอ');
  const ext = path.extname(req.file.originalname).toLowerCase();
  const mediaType = MEDIA_MIME[ext].startsWith('video/') ? 'VIDEO' : 'IMAGE';
  if (req.file.size > MEDIA_MAX[mediaType]) throw badRequest(`ไฟล์ใหญ่เกินไป (${mediaType === 'VIDEO' ? 'วิดีโอไม่เกิน 40 MB' : 'รูปไม่เกิน 10 MB'})`);
  await cleanupMedia();
  const used = await runAsPlatform(() => one(`SELECT COALESCE(sum(size_bytes),0)::bigint AS n FROM stored_files WHERE kind = 'PROMO_MEDIA'`));
  if (Number(used.n) + req.file.size > MEDIA_TOTAL_MAX) throw badRequest('พื้นที่เก็บรูป/วิดีโอเต็ม กรุณาลบสไลด์ที่ไม่ใช้ หรือใช้ไฟล์ที่เล็กลง / ใส่เป็นลิงก์แทน');
  const file = await saveFile(null, { kind: 'PROMO_MEDIA', name: req.file.originalname, mime: MEDIA_MIME[ext], buffer: req.file.buffer });
  await logActivity(null, req, 'PROMO_MEDIA_UPLOAD', 'promotion_image', null, { name: req.file.originalname, size: req.file.size });
  res.json({ url: `/uploads/media/${file.id}${ext}`, mediaType, size: req.file.size });
});
r.get('/promotion-images', async (_req, res) => res.json(await many('SELECT * FROM promotion_images ORDER BY sort_order, id')));
r.post('/promotion-images', can('settings.manage'), async (req, res) => {
  const b = parse(imgSchema, req.body);
  const row = await one(`INSERT INTO promotion_images(title, image_url, link_url, duration_seconds, sort_order, show_on_display, show_on_website, is_active, media_type) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [b.title, b.imageUrl, b.linkUrl, b.durationSeconds, b.sortOrder, b.showOnDisplay, b.showOnWebsite, b.isActive, b.mediaType]);
  await logActivity(null, req, 'PROMO_IMAGE_CREATE', 'promotion_image', row.id, b);
  emitSync('promotion-images');
  res.json(row);
});
r.put('/promotion-images/:id', can('settings.manage'), async (req, res) => {
  const b = parse(imgSchema, req.body);
  const row = await one(`UPDATE promotion_images SET title=$2, image_url=$3, link_url=$4, duration_seconds=$5, sort_order=$6, show_on_display=$7, show_on_website=$8, is_active=$9, media_type=$10 WHERE id=$1 RETURNING *`, [req.params.id, b.title, b.imageUrl, b.linkUrl, b.durationSeconds, b.sortOrder, b.showOnDisplay, b.showOnWebsite, b.isActive, b.mediaType]);
  await logActivity(null, req, 'PROMO_IMAGE_UPDATE', 'promotion_image', req.params.id, b);
  await cleanupMedia();
  emitSync('promotion-images');
  res.json(row);
});
r.post('/promotion-images/reorder', can('settings.manage'), async (req, res) => {
  const { ids } = parse(z.object({ ids: z.array(z.coerce.number().int()) }), req.body);
  await tx(async (c) => {
    for (let i = 0; i < ids.length; i++) await c.query('UPDATE promotion_images SET sort_order = $2 WHERE id = $1', [ids[i], i]);
  });
  emitSync('promotion-images');
  res.json({ ok: true });
});
r.delete('/promotion-images/:id', can('settings.manage'), async (req, res) => {
  await pool.query('DELETE FROM promotion_images WHERE id = $1', [req.params.id]);
  await logActivity(null, req, 'PROMO_IMAGE_DELETE', 'promotion_image', req.params.id);
  await cleanupMedia();
  emitSync('promotion-images');
  res.json({ ok: true });
});

// ── Backups ──
r.get('/backups', can('settings.manage'), async (_req, res) => res.json(await listBackups()));
r.post('/backups', can('settings.manage'), async (req, res) => {
  const out = await runBackup('MANUAL');
  await logActivity(null, req, 'BACKUP_RUN', 'backup', out.id, out);
  res.json(out);
});

export default r;

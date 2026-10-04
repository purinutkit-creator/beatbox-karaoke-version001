import { Router } from 'express';
import net from 'node:net';
import os from 'node:os';
import { pool, many, one } from '../db/index.js';
import { requireAuth, can } from '../lib/auth.js';
import { logActivity } from '../lib/activity.js';
import { z, parse } from '../lib/validate.js';
import { notFound, badRequest } from '../lib/errors.js';
import { emitSync } from '../lib/realtime.js';
import { notify } from '../services/notifications.js';

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
  speed: z.coerce.number().int().min(1).max(9).default(3),
  marginMm: z.coerce.number().min(0).max(10).default(2),
  copies: z.coerce.number().int().min(1).max(5).default(1),
  autoPrint: z.boolean().default(true),
  autoCut: z.boolean().default(true),
  openDrawer: z.boolean().default(true),
  isDefault: z.boolean().default(false),
  isActive: z.boolean().default(true),
  deviceId: z.coerce.number().int().optional().nullable(),
});
const cols = (b) => [b.name, b.connection, b.address, b.port, b.station, b.paperWidth, b.density, b.speed, b.marginMm, b.copies, b.autoPrint, b.autoCut, b.openDrawer, b.isDefault, b.isActive, b.deviceId ?? null];

r.get('/printers', async (_req, res) => res.json(await many('SELECT * FROM printers ORDER BY is_default DESC, id')));

r.post('/printers', can('settings.manage'), async (req, res) => {
  const b = parse(schema, req.body);
  if (b.connection === 'NETWORK' && !b.address) throw badRequest('กรุณาระบุ IP Address');
  if (b.isDefault) await pool.query('UPDATE printers SET is_default = false WHERE station = $1', [b.station]);
  const row = await one(
    `INSERT INTO printers(name, connection, address, port, station, paper_width, density, speed, margin_mm, copies, auto_print, auto_cut, open_drawer, is_default, is_active, device_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
    cols(b),
  );
  await logActivity(null, req, 'PRINTER_CREATE', 'printer', row.id, b);
  emitSync('printers');
  res.json(row);
});

r.put('/printers/:id', can('settings.manage'), async (req, res) => {
  const b = parse(schema, req.body);
  if (b.isDefault) await pool.query('UPDATE printers SET is_default = false WHERE station = $1 AND id <> $2', [b.station, req.params.id]);
  const row = await one(
    `UPDATE printers SET name=$2, connection=$3, address=$4, port=$5, station=$6, paper_width=$7, density=$8, speed=$9, margin_mm=$10, copies=$11,
       auto_print=$12, auto_cut=$13, open_drawer=$14, is_default=$15, is_active=$16, device_id=$17 WHERE id=$1 RETURNING *`,
    [req.params.id, ...cols(b)],
  );
  await logActivity(null, req, 'PRINTER_UPDATE', 'printer', req.params.id, b);
  emitSync('printers');
  res.json(row);
});

r.delete('/printers/:id', can('settings.manage'), async (req, res) => {
  await pool.query('UPDATE printers SET is_active = false, is_default = false WHERE id = $1', [req.params.id]);
  await logActivity(null, req, 'PRINTER_DELETE', 'printer', req.params.id);
  emitSync('printers');
  res.json({ ok: true });
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

/** Send raw ESC/POS bytes (base64) to a network printer — the browser renders the receipt (Kanit) to a raster image. */
r.post('/printers/:id/raw', async (req, res) => {
  const { data, jobType, reference, isCopy } = parse(z.object({ data: z.string().min(1), jobType: z.string().default('RECEIPT'), reference: z.string().optional().nullable(), isCopy: z.boolean().default(false) }), req.body);
  const p = await one('SELECT * FROM printers WHERE id = $1', [req.params.id]);
  if (!p) throw notFound();
  if (p.connection !== 'NETWORK') throw badRequest('เครื่องพิมพ์นี้ไม่ใช่ Network Printer');
  const job = await one(`INSERT INTO print_jobs(printer_id, job_type, reference, is_copy, status, employee_id) VALUES ($1,$2,$3,$4,'PRINTING',$5) RETURNING id`, [p.id, jobType, reference, isCopy, req.employee.id]);
  try {
    await tcpSend(p.address, p.port, Buffer.from(data, 'base64'));
    await pool.query(`UPDATE print_jobs SET status = 'PRINTED', printed_at = now() WHERE id = $1`, [job.id]);
    await pool.query(`UPDATE printers SET status = 'ONLINE', last_seen_at = now() WHERE id = $1`, [p.id]);
    res.json({ ok: true, jobId: job.id });
  } catch (e) {
    await pool.query(`UPDATE print_jobs SET status = 'FAILED', error = $2 WHERE id = $1`, [job.id, e.message]);
    await pool.query(`UPDATE printers SET status = 'OFFLINE' WHERE id = $1`, [p.id]);
    await notify({ type: 'PRINTER_OFFLINE', level: 'error', title: 'Printer Offline', message: `${p.name}: ${e.message}`, dedupeKey: `printer-offline:${p.id}:${Math.floor(Date.now() / 600000)}` });
    res.status(502).json({ error: e.message, code: 'PRINTER_OFFLINE', jobId: job.id });
  }
});

r.get('/print-jobs', async (req, res) => {
  res.json(await many(`SELECT pj.*, p.name AS printer_name, e.name AS employee_name FROM print_jobs pj LEFT JOIN printers p ON p.id = pj.printer_id LEFT JOIN employees e ON e.id = pj.employee_id WHERE ($1::text IS NULL OR pj.status = $1) ORDER BY pj.id DESC LIMIT 200`, [req.query.status || null]));
});

r.post('/print-jobs', async (req, res) => {
  const b = parse(z.object({ printerId: z.coerce.number().int().optional().nullable(), jobType: z.string(), reference: z.string().optional().nullable(), isCopy: z.boolean().default(false), status: z.enum(['PRINTED', 'FAILED', 'QUEUED']).default('PRINTED'), error: z.string().optional().nullable(), payload: z.any().optional() }), req.body);
  const row = await one(
    `INSERT INTO print_jobs(printer_id, job_type, reference, is_copy, status, error, payload, employee_id, printed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $5 = 'PRINTED' THEN now() END) RETURNING *`,
    [b.printerId || null, b.jobType, b.reference, b.isCopy, b.status, b.error, b.payload ?? null, req.employee.id],
  );
  if (b.status === 'FAILED' && b.printerId) {
    await pool.query(`UPDATE printers SET status = 'OFFLINE' WHERE id = $1`, [b.printerId]);
    await notify({ type: 'PRINTER_OFFLINE', level: 'error', title: 'Printer Offline', message: b.error || 'พิมพ์ไม่สำเร็จ', dedupeKey: `printer-offline:${b.printerId}:${Math.floor(Date.now() / 600000)}` });
  }
  res.json(row);
});

r.patch('/print-jobs/:id', async (req, res) => {
  const b = parse(z.object({ status: z.enum(['PRINTED', 'FAILED', 'CANCELLED']), error: z.string().optional().nullable() }), req.body);
  const row = await one(`UPDATE print_jobs SET status = $2, error = $3, printed_at = CASE WHEN $2 = 'PRINTED' THEN now() ELSE printed_at END WHERE id = $1 RETURNING *`, [req.params.id, b.status, b.error || null]);
  emitSync('print-jobs');
  res.json(row);
});

export default r;

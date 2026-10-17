// Smart devices (Tuya): systems (name + trigger + command), the device of each room, buttons and logs.
import { Router } from 'express';
import { pool, many, one } from '../db/index.js';
import { requireAuth, can } from '../lib/auth.js';
import { logActivity } from '../lib/activity.js';
import { z, parse } from '../lib/validate.js';
import { notFound, badRequest } from '../lib/errors.js';
import { emitSync } from '../lib/realtime.js';
import { tuyaConfig, tuyaDevices, tuyaSend, TUYA_REGIONS } from '../providers/tuya.js';
import { runSystem, SMART_TRIGGERS } from '../services/smart.js';

const r = Router();
r.use(requireAuth);

const commandSchema = z.object({ code: z.string().trim().min(1).max(60), value: z.union([z.boolean(), z.number(), z.string().max(200)]) });
const systemSchema = z.object({
  name: z.string().trim().min(1).max(80),
  trigger: z.enum(SMART_TRIGGERS).default('MANUAL'),
  minutes: z.coerce.number().int().min(1).max(240).default(5),
  commands: z.array(commandSchema).min(1).max(6),
  showButton: z.boolean().default(true),
  isActive: z.boolean().default(true),
  sortOrder: z.coerce.number().int().default(0),
});

/** Everything the room screen and the settings page need (no secrets). */
r.get('/smart', async (_req, res) => {
  const cfg = await tuyaConfig();
  const systems = await many('SELECT * FROM smart_systems ORDER BY sort_order, id');
  const bindings = await many('SELECT * FROM smart_bindings ORDER BY id');
  res.json({ enabled: cfg.enabled, configured: !!(cfg.accessId && cfg.accessSecret), regions: TUYA_REGIONS, systems, bindings });
});

r.get('/smart/logs', async (req, res) => {
  const limit = Math.min(200, Number(req.query.limit) || 50);
  const roomId = req.query.roomId ? Number(req.query.roomId) : null;
  res.json(
    await many(
      `SELECT l.*, r.name AS room_name, e.name AS employee_name FROM smart_logs l LEFT JOIN rooms r ON r.id = l.room_id LEFT JOIN employees e ON e.id = l.employee_id
       WHERE ($1::int IS NULL OR l.room_id = $1) ORDER BY l.id DESC LIMIT $2`,
      [roomId, limit],
    ),
  );
});

r.post('/smart/systems', can('settings.manage'), async (req, res) => {
  const b = parse(systemSchema, req.body);
  const row = await one(
    `INSERT INTO smart_systems(name, trigger, minutes, commands, show_button, is_active, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [b.name, b.trigger, b.minutes, JSON.stringify(b.commands), b.showButton, b.isActive, b.sortOrder],
  );
  await logActivity(null, req, 'SMART_SYSTEM_CREATE', 'smart_system', row.id, b);
  emitSync('smart');
  res.json(row);
});

r.put('/smart/systems/:id', can('settings.manage'), async (req, res) => {
  const b = parse(systemSchema, req.body);
  const row = await one(
    `UPDATE smart_systems SET name=$2, trigger=$3, minutes=$4, commands=$5, show_button=$6, is_active=$7, sort_order=$8, updated_at=now() WHERE id=$1 RETURNING *`,
    [req.params.id, b.name, b.trigger, b.minutes, JSON.stringify(b.commands), b.showButton, b.isActive, b.sortOrder],
  );
  if (!row) throw notFound();
  await logActivity(null, req, 'SMART_SYSTEM_UPDATE', 'smart_system', row.id, b);
  emitSync('smart');
  res.json(row);
});

r.delete('/smart/systems/:id', can('settings.manage'), async (req, res) => {
  const row = await one('DELETE FROM smart_systems WHERE id = $1 RETURNING id, name', [req.params.id]);
  if (!row) throw notFound();
  await logActivity(null, req, 'SMART_SYSTEM_DELETE', 'smart_system', row.id, { name: row.name });
  emitSync('smart');
  res.json({ ok: true });
});

/** The device of one room for one system (empty device = remove). */
r.put('/smart/bindings', can('settings.manage'), async (req, res) => {
  const b = parse(z.object({ systemId: z.coerce.number().int(), roomId: z.coerce.number().int(), deviceId: z.string().trim().max(100).optional().nullable(), deviceName: z.string().max(120).optional().nullable() }), req.body);
  if (!b.deviceId) {
    await pool.query('DELETE FROM smart_bindings WHERE system_id = $1 AND room_id = $2', [b.systemId, b.roomId]);
  } else {
    await pool.query(
      `INSERT INTO smart_bindings(system_id, room_id, device_id, device_name) VALUES ($1,$2,$3,$4)
       ON CONFLICT (system_id, room_id) DO UPDATE SET device_id = EXCLUDED.device_id, device_name = EXCLUDED.device_name`,
      [b.systemId, b.roomId, b.deviceId, b.deviceName || null],
    );
  }
  await logActivity(null, req, 'SMART_BINDING', 'smart_system', b.systemId, b);
  emitSync('smart');
  res.json(await many('SELECT * FROM smart_bindings ORDER BY id'));
});

/** Devices in the linked Tuya account (to pick instead of typing the device ID). */
r.get('/smart/devices', can('settings.manage'), async (_req, res) => {
  try {
    res.json(await tuyaDevices());
  } catch (e) {
    throw badRequest(e.message, 'TUYA_ERROR');
  }
});

/** Staff button: run a system on a room's device now. */
r.post('/smart/run', can('room.operate'), async (req, res) => {
  const b = parse(z.object({ systemId: z.coerce.number().int(), roomId: z.coerce.number().int() }), req.body);
  const cfg = await tuyaConfig();
  if (!cfg.enabled) throw badRequest('ยังไม่ได้เปิดใช้งานระบบอุปกรณ์อัจฉริยะ (Tuya)', 'SMART_DISABLED');
  const system = await one('SELECT * FROM smart_systems WHERE id = $1 AND is_active', [b.systemId]);
  if (!system) throw notFound('ไม่พบระบบนี้ หรือถูกปิดใช้งาน');
  const binding = await one('SELECT * FROM smart_bindings WHERE system_id = $1 AND room_id = $2', [b.systemId, b.roomId]);
  if (!binding) throw badRequest('ห้องนี้ยังไม่ได้ผูกอุปกรณ์กับระบบนี้', 'SMART_NOT_BOUND');
  const session = await one(`SELECT id FROM room_sessions WHERE room_id = $1 AND status IN ('PENDING_PAYMENT','SCHEDULED','ACTIVE','PAUSED','CLOSED') ORDER BY id DESC LIMIT 1`, [b.roomId]);
  const out = await runSystem(system, binding, { sessionId: session?.id || null, trigger: 'MANUAL', employeeId: req.employee.id });
  await logActivity(null, req, 'SMART_RUN', 'smart_system', system.id, { room: b.roomId, name: system.name, ok: out.ok, error: out.error });
  if (!out.ok) throw badRequest(out.error, 'TUYA_ERROR');
  res.json(out);
});

/** Settings page: try a command on a device before saving it. */
r.post('/smart/test-device', can('settings.manage'), async (req, res) => {
  const b = parse(z.object({ deviceId: z.string().trim().min(1).max(100), commands: z.array(commandSchema).min(1).max(6) }), req.body);
  try {
    await tuyaSend(b.deviceId, b.commands);
  } catch (e) {
    throw badRequest(e.message, 'TUYA_ERROR');
  }
  res.json({ ok: true });
});

export default r;

// Floor plans and the way to a room: floors with their plan (rooms drawn on it, markers such as the entrance), the GPS
// position of each room (saved by staff standing at its door) and the public guide page customers open from a QR.
import { Router } from 'express';
import { pool, many, one } from '../db/index.js';
import { requireAuth, can } from '../lib/auth.js';
import { logActivity } from '../lib/activity.js';
import { z, parse, zUrl } from '../lib/validate.js';
import { notFound, badRequest } from '../lib/errors.js';
import { emitSync } from '../lib/realtime.js';
import { useStoreOf } from '../lib/tenant.js';
import { getSettings } from '../services/settings.js';

export const MARKER_TYPES = ['ENTRANCE', 'STAIRS', 'LIFT', 'TOILET', 'COUNTER', 'EXIT', 'LABEL'];
const pct = z.coerce.number().min(0).max(100);
const markerSchema = z.object({ id: z.string().max(40), type: z.enum(MARKER_TYPES), x: pct, y: pct, label: z.string().trim().max(60).optional().nullable() });
const floorSchema = z.object({
  name: z.string().trim().min(1).max(60),
  branchId: z.coerce.number().int().optional().nullable(),
  planImageUrl: zUrl,
  aspect: z.coerce.number().min(0.4).max(4).default(1.6),
  sortOrder: z.coerce.number().int().default(0),
});

const ROOM_COLS = `r.id, r.name, r.number, r.floor_id, r.plan_x, r.plan_y, r.plan_w, r.plan_h, r.geo_lat, r.geo_lng, r.geo_accuracy, r.guide_token,
  COALESCE(r.image_url, rt.image_url) AS image_url, rt.name AS type_name, rt.color AS type_color`;

// ── public: the guide page of one room (no sign-in; the link carries the room's random token) ──
export const publicGuide = Router();
publicGuide.get('/guide/:token', async (req, res) => {
  if (!(await useStoreOf('rooms', 'guide_token', String(req.params.token)))) throw notFound('ไม่พบห้องนี้');
  const room = await one(`SELECT ${ROOM_COLS} FROM rooms r JOIN room_types rt ON rt.id = r.room_type_id WHERE r.guide_token = $1 AND r.deleted_at IS NULL`, [req.params.token]);
  if (!room) throw notFound('ไม่พบห้องนี้');
  const s = await getSettings();
  const floor = room.floor_id ? await one('SELECT id, name, plan_image_url, aspect, markers FROM floors WHERE id = $1', [room.floor_id]) : null;
  const rooms = floor
    ? await many(`SELECT r.id, r.name, r.number, r.plan_x, r.plan_y, r.plan_w, r.plan_h FROM rooms r WHERE r.floor_id = $1 AND r.deleted_at IS NULL AND r.plan_x IS NOT NULL ORDER BY r.sort_order, r.id`, [floor.id])
    : [];
  const nav = s.general?.roomNavEnabled && room.geo_lat != null ? { lat: room.geo_lat, lng: room.geo_lng, accuracy: Number(room.geo_accuracy) || null, arriveM: Number(s.general.roomNavArriveM) || 10 } : null;
  res.json({
    store: { name: s.store.name, logoUrl: s.store.logoUrl },
    room: { id: room.id, name: room.name, number: room.number, typeName: room.type_name, color: room.type_color, imageUrl: room.image_url },
    floor: floor && { name: floor.name, planImageUrl: floor.plan_image_url, aspect: Number(floor.aspect), markers: floor.markers || [] },
    rooms,
    nav,
  });
});

// ── staff ──
const r = Router();
r.use(requireAuth);

r.get('/floors', async (_req, res) => {
  const floors = await many('SELECT * FROM floors ORDER BY sort_order, id');
  const rooms = await many(`SELECT ${ROOM_COLS}, r.branch_id FROM rooms r JOIN room_types rt ON rt.id = r.room_type_id WHERE r.deleted_at IS NULL ORDER BY r.sort_order, r.id`);
  const s = await getSettings();
  res.json({ floors, rooms, nav: { enabled: !!s.general?.roomNavEnabled, arriveM: Number(s.general?.roomNavArriveM) || 10 } });
});

/** What the customer display shows about a room after paying: picture, floor and the link to the guide page. */
r.get('/floors/room-card/:roomId', async (req, res) => {
  const room = await one(
    `SELECT r.id, r.name, r.number, r.guide_token, COALESCE(r.image_url, rt.image_url) AS image_url, rt.name AS type_name, f.name AS floor_name
     FROM rooms r JOIN room_types rt ON rt.id = r.room_type_id LEFT JOIN floors f ON f.id = r.floor_id WHERE r.id = $1`,
    [req.params.roomId],
  );
  if (!room) throw notFound();
  res.json(room);
});

r.post('/floors', can('settings.manage'), async (req, res) => {
  const b = parse(floorSchema, req.body);
  const row = await one('INSERT INTO floors(name, branch_id, plan_image_url, aspect, sort_order) VALUES ($1,$2,$3,$4,$5) RETURNING *', [b.name, b.branchId || null, b.planImageUrl || null, b.aspect, b.sortOrder]);
  await logActivity(null, req, 'FLOOR_CREATE', 'floor', row.id, b);
  emitSync('floors');
  res.json(row);
});

r.put('/floors/:id', can('settings.manage'), async (req, res) => {
  const b = parse(floorSchema, req.body);
  const row = await one('UPDATE floors SET name=$2, branch_id=$3, plan_image_url=$4, aspect=$5, sort_order=$6, updated_at=now() WHERE id=$1 RETURNING *', [req.params.id, b.name, b.branchId || null, b.planImageUrl || null, b.aspect, b.sortOrder]);
  if (!row) throw notFound();
  await logActivity(null, req, 'FLOOR_UPDATE', 'floor', row.id, b);
  emitSync('floors');
  res.json(row);
});

r.delete('/floors/:id', can('settings.manage'), async (req, res) => {
  await pool.query('UPDATE rooms SET floor_id = NULL, plan_x = NULL, plan_y = NULL, plan_w = NULL, plan_h = NULL WHERE floor_id = $1', [req.params.id]);
  const row = await one('DELETE FROM floors WHERE id = $1 RETURNING id, name', [req.params.id]);
  if (!row) throw notFound();
  await logActivity(null, req, 'FLOOR_DELETE', 'floor', row.id, { name: row.name });
  emitSync('floors');
  res.json({ ok: true });
});

/** Save a floor's plan: the rooms drawn on it (others leave this floor) and its markers. */
r.put('/floors/:id/layout', can('settings.manage'), async (req, res) => {
  const b = parse(
    z.object({
      rooms: z.array(z.object({ id: z.coerce.number().int(), x: pct, y: pct, w: z.coerce.number().min(2).max(100), h: z.coerce.number().min(2).max(100) })).max(300),
      markers: z.array(markerSchema).max(100),
    }),
    req.body,
  );
  const floor = await one('SELECT id FROM floors WHERE id = $1', [req.params.id]);
  if (!floor) throw notFound();
  const ids = b.rooms.map((x) => x.id);
  await pool.query('UPDATE rooms SET floor_id = NULL, plan_x = NULL, plan_y = NULL, plan_w = NULL, plan_h = NULL WHERE floor_id = $1 AND NOT (id = ANY($2::int[]))', [floor.id, ids]);
  for (const x of b.rooms) {
    await pool.query('UPDATE rooms SET floor_id = $2, plan_x = $3, plan_y = $4, plan_w = $5, plan_h = $6 WHERE id = $1', [x.id, floor.id, x.x, x.y, x.w, x.h]);
  }
  await pool.query('UPDATE floors SET markers = $2, updated_at = now() WHERE id = $1', [floor.id, JSON.stringify(b.markers)]);
  await logActivity(null, req, 'FLOOR_LAYOUT', 'floor', floor.id, { rooms: ids.length, markers: b.markers.length });
  emitSync('floors');
  res.json({ ok: true });
});

/** "บันทึกตำแหน่งห้องนี้": the GPS position of the room's door, taken by staff standing there (null = remove). */
r.put('/floors/rooms/:roomId/location', can('settings.manage'), async (req, res) => {
  const b = parse(
    z.object({ lat: z.number().min(-90).max(90).nullable(), lng: z.number().min(-180).max(180).nullable(), accuracy: z.number().min(0).max(100000).optional().nullable() }),
    req.body,
  );
  if ((b.lat == null) !== (b.lng == null)) throw badRequest('ตำแหน่งไม่ครบ');
  const row = await one('UPDATE rooms SET geo_lat = $2, geo_lng = $3, geo_accuracy = $4 WHERE id = $1 RETURNING id, name, geo_lat, geo_lng, geo_accuracy', [req.params.roomId, b.lat, b.lng, b.lat == null ? null : b.accuracy ?? null]);
  if (!row) throw notFound();
  await logActivity(null, req, 'ROOM_LOCATION', 'room', row.id, b);
  emitSync('floors');
  res.json(row);
});

export default r;

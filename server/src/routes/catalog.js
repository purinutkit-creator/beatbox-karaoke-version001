import { Router } from 'express';
import { pool, tx, many, one } from '../db/index.js';
import { requireAuth, can } from '../lib/auth.js';
import { logActivity } from '../lib/activity.js';
import { z, parse, zUrl, zIdArr } from '../lib/validate.js';
import { notFound, badRequest, conflict } from '../lib/errors.js';
import { halfHourPrice } from '@beatbox/shared/roomPricing.js';
import { emitSync } from '../lib/realtime.js';
import { moveStock } from '../services/stock.js';

const r = Router();
r.use(requireAuth);

// ───────────── Room types ─────────────
const typeSchema = z.object({
  code: z.string().min(1).max(30),
  name: z.string().min(1).max(100),
  imageUrl: zUrl,
  description: z.string().max(2000).optional().nullable(),
  capacity: z.coerce.number().int().min(1).max(200),
  priceHour: z.coerce.number().min(0),
  priceHalf: z.coerce.number().min(0).optional().nullable(),
  halfPriceManual: z.boolean().default(false),
  defaultDeposit: z.coerce.number().min(0).default(0),
  color: z.string().max(20).default('#7c3aed'),
  amenities: z.array(z.string().max(100)).default([]),
  isActive: z.boolean().default(true),
  sortOrder: z.coerce.number().int().default(0),
});

r.get('/room-types', async (_req, res) => res.json(await many('SELECT * FROM room_types WHERE deleted_at IS NULL ORDER BY sort_order, id')));

r.post('/room-types', can('room.create'), async (req, res) => {
  const b = parse(typeSchema, req.body);
  const half = b.halfPriceManual && b.priceHalf != null ? b.priceHalf : halfHourPrice(b.priceHour);
  const row = await one(
    `INSERT INTO room_types(code, name, image_url, description, capacity, price_hour, price_half, half_price_manual, default_deposit, color, amenities, is_active, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [b.code, b.name, b.imageUrl, b.description, b.capacity, b.priceHour, half, b.halfPriceManual, b.defaultDeposit, b.color, b.amenities, b.isActive, b.sortOrder],
  );
  await logActivity(null, req, 'ROOM_TYPE_CREATE', 'room_type', row.id, b);
  emitSync(['room-types', 'rooms']);
  res.json(row);
});

r.put('/room-types/:id', can('room.edit'), async (req, res) => {
  const b = parse(typeSchema, req.body);
  const half = b.halfPriceManual && b.priceHalf != null ? b.priceHalf : halfHourPrice(b.priceHour);
  const before = await one('SELECT * FROM room_types WHERE id = $1', [req.params.id]);
  if (!before) throw notFound();
  const row = await one(
    `UPDATE room_types SET code=$2, name=$3, image_url=$4, description=$5, capacity=$6, price_hour=$7, price_half=$8, half_price_manual=$9,
       default_deposit=$10, color=$11, amenities=$12, is_active=$13, sort_order=$14, updated_at=now() WHERE id=$1 RETURNING *`,
    [req.params.id, b.code, b.name, b.imageUrl, b.description, b.capacity, b.priceHour, half, b.halfPriceManual, b.defaultDeposit, b.color, b.amenities, b.isActive, b.sortOrder],
  );
  if (req.body.applyToRooms) {
    await pool.query(`UPDATE rooms SET price_hour = $2, price_half = $3, half_price_manual = $4, updated_at = now() WHERE room_type_id = $1 AND deleted_at IS NULL`, [req.params.id, b.priceHour, half, b.halfPriceManual]);
  }
  await logActivity(null, req, 'ROOM_TYPE_UPDATE', 'room_type', req.params.id, { before, after: b, applyToRooms: !!req.body.applyToRooms });
  emitSync(['room-types', 'rooms']);
  res.json(row);
});

r.delete('/room-types/:id', can('room.edit'), async (req, res) => {
  const used = await one('SELECT COUNT(*) AS n FROM rooms WHERE room_type_id = $1 AND deleted_at IS NULL', [req.params.id]);
  if (Number(used.n) > 0) throw conflict('มีห้องที่ใช้ Type นี้อยู่ ไม่สามารถลบได้');
  await pool.query('UPDATE room_types SET deleted_at = now(), is_active = false WHERE id = $1', [req.params.id]);
  await logActivity(null, req, 'ROOM_TYPE_DELETE', 'room_type', req.params.id);
  emitSync('room-types');
  res.json({ ok: true });
});

// ───────────── Rooms ─────────────
const roomSchema = z.object({
  name: z.string().min(1).max(100),
  number: z.string().min(1).max(20),
  roomTypeId: z.coerce.number().int(),
  imageUrl: zUrl,
  zone: z.string().max(100).optional().nullable(),
  capacity: z.coerce.number().int().min(1).max(200),
  priceHour: z.coerce.number().min(0),
  priceHalf: z.coerce.number().min(0).optional().nullable(),
  halfPriceManual: z.boolean().default(false),
  deposit: z.coerce.number().min(0).default(0),
  note: z.string().max(1000).optional().nullable(),
  sortOrder: z.coerce.number().int().default(0),
  isActive: z.boolean().default(true),
  status: z.enum(['AVAILABLE', 'MAINTENANCE', 'DISABLED', 'CLEANING']).optional(),
});

r.get('/rooms', async (_req, res) => {
  res.json(await many(`SELECT r.*, rt.name AS type_name, rt.color AS type_color FROM rooms r JOIN room_types rt ON rt.id = r.room_type_id WHERE r.deleted_at IS NULL ORDER BY r.sort_order, r.number`));
});

r.post('/rooms', can('room.create'), async (req, res) => {
  const b = parse(roomSchema, req.body);
  const half = b.halfPriceManual && b.priceHalf != null ? b.priceHalf : halfHourPrice(b.priceHour);
  const branch = await one('SELECT id FROM branches ORDER BY sort_order, id LIMIT 1');
  const row = await one(
    `INSERT INTO rooms(branch_id, room_type_id, name, number, image_url, zone, capacity, price_hour, price_half, half_price_manual, deposit, note, sort_order, is_active, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [req.body.branchId || branch.id, b.roomTypeId, b.name, b.number, b.imageUrl, b.zone, b.capacity, b.priceHour, half, b.halfPriceManual, b.deposit, b.note, b.sortOrder, b.isActive, b.isActive ? b.status || 'AVAILABLE' : 'DISABLED'],
  );
  await logActivity(null, req, 'ROOM_CREATE', 'room', row.id, b);
  emitSync('rooms');
  res.json(row);
});

r.put('/rooms/:id', can('room.edit'), async (req, res) => {
  const b = parse(roomSchema, req.body);
  const half = b.halfPriceManual && b.priceHalf != null ? b.priceHalf : halfHourPrice(b.priceHour);
  const before = await one('SELECT * FROM rooms WHERE id = $1 AND deleted_at IS NULL', [req.params.id]);
  if (!before) throw notFound();
  const row = await one(
    `UPDATE rooms SET room_type_id=$2, name=$3, number=$4, image_url=$5, zone=$6, capacity=$7, price_hour=$8, price_half=$9, half_price_manual=$10,
       deposit=$11, note=$12, sort_order=$13, is_active=$14, status = CASE WHEN $14 = false THEN 'DISABLED' WHEN status = 'DISABLED' THEN 'AVAILABLE' ELSE status END,
       version = version + 1, updated_at = now() WHERE id=$1 RETURNING *`,
    [req.params.id, b.roomTypeId, b.name, b.number, b.imageUrl, b.zone, b.capacity, b.priceHour, half, b.halfPriceManual, b.deposit, b.note, b.sortOrder, b.isActive],
  );
  await logActivity(null, req, 'ROOM_UPDATE', 'room', req.params.id, { before, after: b });
  emitSync('rooms');
  res.json(row);
});

r.delete('/rooms/:id', can('room.edit'), async (req, res) => {
  const active = await one(`SELECT id FROM room_sessions WHERE room_id = $1 AND status IN ('ACTIVE','PAUSED','CLOSED','SCHEDULED')`, [req.params.id]);
  if (active) throw conflict('ห้องนี้กำลังใช้งานอยู่');
  await pool.query(`UPDATE rooms SET deleted_at = now(), is_active = false, status = 'DISABLED' WHERE id = $1`, [req.params.id]);
  await logActivity(null, req, 'ROOM_DELETE', 'room', req.params.id);
  emitSync('rooms');
  res.json({ ok: true });
});

// ───────────── Packages ─────────────
const pkgSchema = z.object({
  name: z.string().min(1).max(150),
  roomTypeIds: zIdArr,
  hours: z.coerce.number().int().min(0).max(24),
  minutes: z.coerce.number().int().min(0).max(59),
  price: z.coerce.number().min(0),
  includedGuests: z.coerce.number().int().min(0).optional().nullable(),
  imageUrl: zUrl,
  description: z.string().max(2000).optional().nullable(),
  availableDays: z.array(z.coerce.number().int().min(0).max(6)).default([0, 1, 2, 3, 4, 5, 6]),
  availableFrom: z.string().optional().nullable().transform((v) => v || null),
  availableTo: z.string().optional().nullable().transform((v) => v || null),
  blackoutDates: z.array(z.string()).default([]),
  deposit: z.coerce.number().min(0).optional().nullable(),
  memberOnly: z.boolean().default(false),
  isOnline: z.boolean().default(true),
  isActive: z.boolean().default(true),
  sortOrder: z.coerce.number().int().default(0),
});
const pkgCols = (b) => [b.name, b.roomTypeIds, b.hours, b.minutes, b.price, b.includedGuests, b.imageUrl, b.description, b.availableDays, b.availableFrom, b.availableTo, b.blackoutDates, b.deposit ?? null, b.memberOnly, b.isOnline, b.isActive, b.sortOrder];

r.get('/packages', async (_req, res) => res.json(await many('SELECT * FROM room_packages WHERE deleted_at IS NULL ORDER BY sort_order, id')));
r.post('/packages', can('room.edit'), async (req, res) => {
  const b = parse(pkgSchema, req.body);
  if (b.hours * 60 + b.minutes <= 0) throw badRequest('แพ็กเกจต้องมีเวลาอย่างน้อย 1 นาที');
  const row = await one(
    `INSERT INTO room_packages(name, room_type_ids, hours, minutes, price, included_guests, image_url, description, available_days, available_from, available_to, blackout_dates, deposit, member_only, is_online, is_active, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
    pkgCols(b),
  );
  await logActivity(null, req, 'PACKAGE_CREATE', 'package', row.id, b);
  emitSync('packages');
  res.json(row);
});
r.put('/packages/:id', can('room.edit'), async (req, res) => {
  const b = parse(pkgSchema, req.body);
  const row = await one(
    `UPDATE room_packages SET name=$2, room_type_ids=$3, hours=$4, minutes=$5, price=$6, included_guests=$7, image_url=$8, description=$9, available_days=$10,
       available_from=$11, available_to=$12, blackout_dates=$13, deposit=$14, member_only=$15, is_online=$16, is_active=$17, sort_order=$18 WHERE id=$1 RETURNING *`,
    [req.params.id, ...pkgCols(b)],
  );
  await logActivity(null, req, 'PACKAGE_UPDATE', 'package', req.params.id, b);
  emitSync('packages');
  res.json(row);
});
r.delete('/packages/:id', can('room.edit'), async (req, res) => {
  await pool.query('UPDATE room_packages SET deleted_at = now(), is_active = false WHERE id = $1', [req.params.id]);
  await logActivity(null, req, 'PACKAGE_DELETE', 'package', req.params.id);
  emitSync('packages');
  res.json({ ok: true });
});

// ───────────── Categories ─────────────
const catSchema = z.object({
  name: z.string().min(1).max(100),
  icon: z.string().max(50).optional().nullable(),
  color: z.string().max(20).default('#7c3aed'),
  station: z.enum(['NONE', 'KITCHEN', 'BAR', 'PREP']).default('NONE'),
  printerId: z.coerce.number().int().optional().nullable(),
  sortOrder: z.coerce.number().int().default(0),
  isActive: z.boolean().default(true),
});
r.get('/categories', async (_req, res) => res.json(await many(`SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.deleted_at IS NULL) AS product_count FROM categories c WHERE c.deleted_at IS NULL ORDER BY c.sort_order, c.id`)));
r.post('/categories', can('product.create'), async (req, res) => {
  const b = parse(catSchema, req.body);
  const row = await one(`INSERT INTO categories(name, icon, color, station, printer_id, sort_order, is_active) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [b.name, b.icon, b.color, b.station, b.printerId, b.sortOrder, b.isActive]);
  await logActivity(null, req, 'CATEGORY_CREATE', 'category', row.id, b);
  emitSync('products');
  res.json(row);
});
r.put('/categories/:id', can('product.edit'), async (req, res) => {
  const b = parse(catSchema, req.body);
  const row = await one(`UPDATE categories SET name=$2, icon=$3, color=$4, station=$5, printer_id=$6, sort_order=$7, is_active=$8 WHERE id=$1 RETURNING *`, [req.params.id, b.name, b.icon, b.color, b.station, b.printerId, b.sortOrder, b.isActive]);
  await logActivity(null, req, 'CATEGORY_UPDATE', 'category', req.params.id, b);
  emitSync('products');
  res.json(row);
});
r.delete('/categories/:id', can('product.delete'), async (req, res) => {
  const used = await one('SELECT COUNT(*) AS n FROM products WHERE category_id = $1 AND deleted_at IS NULL', [req.params.id]);
  if (Number(used.n) > 0) throw conflict('หมวดหมู่นี้ยังมีสินค้าอยู่');
  await pool.query('UPDATE categories SET deleted_at = now() WHERE id = $1', [req.params.id]);
  await logActivity(null, req, 'CATEGORY_DELETE', 'category', req.params.id);
  emitSync('products');
  res.json({ ok: true });
});

// ───────────── Products ─────────────
const optionSchema = z.object({ id: z.coerce.number().int().optional(), groupName: z.string().max(100).default('ตัวเลือก'), name: z.string().min(1).max(100), priceDelta: z.coerce.number().default(0), isAddon: z.boolean().default(false) });
const productSchema = z.object({
  sku: z.string().min(1).max(50),
  barcode: z.string().max(100).optional().nullable(),
  name: z.string().min(1).max(200),
  imageUrl: zUrl,
  categoryId: z.coerce.number().int().optional().nullable(),
  description: z.string().max(2000).optional().nullable(),
  price: z.coerce.number().min(0),
  cost: z.coerce.number().min(0).default(0),
  unit: z.string().max(30).default('ชิ้น'),
  trackStock: z.boolean().default(true),
  minStock: z.coerce.number().min(0).default(0),
  isAvailable: z.boolean().default(true),
  isSoldOut: z.boolean().default(false),
  scExempt: z.boolean().default(false),
  pointsEligible: z.boolean().default(true),
  note: z.string().max(1000).optional().nullable(),
  sortOrder: z.coerce.number().int().default(0),
  options: z.array(optionSchema).default([]),
  initialStock: z.coerce.number().min(0).optional(),
});

const PRODUCT_SELECT = `SELECT p.*, c.name AS category_name, c.color AS category_color, c.station, COALESCE(sb.quantity, 0) AS stock,
   COALESCE((SELECT json_agg(o ORDER BY o.sort_order, o.id) FROM product_options o WHERE o.product_id = p.id), '[]') AS options
   FROM products p LEFT JOIN categories c ON c.id = p.category_id LEFT JOIN stock_balances sb ON sb.product_id = p.id`;

r.get('/products', async (req, res) => {
  const rows = await many(`${PRODUCT_SELECT} WHERE p.deleted_at IS NULL ORDER BY c.sort_order NULLS LAST, p.sort_order, p.name`);
  if (!req.permissions.has('cost.view') && req.employee.role !== 'ADMIN') rows.forEach((p) => delete p.cost);
  res.json(rows);
});

r.get('/products/barcode/:code', async (req, res) => {
  const p = await one(`${PRODUCT_SELECT} WHERE p.deleted_at IS NULL AND (p.barcode = $1 OR upper(p.sku) = upper($1))`, [req.params.code]);
  if (!p) throw notFound('ไม่พบสินค้าจาก Barcode นี้');
  res.json(p);
});

async function saveOptions(c, productId, options) {
  const keep = options.filter((o) => o.id).map((o) => o.id);
  await c.query('DELETE FROM product_options WHERE product_id = $1 AND NOT (id = ANY($2))', [productId, keep]);
  for (const [i, o] of options.entries()) {
    if (o.id) await c.query('UPDATE product_options SET group_name=$2, name=$3, price_delta=$4, is_addon=$5, sort_order=$6 WHERE id=$1 AND product_id=$7', [o.id, o.groupName, o.name, o.priceDelta, o.isAddon, i, productId]);
    else await c.query('INSERT INTO product_options(product_id, group_name, name, price_delta, is_addon, sort_order) VALUES ($1,$2,$3,$4,$5,$6)', [productId, o.groupName, o.name, o.priceDelta, o.isAddon, i]);
  }
}

r.post('/products', can('product.create'), async (req, res) => {
  const b = parse(productSchema, req.body);
  const row = await tx(async (c) => {
    const p = (
      await c.query(
        `INSERT INTO products(sku, barcode, name, image_url, category_id, description, price, cost, unit, track_stock, min_stock, is_available, is_sold_out, sc_exempt, points_eligible, note, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
        [b.sku, b.barcode, b.name, b.imageUrl, b.categoryId, b.description, b.price, b.cost, b.unit, b.trackStock, b.minStock, b.isAvailable, b.isSoldOut, b.scExempt, b.pointsEligible, b.note, b.sortOrder],
      )
    ).rows[0];
    await c.query('INSERT INTO stock_balances(product_id, quantity) VALUES ($1, 0)', [p.id]);
    await saveOptions(c, p.id, b.options);
    if (b.trackStock && b.initialStock) await moveStock(c, { productId: p.id, type: 'IN', quantity: b.initialStock, employeeId: req.employee.id, note: 'ยอดเริ่มต้น' });
    await logActivity(c, req, 'PRODUCT_CREATE', 'product', p.id, b);
    return p;
  });
  emitSync('products');
  res.json(row);
});

r.put('/products/:id', can('product.edit'), async (req, res) => {
  const b = parse(productSchema, req.body);
  const row = await tx(async (c) => {
    const before = (await c.query('SELECT * FROM products WHERE id = $1 AND deleted_at IS NULL', [req.params.id])).rows[0];
    if (!before) throw notFound();
    const p = (
      await c.query(
        `UPDATE products SET sku=$2, barcode=$3, name=$4, image_url=$5, category_id=$6, description=$7, price=$8, cost=$9, unit=$10, track_stock=$11, min_stock=$12,
           is_available=$13, is_sold_out=$14, sc_exempt=$15, points_eligible=$16, note=$17, sort_order=$18, updated_at=now() WHERE id=$1 RETURNING *`,
        [req.params.id, b.sku, b.barcode, b.name, b.imageUrl, b.categoryId, b.description, b.price, b.cost, b.unit, b.trackStock, b.minStock, b.isAvailable, b.isSoldOut, b.scExempt, b.pointsEligible, b.note, b.sortOrder],
      )
    ).rows[0];
    await saveOptions(c, p.id, b.options);
    await logActivity(c, req, 'PRODUCT_UPDATE', 'product', p.id, { before: { name: before.name, price: before.price, cost: before.cost }, after: b });
    return p;
  });
  emitSync('products');
  res.json(row);
});

r.patch('/products/:id/availability', can('product.edit'), async (req, res) => {
  const b = parse(z.object({ isAvailable: z.boolean().optional(), isSoldOut: z.boolean().optional() }), req.body);
  const row = await one(`UPDATE products SET is_available = COALESCE($2, is_available), is_sold_out = COALESCE($3, is_sold_out), updated_at = now() WHERE id = $1 RETURNING *`, [req.params.id, b.isAvailable ?? null, b.isSoldOut ?? null]);
  await logActivity(null, req, 'PRODUCT_AVAILABILITY', 'product', req.params.id, b);
  emitSync('products');
  res.json(row);
});

r.delete('/products/:id', can('product.delete'), async (req, res) => {
  await pool.query('UPDATE products SET deleted_at = now(), is_available = false WHERE id = $1', [req.params.id]);
  await logActivity(null, req, 'PRODUCT_DELETE', 'product', req.params.id);
  emitSync('products');
  res.json({ ok: true });
});

// ───────────── Stock ─────────────
r.get('/stock', async (_req, res) => {
  res.json(
    await many(
      `SELECT p.id, p.sku, p.name, p.unit, p.image_url, p.min_stock, p.track_stock, p.cost, c.name AS category_name, COALESCE(sb.quantity,0) AS quantity, sb.updated_at,
              COALESCE(sb.quantity,0) <= p.min_stock AS is_low
       FROM products p LEFT JOIN stock_balances sb ON sb.product_id = p.id LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.deleted_at IS NULL AND p.track_stock ORDER BY is_low DESC, p.name`,
    ),
  );
});

r.get('/stock/movements', async (req, res) => {
  res.json(
    await many(
      `SELECT sm.*, p.name AS product_name, p.unit, e.name AS employee_name FROM stock_movements sm JOIN products p ON p.id = sm.product_id LEFT JOIN employees e ON e.id = sm.employee_id
       WHERE ($1::int IS NULL OR sm.product_id = $1) AND ($2::text IS NULL OR sm.type = $2) ORDER BY sm.id DESC LIMIT 500`,
      [req.query.productId || null, req.query.type || null],
    ),
  );
});

r.post('/stock/movements', can('stock.manage'), async (req, res) => {
  const b = parse(
    z.object({
      productId: z.coerce.number().int(),
      type: z.enum(['IN', 'OUT', 'ADJUST', 'COUNT', 'DAMAGED', 'EXPIRED', 'RETURN']),
      quantity: z.coerce.number(),
      unitCost: z.coerce.number().min(0).optional().nullable(),
      note: z.string().max(500).optional().nullable(),
      reference: z.string().max(100).optional().nullable(),
    }),
    req.body,
  );
  if (b.type !== 'ADJUST' && b.type !== 'COUNT' && b.quantity <= 0) throw badRequest('จำนวนต้องมากกว่า 0');
  const out = await tx(async (c) => {
    const m = await moveStock(c, { ...b, employeeId: req.employee.id });
    if (!m) throw badRequest('สินค้านี้ไม่ได้เปิดติดตามสต็อก');
    if (b.type === 'IN' && b.unitCost) await c.query('UPDATE products SET cost = $2 WHERE id = $1', [b.productId, b.unitCost]);
    await logActivity(c, req, 'STOCK_' + b.type, 'product', b.productId, { ...b, ...m });
    return m;
  });
  emitSync('products');
  res.json(out);
});

r.post('/stock/count', can('stock.manage'), async (req, res) => {
  const { counts, note } = parse(z.object({ counts: z.array(z.object({ productId: z.coerce.number().int(), counted: z.coerce.number().min(0) })), note: z.string().optional() }), req.body);
  const results = await tx(async (c) => {
    const out = [];
    for (const x of counts) out.push({ productId: x.productId, ...(await moveStock(c, { productId: x.productId, type: 'COUNT', quantity: x.counted, employeeId: req.employee.id, note: note || 'นับสต็อก' })) });
    await logActivity(c, req, 'STOCK_COUNT', 'stock', null, { counts: out });
    return out;
  });
  emitSync('products');
  res.json(results);
});

// ───────────── Promotions ─────────────
const promoSchema = z.object({
  name: z.string().min(1).max(200),
  type: z.enum(['AMOUNT', 'PERCENT', 'MEMBER', 'BIRTHDAY', 'COUPON', 'FREE_HOURS', 'MIN_QTY', 'MIN_SPEND', 'FREE_ITEM', 'ROOM_TYPE', 'TIME_RANGE', 'HAPPY_HOUR']),
  valueType: z.enum(['AMOUNT', 'PERCENT']).default('AMOUNT'),
  value: z.coerce.number().min(0).default(0),
  code: z.string().max(50).optional().nullable().transform((v) => (v ? v.trim().toUpperCase() : null)),
  conditions: z.record(z.string(), z.any()).default({}),
  imageUrl: zUrl,
  description: z.string().max(2000).optional().nullable(),
  startDate: z.string().optional().nullable().transform((v) => v || null),
  endDate: z.string().optional().nullable().transform((v) => v || null),
  usageLimit: z.coerce.number().int().min(0).optional().nullable().transform((v) => v || null),
  autoApply: z.boolean().default(false),
  isOnline: z.boolean().default(true),
  depositAmount: z.coerce.number().min(0).optional().nullable(),
  isActive: z.boolean().default(true),
});
const promoCols = (b) => [b.name, b.type, b.valueType, b.value, b.code, b.conditions, b.imageUrl, b.description, b.startDate, b.endDate, b.usageLimit, b.autoApply, b.isOnline, b.depositAmount ?? null, b.isActive];
r.get('/promotions', async (_req, res) => res.json(await many('SELECT * FROM promotions WHERE deleted_at IS NULL ORDER BY id DESC')));
r.post('/promotions', can('settings.manage'), async (req, res) => {
  const b = parse(promoSchema, req.body);
  const row = await one(
    `INSERT INTO promotions(name, type, value_type, value, code, conditions, image_url, description, start_date, end_date, usage_limit, auto_apply, is_online, deposit_amount, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    promoCols(b),
  );
  await logActivity(null, req, 'PROMOTION_CREATE', 'promotion', row.id, b);
  emitSync('promotions');
  res.json(row);
});
r.put('/promotions/:id', can('settings.manage'), async (req, res) => {
  const b = parse(promoSchema, req.body);
  const row = await one(
    `UPDATE promotions SET name=$2, type=$3, value_type=$4, value=$5, code=$6, conditions=$7, image_url=$8, description=$9, start_date=$10, end_date=$11,
       usage_limit=$12, auto_apply=$13, is_online=$14, deposit_amount=$15, is_active=$16 WHERE id=$1 RETURNING *`,
    [req.params.id, ...promoCols(b)],
  );
  await logActivity(null, req, 'PROMOTION_UPDATE', 'promotion', req.params.id, b);
  emitSync('promotions');
  res.json(row);
});
r.delete('/promotions/:id', can('settings.manage'), async (req, res) => {
  await pool.query('UPDATE promotions SET deleted_at = now(), is_active = false WHERE id = $1', [req.params.id]);
  await logActivity(null, req, 'PROMOTION_DELETE', 'promotion', req.params.id);
  emitSync('promotions');
  res.json({ ok: true });
});

// ───────────── Member tiers ─────────────
const tierSchema = z.object({
  code: z.string().min(1).max(30),
  name: z.string().min(1).max(100),
  color: z.string().max(20).default('#9ca3af'),
  sortOrder: z.coerce.number().int().default(0),
  minPoints: z.coerce.number().min(0).optional().nullable(),
  minSpending: z.coerce.number().min(0).optional().nullable(),
  minVisits: z.coerce.number().int().min(0).optional().nullable(),
  minHours: z.coerce.number().min(0).optional().nullable(),
  conditionMode: z.enum(['ANY', 'ALL']).default('ANY'),
  pointMultiplier: z.coerce.number().min(0).max(100).default(1),
  roomDiscountPercent: z.coerce.number().min(0).max(100).default(0),
  productDiscountPercent: z.coerce.number().min(0).max(100).default(0),
  benefits: z.record(z.string(), z.any()).default({}),
  isActive: z.boolean().default(true),
});
const tierCols = (b) => [b.code, b.name, b.color, b.sortOrder, b.minPoints ?? null, b.minSpending ?? null, b.minVisits ?? null, b.minHours ?? null, b.conditionMode, b.pointMultiplier, b.roomDiscountPercent, b.productDiscountPercent, b.benefits, b.isActive];
r.get('/member-tiers', async (_req, res) => res.json(await many('SELECT t.*, (SELECT COUNT(*) FROM members m WHERE m.tier_id = t.id AND m.deleted_at IS NULL) AS member_count FROM member_tiers t ORDER BY sort_order')));
r.post('/member-tiers', can('settings.manage'), async (req, res) => {
  const b = parse(tierSchema, req.body);
  const row = await one(
    `INSERT INTO member_tiers(code, name, color, sort_order, min_points, min_spending, min_visits, min_hours, condition_mode, point_multiplier, room_discount_percent, product_discount_percent, benefits, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    tierCols(b),
  );
  await logActivity(null, req, 'TIER_CREATE', 'member_tier', row.id, b);
  res.json(row);
});
r.put('/member-tiers/:id', can('settings.manage'), async (req, res) => {
  const b = parse(tierSchema, req.body);
  const row = await one(
    `UPDATE member_tiers SET code=$2, name=$3, color=$4, sort_order=$5, min_points=$6, min_spending=$7, min_visits=$8, min_hours=$9, condition_mode=$10,
       point_multiplier=$11, room_discount_percent=$12, product_discount_percent=$13, benefits=$14, is_active=$15 WHERE id=$1 RETURNING *`,
    [req.params.id, ...tierCols(b)],
  );
  await logActivity(null, req, 'TIER_UPDATE', 'member_tier', req.params.id, b);
  res.json(row);
});

// ───────────── Rewards ─────────────
const rewardSchema = z.object({
  name: z.string().min(1).max(200),
  imageUrl: zUrl,
  description: z.string().max(2000).optional().nullable(),
  pointsCost: z.coerce.number().int().min(1),
  rewardType: z.enum(['DISCOUNT', 'FREE_HOUR', 'EXTRA_30', 'FREE_DRINK', 'FREE_PRODUCT', 'PACKAGE']),
  value: z.coerce.number().min(0).default(0),
  productId: z.coerce.number().int().optional().nullable(),
  roomTypeIds: zIdArr,
  availableDays: z.array(z.coerce.number().int()).default([0, 1, 2, 3, 4, 5, 6]),
  availableFrom: z.string().optional().nullable().transform((v) => v || null),
  availableTo: z.string().optional().nullable().transform((v) => v || null),
  expiresAt: z.string().optional().nullable().transform((v) => v || null),
  validDays: z.coerce.number().int().min(1).default(30),
  quantityTotal: z.coerce.number().int().min(0).optional().nullable().transform((v) => v || null),
  limitPerMember: z.coerce.number().int().min(0).optional().nullable().transform((v) => v || null),
  isActive: z.boolean().default(true),
});
const rewardCols = (b) => [b.name, b.imageUrl, b.description, b.pointsCost, b.rewardType, b.value, b.productId ?? null, b.roomTypeIds, b.availableDays, b.availableFrom, b.availableTo, b.expiresAt, b.validDays, b.quantityTotal, b.limitPerMember, b.isActive];
r.get('/rewards', async (_req, res) => res.json(await many('SELECT * FROM rewards WHERE deleted_at IS NULL ORDER BY points_cost')));
r.post('/rewards', can('settings.manage'), async (req, res) => {
  const b = parse(rewardSchema, req.body);
  const row = await one(
    `INSERT INTO rewards(name, image_url, description, points_cost, reward_type, value, product_id, room_type_ids, available_days, available_from, available_to, expires_at, valid_days, quantity_total, limit_per_member, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
    rewardCols(b),
  );
  await logActivity(null, req, 'REWARD_CREATE', 'reward', row.id, b);
  res.json(row);
});
r.put('/rewards/:id', can('settings.manage'), async (req, res) => {
  const b = parse(rewardSchema, req.body);
  const row = await one(
    `UPDATE rewards SET name=$2, image_url=$3, description=$4, points_cost=$5, reward_type=$6, value=$7, product_id=$8, room_type_ids=$9, available_days=$10,
       available_from=$11, available_to=$12, expires_at=$13, valid_days=$14, quantity_total=$15, limit_per_member=$16, is_active=$17 WHERE id=$1 RETURNING *`,
    [req.params.id, ...rewardCols(b)],
  );
  await logActivity(null, req, 'REWARD_UPDATE', 'reward', req.params.id, b);
  res.json(row);
});
r.delete('/rewards/:id', can('settings.manage'), async (req, res) => {
  await pool.query('UPDATE rewards SET deleted_at = now(), is_active = false WHERE id = $1', [req.params.id]);
  await logActivity(null, req, 'REWARD_DELETE', 'reward', req.params.id);
  res.json({ ok: true });
});

export default r;

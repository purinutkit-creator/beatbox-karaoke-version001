import { Router } from 'express';
import { pool, many, one } from '../db/index.js';
import { requireAuth, can } from '../lib/auth.js';
import { emitStaff } from '../lib/realtime.js';

const r = Router();
r.use(requireAuth);

r.get('/notifications', async (req, res) => {
  const channel = req.query.channel || 'POS';
  const rows = await many(
    `SELECT n.*, e.name AS read_by_name FROM notifications n LEFT JOIN employees e ON e.id = n.read_by
     WHERE n.channel = $1 AND ($2::boolean IS NOT TRUE OR n.read_at IS NULL) ORDER BY n.id DESC LIMIT $3`,
    [channel, req.query.unread === 'true', Number(req.query.limit || 100)],
  );
  const unread = await one(`SELECT COUNT(*) AS n FROM notifications WHERE channel = 'POS' AND read_at IS NULL`);
  res.json({ items: rows, unread: Number(unread.n) });
});

r.post('/notifications/:id/read', async (req, res) => {
  await pool.query('UPDATE notifications SET read_at = now(), read_by = $2 WHERE id = $1 AND read_at IS NULL', [req.params.id, req.employee.id]);
  emitStaff('notification:read', { ids: [Number(req.params.id)] });
  res.json({ ok: true });
});

r.post('/notifications/read-all', async (req, res) => {
  const r2 = await pool.query(`UPDATE notifications SET read_at = now(), read_by = $1 WHERE channel = 'POS' AND read_at IS NULL RETURNING id`, [req.employee.id]);
  emitStaff('notification:read', { ids: r2.rows.map((x) => x.id) });
  res.json({ ok: true });
});

r.post('/notifications/:id/retry', can('settings.manage'), async (req, res) => {
  await pool.query(`UPDATE notifications SET status = 'PENDING', attempts = 0, error = NULL WHERE id = $1 AND channel <> 'POS'`, [req.params.id]);
  res.json({ ok: true });
});

r.get('/activity-logs', can('activity.view'), async (req, res) => {
  const q = req.query;
  res.json(
    await many(
      `SELECT * FROM activity_logs WHERE ($1::int IS NULL OR employee_id = $1) AND ($2::text IS NULL OR action ILIKE '%'||$2||'%') AND ($3::text IS NULL OR entity = $3)
         AND ($4::text IS NULL OR entity_id = $4) AND ($5::date IS NULL OR (created_at AT TIME ZONE 'Asia/Bangkok')::date >= $5)
         AND ($6::date IS NULL OR (created_at AT TIME ZONE 'Asia/Bangkok')::date <= $6)
       ORDER BY id DESC LIMIT $7`,
      [q.employeeId || null, q.action || null, q.entity || null, q.entityId || null, q.from || null, q.to || null, Math.min(Number(q.limit || 300), 2000)],
    ),
  );
});

export default r;

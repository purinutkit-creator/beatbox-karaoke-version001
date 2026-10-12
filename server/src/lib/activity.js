import { pool } from '../db/index.js';

/** Append an Activity Log entry. Use the transaction client when available so the log commits atomically. */
export async function logActivity(client, req, action, entity, entityId, details = {}) {
  const emp = req?.employee;
  const c = client || pool;
  // work done by the Super Owner inside a store is logged with the real platform identity
  const sup = emp?.platformUserId || null;
  await c.query(
    `INSERT INTO activity_logs(employee_id, employee_name, action, entity, entity_id, details, ip, device_id, platform_user_id, actor_type)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [emp?.id || null, emp?.name || details?.actor || null, action, entity || null, entityId != null ? String(entityId) : null, details, req?.ip || null, req?.deviceId || null, sup, sup ? 'SUPER_OWNER' : emp?.id ? 'EMPLOYEE' : 'SYSTEM'],
  );
}

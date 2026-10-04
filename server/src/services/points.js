import { notFound, badRequest } from '../lib/errors.js';

/**
 * The ONLY way to change a member's points: append to point_ledgers (balance_before/after) and update the cached balance.
 */
export async function addPointTx(client, { memberId, type, points, source = 'POS', reservationId = null, orderId = null, receiptId = null, rewardId = null, redemptionId = null, employeeId = null, reason = null, expiresAt = null, idempotencyKey = null, allowNegative = false }) {
  if (idempotencyKey) {
    const ex = (await client.query('SELECT * FROM point_ledgers WHERE idempotency_key = $1', [idempotencyKey])).rows[0];
    if (ex) return ex;
  }
  const m = (await client.query('SELECT id, points_balance FROM members WHERE id = $1 FOR UPDATE', [memberId])).rows[0];
  if (!m) throw notFound('ไม่พบสมาชิก');
  const before = Number(m.points_balance);
  const after = Math.round((before + Number(points)) * 100) / 100;
  if (after < 0 && !allowNegative) throw badRequest('คะแนนสะสมไม่เพียงพอ');
  const r = await client.query(
    `INSERT INTO point_ledgers(member_id, type, points, balance_before, balance_after, source, reservation_id, order_id, receipt_id, reward_id, redemption_id, employee_id, reason, expires_at, remaining, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
    [memberId, type, points, before, after, source, reservationId, orderId, receiptId, rewardId, redemptionId, employeeId, reason, expiresAt, type === 'EARN' ? points : null, idempotencyKey],
  );
  await client.query('UPDATE members SET points_balance = $2, updated_at = now() WHERE id = $1', [memberId, after]);
  // consume FIFO "remaining" for expiry tracking
  if (Number(points) < 0) {
    let toConsume = -Number(points);
    const lots = (await client.query(`SELECT id, remaining FROM point_ledgers WHERE member_id = $1 AND type = 'EARN' AND remaining > 0 ORDER BY created_at`, [memberId])).rows;
    for (const lot of lots) {
      if (toConsume <= 0) break;
      const take = Math.min(Number(lot.remaining), toConsume);
      await client.query('UPDATE point_ledgers SET remaining = remaining - $2 WHERE id = $1', [lot.id, take]);
      toConsume -= take;
    }
  }
  return r.rows[0];
}

/** Re-evaluate the member tier after a relevant transaction (highest tier whose conditions are met). */
export async function evaluateTier(client, memberId) {
  const m = (await client.query('SELECT id, tier_id, points_balance, total_spending, visit_count, total_minutes FROM members WHERE id = $1', [memberId])).rows[0];
  if (!m) return null;
  const tiers = (await client.query('SELECT * FROM member_tiers WHERE is_active ORDER BY sort_order DESC')).rows;
  const hours = Number(m.total_minutes) / 60;
  for (const t of tiers) {
    const checks = [];
    if (t.min_points != null) checks.push(Number(m.points_balance) >= Number(t.min_points));
    if (t.min_spending != null) checks.push(Number(m.total_spending) >= Number(t.min_spending));
    if (t.min_visits != null) checks.push(Number(m.visit_count) >= Number(t.min_visits));
    if (t.min_hours != null) checks.push(hours >= Number(t.min_hours));
    const ok = checks.length === 0 ? true : t.condition_mode === 'ALL' ? checks.every(Boolean) : checks.some(Boolean);
    if (ok) {
      if (t.id !== m.tier_id) await client.query('UPDATE members SET tier_id = $2 WHERE id = $1', [memberId, t.id]);
      return t;
    }
  }
  return null;
}

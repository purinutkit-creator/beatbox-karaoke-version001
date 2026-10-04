import { pool } from '../db/index.js';
import { conflict } from './errors.js';

/**
 * Idempotency middleware: the same Idempotency-Key always returns the same response and never re-executes.
 * Used for payments, deposits, refunds, redemptions, booking confirmation and offline sync.
 */
export function idempotent(scope, { required = true } = {}) {
  return async (req, res, next) => {
    const key = req.headers['idempotency-key'] || req.body?.idempotencyKey;
    if (!key) {
      if (required) return res.status(400).json({ error: 'ต้องระบุ Idempotency-Key', code: 'IDEMPOTENCY_REQUIRED' });
      return next();
    }
    const fullKey = `${scope}:${key}`;
    req.idempotencyKey = String(key);
    const ins = await pool.query(`INSERT INTO idempotency_keys(key, scope) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING RETURNING key`, [fullKey, scope]);
    if (!ins.rows[0]) {
      const ex = await pool.query('SELECT status_code, response FROM idempotency_keys WHERE key = $1', [fullKey]);
      const row = ex.rows[0];
      if (row?.status_code) {
        res.setHeader('Idempotent-Replay', 'true');
        return res.status(row.status_code).json(row.response);
      }
      throw conflict('รายการนี้กำลังประมวลผลอยู่ กรุณารอสักครู่', 'IN_PROGRESS');
    }
    const json = res.json.bind(res);
    res.json = (body) => {
      const status = res.statusCode;
      if (status < 400) {
        pool.query('UPDATE idempotency_keys SET status_code = $2, response = $3 WHERE key = $1', [fullKey, status, body]).catch(() => {});
      } else {
        // allow retry after failure
        pool.query('DELETE FROM idempotency_keys WHERE key = $1', [fullKey]).catch(() => {});
      }
      return json(body);
    };
    res.on('close', () => {
      if (!res.writableFinished) pool.query('DELETE FROM idempotency_keys WHERE key = $1 AND status_code IS NULL', [fullKey]).catch(() => {});
    });
    next();
  };
}

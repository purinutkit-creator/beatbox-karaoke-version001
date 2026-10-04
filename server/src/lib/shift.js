import { pool } from '../db/index.js';
import { conflict } from './errors.js';

export async function currentShift(deviceId) {
  if (!deviceId) return null;
  return (await pool.query(`SELECT * FROM shifts WHERE device_id = $1 AND status = 'OPEN' ORDER BY id DESC LIMIT 1`, [deviceId])).rows[0] || null;
}

/** Money-handling actions require an open shift on this POS device. */
export async function requireShift(req, _res, next) {
  const s = await currentShift(req.deviceId);
  if (!s) throw conflict('กรุณาเปิดรอบการขายก่อนทำรายการ', 'NO_SHIFT');
  req.shiftId = s.id;
  req.shift = s;
  next();
}

/** Attach shift if one is open, without requiring it. */
export async function attachShift(req, _res, next) {
  const s = await currentShift(req.deviceId);
  if (s) {
    req.shiftId = s.id;
    req.shift = s;
  }
  next();
}

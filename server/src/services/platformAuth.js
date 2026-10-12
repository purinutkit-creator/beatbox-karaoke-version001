// Super Owner (Super Admin) sign-in: login name or e-mail + password (no OTP). 5 wrong passwords → 15 minutes lock.
import bcrypt from 'bcryptjs';
import { pool, one, runAsPlatform } from '../db/index.js';
import { signToken } from '../lib/auth.js';
import { unauthorized } from '../lib/errors.js';

export function findPlatformUser(identifier) {
  return runAsPlatform(() =>
    one('SELECT * FROM platform_users WHERE lower(username) = lower($1) OR lower(email) = lower($1) ORDER BY (lower(username) = lower($1)) DESC LIMIT 1', [String(identifier || '').trim()]),
  );
}

/** Returns { token, user } or throws 401 (wrong / locked). */
export async function platformSignIn(identifier, password) {
  return runAsPlatform(async () => {
    const u = await findPlatformUser(identifier);
    if (!u || !u.is_active) throw unauthorized('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
    if (u.locked_until && new Date(u.locked_until) > new Date()) throw unauthorized(`เข้าสู่ระบบผิดหลายครั้ง กรุณารอ ${Math.ceil((new Date(u.locked_until) - Date.now()) / 60000)} นาที`);
    if (!(await bcrypt.compare(String(password), u.password_hash))) {
      const n = Number(u.failed_attempts) + 1;
      await pool.query(`UPDATE platform_users SET failed_attempts = $2, locked_until = CASE WHEN $3 THEN now() + interval '15 minutes' ELSE locked_until END WHERE id = $1`, [u.id, n >= 5 ? 0 : n, n >= 5]);
      throw unauthorized(n >= 5 ? 'เข้าสู่ระบบผิดเกิน 5 ครั้ง ระบบพักการเข้าสู่ระบบ 15 นาที' : 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
    }
    const s = await one('INSERT INTO platform_sessions(platform_user_id) VALUES ($1) RETURNING id', [u.id]);
    await pool.query('UPDATE platform_users SET failed_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [u.id]);
    return { token: signToken({ typ: 'platform', psid: s.id, pid: u.id }, '12h'), user: { id: u.id, username: u.username, email: u.email, displayName: u.display_name, role: u.role } };
  });
}

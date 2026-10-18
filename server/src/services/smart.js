// Smart devices (Tuya) linked to rooms: named "systems" (e.g. "ไฟเตือนใกล้หมดเวลา", "ตัดไฟห้อง") with a trigger,
// a command, and the device of each room. Staff can press a system's button; automations run from the scheduler.
import { pool } from '../db/index.js';
import { tuyaConfig, tuyaSend } from '../providers/tuya.js';
import { sessionTiming } from '@beatbox/shared/roomPricing.js';
import { notify } from './notifications.js';
import { emitSync } from '../lib/realtime.js';

export const SMART_TRIGGERS = ['MANUAL', 'ON_START', 'BEFORE_END', 'AT_END', 'ON_CLOSE'];

/** Send a system's commands to the room's device and keep a log line (never throws). */
export async function runSystem(system, binding, { sessionId = null, trigger = 'MANUAL', employeeId = null } = {}) {
  let ok = true;
  let error = null;
  let detail = null;
  try {
    const r = await tuyaSend(binding.device_id, system.commands);
    detail = { via: r?.via || null, trace: r?.trace || [] };
  } catch (e) {
    ok = false;
    error = e.message;
    detail = { trace: e.trace || [] };
  }
  await pool.query(
    `INSERT INTO smart_logs(system_id, room_id, session_id, device_id, name, trigger, ok, error, employee_id, detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [system.id, binding.room_id, sessionId, binding.device_id, system.name, trigger, ok, error, employeeId, detail],
  );
  emitSync(['smart']);
  return { ok, error, detail };
}

/** Automations on the room clock. Each (system, session, end time) runs once, even with several servers. */
export async function smartTick() {
  const cfg = await tuyaConfig();
  if (!cfg.enabled || !cfg.accessId || !cfg.accessSecret) return [];
  const systems = (await pool.query(`SELECT * FROM smart_systems WHERE is_active AND trigger <> 'MANUAL' ORDER BY sort_order, id`)).rows;
  if (!systems.length) return [];
  const bindings = (await pool.query('SELECT * FROM smart_bindings')).rows;
  const bind = (sysId, roomId) => bindings.find((b) => b.system_id === sysId && b.room_id === roomId);
  const sessions = (
    await pool.query(
      `SELECT rs.*, r.name AS room_name FROM room_sessions rs JOIN rooms r ON r.id = rs.room_id
       WHERE rs.status IN ('ACTIVE','CLOSED') OR (rs.status IN ('PAID','CANCELLED') AND rs.ended_at > now() - interval '10 minutes')`,
    )
  ).rows;
  const ran = [];
  for (const s of sessions) {
    const fired = new Set((s.smart_fired || []).map(String));
    const endKey = new Date(s.scheduled_end_at).getTime();
    const remainingMin = sessionTiming(s).remainingMs / 60000;
    const due = [];
    for (const sys of systems) {
      if (!bind(sys.id, s.room_id)) continue;
      const k = (x) => `S${sys.id}:${x}`;
      if (['PAID', 'CANCELLED'].includes(s.status)) {
        if (sys.trigger === 'ON_CLOSE') due.push([sys, k('close')]);
        continue;
      }
      const ended = s.status === 'CLOSED' || remainingMin <= 0;
      if (sys.trigger === 'ON_START' && s.status === 'ACTIVE' && !ended) {
        due.push([sys, k('start')]);
        // time was added after the room had been cut at its old end → switch it back on
        const cutEarlier = systems.some((x) => x.trigger === 'AT_END' && [...fired].some((f) => f.startsWith(`S${x.id}:end:`) && f !== `S${x.id}:end:${endKey}`));
        if (cutEarlier) due.push([sys, k(`start:${endKey}`)]);
      }
      if (sys.trigger === 'BEFORE_END' && s.status === 'ACTIVE' && !ended && remainingMin <= Number(sys.minutes)) due.push([sys, k(`before:${endKey}`)]);
      if (sys.trigger === 'AT_END' && ended) due.push([sys, k(`end:${endKey}`)]);
    }
    const todo = due.filter(([, key]) => !fired.has(key));
    if (!todo.length) continue;
    const keys = todo.map(([, key]) => key);
    // atomic claim: only the server that adds the keys runs the commands
    const claim = await pool.query(
      `UPDATE room_sessions SET smart_fired = smart_fired || $2::jsonb WHERE id = $1 AND NOT (smart_fired ?| $3::text[]) RETURNING id`,
      [s.id, JSON.stringify(keys), keys],
    );
    if (!claim.rows[0]) continue;
    for (const [sys] of todo) {
      const r = await runSystem(sys, bind(sys.id, s.room_id), { sessionId: s.id, trigger: sys.trigger });
      ran.push({ system: sys.id, session: s.id, ...r });
      if (!r.ok) {
        await notify({ type: 'SMART_DEVICE_FAILED', level: 'error', title: `อุปกรณ์ห้อง ${s.room_name}: ${sys.name} ทำงานไม่สำเร็จ`, message: r.error, roomId: s.room_id, dedupeKey: `smart:${s.id}:${sys.id}:${endKey}` }).catch(() => {});
      }
    }
  }
  return ran;
}

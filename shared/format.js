export const TZ = 'Asia/Bangkok';

export function fmtDate(d, opts = {}) {
  if (!d) return '-';
  return new Date(d).toLocaleDateString('th-TH', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric', ...opts });
}
export function fmtTime(d) {
  if (!d) return '-';
  return new Date(d).toLocaleTimeString('th-TH', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
}
export function fmtDateTime(d) {
  if (!d) return '-';
  return `${fmtDate(d)} ${fmtTime(d)}`;
}
export function fmtCountdown(ms) {
  const neg = ms < 0;
  const s = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const str = `${h > 0 ? h + ':' : ''}${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return neg ? `-${str}` : str;
}
/** YYYY-MM-DD in Bangkok time */
export function bkkDateStr(d = new Date()) {
  const dt = new Date(new Date(d).getTime() + 7 * 3600 * 1000);
  return dt.toISOString().slice(0, 10);
}
/** Build a Date from Bangkok local date (YYYY-MM-DD) and time (HH:mm) */
export function bkkDateTime(dateStr, timeStr = '00:00') {
  return new Date(`${dateStr}T${timeStr.length === 5 ? timeStr + ':00' : timeStr}+07:00`);
}
export function maskPhone(p) {
  const s = String(p || '');
  return s.length >= 7 ? s.slice(0, 3) + '-xxx-' + s.slice(-4) : s;
}
export function normalizePhone(p) {
  let s = String(p || '').replace(/[^0-9]/g, '');
  if (s.startsWith('66') && s.length === 11) s = '0' + s.slice(2);
  return s;
}

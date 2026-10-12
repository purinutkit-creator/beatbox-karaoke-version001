// Calendar-aware "time remaining" (years, months, days, hours, minutes) in a given time zone.
//
// How it is counted (documented so the numbers never surprise anyone):
//  1. both instants are converted to wall-clock time in the store's time zone (default Asia/Bangkok)
//  2. whole years, then whole months are added from the start on the real calendar
//     (months have their real length; when the day does not exist, e.g. 31 → February, the last day of the month is used)
//  3. what is left is real elapsed time split into days, hours and minutes (seconds are dropped)

function wallParts(ms, timeZone) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)]));
  return { y: p.year, mo: p.month - 1, d: p.day, h: p.hour === 24 ? 0 : p.hour, mi: p.minute, s: p.second };
}

const daysInMonth = (y, mo) => new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();

function addMonths(w, n) {
  const total = w.y * 12 + w.mo + n;
  const y = Math.floor(total / 12);
  const mo = total - y * 12;
  return { ...w, y, mo, d: Math.min(w.d, daysInMonth(y, mo)) };
}

const asUtc = (w) => Date.UTC(w.y, w.mo, w.d, w.h, w.mi, w.s);

export function remainingParts(nowMs, endMs, timeZone = 'Asia/Bangkok') {
  if (endMs == null) return { unlimited: true };
  if (endMs <= nowMs) return { expired: true, years: 0, months: 0, days: 0, hours: 0, minutes: 0, totalMs: endMs - nowMs };
  const a = wallParts(nowMs, timeZone);
  const b = asUtc(wallParts(endMs, timeZone));
  let years = b > 0 ? new Date(b).getUTCFullYear() - a.y : 0;
  while (years > 0 && asUtc(addMonths(a, years * 12)) > b) years--;
  let t = addMonths(a, years * 12);
  let months = 0;
  while (months < 12 && asUtc(addMonths(t, months + 1)) <= b) months++;
  t = addMonths(t, months);
  let rest = Math.max(0, b - asUtc(t));
  const days = Math.floor(rest / 86400000);
  rest -= days * 86400000;
  const hours = Math.floor(rest / 3600000);
  rest -= hours * 3600000;
  const minutes = Math.floor(rest / 60000);
  return { expired: false, years, months, days, hours, minutes, totalMs: endMs - nowMs };
}

/** "1 ปี 2 เดือน 3 วัน 4 ชม. 5 นาที" (zero units are skipped, minutes always shown) */
export function formatRemaining(p, lang = 'th') {
  if (!p || p.unlimited) return lang === 'en' ? 'No expiry' : 'ไม่มีวันหมดอายุ';
  if (p.expired) return lang === 'en' ? 'Expired' : 'หมดอายุแล้ว';
  const u = lang === 'en' ? ['y', 'mo', 'd', 'h', 'min'] : ['ปี', 'เดือน', 'วัน', 'ชม.', 'นาที'];
  const v = [p.years, p.months, p.days, p.hours, p.minutes];
  const out = v.map((n, i) => (n || i === 4 ? `${n} ${u[i]}` : null)).filter(Boolean);
  return out.join(' ');
}

/** Wall-clock hour/minute + date string of an instant in a time zone (for the booking calendar "now" line). */
export function zonedNow(ms, timeZone = 'Asia/Bangkok') {
  const w = wallParts(ms, timeZone);
  const pad = (n) => String(n).padStart(2, '0');
  return { date: `${w.y}-${pad(w.mo + 1)}-${pad(w.d)}`, hhmm: `${pad(w.h)}:${pad(w.mi)}`, minutesOfDay: w.h * 60 + w.mi };
}

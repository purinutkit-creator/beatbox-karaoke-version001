export function round2(n) {
  const x = Number(n) || 0;
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

export function formatMoney(n, { decimals = 2, symbol = '' } = {}) {
  const v = round2(n);
  const s = v.toLocaleString('th-TH', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return symbol ? `${symbol}${s}` : s;
}

export function applyRounding(amount, rounding = {}) {
  const mode = rounding.mode || 'NONE';
  const unit = Number(rounding.unit || 1);
  const a = round2(amount);
  if (mode === 'NONE' || !unit) return a;
  const q = a / unit;
  let r;
  if (mode === 'UP') r = Math.ceil(round2(q * 1e6) / 1e6);
  else if (mode === 'DOWN') r = Math.floor(round2(q * 1e6) / 1e6);
  else r = Math.round(q);
  return round2(r * unit);
}

export const ROUNDING_MODES = {
  NONE: 'ไม่ปัดเศษ',
  NEAREST: 'ปัดตามหลักคณิตศาสตร์',
  UP: 'ปัดขึ้น',
  DOWN: 'ปัดลง',
};

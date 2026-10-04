// Document numbering templates: tokens {YYYY} {YY} {MM} {DD} {BRANCH} {SEQ:n}
export function periodKey(template, date = new Date()) {
  const d = toBangkok(date);
  let key = '';
  if (/\{YYYY\}|\{YY\}/.test(template)) key += d.y;
  if (/\{MM\}/.test(template)) key += '-' + d.m;
  if (/\{DD\}/.test(template)) key += '-' + d.d;
  return key || 'ALL';
}

export function renderNumber(template, seq, { date = new Date(), branch = '' } = {}) {
  const d = toBangkok(date);
  return String(template || '{SEQ:6}')
    .replace(/\{YYYY\}/g, d.y)
    .replace(/\{YY\}/g, d.y.slice(2))
    .replace(/\{MM\}/g, d.m)
    .replace(/\{DD\}/g, d.d)
    .replace(/\{BRANCH\}/g, branch)
    .replace(/\{SEQ(?::(\d+))?\}/g, (_, n) => String(seq).padStart(Number(n || 1), '0'));
}

export function renderQueue(cfg = {}, seq) {
  return `${cfg.prefix ?? 'BEATBOX'}${String(seq).padStart(Number(cfg.digits ?? 2), '0')}`;
}

export function toBangkok(date) {
  const dt = new Date(new Date(date).getTime() + 7 * 3600 * 1000);
  return {
    y: String(dt.getUTCFullYear()),
    m: String(dt.getUTCMonth() + 1).padStart(2, '0'),
    d: String(dt.getUTCDate()).padStart(2, '0'),
  };
}

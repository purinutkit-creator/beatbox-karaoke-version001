// ESC/POS *text* output: the printer prints with its own built-in fonts (never the store's font).
// Thai is sent as TIS-620 bytes after selecting the code page configured for the printer (ESC t n);
// QR codes use the printer's native QR command (GS ( k) — no image, no raster, no canvas.
// Logos are images, so they are skipped in this mode (the preview says so).

const ESC = 0x1b;
const GS = 0x1d;

// Thai combining marks take no column on a monospace printer line
const ZERO_WIDTH = /[ัิ-ฺ็-๎]/;
export function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) if (!ZERO_WIDTH.test(ch)) w++;
  return w;
}

function sliceWidth(s, width) {
  // split into [head (≤ width columns), rest] without cutting a base character from its marks
  const chars = [...String(s)];
  let w = 0;
  let i = 0;
  for (; i < chars.length; i++) {
    const zw = ZERO_WIDTH.test(chars[i]);
    if (!zw && w + 1 > width) break;
    if (!zw) w++;
  }
  return [chars.slice(0, i).join(''), chars.slice(i).join('')];
}

/** Word wrap by printer columns (Thai has no spaces between words → falls back to column cuts). */
export function wrap(s, width) {
  const out = [];
  for (const para of String(s ?? '').split('\n')) {
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      if (displayWidth(line + word) <= width) {
        line += word;
        continue;
      }
      if (line.trim()) out.push(line.trimEnd());
      line = word.trimStart();
      while (displayWidth(line) > width) {
        const [head, rest] = sliceWidth(line, width);
        out.push(head);
        line = rest;
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

const pad = (s, width, align) => {
  const gap = Math.max(0, width - displayWidth(s));
  if (align === 'right') return ' '.repeat(gap) + s;
  if (align === 'center') return ' '.repeat(Math.floor(gap / 2)) + s;
  return s;
};

function twoCol(left, right, width) {
  const rw = displayWidth(right);
  if (displayWidth(left) + rw + 1 <= width) return [left + ' '.repeat(width - displayWidth(left) - rw) + right];
  return [...wrap(left, width), pad(right, width, 'right')];
}

/** Columns per line for a printer (Font A: 58 mm → 32, 80 mm → 48 unless the printer says otherwise). */
export function columnsFor(printer = {}) {
  if (printer.chars_per_line) return Number(printer.chars_per_line);
  const w = Number(printer.paper_width || 80);
  return w <= 60 ? 32 : w >= 100 ? 64 : 48;
}

/**
 * Sections → printer lines. Each line: { text, align, bold, mag } or { qr, size } or { feed }.
 * mag: 1 = normal, 2 = double width + height (headers ≥ 16 pt), 'h' = double height only (≥ 12.5 pt).
 */
export function textLines(sections, printer = {}) {
  const cols = columnsFor(printer);
  const lines = [];
  for (const sec of sections) {
    const st = sec.style || {};
    for (let i = 0; i < Math.round(Number(st.spaceBefore || 0) / 4); i++) lines.push({ text: '' });
    for (const b of sec.blocks) {
      const pt = Number(st.size || 10) * (b.rel || 1);
      const mag = pt >= 16 ? 2 : pt >= 12.5 ? 'h' : 1;
      const width = mag === 2 ? Math.floor(cols / 2) : cols;
      const bold = !!(st.bold || b.strong);
      const align = b.align || st.align || 'left';
      if (b.t === 'text') {
        const ls = wrap(b.text, b.box ? width - 4 : width);
        if (b.box) lines.push({ text: '*'.repeat(width), align: 'left', bold, mag });
        for (const l of ls) lines.push({ text: b.box ? pad(l, width, 'center') : l, align: b.box ? 'left' : align, bold, mag });
        if (b.box) lines.push({ text: '*'.repeat(width), align: 'left', bold, mag });
      } else if (b.t === 'kv') {
        for (const l of twoCol(b.k, b.v, width)) lines.push({ text: l, align: 'left', bold, mag });
      } else if (b.t === 'item') {
        for (const l of twoCol(b.name, b.amount, width)) lines.push({ text: l, align: 'left', bold, mag });
        for (const s of b.subs || []) for (const l of wrap(`  ${s}`, width)) lines.push({ text: l, align: 'left', mag: 1 });
      } else if (b.t === 'timebox') {
        // printer fonts: framed block, times in double size
        lines.push({ text: '='.repeat(cols), align: 'left', mag: 1 });
        if (b.date) lines.push({ text: b.date, align: 'center', bold: true, mag: 1 });
        lines.push({ text: `${b.startLabel} - ${b.endLabel}`, align: 'center', bold: true, mag: 1 });
        lines.push({ text: `${b.start} - ${b.end}`, align: 'center', bold: true, mag: 2 });
        if (b.startDate) lines.push({ text: `${b.startDate} - ${b.endDate}`, align: 'center', mag: 1 });
        if (b.duration) lines.push({ text: b.duration, align: 'center', bold: true, mag: 'h' });
        lines.push({ text: '='.repeat(cols), align: 'left', mag: 1 });
      } else if (b.t === 'hr') {
        lines.push({ text: (b.double ? '=' : '-').repeat(cols), align: 'left', mag: 1 });
      } else if (b.t === 'qr') {
        lines.push({ qr: b.value, size: Number(st.qrSize || 30), align: 'center' });
      } else if (b.t === 'img') {
        lines.push({ skipped: 'logo' });
      }
    }
    for (let i = 0; i < Math.round(Number(st.spaceAfter || 0) / 4); i++) lines.push({ text: '' });
  }
  return { lines, cols };
}

// ── encoding ──
function encodeTis620(s) {
  const out = [];
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else if (c >= 0x0e01 && c <= 0x0e5b) out.push(c - 0x0e00 + 0xa0);
    else if (ch === '✔' || ch === '✓') out.push(0x2a);
    else if (ch === '–' || ch === '—') out.push(0x2d);
    else if (ch === '×') out.push(0x78);
    else if (ch === '·') out.push(0x2e);
    else out.push(0x3f); // not available in the printer's code page
  }
  return out;
}

function qrCommand(value, sizeMm) {
  const data = encodeTis620(value);
  const len = data.length + 3;
  // module size: ~8 dots per mm, a QR of this length has ~25–45 modules
  const modules = data.length < 30 ? 25 : data.length < 70 ? 33 : 41;
  const n = Math.max(2, Math.min(12, Math.round((sizeMm * 8) / (modules + 8))));
  return [
    GS, 0x28, 0x6b, 4, 0, 49, 65, 50, 0, // model 2
    GS, 0x28, 0x6b, 3, 0, 49, 67, n, // module size
    GS, 0x28, 0x6b, 3, 0, 49, 69, 49, // error correction M
    GS, 0x28, 0x6b, len & 0xff, (len >> 8) & 0xff, 49, 80, 48, ...data, // store
    GS, 0x28, 0x6b, 3, 0, 49, 81, 48, // print
  ];
}

/** Lines → ESC/POS bytes (copies, cut and cash drawer per job). */
export function encodeLines(lines, printer = {}, { copies = 1, cut = true, drawer = false } = {}) {
  const out = [];
  for (let c = 0; c < copies; c++) {
    out.push(ESC, 0x40); // init
    if (printer.escpos_codepage != null && printer.escpos_codepage !== '') out.push(ESC, 0x74, Number(printer.escpos_codepage));
    for (const l of lines) {
      if (l.skipped) continue;
      const align = l.align === 'center' ? 1 : l.align === 'right' ? 2 : 0;
      out.push(ESC, 0x61, align);
      if (l.qr) {
        out.push(...qrCommand(l.qr, l.size), 0x0a);
        continue;
      }
      out.push(GS, 0x21, l.mag === 2 ? 0x11 : l.mag === 'h' ? 0x01 : 0x00);
      out.push(ESC, 0x45, l.bold ? 1 : 0);
      out.push(...encodeTis620(l.text || ''), 0x0a);
    }
    out.push(GS, 0x21, 0, ESC, 0x45, 0, ESC, 0x61, 0);
    out.push(ESC, 0x64, 4); // feed so the last line clears the cutter
    if (cut) out.push(GS, 0x56, 0x42, 0x00);
  }
  if (drawer) out.push(ESC, 0x70, 0x00, 0x19, 0xfa);
  return new Uint8Array(out);
}

export const DRAWER_KICK = new Uint8Array([ESC, 0x40, ESC, 0x70, 0x00, 0x19, 0xfa]);

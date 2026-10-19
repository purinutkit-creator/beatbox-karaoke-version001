// Member cards, 85.5 × 54 mm. The front: store, tier, the member's name and the barcode of the member number (= the
// card number). The back: the store's text, picture and QR codes to its links. Each tier has its own look (a theme the
// store can recolour or give a picture). Drawn in mm so the same card is the preview on screen and the printed card;
// QR codes and barcodes are drawn at once (no waiting), so printing never catches them half drawn.
import QRCodeLib from 'qrcode';
import JsBarcode from 'jsbarcode';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { browserPrint } from '../lib/print.jsx';

export const CARD_W = 85.5;
export const CARD_H = 54;

export const CARD_THEMES = {
  classic: { label: 'Classic', color1: '#334155', color2: '#0f172a', textColor: '#f8fafc', accent: '#a78bfa', pattern: 'waves' },
  silver: { label: 'Silver', color1: '#f1f5f9', color2: '#94a3b8', textColor: '#0f172a', accent: '#475569', pattern: 'shine' },
  gold: { label: 'Gold', color1: '#fde68a', color2: '#b7791f', textColor: '#3b2a05', accent: '#78350f', pattern: 'shine' },
  platinum: { label: 'Platinum', color1: '#e0e7ff', color2: '#7c83c9', textColor: '#1e1b4b', accent: '#4338ca', pattern: 'lines' },
  vip: { label: 'Black Gold', color1: '#2a2a2a', color2: '#050505', textColor: '#f5e7b2', accent: '#d4af37', pattern: 'lines' },
  neon: { label: 'Neon', color1: '#7c3aed', color2: '#db2777', textColor: '#ffffff', accent: '#fde047', pattern: 'waves' },
  ocean: { label: 'Ocean', color1: '#38bdf8', color2: '#1e3a8a', textColor: '#ffffff', accent: '#a5f3fc', pattern: 'waves' },
  rose: { label: 'Rose', color1: '#fda4af', color2: '#9f1239', textColor: '#ffffff', accent: '#ffe4e6', pattern: 'dots' },
  emerald: { label: 'Emerald', color1: '#6ee7b7', color2: '#065f46', textColor: '#ffffff', accent: '#fef08a', pattern: 'dots' },
};
const BY_CODE = { MEMBER: 'classic', SILVER: 'silver', GOLD: 'gold', PLATINUM: 'platinum', VIP: 'vip', DIAMOND: 'ocean', BLACK: 'vip' };
const BY_ORDER = ['classic', 'silver', 'gold', 'platinum', 'vip', 'neon', 'ocean'];

/** The look of a tier's card: the store's choice for that tier, else a theme picked from the tier. */
export function tierLook(cfg, tier) {
  const own = (tier && cfg?.tiers?.[tier.id]) || {};
  const key = own.theme && CARD_THEMES[own.theme] ? own.theme : BY_CODE[String(tier?.code || '').toUpperCase()] || BY_ORDER[(Number(tier?.sort_order) || 0) % BY_ORDER.length];
  const th = CARD_THEMES[key];
  return { theme: key, pattern: th.pattern, color1: own.color1 || th.color1, color2: own.color2 || th.color2, textColor: own.textColor || th.textColor, accent: own.accent || th.accent, imageUrl: own.imageUrl || '', title: own.title || '' };
}

/** "123456789012" → "1234 5678 9012" (other card numbers as they are). */
export const groupNo = (v) => (/^\d{8,16}$/.test(v || '') ? v.replace(/(\d{4})(?=\d)/g, '$1 ') : v || '');

/** QR as an SVG path, drawn at once. */
export function QrSvg({ value, size = 14, color = '#000' }) {
  if (!value) return null;
  let qr;
  try {
    qr = QRCodeLib.create(String(value), { errorCorrectionLevel: 'M' });
  } catch {
    return null;
  }
  const n = qr.modules.size;
  let d = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.modules.get(y, x)) d += `M${x + 1} ${y + 1}h1v1h-1z`;
  return (
    <svg viewBox={`0 0 ${n + 2} ${n + 2}`} style={{ width: `${size}mm`, height: `${size}mm`, display: 'block', background: '#fff' }} shapeRendering="crispEdges">
      <path d={d} fill={color} />
    </svg>
  );
}

/** CODE128 barcode as SVG bars, drawn at once. */
export function BarcodeSvg({ value, width = 46, height = 8 }) {
  if (!value) return null;
  const enc = {};
  try {
    JsBarcode(enc, String(value), { format: 'CODE128', margin: 0 });
  } catch {
    return null;
  }
  const bits = (enc.encodings || []).map((e) => e.data).join('');
  const rects = [];
  for (let i = 0; i < bits.length; ) {
    if (bits[i] === '1') {
      let j = i;
      while (bits[j] === '1') j++;
      rects.push(<rect key={i} x={i} y={0} width={j - i} height={1} />);
      i = j;
    } else i++;
  }
  return (
    <svg viewBox={`0 0 ${bits.length} 1`} preserveAspectRatio="none" style={{ width: `${width}mm`, height: `${height}mm`, display: 'block' }} shapeRendering="crispEdges">
      <g fill="#000">{rects}</g>
    </svg>
  );
}

function Pattern({ kind, color }) {
  if (kind === 'lines')
    return (
      <svg className="mc-pattern" viewBox="0 0 855 540" preserveAspectRatio="none">
        {Array.from({ length: 16 }, (_, i) => <line key={i} x1={i * 70 - 300} y1="540" x2={i * 70 + 240} y2="0" stroke={color} strokeWidth="1.4" opacity="0.14" />)}
      </svg>
    );
  if (kind === 'dots')
    return (
      <svg className="mc-pattern" viewBox="0 0 855 540" preserveAspectRatio="none">
        {Array.from({ length: 9 * 14 }, (_, i) => <circle key={i} cx={500 + (i % 14) * 26} cy={20 + Math.floor(i / 14) * 26} r={3 + (i % 14) * 0.45} fill={color} opacity="0.13" />)}
      </svg>
    );
  if (kind === 'shine')
    return (
      <svg className="mc-pattern" viewBox="0 0 855 540" preserveAspectRatio="none">
        <path d="M-50 400 L380 -40 L520 -40 L90 400 Z" fill="#fff" opacity="0.28" />
        <path d="M140 560 L600 -40 L650 -40 L190 560 Z" fill="#fff" opacity="0.2" />
        <circle cx="760" cy="80" r="220" fill="none" stroke={color} strokeWidth="2" opacity="0.1" />
      </svg>
    );
  return (
    <svg className="mc-pattern" viewBox="0 0 855 540" preserveAspectRatio="none">
      <path d="M0 400 C 200 300, 400 520, 855 330 L855 540 L0 540 Z" fill={color} opacity="0.1" />
      <path d="M0 460 C 260 360, 520 560, 855 420 L855 540 L0 540 Z" fill={color} opacity="0.1" />
      <circle cx="760" cy="60" r="200" fill={color} opacity="0.07" />
    </svg>
  );
}

const bgStyle = (look) => ({
  '--mc-text': look.textColor,
  '--mc-accent': look.accent,
  color: look.textColor,
  background: `linear-gradient(135deg, ${look.color1} 0%, ${look.color2} 100%)`,
});

function Chip() {
  return (
    <svg className="mc-chip" viewBox="0 0 90 70">
      <defs>
        <linearGradient id="mcchip" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#fbe7a1" /><stop offset="0.5" stopColor="#d4a93a" /><stop offset="1" stopColor="#f4d980" /></linearGradient>
      </defs>
      <rect x="1" y="1" width="88" height="68" rx="12" fill="url(#mcchip)" stroke="#9a7a22" strokeWidth="2" />
      <path d="M30 1 V25 H1 M60 1 V25 H89 M30 69 V45 H1 M60 69 V45 H89 M30 25 H60 V45 H30 Z" fill="none" stroke="#9a7a22" strokeWidth="2.5" />
    </svg>
  );
}

/**
 * member: { first_name, last_name, member_code, created_at, photo_url } · tier: { id, code, name, sort_order }
 * cfg: settings.memberCard · store: settings.store
 */
export function CardFront({ member, tier, cfg = {}, store = {}, print = false }) {
  const look = tierLook(cfg, tier);
  const name = `${member.first_name || ''} ${member.last_name || ''}`.trim();
  const since = member.created_at ? new Date(member.created_at).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'Asia/Bangkok' }) : '';
  return (
    <div className={`mc mc-front ${print ? 'mc-print' : ''}`} style={bgStyle(look)}>
      {look.imageUrl && <img className="mc-bgimg" src={look.imageUrl} alt="" />}
      <Pattern kind={look.pattern} color={look.textColor} />
      <div className="mc-top">
        <div className="mc-brand">
          {cfg.showLogo !== false && store.logoUrl && <img className="mc-logo" src={store.logoUrl} alt="" />}
          <div>
            <div className="mc-store">{store.name}</div>
            <div className="mc-title">{look.title || cfg.title || 'MEMBER CARD'}</div>
          </div>
        </div>
        {cfg.showTier !== false && tier?.name && <div className="mc-tier">{tier.name}</div>}
      </div>
      <div className="mc-mid">
        <Chip />
        <div className="mc-namebox">
          <div className="mc-name">{name}</div>
          {cfg.showSince !== false && since && <div className="mc-since">MEMBER SINCE {since}</div>}
        </div>
        {cfg.showPhoto && member.photo_url && <img className="mc-photo" src={member.photo_url} alt="" />}
      </div>
      <div className="mc-code">
        <BarcodeSvg value={member.member_code} width={50} height={7.2} />
        <div className="mc-no">{groupNo(member.member_code)}</div>
      </div>
    </div>
  );
}

export function CardBack({ tier, cfg = {}, store = {}, print = false }) {
  const look = tierLook(cfg, tier);
  const b = cfg.back || {};
  const links = (b.links || []).filter((l) => l?.url).slice(0, 4);
  const qr = links.length <= 1 ? 17 : links.length === 2 ? 14 : 11.5;
  return (
    <div className={`mc mc-back ${print ? 'mc-print' : ''}`} style={bgStyle(look)}>
      <Pattern kind={look.pattern} color={look.textColor} />
      <div className="mc-band" />
      <div className="mc-back-body">
        <div className="mc-back-text">
          {b.imageUrl && <img className="mc-back-img" src={b.imageUrl} alt="" />}
          {b.heading && <div className="mc-heading">{b.heading}</div>}
          {b.text && <div className="mc-text">{b.text}</div>}
          {b.showStoreInfo !== false && (
            <div className="mc-info">
              <b>{store.name}</b>
              {store.phone && <div>☎ {store.phone}</div>}
              {store.address && <div className="mc-addr">{store.address}</div>}
            </div>
          )}
          {b.terms && <div className="mc-terms">{b.terms}</div>}
        </div>
        {links.length > 0 && (
          <div className={`mc-qrs mc-qrs-${links.length}`}>
            {links.map((l, i) => (
              <div key={i} className="mc-qr">
                <div className="mc-qr-box"><QrSvg value={l.url} size={qr} /></div>
                {l.label && <div className="mc-qr-label">{l.label}</div>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── printing ──
const A4 = { w: 210, h: 297, cols: 2, rows: 5 };
const MX = (A4.w - A4.cols * CARD_W) / 2;
const MY = (A4.h - A4.rows * CARD_H) / 2;

function CutMarks() {
  const xs = Array.from({ length: A4.cols + 1 }, (_, i) => MX + i * CARD_W);
  const ys = Array.from({ length: A4.rows + 1 }, (_, i) => MY + i * CARD_H);
  const L = 5;
  return (
    <>
      {xs.map((x) => [<i key={`t${x}`} className="mc-cut" style={{ left: `${x}mm`, top: `${MY - L - 1}mm`, width: 0, height: `${L}mm` }} />, <i key={`b${x}`} className="mc-cut" style={{ left: `${x}mm`, top: `${A4.h - MY + 1}mm`, width: 0, height: `${L}mm` }} />])}
      {ys.map((y) => [<i key={`l${y}`} className="mc-cut" style={{ top: `${y}mm`, left: `${MX - L - 1}mm`, height: 0, width: `${L}mm` }} />, <i key={`r${y}`} className="mc-cut" style={{ top: `${y}mm`, left: `${A4.w - MX + 1}mm`, height: 0, width: `${L}mm` }} />])}
    </>
  );
}

/** Where card i of a sheet goes. The back page is the mirror, so each back lands behind its front after a duplex flip. */
function slot(i, back, p) {
  let col = i % A4.cols;
  let row = Math.floor(i / A4.cols);
  if (back && p.flip === 'SHORT') row = A4.rows - 1 - row;
  else if (back && p.flip !== 'NONE') col = A4.cols - 1 - col; // NONE: the same spot on both pages, as the file shows
  const dx = back ? Number(p.offsetX) || 0 : 0;
  const dy = back ? Number(p.offsetY) || 0 : 0;
  return { left: `${MX + col * CARD_W + dx}mm`, top: `${MY + row * CARD_H + dy}mm` };
}

/** Same side: each row is one card, front on the left and back on the right, sharing the middle line. */
function pairSlot(i, back) {
  return { left: `${MX + (back ? CARD_W : 0)}mm`, top: `${MY + i * CARD_H}mm` };
}

/**
 * The pages to print.
 * layout DUPLEX: fronts on one page, backs on the next, each back exactly behind its front once the sheet is printed on
 *   both sides. side: BOTH | FRONT | BACK (printers without duplex: print the fronts, put the sheet back in turned
 *   over, print the backs).
 * layout SAME_SIDE: front and back next to each other on one side of the paper (5 cards a sheet): cut out along the
 *   outside lines, fold on the middle line (or cut it and stick the two halves back to back) and laminate.
 */
export function CardSheets({ members, tiers, cfg, store, side = 'BOTH', layout, flip }) {
  const p = { ...(cfg?.print || {}), ...(flip ? { flip } : {}) };
  const lay = layout || p.layout || 'DUPLEX';
  const tierOf = (m) => (tiers || []).find((t) => t.id === m.tier_id) || { id: m.tier_id, name: m.tier_name, code: m.tier_code, sort_order: m.tier_sort };
  const front = (m) => <CardFront member={m} tier={tierOf(m)} cfg={cfg} store={store} print />;
  const backOf = (m) => <CardBack tier={tierOf(m)} cfg={cfg} store={store} print />;
  const pages = [];
  if (p.paper === 'CARD') {
    members.forEach((m, i) => {
      if (side !== 'BACK') pages.push(<div key={`f${i}`} className="print-page mc-cardpage">{front(m)}</div>);
      if (side !== 'FRONT') pages.push(<div key={`b${i}`} className="print-page mc-cardpage">{backOf(m)}</div>);
    });
    return (
      <>
        <style>{`@page { size: ${CARD_W}mm ${CARD_H}mm; margin: 0; }`}</style>
        {pages}
      </>
    );
  }
  if (lay === 'SAME_SIDE') {
    for (let s = 0; s * A4.rows < members.length; s++) {
      const chunk = members.slice(s * A4.rows, s * A4.rows + A4.rows);
      pages.push(
        <div key={`p${s}`} className="print-page mc-sheet">
          {p.cutMarks !== false && <CutMarks />}
          <i className="mc-fold" style={{ left: `${MX + CARD_W}mm`, top: `${MY - 9}mm` }}>✂ / พับ</i>
          {chunk.map((m, i) => [
            <div key={`f${i}`} className="mc-slot" style={pairSlot(i, false)}>{front(m)}</div>,
            <div key={`b${i}`} className="mc-slot" style={pairSlot(i, true)}>{backOf(m)}</div>,
          ])}
        </div>,
      );
    }
  } else {
    const per = A4.cols * A4.rows;
    for (let s = 0; s * per < members.length; s++) {
      const chunk = members.slice(s * per, s * per + per);
      if (side !== 'BACK')
        pages.push(
          <div key={`f${s}`} className="print-page mc-sheet">
            {p.cutMarks !== false && <CutMarks />}
            {chunk.map((m, i) => <div key={i} className="mc-slot" style={slot(i, false, p)}>{front(m)}</div>)}
          </div>,
        );
      if (side !== 'FRONT')
        pages.push(
          <div key={`b${s}`} className="print-page mc-sheet">
            {chunk.map((m, i) => <div key={i} className="mc-slot" style={slot(i, true, p)}>{backOf(m)}</div>)}
          </div>,
        );
    }
  }
  return (
    <>
      <style>{'@page { size: A4 portrait; margin: 0; }'}</style>
      {pages}
    </>
  );
}

/** Through the browser's print window (the printer chosen there). */
export function printCards(members, { tiers, cfg, store, side = 'BOTH', layout, flip }) {
  return browserPrint(<CardSheets members={members} tiers={tiers} cfg={cfg} store={store} side={side} layout={layout} flip={flip} />);
}

/** JPEG pictures → a PDF, one picture filling each page of the given size (mm). */
function jpegPdf(pages) {
  const enc = new TextEncoder();
  const chunks = [];
  const offsets = [];
  let len = 0;
  const push = (d) => {
    const b = typeof d === 'string' ? enc.encode(d) : d;
    chunks.push(b);
    len += b.length;
  };
  const obj = (id, body) => {
    offsets[id] = len;
    push(`${id} 0 obj\n`);
    body();
    push('\nendobj\n');
  };
  const pt = (mm) => ((mm * 72) / 25.4).toFixed(2);
  push('%PDF-1.4\n');
  obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => push(`<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${3 + 3 * i} 0 R`).join(' ')}] >>`));
  pages.forEach((pg, i) => {
    const W = pt(pg.wMm);
    const H = pt(pg.hMm);
    const draw = `q ${W} 0 0 ${H} 0 0 cm /Im${i} Do Q`;
    obj(3 + 3 * i, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Contents ${4 + 3 * i} 0 R /Resources << /XObject << /Im${i} ${5 + 3 * i} 0 R >> >> >>`));
    obj(4 + 3 * i, () => push(`<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`));
    obj(5 + 3 * i, () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${pg.w} /Height ${pg.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${pg.jpeg.length} >>\nstream\n`);
      push(pg.jpeg);
      push('\nendstream');
    });
  });
  const size = 3 + 3 * pages.length;
  const xref = len;
  push(`xref\n0 ${size}\n0000000000 65535 f \n`);
  for (let id = 1; id < size; id++) push(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
  return new Blob(chunks, { type: 'application/pdf' });
}

/**
 * The cards as a PDF at their real size (300 dpi): it prints the same on any printer — also on a computer whose
 * browser prints straight to the receipt printer (--kiosk-printing) — as long as it is printed at 100 % / actual size.
 */
export async function cardsPdf(members, { tiers, cfg, store, side = 'BOTH', layout, flip }) {
  const { default: html2canvas } = await import('html2canvas');
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-30000px;top:0;background:#fff;';
  document.body.appendChild(host);
  const root = createRoot(host);
  flushSync(() => root.render(<CardSheets members={members} tiers={tiers} cfg={cfg} store={store} side={side} layout={layout} flip={flip} />));
  try {
    await document.fonts?.ready;
    const imgs = [...host.querySelectorAll('img')].filter((i) => !i.complete);
    await Promise.race([Promise.all(imgs.map((i) => new Promise((r) => { i.onload = i.onerror = r; }))), new Promise((r) => setTimeout(r, 5000))]);
    const card = cfg?.print?.paper === 'CARD';
    const out = [];
    for (const el of host.querySelectorAll('.print-page')) {
      const canvas = await html2canvas(el, { scale: 300 / 96, backgroundColor: '#ffffff', useCORS: true, logging: false });
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.95));
      out.push({ jpeg: new Uint8Array(await blob.arrayBuffer()), w: canvas.width, h: canvas.height, wMm: card ? CARD_W : A4.w, hMm: card ? CARD_H : A4.h });
    }
    return jpegPdf(out);
  } finally {
    root.unmount();
    host.remove();
  }
}

export function savePdf(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

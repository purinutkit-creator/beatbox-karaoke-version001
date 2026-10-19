// Renders a built document as real HTML text (preview and OS-driver printing). QR codes are vector SVG paths
// (or a pixel-exact image when the document is drawn for a direct USB / network printer).
import QRCodeLib from 'qrcode';
import { loadFont } from '../lib/fonts.js';

/** Logo width on paper when the layout does not set one (mm). */
export const DEFAULT_LOGO_MM = 40;

/** QR drawn module-by-module on a canvas — synchronous, so it is ready before the page is captured. */
export function QrImg({ value, sizeMm = 30 }) {
  const qr = QRCodeLib.create(String(value), { errorCorrectionLevel: 'M' });
  const n = qr.modules.size + 4;
  const unit = 8;
  const c = document.createElement('canvas');
  c.width = c.height = n * unit;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#000';
  for (let y = 0; y < n - 4; y++) for (let x = 0; x < n - 4; x++) if (qr.modules.get(x, y)) ctx.fillRect((x + 2) * unit, (y + 2) * unit, unit, unit);
  return <img className="doc-qr" src={c.toDataURL('image/png')} alt="QR" style={{ width: `${sizeMm}mm`, height: `${sizeMm}mm`, imageRendering: 'pixelated' }} />;
}

export function QrSvg({ value, sizeMm = 30 }) {
  const qr = QRCodeLib.create(String(value), { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  let d = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.modules.get(x, y)) d += `M${x + 2} ${y + 2}h1v1h-1z`;
  return (
    <svg className="doc-qr" viewBox={`0 0 ${n + 4} ${n + 4}`} style={{ width: `${sizeMm}mm`, height: `${sizeMm}mm` }} shapeRendering="crispEdges" role="img" aria-label="QR">
      <rect width={n + 4} height={n + 4} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}

function Block({ b, style, qrAsImage }) {
  const st = { fontSize: b.rel ? `${b.rel}em` : undefined, fontWeight: b.strong ? 700 : undefined, textAlign: b.align || undefined };
  switch (b.t) {
    case 'text':
      return (
        <div className={b.box ? 'doc-box' : 'doc-text'} style={st}>
          {b.text}
        </div>
      );
    case 'kv':
      return (
        <div className="doc-kv" style={st}>
          <span>{b.k}</span>
          <span>{b.v}</span>
        </div>
      );
    case 'item':
      return (
        <div className="doc-item" style={st}>
          <span>{b.name}</span>
          <span>{b.amount}</span>
          {(b.subs || []).map((s, i) => (
            <span className="sub" key={i}>
              {s}
            </span>
          ))}
        </div>
      );
    case 'timebox':
      return (
        <div className="doc-timebox">
          {b.date && <div className="tb-date">{b.date}</div>}
          <div className="tb-times">
            <div className="tb-col">
              <div className="tb-label">{b.startLabel}</div>
              <div className="tb-time">{b.start}</div>
              {b.startDate && <div className="tb-sub">{b.startDate}</div>}
            </div>
            <div className="tb-arrow">→</div>
            <div className="tb-col">
              <div className="tb-label">{b.endLabel}</div>
              <div className="tb-time">{b.end}</div>
              {b.endDate && <div className="tb-sub">{b.endDate}</div>}
            </div>
          </div>
          {b.duration && <div className="tb-duration">{b.duration}</div>}
        </div>
      );
    case 'hr':
      return <div className={b.double ? 'doc-hr2' : 'doc-hr'} />;
    case 'qr':
      return (
        <div className="doc-qr-wrap" style={{ textAlign: style.align || 'center' }}>
          {qrAsImage ? <QrImg value={b.value} sizeMm={Number(style.qrSize || 30)} /> : <QrSvg value={b.value} sizeMm={Number(style.qrSize || 30)} />}
        </div>
      );
    case 'img':
      return (
        <div style={{ textAlign: style.align || 'center' }}>
          <img className="doc-logo" src={b.url} alt="" crossOrigin="anonymous" style={{ width: `${Number(b.widthMm || style.logoWidth) || DEFAULT_LOGO_MM}mm` }} />
        </div>
      );
    default:
      return null;
  }
}

/** sections from buildDoc(); geometry from paperGeometry(printer). Width = the real paper width in mm. */
export function DocView({ sections, geometry, qrAsImage = false }) {
  const g = geometry;
  return (
    <div className="doc" style={{ width: `${g.paperMm}mm`, padding: `${g.mt}mm ${g.mr}mm ${g.mb}mm ${g.ml}mm` }}>
      {sections.map((sec, i) => {
        const s = sec.style || {};
        if (s.font) loadFont(s.font); // idempotent: registers an imported font the first time a document uses it
        return (
          <div
            key={`${sec.key}-${i}`}
            className={`doc-sec doc-${sec.key}`}
            style={{
              fontSize: `${(Number(s.size) || 10) * (g.scale || 1)}pt`,
              fontWeight: s.bold ? 700 : 400,
              textAlign: s.align || 'left',
              marginTop: `${Number(s.spaceBefore || 0)}mm`,
              marginBottom: `${Number(s.spaceAfter || 0)}mm`,
              fontFamily: s.font ? `'${s.font}', var(--font-receipt)` : undefined,
            }}
          >
            {sec.blocks.map((b, j) => (
              <Block key={j} b={b} style={s} qrAsImage={qrAsImage} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

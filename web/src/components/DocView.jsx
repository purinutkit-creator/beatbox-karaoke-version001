// Renders a built document as real HTML text (preview and OS-driver printing). QR codes are vector SVG paths.
import QRCodeLib from 'qrcode';

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

function Block({ b, style }) {
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
    case 'hr':
      return <div className={b.double ? 'doc-hr2' : 'doc-hr'} />;
    case 'qr':
      return (
        <div className="doc-qr-wrap" style={{ textAlign: style.align || 'center' }}>
          <QrSvg value={b.value} sizeMm={Number(style.qrSize || 30)} />
        </div>
      );
    case 'img':
      return (
        <div style={{ textAlign: style.align || 'center' }}>
          <img className="doc-logo" src={b.url} alt="" crossOrigin="anonymous" />
        </div>
      );
    default:
      return null;
  }
}

/** sections from buildDoc(); geometry from paperGeometry(printer). Width = the real paper width in mm. */
export function DocView({ sections, geometry }) {
  const g = geometry;
  return (
    <div className="doc" style={{ width: `${g.paperMm}mm`, padding: `${g.mt}mm ${g.mr}mm ${g.mb}mm ${g.ml}mm` }}>
      {sections.map((sec, i) => {
        const s = sec.style || {};
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
              <Block key={j} b={b} style={s} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

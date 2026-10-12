// Print provider: document routing (every document type → printer, copies, cut), automatic printing through the single
// print queue, preview on the real paper width, failure panel with "พิมพ์ใหม่" (retry never re-charges anything),
// and reprints marked "สำเนา".
import { createContext, useContext, useState, useCallback, useEffect, useMemo } from 'react';
import { Printer, AlertTriangle, RotateCcw, X, ZoomIn, ZoomOut } from 'lucide-react';
import { Modal, Button, Select, Field, Input, useToast } from './ui.jsx';
import { useT } from '../lib/i18n.jsx';
import { api, uid } from '../lib/api.js';
import { useAuth } from '../lib/store.jsx';
import { printJob, paperGeometry, routeProblem, getLocalPrinterId, setLocalPrinterId, DRIVER_FALLBACK, receiptFontFamily } from '../lib/print.jsx';
import { buildDoc } from '../lib/docs.js';
import { textLines } from '../lib/escpos.js';
import { DocView } from './DocView.jsx';
import { useLive } from '../lib/socket.js';
import { DEFAULT_ROUTING, DOC_TYPES } from '@beatbox/shared/documents.js';

const Ctx = createContext(null);
const asList = (docs) => (Array.isArray(docs) ? docs : [docs]);
export const docLabel = (k) => DOC_TYPES.find((d) => d.key === k)?.label || k;

/** On-screen preview of documents exactly as they will be printed on this printer. */
export function DocsPreview({ docs, printer, layouts, zoom = 1 }) {
  const { t } = useT();
  const p = printer || DRIVER_FALLBACK;
  const g = paperGeometry(p);
  const built = docs.map((d) => ({ d, sections: buildDoc(d.docType, d.data, { isCopy: d.isCopy, layouts, geometry: g, fontLabel: receiptFontFamily() }) }));
  if (p.render_mode === 'ESCPOS_TEXT') {
    return (
      <div className="doc-preview">
        <div className="small" style={{ color: '#7c2d12', marginBottom: 8 }}>{t('ตัวอย่างโดยประมาณ: โหมดนี้พิมพ์ด้วยฟอนต์ในเครื่องพิมพ์ ไม่ใช่ฟอนต์ที่ตั้งไว้ และไม่พิมพ์โลโก้')}</div>
        {built.map(({ sections }, i) => {
          const { lines } = textLines(sections, p);
          return (
            <div key={i} className="doc-escpos" style={{ marginBottom: 12 }}>
              {lines.map((l, j) =>
                l.qr ? (
                  <div key={j} style={{ textAlign: 'center', whiteSpace: 'normal' }}>[QR: {l.qr.slice(0, 40)}]</div>
                ) : l.skipped ? null : (
                  <div key={j} className={`${l.bold ? 'b' : ''} ${l.mag === 2 ? 'big' : ''}`} style={{ textAlign: l.align || 'left' }}>
                    {l.text || ' '}
                  </div>
                ),
              )}
            </div>
          );
        })}
      </div>
    );
  }
  return (
    <div className="doc-preview">
      {built.map(({ sections }, i) => (
        <div key={i} className="doc-sheet" style={{ zoom, marginBottom: 14 }}>
          <div className="print-area" style={{ left: `${(g.paperMm - g.printableMm) / 2}mm`, right: `${(g.paperMm - g.printableMm) / 2}mm` }} title={t('พื้นที่พิมพ์ได้จริง')} />
          <DocView sections={sections} geometry={g} />
        </div>
      ))}
      <div className="xs center" style={{ color: '#3f3f46' }}>
        {t('กระดาษ')} {g.paperMm} mm · {t('พื้นที่พิมพ์')} {g.printableMm} mm · {t('ความกว้างเนื้อหา')} {g.contentMm.toFixed(1)} mm · {t('ความยาวตามเนื้อหา')}
      </div>
    </div>
  );
}

export function PrintProvider({ children }) {
  const { t } = useT();
  const toast = useToast();
  const { settings } = useAuth();
  const { data: printers } = useLive(() => api.get('/printers'), ['printers'], []);
  const [job, setJob] = useState(null); // preview modal
  const [failures, setFailures] = useState([]); // [{ key, docs, opts, error, suggestion, jobId }]
  const list = useMemo(() => (printers || []).filter((p) => p.is_active), [printers]);
  const routing = { ...DEFAULT_ROUTING, ...(settings?.documents?.routing || {}) };
  const layouts = settings?.documents?.layouts || {};

  /** Which printer prints this document type (one printer for everything unless routed otherwise). */
  const printerFor = useCallback(
    (docType, station) => {
      const r = routing[docType] || {};
      const routed = r.printerId && list.find((p) => p.id === Number(r.printerId));
      if (routed) return routed;
      if (docType === 'KITCHEN' && station) {
        const st = list.find((p) => p.station === station && p.is_default) || list.find((p) => p.station === station);
        if (st) return st;
      }
      const local = list.find((p) => p.id === getLocalPrinterId());
      if (local) return local;
      return list.find((p) => p.station === 'MAIN' && p.is_default) || list.find((p) => p.station === 'MAIN') || list[0] || DRIVER_FALLBACK;
    },
    [list, JSON.stringify(routing)],
  );

  const withRouting = (docs) => asList(docs).map((d) => ({ ...d, copies: d.copies ?? routing[d.docType]?.copies ?? 1, cut: d.cut ?? routing[d.docType]?.cut !== false }));

  const run = useCallback(
    async (docs, opts = {}, printer = null) => {
      const ds = withRouting(docs);
      const p = printer || printerFor(ds[0].docType, ds[0].data?.station);
      const r = await printJob({ printer: p, docs: ds, layouts, drawer: !!opts.drawer, record: { clientJobId: opts.clientJobId || null, reference: opts.reference || null, jobId: opts.jobId || null, reprintOf: opts.reprintOf || null, force: opts.force } });
      if (!r.ok) {
        setFailures((f) => [...f.filter((x) => x.key !== (opts.clientJobId || r.jobId)), { key: opts.clientJobId || r.jobId || uid(), docs: ds, opts: { ...opts, jobId: r.jobId }, error: r.error, suggestion: r.suggestion, printer: p }]);
      }
      return r;
    },
    [printerFor, JSON.stringify(layouts)],
  );

  /** Automatic print (after payment, room open, kitchen …). Respects the routing "auto" switch unless forced. */
  const print = useCallback(
    async (docs, opts = {}) => {
      const first = asList(docs)[0];
      if (!opts.force && routing[first.docType]?.auto === false) return { ok: true, skipped: true };
      return run(docs, opts);
    },
    [run, JSON.stringify(routing)],
  );

  /** Open the preview (real paper width) with printer choice. */
  const preview = useCallback(
    (docs, opts = {}) => {
      const ds = withRouting(docs);
      const p = printerFor(ds[0].docType, ds[0].data?.station);
      setJob({ docs: ds, opts, printerId: p?.id || '', copies: ds[0].copies || 1, zoom: 1, error: null, busy: false });
    },
    [printerFor],
  );

  /** Reprint a recorded job: same data, marked "สำเนา"; no bill / payment / room opening is created. */
  const reprint = useCallback(
    async (jobId) => {
      try {
        const j = await api.post(`/print-jobs/${jobId}/reprint`);
        const pl = j.payload || {};
        const docs = (pl.docs || [{ docType: pl.docType || j.docType, data: pl.data !== undefined ? pl.data : pl }]).map((d) => ({ ...d, isCopy: true }));
        preview(docs, { reference: j.reference, reprintOf: j.id, clientJobId: `reprint-${j.id}-${uid()}` });
      } catch (e) {
        toast.error(e);
      }
    },
    [preview],
  );

  /** Retry a failed job from the failure panel (the original never printed → not a copy). */
  const retry = async (f) => {
    setFailures((x) => x.filter((y) => y.key !== f.key));
    const r = await run(f.docs, { ...f.opts, force: true });
    if (r.ok) toast.success(t('พิมพ์สำเร็จ'));
  };

  const doPrint = async () => {
    setJob((j) => ({ ...j, busy: true, error: null }));
    const p = list.find((x) => x.id === Number(job.printerId)) || (job.printerId ? null : DRIVER_FALLBACK) || DRIVER_FALLBACK;
    const docs = job.docs.map((d) => ({ ...d, copies: Number(job.copies) || 1 }));
    const r = await printJob({ printer: p, docs, layouts, drawer: !!job.opts.drawer, record: { clientJobId: job.opts.clientJobId || null, reference: job.opts.reference || null, jobId: job.opts.jobId || null, reprintOf: job.opts.reprintOf || null, force: true } });
    if (r.ok) {
      job.opts.onPrinted?.();
      setFailures((f) => f.filter((x) => x.key !== job.opts.clientJobId));
      setJob(null);
    } else setJob((j) => ({ ...j, busy: false, error: r }));
  };

  const selected = job ? list.find((x) => x.id === Number(job.printerId)) || DRIVER_FALLBACK : null;
  const problem = selected ? routeProblem(selected) : null;

  return (
    <Ctx.Provider value={{ print, preview, reprint, printers: list, printerFor, layouts, routing }}>
      {children}
      {job && (
        <Modal
          title={job.opts.title ? t(job.opts.title) : `${t('ตัวอย่างก่อนพิมพ์')}: ${job.docs.map((d) => t(docLabel(d.docType))).join(' + ')}`}
          onClose={() => setJob(null)}
          size="wide"
          footer={
            <>
              <Button onClick={() => setJob(null)}>{t('ปิด')}</Button>
              <Button variant="primary" icon={Printer} loading={job.busy} onClick={doPrint} disabled={!!problem}>
                {job.docs.some((d) => d.isCopy) ? t('พิมพ์สำเนา') : t('พิมพ์')}
              </Button>
            </>
          }
        >
          <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 6 }}>
            <Button size="sm" variant="ghost icon" icon={ZoomOut} onClick={() => setJob((j) => ({ ...j, zoom: Math.max(0.5, j.zoom - 0.25) }))} />
            <span className="small">{Math.round(job.zoom * 100)}%</span>
            <Button size="sm" variant="ghost icon" icon={ZoomIn} onClick={() => setJob((j) => ({ ...j, zoom: Math.min(2.5, j.zoom + 0.25) }))} />
          </div>
          <DocsPreview docs={job.docs} printer={selected} layouts={layouts} zoom={job.zoom} />
          <div className="grid grid-2 mt">
            <Field label="เครื่องพิมพ์">
              <Select
                value={job.printerId}
                onChange={(e) => {
                  const v = e.target.value;
                  setJob((j) => ({ ...j, printerId: v, error: null }));
                  if (!['KITCHEN'].includes(job.docs[0].docType) && v) setLocalPrinterId(Number(v));
                }}
                options={[{ value: '', label: t(DRIVER_FALLBACK.name) }, ...list.map((p) => ({ value: p.id, label: `${p.name} · ${p.paper_width}mm · ${p.render_mode === 'ESCPOS_TEXT' ? t('ฟอนต์เครื่องพิมพ์') : t('ไดรเวอร์')}` }))]}
              />
            </Field>
            <Field label="จำนวนใบ">
              <Input type="number" min={1} max={5} value={job.copies} onChange={(e) => setJob((j) => ({ ...j, copies: e.target.value }))} />
            </Field>
          </div>
          {(problem || job.error) && (
            <div className="card flat mt" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}>
              <AlertTriangle size={18} /> {problem ? problem.message : job.error.error}
              {(problem?.suggestion || job.error?.suggestion) && <div className="small" style={{ color: 'var(--text)' }}>{problem?.suggestion || job.error?.suggestion}</div>}
            </div>
          )}
        </Modal>
      )}
      {failures.length > 0 && (
        <div className="print-failures">
          {failures.map((f) => (
            <div key={f.key} className="card print-failure">
              <div className="row nowrap" style={{ alignItems: 'flex-start' }}>
                <AlertTriangle size={18} color="var(--danger)" style={{ flex: 'none' }} />
                <div className="grow">
                  <div className="bold small">{t('พิมพ์ไม่สำเร็จ')}: {f.docs.map((d) => t(docLabel(d.docType))).join(' + ')} {f.opts.reference ? `(${f.opts.reference})` : ''}</div>
                  <div className="xs">{f.error}</div>
                  {f.suggestion && <div className="xs muted">{f.suggestion}</div>}
                  <div className="xs muted">{t('รายการชำระเงิน / เปิดห้องบันทึกเรียบร้อยแล้ว การพิมพ์ใหม่ไม่เรียกเก็บเงินซ้ำ')}</div>
                </div>
                <Button size="sm" variant="ghost icon" icon={X} onClick={() => setFailures((x) => x.filter((y) => y.key !== f.key))} />
              </div>
              <div className="row mt" style={{ justifyContent: 'flex-end' }}>
                <Button size="sm" onClick={() => { setFailures((x) => x.filter((y) => y.key !== f.key)); preview(f.docs, { ...f.opts }); }}>{t('เลือกเครื่องพิมพ์อื่น')}</Button>
                <Button size="sm" variant="primary" icon={RotateCcw} onClick={() => retry(f)}>{t('พิมพ์ใหม่')}</Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Ctx.Provider>
  );
}

export const usePrint = () => useContext(Ctx);

/** Re-render when the layout settings change (for pages that show a live preview). */
export function useDocLayouts() {
  const { settings } = useAuth();
  const [l, setL] = useState(settings?.documents?.layouts || {});
  useEffect(() => setL(settings?.documents?.layouts || {}), [settings?.documents?.layouts]);
  return l;
}

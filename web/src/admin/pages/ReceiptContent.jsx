// ตั้งค่าร้าน → ใบเสร็จ: tick what the receipt shows (whole sections and single lines), with a live preview.
// Saved into the RECEIPT layout of the document designer (same data, so both pages always agree).
import { useEffect, useState } from 'react';
import { Save, FileText, RotateCcw } from 'lucide-react';
import { Button, Switch, Loading, useToast } from '../../components/ui.jsx';
import { DocsPreview } from '../../components/PrintPreview.jsx';
import { useT } from '../../lib/i18n.jsx';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/store.jsx';
import { DOC_ELEMENTS, ELEMENT_LINES, resolveLayout } from '@beatbox/shared/documents.js';
import { DRIVER_FALLBACK } from '../../lib/print.jsx';
import { sampleData } from './Documents.jsx';

export default function ReceiptContent() {
  const { t } = useT();
  const toast = useToast();
  const { settings, loadSettings } = useAuth();
  const [layout, setLayout] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (settings && !layout) setLayout(structuredClone(settings.documents?.layouts?.RECEIPT || {}));
  }, [settings]);
  if (!layout || !settings) return <Loading />;
  const elements = resolveLayout('RECEIPT', layout);
  const lines = ELEMENT_LINES.RECEIPT;
  const patch = (key, p) =>
    setLayout((l) => ({ order: l.order?.length ? l.order : elements.map((e) => e.key), elements: { ...(l.elements || {}), [key]: { ...(l.elements?.[key] || {}), ...p } } }));
  const toggleLine = (el, line, show) => {
    const hide = new Set(el.hide || []);
    if (show) hide.delete(line);
    else hide.add(line);
    patch(el.key, { hide: [...hide] });
  };
  const save = async () => {
    setBusy(true);
    try {
      await api.put('/documents/settings', { layouts: { RECEIPT: { order: layout.order?.length ? layout.order : elements.map((e) => e.key), elements: layout.elements || {} } } });
      await loadSettings();
      toast.success('บันทึกรูปแบบใบเสร็จแล้ว');
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const showAll = () => setLayout((l) => ({ ...l, elements: Object.fromEntries(elements.map((e) => [e.key, { ...(l.elements?.[e.key] || {}), show: e.key === 'qr' ? e.show : true, hide: [] }])) }));
  const printer = DRIVER_FALLBACK;
  const data = sampleData('RECEIPT', settings.store);
  return (
    <div className="card">
      <h3 className="row nowrap"><FileText size={18} /> {t('ใบเสร็จแสดงอะไรบ้าง')}</h3>
      <div className="small muted mb">{t('ติ๊กเลือกส่วนและบรรทัดที่ต้องการให้พิมพ์บนใบเสร็จ ดูผลได้ทันทีด้านขวา · ปรับฟอนต์ ขนาด และลำดับได้ที่ "ออกแบบเอกสาร/ใบเสร็จ"')}</div>
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,340px)', gap: 16, alignItems: 'start' }}>
        <div className="col" style={{ gap: 6 }}>
          {elements.map((el) => (
            <div key={el.key} className="card flat" style={{ padding: '8px 12px' }}>
              <Switch checked={el.show !== false} onChange={(v) => patch(el.key, { show: v })} label={DOC_ELEMENTS[el.key]?.label || el.key} />
              {el.show !== false && lines[el.key] && (
                <div className="row" style={{ gap: 4, paddingLeft: 28, marginTop: 4 }}>
                  {lines[el.key].map((ln) => (
                    <Switch key={ln.key} checked={!(el.hide || []).includes(ln.key)} onChange={(v) => toggleLine(el, ln.key, v)} label={ln.label} />
                  ))}
                </div>
              )}
            </div>
          ))}
          <div className="row">
            <Button icon={RotateCcw} onClick={showAll}>{t('แสดงทั้งหมด')}</Button>
            <Button variant="primary" icon={Save} loading={busy} onClick={save}>{t('บันทึกรูปแบบใบเสร็จ')}</Button>
          </div>
        </div>
        <div style={{ position: 'sticky', top: 70 }}>
          <DocsPreview docs={[{ docType: 'RECEIPT', data }]} printer={printer} layouts={{ ...(settings.documents?.layouts || {}), RECEIPT: layout }} />
        </div>
      </div>
    </div>
  );
}

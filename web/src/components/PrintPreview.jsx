// Print preview (required before printing) + printer selection + failure recovery.
import { createContext, useContext, useState, useCallback } from 'react';
import { Printer, AlertTriangle } from 'lucide-react';
import { Modal, Button, Select, Field, Input, useToast } from './ui.jsx';
import { useT } from '../lib/i18n.jsx';
import { api } from '../lib/api.js';
import { printElement, getLocalPrinterId, setLocalPrinterId } from '../lib/print.jsx';
import { useLive } from '../lib/socket.js';

const Ctx = createContext(null);

export function PrintProvider({ children }) {
  const { t } = useT();
  const toast = useToast();
  const { data: printers } = useLive(() => api.get('/printers'), ['printers'], []);
  const [job, setJob] = useState(null);
  const [printerId, setPrinterId] = useState('');
  const [copies, setCopies] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const list = (printers || []).filter((p) => p.is_active);
  const defaultPrinter = (station = 'MAIN') => {
    const local = list.find((p) => p.id === getLocalPrinterId());
    if (local && station === 'MAIN') return local;
    return list.find((p) => p.station === station && p.is_default) || list.find((p) => p.station === station) || list.find((p) => p.is_default) || list[0] || { connection: 'BROWSER', copies: 1, name: 'Browser' };
  };

  /** Open preview. opts: { title, jobType, reference, isCopy, station, drawer, onPrinted, direct } */
  const preview = useCallback(
    (element, opts = {}) => {
      const p = defaultPrinter(opts.station);
      setPrinterId(p?.id || '');
      setCopies(opts.copies ?? p?.copies ?? 1);
      setError('');
      setJob({ element, opts });
    },
    [printers],
  );

  /** Print without preview (auto print after payment, kitchen tickets). Falls back to preview on error. */
  const printNow = useCallback(
    async (element, opts = {}) => {
      const p = defaultPrinter(opts.station);
      const r = await printElement(element, p, { ...opts, copies: opts.copies ?? p.copies });
      if (!r.ok) {
        toast.error(`${t('พิมพ์ไม่สำเร็จ')}: ${r.error}`);
        preview(element, opts);
      }
      return r;
    },
    [printers],
  );

  const doPrint = async () => {
    setBusy(true);
    setError('');
    const p = list.find((x) => x.id === Number(printerId)) || defaultPrinter(job.opts.station);
    const r = await printElement(job.element, p, { ...job.opts, copies: Number(copies) || 1 });
    setBusy(false);
    if (r.ok) {
      job.opts.onPrinted?.();
      setJob(null);
    } else setError(r.error);
  };

  return (
    <Ctx.Provider value={{ preview, printNow, printers: list, defaultPrinter }}>
      {children}
      {job && (
        <Modal
          title={t(job.opts.title || 'ตัวอย่างก่อนพิมพ์')}
          onClose={() => setJob(null)}
          footer={
            <>
              <Button onClick={() => setJob(null)}>{t('ปิด')}</Button>
              <Button variant="primary" icon={Printer} loading={busy} onClick={doPrint}>
                {t('พิมพ์')}
              </Button>
            </>
          }
        >
          <div className="receipt-preview">{job.element}</div>
          <div className="grid grid-2 mt">
            <Field label="เครื่องพิมพ์">
              <Select
                value={printerId}
                onChange={(e) => {
                  setPrinterId(e.target.value);
                  if (job.opts.station !== 'KITCHEN') setLocalPrinterId(Number(e.target.value));
                }}
                options={list.map((p) => ({ value: p.id, label: `${p.name} (${p.connection})` }))}
              />
            </Field>
            <Field label="จำนวนใบ">
              <Input type="number" min={1} max={5} value={copies} onChange={(e) => setCopies(e.target.value)} />
            </Field>
          </div>
          {error && (
            <div className="card flat mt" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}>
              <AlertTriangle size={18} /> {t('เครื่องพิมพ์ไม่ได้เชื่อมต่อ')}: {error}
              <div className="small muted">{t('กรุณาเลือกเครื่องพิมพ์ใหม่แล้วลองอีกครั้ง')}</div>
            </div>
          )}
        </Modal>
      )}
    </Ctx.Provider>
  );
}

export const usePrint = () => useContext(Ctx);

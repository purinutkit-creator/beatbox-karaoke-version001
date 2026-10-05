import { useState } from 'react';
import { BarChart3, FileSpreadsheet, FileText, Printer, Download } from 'lucide-react';
import { PageHead, Button, Input, Select, Loading, Empty, money, useToast } from '../../components/ui.jsx';
import { ReportSlip } from '../../components/Receipt.jsx';
import { usePrint } from '../../components/PrintPreview.jsx';
import { useT } from '../../lib/i18n.jsx';
import { api, download } from '../../lib/api.js';
import { useAuth } from '../../lib/store.jsx';
import { useLive } from '../../lib/socket.js';
import { browserPrint } from '../../lib/print.jsx';
import { fmtDateTime, fmtDate, bkkDateStr } from '@beatbox/shared/format.js';

function cell(c, v) {
  if (v == null) return '';
  if (c.type === 'money') return money(v);
  if (c.type === 'datetime') return fmtDateTime(v);
  if (c.type === 'date') return fmtDate(v);
  return String(v);
}

function A4Report({ rep, store }) {
  return (
    <div className="report-a4">
      <h2>{store?.name} — {rep.title}</h2>
      <div>{rep.from} – {rep.to}</div>
      <table>
        <thead><tr>{rep.columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
        <tbody>{rep.rows.map((r, i) => <tr key={i}>{rep.columns.map((c) => <td key={c.key}>{cell(c, r[c.key])}</td>)}</tr>)}</tbody>
        {Object.keys(rep.totals).length > 0 && <tfoot><tr>{rep.columns.map((c, i) => <td key={c.key}><b>{i === 0 ? 'รวม' : rep.totals[c.key] != null ? (c.type === 'money' ? money(rep.totals[c.key]) : rep.totals[c.key]) : ''}</b></td>)}</tr></tfoot>}
      </table>
    </div>
  );
}

export default function Reports() {
  const { t } = useT();
  const toast = useToast();
  const { settings } = useAuth();
  const { preview } = usePrint();
  const { data: list } = useLive(() => api.get('/reports'), [], []);
  const { data: emps } = useLive(() => api.get('/employees/directory'), [], []);
  const { data: rooms } = useLive(() => api.get('/rooms'), [], []);
  const { data: types } = useLive(() => api.get('/room-types'), [], []);
  const [f, setF] = useState({ type: 'sales', from: bkkDateStr(Date.now() - 6 * 86400000), to: bkkDateStr(), employeeId: '', roomId: '', roomTypeId: '', timeFrom: '', timeTo: '' });
  const qs = new URLSearchParams(Object.fromEntries(Object.entries(f).filter(([k, v]) => v && k !== 'type')));
  const { data: rep, loading } = useLive(() => api.get(`/reports/${f.type}?${qs}`), [], [f.type, qs.toString()]);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const exp = async (format) => {
    try {
      await download(`/reports/${f.type}?${qs}&format=${format}`, `${f.type}-${f.from}-${f.to}.${format}`);
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <div>
      <PageHead icon={BarChart3} title="รายงาน">
        <Button icon={FileText} onClick={() => rep && browserPrint(<A4Report rep={rep} store={settings.store} />, { a4: true })}>PDF</Button>
        <Button icon={FileSpreadsheet} onClick={() => exp('xlsx')}>Excel</Button>
        <Button icon={Download} onClick={() => exp('csv')}>CSV</Button>
        <Button icon={Printer} onClick={() => rep && preview(<ReportSlip store={settings.store} report={rep} />, { jobType: 'REPORT', reference: rep.title })}>{t('พิมพ์ใบเสร็จ')}</Button>
      </PageHead>
      <div className="row mb">
        <Select value={f.type} onChange={(e) => set('type', e.target.value)} options={(list || []).map((r) => ({ value: r.key, label: r.title }))} style={{ width: 260 }} />
        <Input type="date" value={f.from} onChange={(e) => set('from', e.target.value)} style={{ width: 160 }} />
        <Input type="date" value={f.to} onChange={(e) => set('to', e.target.value)} style={{ width: 160 }} />
        <Input type="time" value={f.timeFrom} onChange={(e) => set('timeFrom', e.target.value)} style={{ width: 120 }} title={t('เวลาเริ่ม')} />
        <Input type="time" value={f.timeTo} onChange={(e) => set('timeTo', e.target.value)} style={{ width: 120 }} title={t('เวลาสิ้นสุด')} />
        <Select value={f.employeeId} onChange={(e) => set('employeeId', e.target.value)} options={(emps || []).map((x) => ({ value: x.id, label: x.name }))} placeholder="ทุกพนักงาน" style={{ width: 160 }} />
        <Select value={f.roomId} onChange={(e) => set('roomId', e.target.value)} options={(rooms || []).map((x) => ({ value: x.id, label: x.name }))} placeholder="ทุกห้อง" style={{ width: 150 }} />
        <Select value={f.roomTypeId} onChange={(e) => set('roomTypeId', e.target.value)} options={(types || []).map((x) => ({ value: x.id, label: x.name }))} placeholder="ทุก Type ห้อง" style={{ width: 150 }} />
      </div>
      {loading || !rep ? <Loading /> : !rep.rows.length ? <Empty /> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr>{rep.columns.map((c) => <th key={c.key} className={c.type === 'money' ? 'right' : ''}>{t(c.label)}</th>)}</tr></thead>
            <tbody>{rep.rows.map((r, i) => <tr key={i}>{rep.columns.map((c) => <td key={c.key} className={c.type === 'money' ? 'right num' : ''}>{cell(c, r[c.key])}</td>)}</tr>)}</tbody>
            {Object.keys(rep.totals).length > 0 && (
              <tfoot><tr>{rep.columns.map((c, i) => <td key={c.key} className={c.type === 'money' ? 'right num' : ''}>{i === 0 ? t('รวม') : rep.totals[c.key] != null ? (c.type === 'money' ? money(rep.totals[c.key]) : rep.totals[c.key]) : ''}</td>)}</tr></tfoot>
            )}
          </table>
        </div>
      )}
    </div>
  );
}

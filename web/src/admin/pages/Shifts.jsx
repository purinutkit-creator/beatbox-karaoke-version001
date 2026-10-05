import { useEffect, useState } from 'react';
import { Clock, LockOpen, Lock, Printer, Eye } from 'lucide-react';
import { PageHead, Button, Field, Input, Textarea, Badge, Loading, Empty, Modal, NumPad, money, useToast, useDialog } from '../../components/ui.jsx';
import { ShiftReport } from '../../components/Receipt.jsx';
import { usePrint } from '../../components/PrintPreview.jsx';
import { useT } from '../../lib/i18n.jsx';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/store.jsx';
import { useLive } from '../../lib/socket.js';
import { fmtDateTime } from '@beatbox/shared/format.js';

function SummaryTable({ s }) {
  const { t } = useT();
  const rows = [
    ['เงินสดตั้งต้น', s.openingCash], ['ยอดขายเงินสด', s.cashSales], ['ยอดขาย QR Code', s.qrSales], ['ยอดขายโอนเงิน', s.transferSales], ['ยอดขายบัตร', s.cardSales], ['ยอดขายช่องทางอื่น', s.otherSales],
    ['ยอดมัดจำที่รับ', s.depositsReceived], ['ยอดมัดจำที่คืน', s.depositsRefunded], ['ยอดคืนเงิน', s.refundsTotal], ['ส่วนลดทั้งหมด', s.discountTotal], ['Service Charge', s.serviceCharge], ['VAT', s.vat],
  ];
  const counts = [['จำนวนใบเสร็จ', s.receipts], ['จำนวนรายการขาย', s.itemsSold], ['จำนวนห้องที่ขาย', s.roomsSold], ['จำนวนชั่วโมงที่ขาย', s.hoursSold], ['จำนวนสมาชิกใหม่', s.newMembers], ['รายการยกเลิก', s.voids?.length], ['รายการคืนเงิน', s.refunds?.length]];
  return (
    <div className="grid grid-2">
      <div className="card flat">{rows.map(([k, v]) => <div key={k} className="sum-line"><span>{t(k)}</span><span className="num">{money(v)}</span></div>)}
        <div className="sum-line total"><span>{t('เงินสดที่ควรมีในลิ้นชัก')}</span><span className="num">{money(s.expectedCash)}</span></div>
      </div>
      <div className="card flat">{counts.map(([k, v]) => <div key={k} className="sum-line"><span>{t(k)}</span><b>{v ?? 0}</b></div>)}
        {s.countedCash != null && <>
          <div className="divider" />
          <div className="sum-line"><span>{t('เงินสดที่นับได้จริง')}</span><b>{money(s.countedCash)}</b></div>
          <div className="sum-line" style={{ color: 'var(--danger)' }}><span>{t('เงินขาด')}</span><b>{money(s.shortage)}</b></div>
          <div className="sum-line" style={{ color: 'var(--ok)' }}><span>{t('เงินเกิน')}</span><b>{money(s.overage)}</b></div>
        </>}
      </div>
    </div>
  );
}

export default function Shifts() {
  const { t } = useT();
  const toast = useToast();
  const { confirm } = useDialog();
  const { shift, loadShift, can, employee, device, settings } = useAuth();
  const { preview } = usePrint();
  const { data: list, reload } = useLive(() => api.get('/shifts'), ['shifts'], []);
  const [openForm, setOpenForm] = useState({ openingCash: '', note: '' });
  const [summary, setSummary] = useState(null);
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const [view, setView] = useState(null);
  useEffect(() => {
    if (shift) api.get(`/shifts/${shift.id}/summary`).then((r) => setSummary(r.summary)).catch(() => {});
  }, [shift?.id]);
  const open = async () => {
    try {
      await api.post('/shifts/open', { deviceId: device.id, openingCash: Number(openForm.openingCash) || 0, note: openForm.note });
      toast.success('เปิดรอบการขายเรียบร้อย');
      await loadShift();
      reload();
    } catch (e) {
      toast.error(e);
    }
  };
  const close = async () => {
    if (!(await confirm({ title: 'ปิดรอบการขาย', message: `${t('เงินสดที่นับได้')} ${money(counted)} ${t('ยืนยันปิดรอบ?')}` }))) return;
    try {
      let r;
      try {
        r = await api.post(`/shifts/${shift.id}/close`, { countedCash: Number(counted) || 0, note });
      } catch (e) {
        if (e.code !== 'OPEN_ORDERS' || !(await confirm({ message: `${e.message}\n${t('ต้องการปิดรอบต่อหรือไม่?')}`, danger: true }))) throw e;
        r = await api.post(`/shifts/${shift.id}/close`, { countedCash: Number(counted) || 0, note, force: true });
      }
      toast.success('ปิดรอบการขายเรียบร้อย');
      preview(<ShiftReport store={settings.store} shift={{ ...r.shift, employee_name: shift.employee_name, closed_by_name: employee.name }} summary={r.summary} />, { jobType: 'SHIFT_REPORT', reference: r.shift.shift_no, title: 'พิมพ์รายงานปิดรอบ' });
      setCounted('');
      await loadShift();
      reload();
    } catch (e) {
      toast.error(e);
    }
  };
  const diff = summary ? Number(counted || 0) - summary.expectedCash : 0;
  return (
    <div>
      <PageHead icon={Clock} title="เปิดและปิดรอบ" />
      {!shift ? (
        <div className="card" style={{ maxWidth: 560 }}>
          <h2><LockOpen size={22} /> {t('เปิดรอบการขาย')}</h2>
          <div className="grid grid-2">
            <Field label="ชื่อพนักงาน"><Input value={employee.name} disabled /></Field>
            <Field label="วันที่และเวลาเปิดรอบ"><Input value={fmtDateTime(new Date())} disabled /></Field>
            <Field label="เครื่อง POS ที่ใช้งาน"><Input value={device?.name || `POS #${device?.id}`} disabled /></Field>
            <Field label="เงินสดตั้งต้นในลิ้นชัก"><Input className="lg" type="number" value={openForm.openingCash} onChange={(e) => setOpenForm({ ...openForm, openingCash: e.target.value })} /></Field>
            <Field label="หมายเหตุ" style={{ gridColumn: '1/-1' }}><Textarea value={openForm.note} onChange={(e) => setOpenForm({ ...openForm, note: e.target.value })} /></Field>
          </div>
          <Button className="mt" variant="primary" size="lg" block icon={LockOpen} disabled={!can('shift.open')} onClick={open}>{t('เปิดรอบการขาย')}</Button>
        </div>
      ) : (
        <div className="col">
          <div className="card row between">
            <div><Badge color="#16a34a">{t('รอบที่เปิดอยู่')}</Badge> <b>{shift.shift_no}</b> · {t('เปิดโดย')} {shift.employee_name} · {fmtDateTime(shift.opened_at)}</div>
          </div>
          {summary ? <SummaryTable s={summary} /> : <Loading />}
          {summary && can('shift.close') && (
            <div className="card">
              <h2><Lock size={22} /> {t('ปิดรอบการขาย')}</h2>
              <div className="grid grid-2">
                <div className="col">
                  <div className="card flat center"><div className="muted">{t('เงินสดที่ควรมีในลิ้นชัก')}</div><div className="big-money">{money(summary.expectedCash)}</div></div>
                  <div className="card flat center"><div className="muted">{t('เงินสดที่นับได้จริง')}</div><div className="big-money">{money(counted || 0)}</div></div>
                  <div className="card flat center" style={{ borderColor: diff < 0 ? 'var(--danger)' : 'var(--ok)' }}><div className="muted">{diff < 0 ? t('เงินขาด') : diff > 0 ? t('เงินเกิน') : t('ตรงยอด')}</div><div className="big-money" style={{ color: diff < 0 ? 'var(--danger)' : 'var(--ok)' }}>{money(Math.abs(diff))}</div></div>
                </div>
                <div className="col">
                  <NumPad value={counted} onChange={setCounted} />
                  <Field label="หมายเหตุ"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
                  <Button variant="danger" size="lg" icon={Lock} onClick={close}>{t('ยืนยันปิดรอบ')}</Button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
      <h2 className="mt">{t('ประวัติรอบการขาย')}</h2>
      {!list?.length ? <Empty /> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>{t('รอบ')}</th><th>{t('เครื่อง')}</th><th>{t('เปิด')}</th><th>{t('ปิด')}</th><th className="right">{t('เงินตั้งต้น')}</th><th className="right">{t('ควรมี')}</th><th className="right">{t('นับได้')}</th><th className="right">{t('ขาด/เกิน')}</th><th /></tr></thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.id}>
                  <td className="bold">{s.shift_no} {s.status === 'OPEN' && <Badge color="#16a34a">OPEN</Badge>}</td>
                  <td>{s.device_name}</td>
                  <td className="small">{fmtDateTime(s.opened_at)}<div className="xs muted">{s.employee_name}</div></td>
                  <td className="small">{s.closed_at ? fmtDateTime(s.closed_at) : '-'}<div className="xs muted">{s.closed_by_name}</div></td>
                  <td className="right num">{money(s.opening_cash)}</td>
                  <td className="right num">{s.expected_cash != null ? money(s.expected_cash) : '-'}</td>
                  <td className="right num">{s.counted_cash != null ? money(s.counted_cash) : '-'}</td>
                  <td className="right num" style={{ color: Number(s.difference) < 0 ? 'var(--danger)' : 'var(--ok)' }}>{s.difference != null ? money(s.difference) : '-'}</td>
                  <td className="nowrap">
                    <Button size="sm" variant="ghost" icon={Eye} onClick={async () => setView(await api.get(`/shifts/${s.id}/summary`))} />
                    <Button size="sm" variant="ghost" icon={Printer} onClick={async () => { const r = await api.get(`/shifts/${s.id}/summary`); preview(<ShiftReport store={settings.store} shift={r.shift} summary={r.summary} />, { jobType: 'SHIFT_REPORT', reference: s.shift_no }); }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {view && <Modal title={`${t('รอบ')} ${view.shift.shift_no}`} size="wide" onClose={() => setView(null)}><SummaryTable s={view.summary} /></Modal>}
    </div>
  );
}

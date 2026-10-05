import { useState } from 'react';
import { Receipt, Printer, Undo2, Ban, Send, History, Search } from 'lucide-react';
import { PageHead, Button, Input, Select, Badge, Loading, Empty, Modal, Field, Seg, Tabs, money, useToast, useDialog } from '../../components/ui.jsx';
import { SaleReceipt, VoidSlip } from '../../components/Receipt.jsx';
import { usePrint } from '../../components/PrintPreview.jsx';
import { useT } from '../../lib/i18n.jsx';
import { api, uid } from '../../lib/api.js';
import { useAuth } from '../../lib/store.jsx';
import { useLive } from '../../lib/socket.js';
import { fmtDateTime, bkkDateStr } from '@beatbox/shared/format.js';
import { PAYMENT_METHODS } from '@beatbox/shared/constants.js';

function ReceiptView({ id, onClose, onChanged }) {
  const { t } = useT();
  const toast = useToast();
  const { confirm, prompt, approve } = useDialog();
  const { can, settings, employee } = useAuth();
  const { preview } = usePrint();
  const { data: rc, reload } = useLive(() => api.get(`/receipts/${id}`), ['orders'], [id]);
  const [tab, setTab] = useState('receipt');
  const [refund, setRefund] = useState(null);
  const [send, setSend] = useState(null);
  if (!rc) return <Modal title="..." onClose={onClose}><Loading /></Modal>;
  const print = async (kind) => {
    const isCopy = rc.print_count > 0;
    if (isCopy && !(await confirm({ title: 'พิมพ์ซ้ำ', message: 'ใบเสร็จนี้พิมพ์ไปแล้ว ต้องการพิมพ์สำเนา (COPY) หรือไม่?' }))) return;
    preview(<SaleReceipt snap={rc.snapshot} isCopy={isCopy} short={kind === 'SHORT'} />, {
      reference: rc.receipt_no,
      isCopy,
      onPrinted: async () => {
        try {
          await api.post(`/receipts/${rc.id}/print`, { kind, confirmReprint: true });
          reload();
        } catch (e) {
          toast.error(e);
        }
      },
    });
  };
  const withApproval = async (fn) => {
    try {
      return await fn(null);
    } catch (e) {
      if (e.code !== 'APPROVAL_REQUIRED') throw e;
      const tok = await approve('refund.approve', 'คืนเงิน/ยกเลิกบิล');
      if (!tok) return null;
      return fn(tok);
    }
  };
  const voidOrder = async () => {
    const reason = await prompt({ title: 'ยกเลิกรายการ', message: 'กรุณาระบุเหตุผลการยกเลิก', danger: true, options: ['คีย์รายการผิด', 'ลูกค้ายกเลิก', 'ชำระเงินผิดช่องทาง'] });
    if (!reason) return;
    try {
      const r = await withApproval((tok) => api.post(`/orders/${rc.order_id}/void`, { reason, approvalToken: tok }));
      if (!r) return;
      toast.success('ยกเลิกรายการเรียบร้อย');
      preview(<VoidSlip store={settings.store} receipt={rc} reason={reason} employee={employee.name} />, { jobType: 'VOID', reference: rc.receipt_no, title: 'พิมพ์ใบยกเลิก' });
      reload();
      onChanged();
    } catch (e) {
      toast.error(e);
    }
  };
  const doRefund = async () => {
    const body = refund.full ? { full: true, reason: refund.reason, method: refund.method } : { amount: refund.items.length ? undefined : Number(refund.amount), items: refund.items.filter((x) => x.qty > 0).map((x) => ({ itemId: x.itemId, qty: x.qty })), reason: refund.reason, method: refund.method };
    try {
      const r = await withApproval((tok) => api.post(`/orders/${rc.order_id}/refunds`, { ...body, approvalToken: tok }, { idempotencyKey: refund.key }));
      if (!r) return;
      toast.success(r.status === 'REQUESTED' ? 'ส่งคำขอคืนเงินแล้ว รอผู้จัดการอนุมัติ' : 'คืนเงินเรียบร้อย');
      setRefund(null);
      reload();
      onChanged();
    } catch (e) {
      toast.error(e);
    }
  };
  const s = rc.snapshot;
  const productLines = (s.lines || []).map((l, i) => ({ ...l, i })).filter((l) => l.type === 'PRODUCT' && l.id);
  return (
    <Modal title={`${t('ใบเสร็จ')} ${rc.receipt_no}`} size="wide" onClose={onClose}>
      <div className="row mb">
        <Badge color={rc.order_status === 'PAID' ? '#16a34a' : '#dc2626'}>{rc.order_status}</Badge>
        {rc.void_reason && <span className="small muted">{rc.void_reason}</span>}
        <span className="small muted">{t('พิมพ์แล้ว')} {rc.print_count} {t('ครั้ง')}</span>
      </div>
      <div className="row mb">
        <Button icon={Printer} onClick={() => print('FULL')} disabled={rc.print_count > 0 && !can('receipt.reprint')}>{rc.print_count > 0 ? t('พิมพ์ซ้ำ (สำเนา)') : t('พิมพ์ใบเสร็จเต็ม')}</Button>
        <Button icon={Printer} onClick={() => print('SHORT')} disabled={rc.print_count > 0 && !can('receipt.reprint')}>{t('ใบเสร็จย่อ')}</Button>
        <Button icon={Send} onClick={() => setSend({ channel: 'LINE', to: s.customer?.phone || '' })}>{t('ส่งใบเสร็จ')}</Button>
        {can('refund.create') && ['PAID', 'PARTIALLY_REFUNDED'].includes(rc.order_status) && <Button icon={Undo2} onClick={() => setRefund({ full: false, amount: '', reason: '', method: 'CASH', key: uid(), items: [] })}>{t('คืนเงิน')}</Button>}
        {can('order.void') && rc.order_status === 'PAID' && <Button icon={Ban} variant="danger" onClick={voidOrder}>{t('ยกเลิกรายการ')}</Button>}
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'receipt', label: 'ใบเสร็จ' }, { value: 'log', label: 'Activity Log' }]} />
      {tab === 'receipt' ? <div className="receipt-preview"><SaleReceipt snap={s} /></div> : (
        <div className="col">{rc.logs.map((l) => <div key={l.id} className="card flat small" style={{ padding: 10 }}><div className="row between"><b>{l.action}</b><span className="muted">{fmtDateTime(l.created_at)}</span></div><div className="muted">{l.employee_name} · {JSON.stringify(l.details).slice(0, 240)}</div></div>)}</div>
      )}
      {refund && (
        <Modal title={t('คืนเงิน')} onClose={() => setRefund(null)} footer={<Button variant="danger" disabled={!refund.reason} onClick={doRefund}>{t('ยืนยันคืนเงิน')}</Button>}>
          <Seg value={refund.full ? 'full' : 'partial'} onChange={(v) => setRefund({ ...refund, full: v === 'full' })} options={[{ value: 'partial', label: 'คืนเงินบางส่วน' }, { value: 'full', label: 'คืนเงินทั้งหมด' }]} />
          {!refund.full && (
            <div className="mt">
              {productLines.length > 0 && <div className="small muted">{t('เลือกสินค้าที่คืน (คืนสต็อกอัตโนมัติ) หรือระบุจำนวนเงิน')}</div>}
              {productLines.map((l) => {
                const it = refund.items.find((x) => x.i === l.i);
                return (
                  <div key={l.i} className="row between">
                    <span>{l.name} × {l.qty}</span>
                    <Input type="number" min={0} max={l.qty} style={{ width: 90 }} value={it?.qty ?? 0} onChange={(e) => setRefund({ ...refund, items: [...refund.items.filter((x) => x.i !== l.i), { i: l.i, itemId: l.id, qty: Number(e.target.value) }] })} />
                  </div>
                );
              })}
              <Field label="จำนวนเงิน"><Input type="number" value={refund.amount} onChange={(e) => setRefund({ ...refund, amount: e.target.value, items: [] })} /></Field>
            </div>
          )}
          <div className="grid grid-2 mt">
            <Field label="ช่องทางคืนเงิน"><Select value={refund.method} onChange={(e) => setRefund({ ...refund, method: e.target.value })} options={Object.entries(PAYMENT_METHODS).map(([value, label]) => ({ value, label }))} /></Field>
            <Field label="เหตุผล *"><Input value={refund.reason} onChange={(e) => setRefund({ ...refund, reason: e.target.value })} /></Field>
          </div>
          <div className="small muted mt">{t('รายการคืนเงินต้องได้รับอนุมัติ และระบบจะย้อนคะแนนสมาชิกตามยอดที่คืน')}</div>
        </Modal>
      )}
      {send && (
        <Modal title={t('ส่งใบเสร็จ')} onClose={() => setSend(null)} footer={<Button variant="primary" onClick={async () => { try { await api.post(`/receipts/${rc.id}/send`, send); toast.success('บันทึกการส่งแล้ว'); setSend(null); } catch (e) { toast.error(e); } }}>{t('ส่ง')}</Button>}>
          <Seg value={send.channel} onChange={(v) => setSend({ ...send, channel: v })} options={['LINE', 'SMS', 'EMAIL']} />
          <Field label="ถึง"><Input value={send.to} onChange={(e) => setSend({ ...send, to: e.target.value })} /></Field>
        </Modal>
      )}
    </Modal>
  );
}

export default function Receipts() {
  const { t } = useT();
  const [q, setQ] = useState('');
  const [from, setFrom] = useState(bkkDateStr(Date.now() - 7 * 86400000));
  const [to, setTo] = useState(bkkDateStr());
  const [method, setMethod] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [open, setOpen] = useState(null);
  const qs = new URLSearchParams({ q, from, to, ...(method ? { method } : {}), ...(employeeId ? { employeeId } : {}) });
  const { data, loading, reload } = useLive(() => api.get(`/receipts?${qs}`), ['orders'], [qs.toString()]);
  const { data: emps } = useLive(() => api.get('/employees/directory'), [], []);
  return (
    <div>
      <PageHead icon={Receipt} title="ประวัติใบเสร็จ" />
      <div className="row mb">
        <div className="row nowrap" style={{ position: 'relative' }}>
          <Search size={16} style={{ position: 'absolute', left: 10, color: 'var(--muted)' }} />
          <Input style={{ paddingLeft: 32, width: 280 }} placeholder={t('เลขที่ใบเสร็จ / คิว / ชื่อ / เบอร์โทร / ห้อง')} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 160 }} />
        <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 160 }} />
        <Select value={method} onChange={(e) => setMethod(e.target.value)} options={Object.entries(PAYMENT_METHODS).map(([value, label]) => ({ value, label }))} placeholder="ทุกช่องทาง" style={{ width: 150 }} />
        <Select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} options={(emps || []).map((e) => ({ value: e.id, label: e.name }))} placeholder="ทุกพนักงาน" style={{ width: 170 }} />
      </div>
      {loading ? <Loading /> : !data?.length ? <Empty /> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>{t('เลขที่ใบเสร็จ')}</th><th>{t('คิว')}</th><th>{t('วันเวลา')}</th><th>{t('ลูกค้า')}</th><th>{t('ห้อง')}</th><th>{t('พนักงาน')}</th><th>{t('ช่องทาง')}</th><th className="right">{t('ยอดรวม')}</th><th>{t('สถานะ')}</th></tr></thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => setOpen(r.id)}>
                  <td className="bold">{r.receipt_no}</td><td>{r.queue_no}</td><td className="small nowrap">{fmtDateTime(r.issued_at)}</td>
                  <td>{r.member_name || r.customer_name || '-'}<div className="xs muted">{r.member_phone || r.phone}</div></td>
                  <td>{r.room_name || t('หน้าร้าน')}</td><td>{r.employee_name}</td>
                  <td className="small">{(r.methods || '').split(',').map((m) => t(PAYMENT_METHODS[m] || m)).join(', ')}</td>
                  <td className="right num">{money(r.grand_total)}{Number(r.refunded_total) > 0 && <div className="xs" style={{ color: 'var(--warn)' }}>-{money(r.refunded_total)}</div>}</td>
                  <td><Badge color={r.status === 'PAID' ? '#16a34a' : r.status === 'VOID' ? '#dc2626' : '#f97316'}>{r.status}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <ReceiptView id={open} onClose={() => setOpen(null)} onChanged={reload} />}
    </div>
  );
}

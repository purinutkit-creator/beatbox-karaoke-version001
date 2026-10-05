import { useState } from 'react';
import { Wallet, Undo2, Printer } from 'lucide-react';
import { PageHead, Button, Input, Select, Badge, Loading, Empty, Modal, Field, money, useToast, useDialog } from '../../components/ui.jsx';
import { DepositSlip } from '../../components/Receipt.jsx';
import { usePrint } from '../../components/PrintPreview.jsx';
import { ReservationDrawer } from '../../components/ReservationParts.jsx';
import { useT } from '../../lib/i18n.jsx';
import { api, uid } from '../../lib/api.js';
import { useAuth } from '../../lib/store.jsx';
import { useLive } from '../../lib/socket.js';
import { fmtDateTime } from '@beatbox/shared/format.js';
import { PAYMENT_METHODS } from '@beatbox/shared/constants.js';

export default function Deposits() {
  const { t } = useT();
  const toast = useToast();
  const { approve } = useDialog();
  const { can, settings } = useAuth();
  const { preview } = usePrint();
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [refund, setRefund] = useState(null);
  const [open, setOpen] = useState(null);
  const { data, loading, reload } = useLive(() => api.get(`/deposits?${new URLSearchParams({ ...(status ? { status } : {}), ...(q ? { q } : {}) })}`), ['deposits', 'reservations'], [status, q]);
  const doRefund = async () => {
    const body = { amount: Number(refund.amount), reason: refund.reason, refundType: refund.refundType, note: refund.note };
    const send = (approvalToken) => api.post(`/deposits/${refund.deposit.id}/refund`, { ...body, approvalToken }, { idempotencyKey: refund.key });
    try {
      let r;
      try {
        r = await send(null);
      } catch (e) {
        if (e.code !== 'APPROVAL_REQUIRED') throw e;
        const tok = await approve('refund.approve', 'คืนมัดจำ');
        if (!tok) return;
        r = await send(tok);
      }
      toast.success('คืนเงินมัดจำเรียบร้อย');
      preview(<DepositSlip store={settings.store} deposit={refund.deposit} refund={{ ...r, employee_name: '' }} />, { jobType: 'DEPOSIT_REFUND', reference: r.refund_no, title: 'พิมพ์ใบคืนมัดจำ' });
      setRefund(null);
      reload();
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <div>
      <PageHead icon={Wallet} title="เงินมัดจำ">
        <Input placeholder={t('ค้นหา')} value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 220 }} />
        <Select value={status} onChange={(e) => setStatus(e.target.value)} options={['RECEIVED', 'APPLIED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'FORFEITED', 'CANCELLED']} placeholder="ทุกสถานะ" style={{ width: 200 }} />
      </PageHead>
      {loading ? <Loading /> : !data?.length ? <Empty /> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>{t('เลขที่รายการมัดจำ')}</th><th>{t('เลขที่การจอง')}</th><th>{t('ลูกค้า')}</th><th className="right">{t('จำนวนเงิน')}</th><th>{t('ช่องทาง')}</th><th>{t('การตรวจสอบ')}</th><th>{t('สถานะ')}</th><th>{t('ผู้รับเงิน')}</th><th>{t('วันเวลา')}</th><th /></tr></thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.id}>
                  <td className="bold">{d.deposit_no}</td>
                  <td>{d.booking_no ? <a href="#" onClick={(e) => { e.preventDefault(); setOpen(d.reservation_id); }}>{d.booking_no}</a> : '-'}</td>
                  <td>{d.customer_name}<div className="xs muted">{d.phone}</div></td>
                  <td className="right num">{money(d.amount)}{Number(d.refunded_amount) > 0 && <div className="xs" style={{ color: 'var(--warn)' }}>{t('คืน')} {money(d.refunded_amount)}</div>}</td>
                  <td>{t(PAYMENT_METHODS[d.method] || d.method)}<div className="xs muted">{d.source}</div></td>
                  <td><Badge color={d.verification_status === 'VERIFIED' ? '#16a34a' : d.verification_status === 'PENDING' ? '#f97316' : '#dc2626'}>{d.verification_status}</Badge></td>
                  <td><Badge>{d.status}</Badge></td>
                  <td>{d.received_by_name || 'ONLINE'}</td>
                  <td className="small nowrap">{fmtDateTime(d.received_at)}</td>
                  <td className="nowrap">
                    <Button size="sm" variant="ghost" icon={Printer} onClick={() => preview(<DepositSlip store={settings.store} deposit={d} />, { jobType: 'DEPOSIT', reference: d.deposit_no })} />
                    {can('refund.create') && ['RECEIVED', 'PARTIALLY_REFUNDED', 'FORFEITED'].includes(d.status) && <Button size="sm" icon={Undo2} onClick={() => setRefund({ deposit: d, amount: Number(d.amount) - Number(d.refunded_amount), reason: '', refundType: 'CASH', key: uid() })}>{t('คืนเงิน')}</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {refund && (
        <Modal title={`${t('คืนเงินมัดจำ')} ${refund.deposit.deposit_no}`} onClose={() => setRefund(null)} footer={<Button variant="danger" disabled={!refund.reason || !Number(refund.amount)} onClick={doRefund}>{t('ยืนยันคืนเงิน')}</Button>}>
          <div className="grid grid-2">
            <Field label="จำนวนเงินที่คืน"><Input type="number" value={refund.amount} onChange={(e) => setRefund({ ...refund, amount: e.target.value })} /></Field>
            <Field label="ช่องทางคืนเงิน"><Select value={refund.refundType} onChange={(e) => setRefund({ ...refund, refundType: e.target.value })} options={[{ value: 'CASH', label: 'เงินสด' }, { value: 'TRANSFER', label: 'โอนเงิน' }, { value: 'QR', label: 'QR Code' }, { value: 'CARD', label: 'บัตร' }, { value: 'STORE_CREDIT', label: 'Store Credit' }, { value: 'OTHER', label: 'ช่องทางอื่น' }]} /></Field>
            <Field label="เหตุผล *" style={{ gridColumn: '1/-1' }}><Input value={refund.reason} onChange={(e) => setRefund({ ...refund, reason: e.target.value })} /></Field>
            <Field label="หมายเหตุ" style={{ gridColumn: '1/-1' }}><Input value={refund.note || ''} onChange={(e) => setRefund({ ...refund, note: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
      {open && <ReservationDrawer id={open} onClose={() => setOpen(null)} onChanged={reload} />}
    </div>
  );
}

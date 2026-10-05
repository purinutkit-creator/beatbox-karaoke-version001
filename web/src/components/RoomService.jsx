// Staff side of in-room QR ordering: verify customer prepayments (with slip) and handle reported problems.
import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle, AlertTriangle, Hand, Check } from 'lucide-react';
import { Button, Badge, money, useToast, useDialog } from './ui.jsx';
import { useT } from '../lib/i18n.jsx';
import { api, request } from '../lib/api.js';
import { useAuth } from '../lib/store.jsx';
import { fmtTime } from '@beatbox/shared/format.js';

export function SlipImage({ url }) {
  const [src, setSrc] = useState(null);
  const [none, setNone] = useState(false);
  useEffect(() => {
    let u;
    request('GET', url, undefined, { raw: true })
      .then((r) => (r.ok ? r.blob() : Promise.reject()))
      .then((b) => setSrc((u = URL.createObjectURL(b))))
      .catch(() => setNone(true));
    return () => u && URL.revokeObjectURL(u);
  }, [url]);
  if (none) return <div className="muted small">ไม่มีสลิปแนบ</div>;
  if (!src) return <span className="spinner" />;
  return (
    <a href={src} target="_blank" rel="noreferrer">
      <img src={src} alt="slip" style={{ maxWidth: '100%', maxHeight: 360, borderRadius: 10, border: '1px solid var(--border)' }} />
    </a>
  );
}

const PAY_LABEL = { PENDING: ['รอตรวจสลิป', '#f97316'], AUTO_ACCEPTED: ['ยืนยันอัตโนมัติให้ลูกค้าแล้ว · รอตรวจสลิป', '#dc2626'], VERIFIED: ['ตรวจแล้ว', '#16a34a'], REJECTED: ['ไม่ผ่าน', '#dc2626'] };

/** One customer prepayment waiting for the cashier. */
export function PrepayReview({ p, onDone }) {
  const { t } = useT();
  const toast = useToast();
  const { prompt } = useDialog();
  const { can } = useAuth();
  const [busy, setBusy] = useState(false);
  const decide = async (approve) => {
    let reason = null;
    if (!approve) {
      reason = await prompt({ title: 'สลิปไม่ผ่าน', message: 'ระบุเหตุผล (ลูกค้าจะเห็นข้อความนี้)', danger: true, options: ['ยังไม่พบยอดเงินเข้าบัญชี', 'ยอดเงินไม่ตรง', 'สลิปไม่ถูกต้อง/ซ้ำ'] });
      if (!reason) return;
    }
    setBusy(true);
    try {
      await api.post(`/room-service/orders/${p.id}/verify`, { approve, reason });
      toast.success(approve ? 'ยืนยันการชำระเงินแล้ว' : 'บันทึกว่าสลิปไม่ผ่านแล้ว');
      onDone?.();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const [label, color] = PAY_LABEL[p.payment_status] || [p.payment_status, '#6b7280'];
  return (
    <div className="card flat col" style={{ borderColor: color }}>
      <div className="row between nowrap">
        <b>{p.room_name ? `${t('ห้อง')} ${p.room_name} · ` : ''}#{p.id} · {fmtTime(p.submitted_at || p.created_at)}</b>
        <b style={{ fontSize: '1.3rem', color: 'var(--primary)' }}>฿{money(p.amount)}</b>
      </div>
      <Badge color={color}>{t(label)}</Badge>
      <div className="small">{(p.items || []).map((i, k) => <span key={k}>{i.name} × {i.qty}{k < p.items.length - 1 ? ', ' : ''}</span>)}</div>
      <div className="xs muted">{t('ตรวจยอดเงินเข้าในแอปธนาคารของร้านก่อนกดยืนยัน')}</div>
      <SlipImage url={`/room-service/orders/${p.id}/slip`} />
      {can('slip.verify') && (
        <div className="grid grid-2">
          <Button variant="success" icon={CheckCircle2} loading={busy} onClick={() => decide(true)}>{t('ยอดเงินเข้าแล้ว ยืนยัน')}</Button>
          <Button variant="danger" icon={XCircle} disabled={busy} onClick={() => decide(false)}>{t('ไม่ผ่าน')}</Button>
        </div>
      )}
    </div>
  );
}

const ISSUE_LABEL = { OPEN: ['รอพนักงาน', '#dc2626'], ACKNOWLEDGED: ['กำลังดำเนินการ', '#f97316'] };

export function IssueItem({ issue, onDone }) {
  const { t } = useT();
  const toast = useToast();
  const { prompt } = useDialog();
  const act = async (action) => {
    let note = null;
    if (action === 'resolve') {
      note = await prompt({ title: 'แก้ไขปัญหาแล้ว', message: 'บันทึกสิ่งที่ทำ (ไม่บังคับ)', required: false });
      if (note === null || note === undefined) return;
    }
    try {
      await api.post(`/room-issues/${issue.id}/${action}`, { note });
      onDone?.();
    } catch (e) {
      toast.error(e);
    }
  };
  const [label, color] = ISSUE_LABEL[issue.status] || [issue.status, '#6b7280'];
  return (
    <div className="card flat" style={{ borderColor: color, padding: 12 }}>
      <div className="row between nowrap">
        <b><AlertTriangle size={16} color={color} /> {issue.room_name ? `${issue.room_name} · ` : ''}{issue.category}</b>
        <span className="xs muted">{fmtTime(issue.created_at)}</span>
      </div>
      {issue.message && <div className="mt">{issue.message}</div>}
      <div className="row between mt">
        <Badge color={color}>{t(label)}</Badge>
        <div className="row">
          {issue.status === 'OPEN' && <Button size="sm" icon={Hand} onClick={() => act('ack')}>{t('รับเรื่อง')}</Button>}
          <Button size="sm" variant="success" icon={Check} onClick={() => act('resolve')}>{t('แก้ไขแล้ว')}</Button>
        </div>
      </div>
    </div>
  );
}

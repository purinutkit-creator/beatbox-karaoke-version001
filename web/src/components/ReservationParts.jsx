import { useEffect, useMemo, useState } from 'react';
import { CalendarPlus, CheckCircle2, DoorOpen, Wallet, XCircle, UserX, UserCheck, Printer, Search, Pencil, Eye, QrCode, Link2 } from 'lucide-react';
import { Modal, Drawer, Button, Field, Input, Select, Textarea, Badge, Tabs, Loading, money, useToast, useDialog, QRCode, Barcode, Empty } from './ui.jsx';
import { MemberPicker } from './MemberPicker.jsx';
import { DepositSlip } from './Receipt.jsx';
import { usePrint } from './PrintPreview.jsx';
import { DepositModal } from '../admin/pages/Rooms.jsx';
import { useT } from '../lib/i18n.jsx';
import { api, uid } from '../lib/api.js';
import { useAuth, useApp } from '../lib/store.jsx';
import { useLive } from '../lib/socket.js';
import { RESERVATION_STATUS_LABEL, RESERVATION_STATUS_COLOR } from '@beatbox/shared/constants.js';
import { fmtDateTime, fmtTime, fmtDate, bkkDateStr } from '@beatbox/shared/format.js';
import { formatMinutesShort } from '@beatbox/shared/roomPricing.js';

export function StatusBadge({ status }) {
  const { t } = useT();
  return <Badge color={RESERVATION_STATUS_COLOR[status]}>{t(RESERVATION_STATUS_LABEL[status] || status)}</Badge>;
}

const toLocal = (d) => new Date(new Date(d).getTime() + 7 * 3600000).toISOString().slice(0, 16);

/** Create / edit reservation with live availability check + alternatives. */
export function ReservationForm({ initial = {}, onClose, onSaved }) {
  const { t } = useT();
  const toast = useToast();
  const { shift } = useAuth();
  const { data: board } = useLive(() => api.get('/rooms'), [], []);
  const { data: packages } = useLive(() => api.get('/packages'), [], []);
  const editing = !!initial.id;
  const [f, setF] = useState({
    roomId: initial.room_id || initial.roomId || '',
    startAt: initial.start_at ? toLocal(initial.start_at) : initial.startAt || `${bkkDateStr()}T19:00`,
    durationMinutes: initial.duration_minutes || 120,
    customerName: initial.customer_name || '',
    phone: initial.phone || '',
    memberId: initial.member_id || null,
    guestCount: initial.guest_count || 4,
    packageId: initial.package_id || '',
    note: initial.note || '',
    source: initial.source || 'PHONE',
    status: 'CONFIRMED',
    depositAmount: '',
    depositMethod: 'CASH',
  });
  const [avail, setAvail] = useState(null);
  const [busy, setBusy] = useState(false);
  const [memberOpen, setMemberOpen] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const startIso = f.startAt ? new Date(`${f.startAt}:00+07:00`).toISOString() : null;
  useEffect(() => {
    if (!startIso || !f.durationMinutes) return;
    const id = setTimeout(async () => {
      try {
        setAvail(await api.get(`/reservations/availability?startAt=${encodeURIComponent(startIso)}&durationMinutes=${f.durationMinutes}&guests=${f.guestCount}${editing ? `&excludeReservationId=${initial.id}` : ''}`));
      } catch {
        setAvail(null);
      }
    }, 300);
    return () => clearTimeout(id);
  }, [startIso, f.durationMinutes, f.guestCount]);
  const selected = avail?.rooms?.find((r) => r.id === Number(f.roomId));
  const selectedBusy = selected && !selected.available && !(editing && Number(f.roomId) === initial.room_id);
  const suggestions = avail && selected ? avail.rooms.filter((r) => r.available && r.fits && r.room_type_id === selected.room_type_id && r.id !== selected.id) : [];
  const save = async () => {
    setBusy(true);
    try {
      if (editing) await api.put(`/reservations/${initial.id}`, { roomId: Number(f.roomId), startAt: startIso, durationMinutes: Number(f.durationMinutes), guestCount: Number(f.guestCount), customerName: f.customerName, phone: f.phone, note: f.note, packageId: f.packageId ? Number(f.packageId) : null, version: initial.version });
      else
        await api.post(
          '/reservations',
          { roomId: Number(f.roomId), startAt: startIso, durationMinutes: Number(f.durationMinutes), customerName: f.customerName, phone: f.phone, memberId: f.memberId, guestCount: Number(f.guestCount), packageId: f.packageId ? Number(f.packageId) : null, note: f.note, source: f.source, status: f.status, deposit: Number(f.depositAmount) > 0 ? { amount: Number(f.depositAmount), method: f.depositMethod } : null },
          { idempotencyKey: uid() },
        );
      toast.success('บันทึกการจองเรียบร้อย');
      onSaved?.();
    } catch (e) {
      toast.error(e);
      if (e.code === 'ROOM_TAKEN') setAvail((a) => a && { ...a });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={editing ? `${t('แก้ไขการจอง')} ${initial.booking_no}` : t('สร้างการจอง')} size="wide" onClose={onClose}
      footer={<Button variant="primary" loading={busy} disabled={!f.roomId || !f.customerName || !f.phone || selectedBusy} onClick={save}>{t('บันทึกการจอง')}</Button>}>
      <div className="grid grid-2">
        <Field label="วันที่และเวลาเริ่ม"><Input type="datetime-local" value={f.startAt} onChange={(e) => set('startAt', e.target.value)} /></Field>
        <Field label="ระยะเวลา">
          <Select value={f.durationMinutes} onChange={(e) => set('durationMinutes', Number(e.target.value))} options={[30, 60, 90, 120, 150, 180, 240, 300, 360].map((m) => ({ value: m, label: formatMinutesShort(m) }))} />
        </Field>
        <Field label="จำนวนลูกค้า"><Input type="number" value={f.guestCount} onChange={(e) => set('guestCount', e.target.value)} /></Field>
        <Field label="แพ็กเกจ"><Select value={f.packageId} onChange={(e) => set('packageId', e.target.value)} options={(packages || []).filter((p) => p.is_active).map((p) => ({ value: p.id, label: `${p.name} ฿${money(p.price, 0)}` }))} placeholder="-" /></Field>
        <Field label="ห้อง" style={{ gridColumn: '1/-1' }}>
          <div className="grid grid-auto" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(140px,1fr))', gap: 6 }}>
            {(avail?.rooms || (board || []).map((r) => ({ ...r, available: true, fits: true }))).map((r) => {
              const free = r.available || (editing && r.id === initial.room_id);
              return (
                <button key={r.id} type="button" className={`slot ${Number(f.roomId) === r.id ? 'sel' : free && r.fits ? 'free' : 'busy'}`} onClick={() => set('roomId', r.id)}>
                  {r.name}
                  <div className="xs">{r.type_name} · {r.capacity}{t('คน')}</div>
                </button>
              );
            })}
          </div>
          <div className="xs muted">{t('สีเขียว = ว่าง, สีแดง = ถูกจองแล้ว/ไม่พอจำนวนคน')}</div>
        </Field>
        {selectedBusy && (
          <div className="card flat" style={{ gridColumn: '1/-1', borderColor: 'var(--danger)' }}>
            <b style={{ color: 'var(--danger)' }}>{t('ห้องที่เลือกไม่ว่างในช่วงเวลานี้')}</b>
            {suggestions.length ? (
              <div className="row mt">{t('แนะนำห้อง Type เดียวกันที่ว่าง')}: {suggestions.map((r) => <Button key={r.id} size="sm" variant="success" onClick={() => set('roomId', r.id)}>{r.name}</Button>)}</div>
            ) : <div className="small">{t('ไม่มีห้อง Type เดียวกันว่าง ลองเปลี่ยนเวลา')}</div>}
          </div>
        )}
        {avail?.suggestions && (
          <div className="card flat" style={{ gridColumn: '1/-1' }}>
            <b>{t('ไม่มีห้องว่าง — ตัวเลือกใกล้เคียง')}</b>
            <div className="row mt">
              {avail.suggestions.nearbyTimes.map((s, i) => <Button key={i} size="sm" onClick={() => set('startAt', toLocal(s.startAt))}>{fmtTime(s.startAt)} ({s.rooms} {t('ห้อง')})</Button>)}
              {avail.suggestions.otherDays.map((s, i) => <Button key={`d${i}`} size="sm" onClick={() => set('startAt', toLocal(s.startAt))}>{fmtDate(s.startAt)}</Button>)}
            </div>
          </div>
        )}
        <Field label="ชื่อลูกค้า *"><Input value={f.customerName} onChange={(e) => set('customerName', e.target.value)} /></Field>
        <Field label="เบอร์โทรศัพท์ *">
          <div className="row nowrap">
            <Input value={f.phone} onChange={(e) => set('phone', e.target.value)} />
            <Button icon={Search} onClick={() => setMemberOpen(true)}>{t('สมาชิก')}</Button>
          </div>
        </Field>
        {!editing && (
          <>
            <Field label="ช่องทางการจอง"><Select value={f.source} onChange={(e) => set('source', e.target.value)} options={['PHONE', 'POS', 'WALK_IN', 'LINE']} /></Field>
            <Field label="สถานะ"><Select value={f.status} onChange={(e) => set('status', e.target.value)} options={[{ value: 'CONFIRMED', label: 'ยืนยันแล้ว' }, { value: 'PENDING', label: 'รอยืนยัน' }]} /></Field>
            <Field label="รับมัดจำ (เงินสด/บัตร)" hint={!shift ? 'ต้องเปิดรอบการขายก่อน' : 'QR/โอน: รับมัดจำภายหลังในรายละเอียดการจอง'}>
              <div className="row nowrap">
                <Input type="number" value={f.depositAmount} onChange={(e) => set('depositAmount', e.target.value)} disabled={!shift} />
                <Select value={f.depositMethod} onChange={(e) => set('depositMethod', e.target.value)} options={[{ value: 'CASH', label: 'เงินสด' }, { value: 'CARD', label: 'บัตร' }, { value: 'OTHER', label: 'ช่องทางอื่น' }]} />
              </div>
            </Field>
          </>
        )}
        <Field label="หมายเหตุ" style={{ gridColumn: '1/-1' }}><Textarea value={f.note} onChange={(e) => set('note', e.target.value)} /></Field>
      </div>
      {memberOpen && (
        <Modal title={t('เลือกสมาชิก')} onClose={() => setMemberOpen(false)}>
          <MemberPicker initialPhone={f.phone} onPick={(m) => { setF((x) => ({ ...x, memberId: m.id, customerName: `${m.first_name} ${m.last_name || ''}`.trim(), phone: m.phone })); setMemberOpen(false); }} />
        </Modal>
      )}
    </Modal>
  );
}

/** Reservation detail with every action staff can take. */
export function ReservationDrawer({ id, onClose, onChanged }) {
  const { t } = useT();
  const toast = useToast();
  const { confirm, prompt, approve } = useDialog();
  const { can, settings } = useAuth();
  const { preview } = usePrint();
  const { data: rv, reload } = useLive(() => api.get(`/reservations/${id}`), ['reservations', 'deposits'], [id]);
  const [tab, setTab] = useState('info');
  const [modal, setModal] = useState(null);
  const [cancelForm, setCancelForm] = useState(null);
  if (!rv) return <Drawer title="..." onClose={onClose}><Loading /></Drawer>;
  const act = async (fn, msg) => {
    try {
      await fn();
      toast.success(msg || 'บันทึกเรียบร้อย');
      reload();
      onChanged?.();
    } catch (e) {
      toast.error(e);
    }
  };
  const active = ['PENDING', 'CONFIRMED', 'DEPOSIT_PAID', 'WAITING', 'ARRIVED', 'HOLD'].includes(rv.status);
  const doCancel = async () => {
    const body = { reason: cancelForm.reason, refundAmount: Number(cancelForm.refundAmount) || 0, refundMethod: cancelForm.refundMethod };
    try {
      await api.post(`/reservations/${rv.id}/cancel`, body, { idempotencyKey: uid() });
    } catch (e) {
      if (e.code !== 'APPROVAL_REQUIRED') return toast.error(e);
      const tok = await approve('refund.approve', 'คืนมัดจำ');
      if (!tok) return;
      try {
        await api.post(`/reservations/${rv.id}/cancel`, { ...body, approvalToken: tok }, { idempotencyKey: uid() });
      } catch (e2) {
        return toast.error(e2);
      }
    }
    toast.success('ยกเลิกการจองเรียบร้อย');
    setCancelForm(null);
    reload();
    onChanged?.();
  };
  const store = settings?.store;
  return (
    <Drawer title={<span className="row nowrap">{rv.booking_no} <StatusBadge status={rv.status} /></span>} onClose={onClose}>
      <div className="col">
        <div className="grid grid-2">
          <div className="card flat">
            <div className="bold" style={{ fontSize: '1.2rem' }}>{rv.customer_name}</div>
            <div className="muted">{rv.phone}</div>
            {rv.member_code && <div className="small"><Badge color="#eab308">{rv.member_code}</Badge> {rv.member_points} {t('คะแนน')} {rv.line_connected && <Badge color="#06c755">LINE</Badge>}</div>}
            <div className="mt"><b>{rv.room_name}</b> · {rv.type_name}</div>
            <div>{fmtDate(rv.start_at)} {fmtTime(rv.start_at)} – {fmtTime(rv.end_at)} ({formatMinutesShort(rv.duration_minutes)})</div>
            <div>{t('จำนวนลูกค้า')} {rv.guest_count} · {rv.package_name || t('รายชั่วโมง')}</div>
            <div className="small muted">{t('ช่องทาง')} {rv.source} · {t('รับจองโดย')} {rv.created_by_name || 'ONLINE'} · {fmtDateTime(rv.created_at)}</div>
            {rv.note && <div className="small">📝 {rv.note}</div>}
          </div>
          <div className="card flat center">
            <QRCode value={`CHECKIN:${rv.check_in_token}`} size={140} />
            <Barcode value={rv.booking_no} height={34} />
            <div className="small">{t('ยอดโดยประมาณ')} <b>฿{money(rv.estimated_total)}</b></div>
            <div className="small">{t('มัดจำ')} <b>{money(rv.deposit_paid)}</b> / {money(rv.deposit_required)}</div>
            <div className="small">{t('คงเหลือโดยประมาณ')} <b>฿{money(Math.max(0, rv.estimated_total - rv.deposit_paid))}</b></div>
            {rv.payment_status && <Badge color="#2563eb">Payment {rv.payment_status}</Badge>}
          </div>
        </div>
        {active && (
          <div className="grid grid-3" style={{ gap: 8 }}>
            {['PENDING', 'HOLD'].includes(rv.status) && <Button icon={CheckCircle2} variant="success" onClick={() => act(() => api.post(`/reservations/${rv.id}/status`, { status: 'CONFIRMED' }))}>{t('ยืนยันรายการ')}</Button>}
            {['PENDING', 'CONFIRMED', 'DEPOSIT_PAID', 'WAITING'].includes(rv.status) && <Button icon={UserCheck} variant="success" onClick={() => act(() => api.post(`/reservations/${rv.id}/check-in`), 'ลูกค้ามาถึงแล้ว')}>{t('ลูกค้ามาถึงแล้ว')}</Button>}
            {can('room.operate') && rv.status !== 'HOLD' && <Button icon={DoorOpen} variant="primary" onClick={() => act(() => api.post(`/reservations/${rv.id}/open`, { clientOpId: uid() }), 'เปิดห้องจากการจองแล้ว')}>{t('เปิดห้องจากการจอง')}</Button>}
            <Button icon={Wallet} onClick={() => setModal('deposit')}>{t('รับมัดจำ')}</Button>
            <Button icon={Pencil} onClick={() => setModal('edit')}>{t('เปลี่ยนห้อง/เวลา')}</Button>
            {['PENDING', 'CONFIRMED', 'DEPOSIT_PAID', 'WAITING'].includes(rv.status) && <Button icon={UserX} onClick={async () => (await confirm({ message: 'Mark No-show?', danger: true })) && act(() => api.post(`/reservations/${rv.id}/status`, { status: 'NO_SHOW' }))}>{t('ไม่มาตามนัด')}</Button>}
            <Button icon={XCircle} variant="danger" onClick={() => setCancelForm({ reason: '', refundAmount: rv.cancelPreview?.amount || 0, refundMethod: 'TRANSFER' })}>{t('ยกเลิก / Refund')}</Button>
          </div>
        )}
        <Tabs value={tab} onChange={setTab} tabs={[{ value: 'info', label: 'มัดจำ & การชำระเงิน' }, { value: 'log', label: 'Activity Log' }]} />
        {tab === 'info' ? (
          <div className="col">
            {rv.deposits.map((d) => (
              <div key={d.id} className="card flat row between">
                <div>
                  <b>{d.deposit_no}</b> · {money(d.amount)} · {d.method} <Badge>{d.status}</Badge> <Badge color={d.verification_status === 'VERIFIED' ? '#16a34a' : '#f97316'}>{d.verification_status}</Badge>
                  <div className="xs muted">{fmtDateTime(d.received_at)} · {d.received_by_name || d.source}{Number(d.refunded_amount) > 0 && ` · ${t('คืนแล้ว')} ${money(d.refunded_amount)}`}</div>
                </div>
                <div className="row nowrap">
                  {d.verification_status === 'PENDING' && can('slip.verify') && <Button size="sm" variant="success" onClick={() => act(() => api.post(`/deposits/${d.id}/verify`, { approve: true }))}>{t('ยืนยัน')}</Button>}
                  <Button size="sm" icon={Printer} onClick={() => preview(<DepositSlip store={store} deposit={{ ...d, booking_no: rv.booking_no, room_name: rv.room_name, start_at: rv.start_at }} />, { jobType: 'DEPOSIT', reference: d.deposit_no })} />
                </div>
              </div>
            ))}
            {rv.refunds.map((r) => (
              <div key={r.id} className="card flat row between" style={{ borderColor: 'var(--warn)' }}>
                <div><b>{r.refund_no}</b> · {t('คืนมัดจำ')} {money(r.amount)} · {r.refund_type}<div className="xs muted">{r.reason} · {r.employee_name} · {fmtDateTime(r.created_at)}</div></div>
                <Button size="sm" icon={Printer} onClick={() => preview(<DepositSlip store={store} deposit={{ ...(rv.deposits.find((d) => d.id === r.deposit_id) || {}), booking_no: rv.booking_no }} refund={r} />, { jobType: 'DEPOSIT_REFUND', reference: r.refund_no })} />
              </div>
            ))}
            {rv.verifications.map((v) => (
              <div key={v.id} className="card flat">
                <div className="row between">
                  <span><QrCode size={14} /> {t('ตรวจสลิป')} #{v.id} · {v.provider} · <Badge color={v.result === 'PASSED' ? '#16a34a' : v.result === 'FAILED' ? '#dc2626' : '#f97316'}>{v.result}</Badge></span>
                  <span className="xs muted">{fmtDateTime(v.created_at)}</span>
                </div>
                <div className="small muted">{v.transaction_ref || ''} {v.failure_reason || ''} {v.reviewed_by_name && `· ${v.reviewed_by_name}`}</div>
                {v.slip_path && <SlipImage id={v.id} />}
                {['MANUAL_REVIEW', 'PENDING', 'FAILED'].includes(v.result) && can('slip.verify') && (
                  <div className="row mt">
                    <Button size="sm" variant="success" onClick={async () => { const ref2 = await prompt({ title: 'อนุมัติสลิป', message: 'เลขอ้างอิงธุรกรรม (Transaction Reference)', required: false }); if (ref2 !== null) act(() => api.post(`/payment-verifications/${v.id}/review`, { approve: true, transactionRef: ref2 || null })); }}>{t('อนุมัติ')}</Button>
                    <Button size="sm" variant="danger" onClick={async () => { const reason = await prompt({ title: 'ปฏิเสธสลิป', message: 'เหตุผล', options: ['ยอดเงินไม่ตรง', 'ไม่สามารถตรวจสอบรายการได้', 'พบรายการนี้ถูกใช้แล้ว'] }); if (reason) act(() => api.post(`/payment-verifications/${v.id}/review`, { approve: false, reason })); }}>{t('ปฏิเสธ')}</Button>
                  </div>
                )}
              </div>
            ))}
            {!rv.deposits.length && !rv.verifications.length && <Empty text="ยังไม่มีรายการมัดจำ" />}
          </div>
        ) : (
          <div className="col">
            {rv.logs.map((l) => (
              <div key={l.id} className="card flat small" style={{ padding: 10 }}>
                <div className="row between"><b>{l.action}</b><span className="muted">{fmtDateTime(l.created_at)}</span></div>
                <div className="muted">{l.employee_name || 'SYSTEM'} · {JSON.stringify(l.details).slice(0, 200)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
      {modal === 'deposit' && <DepositModal reservation={rv} onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); onChanged?.(); }} />}
      {modal === 'edit' && <ReservationForm initial={rv} onClose={() => setModal(null)} onSaved={() => { setModal(null); reload(); onChanged?.(); }} />}
      {cancelForm && (
        <Modal title={t('ยกเลิกการจอง')} onClose={() => setCancelForm(null)} footer={<Button variant="danger" disabled={!cancelForm.reason} onClick={doCancel}>{t('ยืนยันยกเลิก')}</Button>}>
          <div className="card flat mb">
            {t('มัดจำที่ถืออยู่')} <b>{money(rv.depositHeld)}</b> · {t('ตามนโยบาย')} ({rv.cancelPreview.hoursLeft} {t('ชม. ก่อนเวลาจอง')}) {t('คืน')} <b>{rv.cancelPreview.percent}% = ฿{money(rv.cancelPreview.amount)}</b>
          </div>
          <div className="grid grid-2">
            <Field label="ยอดที่คืน"><Input type="number" value={cancelForm.refundAmount} onChange={(e) => setCancelForm({ ...cancelForm, refundAmount: e.target.value })} /></Field>
            <Field label="ช่องทางคืนเงิน"><Select value={cancelForm.refundMethod} onChange={(e) => setCancelForm({ ...cancelForm, refundMethod: e.target.value })} options={[{ value: 'CASH', label: 'เงินสด' }, { value: 'TRANSFER', label: 'โอนเงิน' }, { value: 'QR', label: 'QR Code' }, { value: 'CARD', label: 'บัตร' }, { value: 'STORE_CREDIT', label: 'Store Credit' }, { value: 'OTHER', label: 'ช่องทางอื่น' }]} /></Field>
            <Field label="เหตุผล *" style={{ gridColumn: '1/-1' }}><Input value={cancelForm.reason} onChange={(e) => setCancelForm({ ...cancelForm, reason: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
    </Drawer>
  );
}

function SlipImage({ id }) {
  const [url, setUrl] = useState(null);
  const { t } = useT();
  const load = async () => {
    const res = await api.get(`/payment-verifications/${id}/slip`, { raw: true });
    if (res.ok) setUrl(URL.createObjectURL(await res.blob()));
  };
  return url ? <img src={url} alt="slip" style={{ maxWidth: 260, borderRadius: 8, marginTop: 8 }} /> : <Button size="sm" variant="ghost" icon={Eye} onClick={load}>{t('ดูสลิป')}</Button>;
}

export function ReservationTable({ rows, onOpen }) {
  const { t } = useT();
  if (!rows?.length) return <Empty />;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>{t('เลขที่การจอง')}</th><th>{t('วันที่')}</th><th>{t('เวลา')}</th><th>{t('ลูกค้า')}</th><th>{t('ห้อง')}</th><th className="right">{t('คน')}</th><th>{t('แพ็กเกจ')}</th><th className="right">{t('ยอดรวม')}</th><th className="right">{t('มัดจำ')}</th><th>Payment</th><th>{t('สถานะ')}</th><th>Source</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="clickable" onClick={() => onOpen(r.id)}>
              <td className="bold">{r.booking_no}</td>
              <td className="nowrap">{fmtDate(r.start_at)}</td>
              <td className="nowrap">{fmtTime(r.start_at)}–{fmtTime(r.end_at)}</td>
              <td>{r.customer_name}<div className="xs muted">{r.phone} {r.member_code && `· ${r.member_code}`} {r.line_connected && '· LINE'}</div></td>
              <td>{r.room_name}<div className="xs muted">{r.type_name}</div></td>
              <td className="right">{r.guest_count}</td>
              <td>{r.package_name || '-'}</td>
              <td className="right num">{money(r.estimated_total)}</td>
              <td className="right num">{money(r.deposit_paid)}</td>
              <td>{r.payment_status ? <Badge>{r.payment_status}</Badge> : '-'}{r.slip_result && <div className="xs muted">{t('สลิป')}: {r.slip_result}</div>}</td>
              <td><StatusBadge status={r.status} /></td>
              <td><Badge>{r.source}</Badge></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

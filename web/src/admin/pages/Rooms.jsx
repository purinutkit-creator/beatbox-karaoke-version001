import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  DoorOpen, Users, Clock, Plus, Pause, Play, ArrowRightLeft, ShoppingCart, CreditCard, XCircle, Sparkles, Wrench, Ban, CheckCircle2, Timer,
  Pencil, Send, Trash2, UserPlus, Wallet, LayoutGrid, History, CalendarClock, User, Minus,
} from 'lucide-react';
import { Button, Drawer, Modal, Field, Input, Select, Seg, Badge, Loading, Empty, PageHead, Tabs, money, useToast, useDialog, Switch, Textarea } from '../../components/ui.jsx';
import { MemberPicker } from '../../components/MemberPicker.jsx';
import { ProductCatalog } from '../../components/ProductCatalog.jsx';
import Checkout, { QrPayPanel } from '../../components/Checkout.jsx';
import { KitchenTicket } from '../../components/Receipt.jsx';
import { usePrint } from '../../components/PrintPreview.jsx';
import { useT } from '../../lib/i18n.jsx';
import { api, uid } from '../../lib/api.js';
import { useAuth } from '../../lib/store.jsx';
import { useLive, useServerNow, serverNow } from '../../lib/socket.js';
import { pushDisplay, orderToDisplay } from '../../lib/display.js';
import { ROOM_STATUS_LABEL, ROOM_STATUS_COLOR, RESERVATION_STATUS_LABEL } from '@beatbox/shared/constants.js';
import { sessionTiming, computeSessionCharges, formatMinutesShort, priceForMinutes } from '@beatbox/shared/roomPricing.js';
import { fmtTime, fmtCountdown, fmtDateTime, bkkDateStr } from '@beatbox/shared/format.js';

function RoomCard({ room, now, settings, onClick }) {
  const { t } = useT();
  const s = room.session;
  const timing = s ? sessionTiming(s, now) : null;
  const ch = s && settings ? computeSessionCharges(s, { partialRule: settings.room.partialRule, graceMinutes: settings.room.graceMinutes }, now) : null;
  const nearMs = Number(settings?.room?.nearEndMinutes || 10) * 60000;
  let status = room.status;
  if (s && ['ACTIVE', 'PAUSED'].includes(s.status)) status = timing.remainingMs <= 0 ? 'TIME_UP' : timing.remainingMs <= nearMs ? 'NEAR_END' : 'IN_USE';
  const color = ROOM_STATUS_COLOR[status];
  const total = timing ? timing.endMs - timing.startMs - Number(s.total_paused_seconds || 0) * 1000 : 1;
  const pct = timing ? Math.min(100, Math.max(0, (timing.usedMs / Math.max(1, total)) * 100)) : 0;
  const label = s?.status === 'CLOSED' ? 'รอชำระเงิน' : s?.status === 'PAUSED' ? 'หยุดเวลา' : ROOM_STATUS_LABEL[status];
  return (
    <div className={`room-card ${status === 'NEAR_END' ? 'near' : ''} ${status === 'TIME_UP' ? 'over' : ''}`} style={{ '--status': color }} onClick={onClick}>
      <div className="head">
        <div>
          <div className="name">{room.name}</div>
          <div className="xs" style={{ opacity: 0.9 }}>{room.type_name} · <Users size={11} /> {room.capacity}</div>
        </div>
        <span className="badge" style={{ background: 'rgba(255,255,255,0.22)', color: '#fff' }}>{t(label)}</span>
      </div>
      <div className="body">
        {s ? (
          <>
            <div className="row between nowrap">
              <span className="ellipsis bold">{s.customer_name || t('ลูกค้า Walk-in')}</span>
              <span className="small muted nowrap"><Users size={12} /> {s.guest_count}</span>
            </div>
            <div className="timer">{s.status === 'CLOSED' ? '--:--' : fmtCountdown(timing.remainingMs)}</div>
            <div className="progress"><div style={{ width: `${pct}%` }} /></div>
            <div className="line"><span>{t('เริ่ม')}</span><span>{fmtTime(s.started_at)}</span></div>
            <div className="line"><span>{t('สิ้นสุด')}</span><span>{fmtTime(timing.endMs)}</span></div>
            <div className="line"><span>{t('ยอดปัจจุบัน')}</span><b>฿{money((ch?.roomTotal || 0) + (room.live?.productTotal || 0))}</b></div>
            <div className="line"><span>{t('พนักงาน')}</span><span className="ellipsis">{s.opened_by_name}</span></div>
          </>
        ) : room.nextReservation ? (
          <>
            <div className="small muted">{t('การจองถัดไป')}</div>
            <div className="bold">{room.nextReservation.customer_name}</div>
            <div className="small">{fmtTime(room.nextReservation.start_at)} – {fmtTime(room.nextReservation.end_at)} · {room.nextReservation.booking_no}</div>
            <Badge color="#7c3aed">{t(RESERVATION_STATUS_LABEL[room.nextReservation.status])}</Badge>
          </>
        ) : (
          <div className="center muted" style={{ padding: '18px 0' }}>
            {status === 'AVAILABLE' ? <><DoorOpen size={30} /><div>{t('พร้อมใช้งาน')}</div></> : status === 'CLEANING' ? <><Sparkles size={30} /><div>{t('รอทำความสะอาด')}</div></> : <><Wrench size={30} /><div>{t(ROOM_STATUS_LABEL[status])}</div></>}
          </div>
        )}
      </div>
    </div>
  );
}

export default function Rooms() {
  const { t } = useT();
  const { settings } = useAuth();
  const now = useServerNow(1000);
  const { data, loading, reload } = useLive(() => api.get('/rooms/board', { passive: true }), ['rooms', 'orders', 'reservations'], [], { poll: 30000 });
  const [filter, setFilter] = useState('ALL');
  const [zone, setZone] = useState('');
  const [selected, setSelected] = useState(null);
  const [params, setParams] = useSearchParams();
  const rooms = data?.rooms || [];
  useEffect(() => {
    const sid = Number(params.get('session'));
    if (sid && rooms.length) {
      const r = rooms.find((x) => x.session?.id === sid);
      if (r) setSelected({ id: r.id, checkout: params.get('checkout') === '1' });
      setParams({}, { replace: true });
    }
  }, [params, rooms.length]);
  const zones = [...new Set(rooms.map((r) => r.zone).filter(Boolean))];
  const counts = useMemo(() => rooms.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {}), [rooms]);
  const shown = rooms.filter((r) => (filter === 'ALL' || r.status === filter || (filter === 'BUSY' && r.session)) && (!zone || r.zone === zone));
  const room = selected ? rooms.find((r) => r.id === selected.id) : null;
  return (
    <div>
      <PageHead icon={DoorOpen} title="ห้องทั้งหมด">
        {zones.length > 0 && <Select value={zone} onChange={(e) => setZone(e.target.value)} options={zones} placeholder="ทุกชั้น/โซน" style={{ width: 160 }} />}
      </PageHead>
      <div className="row mb" style={{ gap: 6 }}>
        <Button size="sm" variant={filter === 'ALL' ? 'primary' : ''} onClick={() => setFilter('ALL')}>{t('ทั้งหมด')} ({rooms.length})</Button>
        {Object.keys(ROOM_STATUS_LABEL).map((k) => counts[k] ? (
          <Button key={k} size="sm" variant={filter === k ? 'primary' : ''} onClick={() => setFilter(k)} style={filter === k ? undefined : { borderColor: ROOM_STATUS_COLOR[k] }}>
            <span style={{ color: ROOM_STATUS_COLOR[k] }}>●</span> {t(ROOM_STATUS_LABEL[k])} ({counts[k]})
          </Button>
        ) : null)}
      </div>
      {loading ? <Loading /> : !shown.length ? <Empty /> : (
        <div className="room-grid">
          {shown.map((r) => <RoomCard key={r.id} room={r} now={now} settings={settings} onClick={() => setSelected({ id: r.id })} />)}
        </div>
      )}
      {room && <RoomDrawer room={room} rooms={rooms} openCheckout={selected.checkout} onClose={() => setSelected(null)} reload={reload} />}
    </div>
  );
}

function RoomDrawer({ room, rooms, onClose, reload, openCheckout }) {
  const { t, tp } = useT();
  const toast = useToast();
  const { confirm, prompt } = useDialog();
  const { can, settings } = useAuth();
  const { printNow } = usePrint();
  const s = room.session;
  const now = useServerNow(1000);
  const [modal, setModal] = useState(openCheckout && s?.order_id ? 'checkout' : null);
  const [checkoutOrderId, setCheckoutOrderId] = useState(openCheckout ? s?.order_id : null);
  const openCheckoutFor = () => {
    setCheckoutOrderId(s.order_id);
    setModal('checkout');
  };
  const [detail, setDetail] = useState(null);
  const [tab, setTab] = useState('bill');
  const loadDetail = async () => {
    if (!s) return setDetail(null);
    try {
      setDetail(await api.get(`/sessions/${s.id}`));
    } catch (e) {
      toast.error(e);
    }
  };
  useEffect(() => {
    loadDetail();
  }, [s?.id, s?.version, room.live?.itemCount, room.live?.productTotal]);
  useEffect(() => {
    if (detail?.order) pushDisplay(orderToDisplay(detail.order));
  }, [detail]);
  const act = async (fn, msg) => {
    try {
      await fn();
      if (msg) toast.success(msg);
      reload();
      loadDetail();
    } catch (e) {
      toast.error(e);
    }
  };
  const timing = s ? sessionTiming(s, now) : null;
  const charges = s ? computeSessionCharges(s, { partialRule: settings.room.partialRule, graceMinutes: settings.room.graceMinutes }, now) : null;
  const productTotal = detail?.order?.calc?.lines?.filter((l) => l.type === 'PRODUCT').reduce((a, l) => a + l.net, 0) || 0;
  const deposit = detail?.order?.deposits?.reduce((a, d) => a + Number(d.amount) - Number(d.refunded_amount), 0) || 0;
  const total = (charges?.roomTotal || 0) + productTotal;
  const extend = (m) => act(() => api.post(`/sessions/${s.id}/extend`, { minutes: m }), `${t('เพิ่มเวลา')} ${formatMinutesShort(m)}`);
  const customExtend = async () => {
    const v = await prompt({ title: 'กำหนดเวลาเพิ่มเติมเอง', message: 'จำนวนนาที', type: 'number' });
    if (v) extend(Number(v));
  };
  const closeRoom = async () => {
    if (!(await confirm({ title: 'ปิดห้อง', message: `${t('ยืนยันปิดห้อง')} ${room.name}? ${t('ระบบจะหยุดเวลาและคำนวณค่าห้อง')}` }))) return;
    await act(() => api.post(`/sessions/${s.id}/close`));
    openCheckoutFor();
  };
  const cancelRoom = async () => {
    const reason = await prompt({ title: 'ยกเลิกห้อง', message: 'กรุณาระบุเหตุผลการยกเลิก', danger: true, options: ['เปิดห้องผิด', 'ลูกค้ายกเลิก', 'อื่นๆ'] });
    if (reason) act(() => api.post(`/sessions/${s.id}/cancel`, { reason }), 'ยกเลิกเรียบร้อย');
  };
  const setStatus = (status) => act(() => api.post(`/rooms/${room.id}/status`, { status }), 'บันทึกเรียบร้อย');
  const sendKitchen = async () => {
    try {
      const r = await api.post(`/orders/${s.order_id}/send-kitchen`);
      if (!r.tickets.length) return toast.info('ไม่มีรายการใหม่ที่ต้องส่ง');
      for (const tk of r.tickets) await printNow(<KitchenTicket ticket={tk} />, { jobType: 'KITCHEN', station: tk.station, reference: tk.orderNo });
      toast.success('ส่งรายการไปครัว/บาร์แล้ว');
      loadDetail();
    } catch (e) {
      toast.error(e);
    }
  };
  const items = detail?.order?.items?.filter((l) => l.type === 'PRODUCT' && !l.voided) || [];
  return (
    <Drawer
      title={<span className="row nowrap">{room.name} <Badge color={ROOM_STATUS_COLOR[room.status]}>{t(ROOM_STATUS_LABEL[room.status])}</Badge></span>}
      onClose={onClose}
    >
      {!s ? (
        <div className="col">
          <div className="card flat">
            <div className="row between"><span className="muted">{t('Type ห้อง')}</span><b>{room.type_name}</b></div>
            <div className="row between"><span className="muted">{t('จำนวนคนที่รองรับ')}</span><b>{room.capacity}</b></div>
            <div className="row between"><span className="muted">{t('ราคาต่อชั่วโมง')}</span><b>฿{money(room.price_hour)}</b></div>
            <div className="row between"><span className="muted">{t('ราคา 30 นาที')}</span><b>฿{money(room.price_half)}</b></div>
            {room.zone && <div className="row between"><span className="muted">{t('ชั้นหรือโซน')}</span><b>{room.zone}</b></div>}
          </div>
          {room.nextReservation && (
            <div className="card flat" style={{ borderColor: '#7c3aed' }}>
              <div className="bold"><CalendarClock size={16} /> {t('การจองที่กำลังจะมาถึง')}</div>
              <div>{room.nextReservation.booking_no} · {room.nextReservation.customer_name} ({room.nextReservation.phone})</div>
              <div className="small">{fmtDateTime(room.nextReservation.start_at)} – {fmtTime(room.nextReservation.end_at)} · {room.nextReservation.guest_count} {t('คน')} · {t('มัดจำ')} {money(room.nextReservation.deposit_paid)}</div>
              {can('room.operate') && room.status !== 'CLEANING' && <Button className="mt" variant="primary" icon={DoorOpen} onClick={() => act(() => api.post(`/reservations/${room.nextReservation.id}/open`, { clientOpId: uid() }), 'เปิดห้องจากการจองแล้ว')}>{t('เปิดห้องจากการจอง')}</Button>}
            </div>
          )}
          {can('room.operate') && (
            <>
              {room.status === 'CLEANING' ? (
                <Button size="xl" variant="success" icon={CheckCircle2} onClick={() => setStatus('AVAILABLE')}>{t('ห้องพร้อมใช้งาน')}</Button>
              ) : ['AVAILABLE', 'RESERVED', 'WAITING'].includes(room.status) ? (
                <Button size="xl" variant="primary" icon={DoorOpen} onClick={() => setModal('open')}>{t('เปิดห้อง')}</Button>
              ) : null}
              <div className="grid grid-3">
                {room.status !== 'CLEANING' && <Button icon={Sparkles} onClick={() => setStatus('CLEANING')}>{t('รอทำความสะอาด')}</Button>}
                {room.status !== 'MAINTENANCE' ? <Button icon={Wrench} onClick={() => setStatus('MAINTENANCE')}>{t('ปิดปรับปรุง')}</Button> : <Button icon={CheckCircle2} onClick={() => setStatus('AVAILABLE')}>{t('เปิดใช้งาน')}</Button>}
                {room.status !== 'DISABLED' && <Button icon={Ban} onClick={() => setStatus('DISABLED')}>{t('ปิดใช้งาน')}</Button>}
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="col">
          <div className="card flat center" style={{ borderColor: ROOM_STATUS_COLOR[room.status] }}>
            <div className="muted">{s.status === 'PAUSED' ? t('หยุดเวลาอยู่') : s.status === 'CLOSED' ? t('ปิดห้องแล้ว รอชำระเงิน') : t('เวลาที่เหลือ')}</div>
            <div className="big-money" style={{ color: timing.remainingMs <= 0 ? 'var(--danger)' : undefined }}>{s.status === 'CLOSED' ? '--:--' : fmtCountdown(timing.remainingMs)}</div>
            <div className="grid grid-3 small mt">
              <div><div className="muted">{t('เวลาเริ่มต้น')}</div><b>{fmtTime(s.started_at)}</b></div>
              <div><div className="muted">{t('เวลาสิ้นสุด')}</div><b>{fmtTime(timing.endMs)}</b></div>
              <div><div className="muted">{t('เวลาที่ใช้ไป')}</div><b>{formatMinutesShort(timing.usedMinutes)}</b></div>
            </div>
          </div>
          <div className="grid grid-2">
            <div className="card flat kpi"><div className="label">{t('ยอดค่าใช้ห้อง')}</div><div className="value">฿{money(charges.roomTotal)}</div></div>
            <div className="card flat kpi"><div className="label">{t('ยอดสินค้า')}</div><div className="value">฿{money(productTotal)}</div></div>
            <div className="card flat kpi"><div className="label">{t('ยอดรวมปัจจุบัน')}</div><div className="value">฿{money(total)}</div></div>
            <div className="card flat kpi"><div className="label">{t('เงินมัดจำ')} / {t('คงเหลือที่ต้องชำระ')}</div><div className="value small">{money(deposit)} / <span style={{ color: 'var(--primary)' }}>฿{money(Math.max(0, total - deposit))}</span></div></div>
          </div>
          <div className="row small muted">
            <User size={14} /> {s.customer_name || '-'} {s.phone && `· ${s.phone}`} {s.member_code && <Badge color="#eab308">{s.member_code}</Badge>} · <Users size={14} /> {s.guest_count}/{s.room_capacity} · {s.package_name || t('รายชั่วโมง')} · {t('เปิดโดย')} {s.opened_by_name}
          </div>
          {['ACTIVE', 'PAUSED', 'SCHEDULED', 'CLOSED'].includes(s.status) && (
            <div className="grid grid-3" style={{ gap: 8 }}>
              <Button size="lg" variant="warn" icon={Plus} onClick={() => extend(30)}>{t('เพิ่ม 30 นาที')}</Button>
              <Button size="lg" variant="warn" icon={Plus} onClick={() => extend(60)}>{t('เพิ่ม 1 ชั่วโมง')}</Button>
              <Button size="lg" icon={Timer} onClick={customExtend}>{t('กำหนดเวลาเอง')}</Button>
              {s.status === 'ACTIVE' && can('room.pause') && <Button icon={Pause} onClick={() => act(() => api.post(`/sessions/${s.id}/pause`), 'หยุดเวลาแล้ว')}>{t('หยุดเวลา')}</Button>}
              {s.status === 'PAUSED' && can('room.pause') && <Button icon={Play} variant="success" onClick={() => act(() => api.post(`/sessions/${s.id}/resume`), 'เริ่มเวลาต่อแล้ว')}>{t('เริ่มเวลาต่อ')}</Button>}
              {can('room.move') && s.status !== 'CLOSED' && <Button icon={ArrowRightLeft} onClick={() => setModal('move')}>{t('ย้ายห้อง')}</Button>}
              {can('room.move') && <Button icon={LayoutGrid} onClick={() => setModal('type')}>{t('เปลี่ยน Type ห้อง')}</Button>}
              <Button icon={ShoppingCart} onClick={() => setModal('products')}>{t('เพิ่มสินค้า')}</Button>
              <Button icon={Users} onClick={async () => { const v = await prompt({ title: 'จำนวนลูกค้า', type: 'number', defaultValue: String(s.guest_count) }); if (v) act(() => api.post(`/sessions/${s.id}/guests`, { guestCount: Number(v) })); }}>{t('จำนวนลูกค้า')}</Button>
              <Button icon={UserPlus} onClick={() => setModal('member')}>{t('ลูกค้า/สมาชิก')}</Button>
              <Button icon={Wallet} onClick={() => setModal('deposit')}>{t('รับมัดจำ')}</Button>
              {can('room.time_edit') && <Button icon={Pencil} onClick={() => setModal('adjust')}>{t('แก้ไขเวลา')}</Button>}
              {can('order.void') && <Button icon={XCircle} variant="danger" onClick={cancelRoom}>{t('ยกเลิกห้อง')}</Button>}
            </div>
          )}
          <div className="grid grid-2">
            {s.status !== 'CLOSED' && <Button size="xl" icon={DoorOpen} onClick={closeRoom}>{t('ปิดห้อง')}</Button>}
            <Button size="xl" variant="primary" icon={CreditCard} onClick={openCheckoutFor} style={s.status === 'CLOSED' ? { gridColumn: '1/-1' } : undefined}>{t('ชำระเงิน')}</Button>
          </div>
          <Tabs value={tab} onChange={setTab} tabs={[{ value: 'bill', label: 'รายละเอียดค่าห้อง' }, { value: 'items', label: 'รายการสินค้า', count: items.length }, { value: 'log', label: 'ประวัติเวลา' }]} />
          {tab === 'bill' && (
            <div className="card flat">
              {charges.lines.map((l, i) => (
                <div key={i} className="sum-line" style={{ alignItems: 'flex-start' }}>
                  <div><div>{tp(l.name)}</div><div className="xs muted">{tp(l.detail)}</div></div>
                  <b className="num">{money(l.qty * l.unitPrice)}</b>
                </div>
              ))}
              <div className="xs muted mt">{t('ราคาต่อชั่วโมง')} {money(s.price_hour)} · {t('30 นาที')} {money(s.price_half)} · {t('ค่าลูกค้าเกินจำนวน')} {money(s.extra_guest_fee)}/{t('คน')}</div>
            </div>
          )}
          {tab === 'items' && (
            <div className="col">
              <div className="row end"><Button size="sm" icon={Send} onClick={sendKitchen}>{t('ส่งครัว/บาร์')}</Button></div>
              {!items.length && <Empty text="ยังไม่มีสินค้า" />}
              {items.map((it) => (
                <div key={it.id} className="row between card flat" style={{ padding: 10 }}>
                  <div className="grow">
                    <b>{it.name}</b> {it.kitchenStatus === 'SENT' && <Badge color="#16a34a">{t('ส่งแล้ว')}</Badge>}
                    {it.note && <div className="xs muted">* {it.note}</div>}
                  </div>
                  <div className="qty">
                    <button onClick={() => (it.qty > 1 ? act(() => api.patch(`/orders/${s.order_id}/items/${it.id}`, { qty: it.qty - 1 })) : null)}><Minus size={14} /></button>
                    <b>{it.qty}</b>
                    <button onClick={() => act(() => api.patch(`/orders/${s.order_id}/items/${it.id}`, { qty: it.qty + 1 }))}><Plus size={14} /></button>
                  </div>
                  <b className="num" style={{ width: 80, textAlign: 'right' }}>{money(it.qty * it.unitPrice)}</b>
                  <Button size="sm" variant="ghost" icon={Trash2} onClick={async () => {
                    let reason = null;
                    if (it.kitchenStatus === 'SENT') reason = await prompt({ title: 'ยกเลิกรายการ', message: 'กรุณาระบุเหตุผล' });
                    else if (!(await confirm({ message: `${t('ลบ')} ${it.name}?`, danger: true }))) return;
                    if (it.kitchenStatus === 'SENT' && !reason) return;
                    act(() => api.del(`/orders/${s.order_id}/items/${it.id}`, { reason }));
                  }} />
                </div>
              ))}
            </div>
          )}
          {tab === 'log' && (
            <div className="col">
              {(detail?.adjustments || []).map((a) => (
                <div key={a.id} className="card flat small" style={{ padding: 10 }}>
                  <div className="row between"><b>{a.type}{a.minutes ? ` ${a.minutes} ${t('นาที')}` : ''}</b><span className="muted">{fmtDateTime(a.created_at)}</span></div>
                  <div className="muted">{a.employee_name} {a.reason && `· ${a.reason}`}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {modal === 'open' && <OpenRoomModal room={room} onClose={() => setModal(null)} onOpened={() => { setModal(null); reload(); }} />}
      {modal === 'checkout' && checkoutOrderId && <Checkout orderId={checkoutOrderId} onClose={() => { setModal(null); setCheckoutOrderId(null); reload(); }} onPaid={() => reload()} />}
      {modal === 'products' && (
        <Modal title={`${t('เพิ่มสินค้า')} · ${room.name}`} size="xwide" onClose={() => setModal(null)}>
          <ProductCatalog compact onAdd={(p, qty, options, note) => act(() => api.post(`/orders/${s.order_id}/items`, { productId: p.id, qty, options, note, clientOpId: uid() }, { queueable: true, queueLabel: p.name }), `${t('เพิ่ม')} ${p.name}`)} />
        </Modal>
      )}
      {modal === 'move' && (
        <Modal title={t('ย้ายห้อง')} onClose={() => setModal(null)}>
          <MoveRoom rooms={rooms} current={room} onMove={(toRoomId, reprice) => act(() => api.post(`/sessions/${s.id}/move`, { toRoomId, reprice }), 'ย้ายห้องเรียบร้อย').then(() => { setModal(null); onClose(); })} />
        </Modal>
      )}
      {modal === 'type' && <ChangeType session={s} onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); loadDetail(); }} />}
      {modal === 'member' && (
        <Modal title={t('ลูกค้า/สมาชิก')} onClose={() => setModal(null)}>
          <MemberPicker initialPhone={s.phone || ''} onPick={(m) => act(() => api.post(`/sessions/${s.id}/customer`, { memberId: m.id, customerName: `${m.first_name} ${m.last_name || ''}`.trim(), phone: m.phone }), 'บันทึกเรียบร้อย').then(() => setModal(null))} />
        </Modal>
      )}
      {modal === 'deposit' && <DepositModal session={s} onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); loadDetail(); }} />}
      {modal === 'adjust' && <AdjustTime session={s} onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); loadDetail(); }} />}
    </Drawer>
  );
}

function MoveRoom({ rooms, current, onMove }) {
  const { t } = useT();
  const [to, setTo] = useState(null);
  const [reprice, setReprice] = useState(true);
  const free = rooms.filter((r) => r.id !== current.id && !r.session && ['AVAILABLE', 'RESERVED'].includes(r.status));
  return (
    <div className="col">
      <div className="grid grid-3">
        {free.map((r) => (
          <Button key={r.id} variant={to === r.id ? 'primary' : ''} onClick={() => setTo(r.id)}>
            <div><div>{r.name}</div><div className="xs">{r.type_name} · {r.capacity} {t('คน')}</div></div>
          </Button>
        ))}
      </div>
      {!free.length && <Empty text="ไม่มีห้องว่าง" />}
      <Switch checked={reprice} onChange={setReprice} label="คิดราคาตามห้องใหม่" />
      <Button variant="primary" disabled={!to} onClick={() => onMove(to, reprice)}>{t('ยืนยันย้ายห้อง')}</Button>
    </div>
  );
}

function ChangeType({ session, onClose, onDone }) {
  const { t } = useT();
  const toast = useToast();
  const { data: types } = useLive(() => api.get('/room-types'), [], []);
  return (
    <Modal title={t('เปลี่ยน Type ห้อง')} onClose={onClose}>
      <div className="col">
        {(types || []).filter((x) => x.is_active).map((ty) => (
          <Button key={ty.id} variant={ty.id === session.room_type_id ? 'primary' : ''} onClick={async () => {
            try {
              await api.post(`/sessions/${session.id}/change-type`, { roomTypeId: ty.id });
              toast.success('บันทึกเรียบร้อย');
              onDone();
            } catch (e) {
              toast.error(e);
            }
          }}>
            {ty.name} · ฿{money(ty.price_hour, 0)}/{t('ชม.')}
          </Button>
        ))}
      </div>
    </Modal>
  );
}

function AdjustTime({ session, onClose, onDone }) {
  const { t } = useT();
  const toast = useToast();
  const toLocal = (d) => new Date(new Date(d).getTime() + 7 * 3600000).toISOString().slice(0, 16);
  const [start, setStart] = useState(toLocal(session.started_at));
  const [end, setEnd] = useState(toLocal(session.scheduled_end_at));
  const [reason, setReason] = useState('');
  const save = async () => {
    try {
      const body = { reason };
      if (start !== toLocal(session.started_at)) body.startedAt = new Date(`${start}:00+07:00`).toISOString();
      if (end !== toLocal(session.scheduled_end_at)) body.scheduledEndAt = new Date(`${end}:00+07:00`).toISOString();
      await api.post(`/sessions/${session.id}/adjust`, body);
      toast.success('แก้ไขเวลาเรียบร้อย');
      onDone();
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <Modal title={t('แก้ไขเวลาห้อง')} onClose={onClose} footer={<Button variant="primary" disabled={!reason} onClick={save}>{t('บันทึก')}</Button>}>
      <div className="grid grid-2">
        <Field label="เวลาเริ่ม (แก้แล้วเวลาสิ้นสุดเลื่อนตาม)"><Input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
        <Field label="เวลาสิ้นสุด"><Input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
      </div>
      <Field label="เหตุผล (บันทึกในประวัติ) *" style={{ marginTop: 12 }}><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    </Modal>
  );
}

export function DepositModal({ session, reservation, onClose, onDone }) {
  const { t } = useT();
  const toast = useToast();
  const [amount, setAmount] = useState(reservation ? Math.max(0, Number(reservation.deposit_required) - Number(reservation.deposit_paid)) || '' : '');
  const [method, setMethod] = useState('CASH');
  const [token, setToken] = useState(null);
  const [busy, setBusy] = useState(false);
  const key = useMemo(() => uid(), []);
  const save = async () => {
    setBusy(true);
    try {
      await api.post('/deposits', { reservationId: reservation?.id, sessionId: session?.id, amount: Number(amount), method, verificationToken: token }, { idempotencyKey: key });
      toast.success('รับเงินมัดจำเรียบร้อย');
      onDone();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const needsSlip = ['QR', 'TRANSFER'].includes(method);
  return (
    <Modal title={t('รับเงินมัดจำ')} onClose={onClose} footer={<Button variant="primary" loading={busy} disabled={!Number(amount) || (needsSlip && !token)} onClick={save}>{t('บันทึกรับมัดจำ')}</Button>}>
      <div className="grid grid-2">
        <Field label="จำนวนเงินมัดจำ"><Input className="lg" type="number" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="ช่องทางชำระ"><Select value={method} onChange={(e) => { setMethod(e.target.value); setToken(null); }} options={[{ value: 'CASH', label: 'เงินสด' }, { value: 'QR', label: 'QR Code' }, { value: 'TRANSFER', label: 'โอนเงิน' }, { value: 'CARD', label: 'บัตร' }, { value: 'OTHER', label: 'ช่องทางอื่น' }]} /></Field>
      </div>
      {needsSlip && Number(amount) > 0 && !token && <div className="mt"><QrPayPanel method={method} amount={Number(amount)} depositRef={reservation?.booking_no || `session-${session?.id}`} onVerified={(r) => setToken(r.verificationToken)} /></div>}
      {token && <div className="mt center"><Badge color="#16a34a">{t('ตรวจสอบเรียบร้อย')}</Badge></div>}
    </Modal>
  );
}

const TIME_OPTS = [30, 60, 90, 120, 150, 180, 240];

export function OpenRoomModal({ room: initialRoom, onClose, onOpened }) {
  const { t } = useT();
  const toast = useToast();
  const { settings, shift } = useAuth();
  const { data: board } = useLive(() => api.get('/rooms/board'), ['rooms'], []);
  const { data: packages } = useLive(() => api.get('/packages'), ['packages'], []);
  const [roomId, setRoomId] = useState(initialRoom?.id || '');
  const room = (board?.rooms || []).find((r) => r.id === Number(roomId)) || initialRoom;
  const [member, setMember] = useState(null);
  const [f, setF] = useState({ customerName: '', phone: '', guestCount: 2, packageId: '', minutes: 60, startMode: 'NOW', startAt: '', depositAmount: '', depositMethod: 'CASH', note: '' });
  const [items, setItems] = useState([]);
  const [token, setToken] = useState(null);
  const [step, setStep] = useState('info');
  const [busy, setBusy] = useState(false);
  const opKey = useMemo(() => uid(), []);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const pkg = (packages || []).find((p) => p.id === Number(f.packageId));
  const pkgMin = pkg ? pkg.hours * 60 + pkg.minutes : 0;
  const extra = room ? Math.max(0, Number(f.guestCount) - room.capacity) : 0;
  const timePrice = room ? priceForMinutes(Number(f.minutes) || 0, { priceHour: room.price_hour, priceHalf: room.price_half, partialRule: settings.room.partialRule }).amount : 0;
  const estimate = (pkg ? Number(pkg.price) : 0) + timePrice + extra * Number(settings.room.extraGuestFee) + items.reduce((s, i) => s + i.qty * Number(i.product.price), 0);
  const usablePkgs = (packages || []).filter((p) => p.is_active && (!p.room_type_ids?.length || p.room_type_ids.includes(room?.room_type_id)));
  const freeRooms = (board?.rooms || []).filter((r) => !r.session && ['AVAILABLE', 'RESERVED', 'WAITING'].includes(r.status));
  const submit = async () => {
    if (!room) return toast.error('กรุณาเลือกห้อง');
    if (!pkg && !Number(f.minutes)) return toast.error('กรุณาเลือกแพ็กเกจหรือจำนวนเวลา');
    if (Number(f.depositAmount) > 0 && !shift) return toast.error('กรุณาเปิดรอบการขายก่อนรับเงินมัดจำ');
    setBusy(true);
    try {
      await api.post('/sessions/open', {
        roomId: room.id,
        memberId: member?.id || null,
        customerName: f.customerName || (member ? `${member.first_name} ${member.last_name || ''}`.trim() : null),
        phone: f.phone || member?.phone || null,
        guestCount: Number(f.guestCount),
        packageId: pkg?.id || null,
        minutes: Number(f.minutes) || 0,
        startMode: f.startMode,
        startAt: f.startMode === 'SCHEDULED' && f.startAt ? new Date(`${f.startAt}:00+07:00`).toISOString() : null,
        deposit: Number(f.depositAmount) > 0 ? { amount: Number(f.depositAmount), method: f.depositMethod, verificationToken: token } : null,
        items: items.map((i) => ({ productId: i.product.id, qty: i.qty, note: i.note, options: i.options })),
        note: f.note,
        clientOpId: opKey,
      });
      toast.success(`${t('เปิดห้อง')} ${room.name} ${t('เรียบร้อย')}`);
      onOpened();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={`${t('เปิดห้อง')} ${room?.name || ''}`} size="xwide" onClose={onClose} closeOnBack={false}
      footer={
        <>
          <div className="grow bold" style={{ fontSize: '1.2rem' }}>{t('ยอดประมาณการ')} ฿{money(estimate)}</div>
          {step === 'products' ? <Button onClick={() => setStep('info')}>{t('ย้อนกลับ')}</Button> : <Button icon={ShoppingCart} onClick={() => setStep('products')}>{t('เพิ่มสินค้าเบื้องต้น')} ({items.length})</Button>}
          <Button variant="primary" size="lg" loading={busy} onClick={submit} icon={DoorOpen}>{t('ยืนยันเปิดห้อง')}</Button>
        </>
      }
    >
      {step === 'products' ? (
        <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1fr) 300px' }}>
          <ProductCatalog compact onAdd={(p, qty, options, note) => setItems((l) => [...l, { product: p, qty, options, note }])} />
          <div className="col">
            {items.map((i, k) => (
              <div key={k} className="row between card flat" style={{ padding: 8 }}>
                <span>{i.product.name} × {i.qty}</span>
                <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setItems(items.filter((_, j) => j !== k))} />
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="grid grid-2">
          <div className="col">
            <Field label="1. เลือกห้อง">
              <Select value={roomId} onChange={(e) => setRoomId(e.target.value)} options={freeRooms.map((r) => ({ value: r.id, label: `${r.name} · ${r.type_name} · ${r.capacity} ${t('คน')}` }))} placeholder="เลือกห้อง" />
            </Field>
            {room?.nextReservation && <div className="small" style={{ color: 'var(--warn)' }}>⚠ {t('มีการจอง')} {fmtTime(room.nextReservation.start_at)} ({room.nextReservation.customer_name}) — {t('ระบบจะตรวจสอบเวลาทับซ้อนอัตโนมัติ')}</div>}
            <Field label="2. เลือกลูกค้าหรือสมาชิก">
              {member ? (
                <div className="row between card flat" style={{ padding: 10 }}>
                  <span><b>{member.first_name}</b> · {member.phone} · {member.tier_name}</span>
                  <Button size="sm" variant="ghost" onClick={() => setMember(null)}>{t('เปลี่ยน')}</Button>
                </div>
              ) : <MemberPicker onPick={(m) => { setMember(m); set('customerName', `${m.first_name} ${m.last_name || ''}`.trim()); set('phone', m.phone); }} />}
            </Field>
            <div className="grid grid-2">
              <Field label="3. ชื่อลูกค้า"><Input value={f.customerName} onChange={(e) => set('customerName', e.target.value)} /></Field>
              <Field label="4. เบอร์โทรศัพท์"><Input value={f.phone} onChange={(e) => set('phone', e.target.value)} /></Field>
            </div>
            <Field label="5. จำนวนลูกค้า" hint={room ? `${t('ห้องรองรับ')} ${room.capacity} ${t('คน')}` : ''}>
              <div className="row nowrap">
                <Button icon={Minus} onClick={() => set('guestCount', Math.max(1, Number(f.guestCount) - 1))} />
                <Input className="lg center" type="number" value={f.guestCount} onChange={(e) => set('guestCount', e.target.value)} />
                <Button icon={Plus} onClick={() => set('guestCount', Number(f.guestCount) + 1)} />
              </div>
            </Field>
            {extra > 0 && <div className="card flat" style={{ borderColor: 'var(--warn)' }}>{t('ลูกค้าเกินจำนวน')} {extra} {t('คน')} × {money(settings.room.extraGuestFee, 0)} = <b>฿{money(extra * settings.room.extraGuestFee, 0)}</b></div>}
          </div>
          <div className="col">
            <Field label="6. เลือกแพ็กเกจหรือจำนวนเวลา">
              <div className="grid grid-2" style={{ gap: 6 }}>
                <Button variant={!f.packageId ? 'primary' : ''} onClick={() => set('packageId', '')}>{t('รายชั่วโมง')}</Button>
                {usablePkgs.map((p) => (
                  <Button key={p.id} variant={Number(f.packageId) === p.id ? 'primary' : ''} onClick={() => { set('packageId', p.id); set('minutes', 0); }}>
                    <div><div className="small">{p.name}</div><div className="xs">฿{money(p.price, 0)}</div></div>
                  </Button>
                ))}
              </div>
            </Field>
            <Field label={pkg ? `${t('เวลาเพิ่มจากแพ็กเกจ')} (${formatMinutesShort(pkgMin)})` : 'จำนวนเวลา'}>
              <div className="row" style={{ gap: 6 }}>
                {(pkg ? [0, 30, 60] : TIME_OPTS).map((m) => (
                  <Button key={m} size="sm" variant={Number(f.minutes) === m ? 'primary' : ''} onClick={() => set('minutes', m)}>{m ? formatMinutesShort(m) : t('ไม่เพิ่ม')}</Button>
                ))}
                <Input type="number" style={{ width: 110 }} value={f.minutes} onChange={(e) => set('minutes', e.target.value)} placeholder={t('นาที')} />
              </div>
              <div className="small muted">{t('ค่าห้อง')} ฿{money(timePrice)} {pkg && `+ ${t('แพ็กเกจ')} ฿${money(pkg.price)}`}</div>
            </Field>
            <Field label="7. เวลาเริ่ม">
              <Seg value={f.startMode} onChange={(v) => set('startMode', v)} options={[{ value: 'NOW', label: 'เริ่มทันที' }, { value: 'SCHEDULED', label: 'กำหนดเวลาเริ่ม' }]} />
              {f.startMode === 'SCHEDULED' && <Input type="datetime-local" value={f.startAt} onChange={(e) => set('startAt', e.target.value)} />}
            </Field>
            <Field label="8. รับเงินมัดจำ">
              <div className="row nowrap">
                <Input type="number" placeholder={room ? String(room.deposit) : '0'} value={f.depositAmount} onChange={(e) => { set('depositAmount', e.target.value); setToken(null); }} />
                <Select value={f.depositMethod} onChange={(e) => { set('depositMethod', e.target.value); setToken(null); }} options={[{ value: 'CASH', label: 'เงินสด' }, { value: 'QR', label: 'QR Code' }, { value: 'TRANSFER', label: 'โอนเงิน' }, { value: 'CARD', label: 'บัตร' }]} />
              </div>
            </Field>
            {['QR', 'TRANSFER'].includes(f.depositMethod) && Number(f.depositAmount) > 0 && !token && <QrPayPanel method={f.depositMethod} amount={Number(f.depositAmount)} depositRef={`open-${opKey}`} onVerified={(r) => setToken(r.verificationToken)} />}
            {token && <Badge color="#16a34a">{t('ตรวจสอบเรียบร้อย')}</Badge>}
            <Field label="หมายเหตุ"><Textarea style={{ minHeight: 42 }} value={f.note} onChange={(e) => set('note', e.target.value)} /></Field>
          </div>
        </div>
      )}
    </Modal>
  );
}

import { useMemo, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, CalendarPlus } from 'lucide-react';
import { PageHead, Button, Seg, Input, Loading, useToast, Badge } from '../../components/ui.jsx';
import { ReservationForm, ReservationDrawer, ReservationTable } from '../../components/ReservationParts.jsx';
import { useT } from '../../lib/i18n.jsx';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/store.jsx';
import { useLive, useServerNow } from '../../lib/socket.js';
import { RESERVATION_STATUS_COLOR } from '@beatbox/shared/constants.js';
import { bkkDateStr, bkkDateTime, fmtTime, fmtDate } from '@beatbox/shared/format.js';

const SLOT = 30;
const W = 46;
const ACTIVE = ['HOLD', 'PENDING', 'CONFIRMED', 'DEPOSIT_PAID', 'WAITING', 'ARRIVED', 'IN_USE'];

function addDays(dateStr, n) {
  return bkkDateStr(bkkDateTime(dateStr, '12:00').getTime() + n * 86400000);
}

export default function BookingCalendar() {
  const { t } = useT();
  const toast = useToast();
  const { settings } = useAuth();
  const now = useServerNow(30000);
  const [view, setView] = useState('day');
  const [date, setDate] = useState(bkkDateStr());
  const [open, setOpen] = useState(null);
  const [create, setCreate] = useState(null);
  const [dropCell, setDropCell] = useState(null);
  const openT = settings?.store?.openTime || '12:00';
  const closeT = settings?.store?.closeTime || '02:00';
  const dayStart = bkkDateTime(date, openT);
  let dayEnd = bkkDateTime(date, closeT);
  if (dayEnd <= dayStart) dayEnd = new Date(dayEnd.getTime() + 86400000);
  const slots = Math.round((dayEnd - dayStart) / (SLOT * 60000));

  const range = useMemo(() => {
    if (view === 'month') {
      const first = `${date.slice(0, 8)}01`;
      return { from: bkkDateTime(addDays(first, -7)), to: bkkDateTime(addDays(first, 42)) };
    }
    if (view === 'week') return { from: bkkDateTime(date), to: bkkDateTime(addDays(date, 8)) };
    if (view === 'list') return { from: bkkDateTime(date), to: bkkDateTime(addDays(date, 31)) };
    return { from: dayStart, to: dayEnd };
  }, [view, date]);
  const { data: rooms } = useLive(() => api.get('/rooms'), ['rooms'], []);
  const { data: board } = useLive(() => api.get('/rooms/board', { passive: true }), ['rooms'], []);
  const { data: resv, loading, reload } = useLive(() => api.get(`/reservations?from=${range.from.toISOString()}&to=${range.to.toISOString()}`), ['reservations'], [range.from.getTime(), range.to.getTime()]);
  const list = (resv || []).filter((r) => ACTIVE.includes(r.status) || ['COMPLETED', 'NO_SHOW'].includes(r.status));
  const sessions = (board?.rooms || []).filter((r) => r.session).map((r) => ({ roomId: r.id, start: new Date(r.session.started_at), end: new Date(Math.max(new Date(r.session.scheduled_end_at).getTime(), now)), name: r.session.customer_name, reservationId: r.session.reservation_id }));

  const move = async (rv, roomId, slotIdx) => {
    const start = new Date(dayStart.getTime() + slotIdx * SLOT * 60000);
    try {
      await api.put(`/reservations/${rv.id}`, { roomId, startAt: start.toISOString(), durationMinutes: rv.duration_minutes, version: rv.version });
      toast.success(`${t('ย้ายการจอง')} ${rv.booking_no} → ${fmtTime(start)}`);
      reload();
    } catch (e) {
      toast.error(e);
    }
  };

  const nav = (n) => setDate(view === 'month' ? addDays(`${date.slice(0, 8)}15`, n * 30) : addDays(date, n * (view === 'week' ? 7 : 1)));
  const sortedRooms = [...(rooms || [])].filter((r) => r.is_active).sort((a, b) => (view === 'type' ? a.room_type_id - b.room_type_id || a.sort_order - b.sort_order : a.sort_order - b.sort_order));

  const Timeline = () => {
    let lastType = null;
    return (
      <div className="timeline">
        <div className="tl-grid" style={{ gridTemplateColumns: `150px repeat(${slots}, ${W}px)` }}>
          <div className="tl-head tl-room" style={{ position: 'sticky', left: 0, zIndex: 4, background: 'var(--surface-2)' }}>{t('ห้อง')}</div>
          {Array.from({ length: slots }).map((_, i) => (
            <div key={i} className="tl-head" style={{ padding: '6px 2px', borderLeft: '1px dashed var(--border)' }}>
              {i % 2 === 0 ? fmtTime(dayStart.getTime() + i * SLOT * 60000) : ''}
            </div>
          ))}
          {sortedRooms.map((room) => {
            const typeHeader = view === 'type' && room.room_type_id !== lastType;
            lastType = room.room_type_id;
            const evs = list.filter((r) => r.room_id === room.id && new Date(r.end_at) > dayStart && new Date(r.start_at) < dayEnd);
            const ses = sessions.filter((s) => s.roomId === room.id && s.end > dayStart && s.start < dayEnd && !evs.some((e) => e.id === s.reservationId));
            const pos = (s, e) => ({ left: 150 + (Math.max(0, s - dayStart) / (SLOT * 60000)) * W + 2, width: Math.max(W - 4, ((Math.min(e, dayEnd) - Math.max(s, dayStart)) / (SLOT * 60000)) * W - 4) });
            return [
              typeHeader && (
                <div key={`h${room.id}`} style={{ gridColumn: `1 / span ${slots + 1}`, padding: '6px 10px', background: 'var(--surface-3)', fontWeight: 800 }}>
                  <Badge color={room.type_color}>{room.type_name}</Badge>
                </div>
              ),
              <div key={room.id} style={{ display: 'contents' }}>
                <div className="tl-room" style={{ height: 58 }}>
                  {room.name}
                  <span className="xs muted">{room.type_name} · {room.capacity}</span>
                </div>
                {Array.from({ length: slots }).map((_, i) => (
                  <div
                    key={i}
                    className={`tl-cell ${dropCell === `${room.id}:${i}` ? 'drop' : ''}`}
                    style={{ height: 58 }}
                    onClick={() => setCreate({ roomId: room.id, startAt: new Date(dayStart.getTime() + i * SLOT * 60000 + 7 * 3600000).toISOString().slice(0, 16) })}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDropCell(`${room.id}:${i}`);
                    }}
                    onDragLeave={() => setDropCell(null)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDropCell(null);
                      const rv = list.find((x) => x.id === Number(e.dataTransfer.getData('text/plain')));
                      if (rv) move(rv, room.id, i);
                    }}
                  />
                ))}
                <div style={{ position: 'relative', gridColumn: '1 / -1', height: 0 }}>
                  {evs.map((r) => {
                    const p = pos(new Date(r.start_at), new Date(r.end_at));
                    return (
                      <div
                        key={r.id}
                        className="tl-event"
                        draggable={['PENDING', 'CONFIRMED', 'DEPOSIT_PAID', 'WAITING', 'HOLD'].includes(r.status)}
                        onDragStart={(e) => e.dataTransfer.setData('text/plain', String(r.id))}
                        onClick={() => setOpen(r.id)}
                        style={{ ...p, top: -54, height: 50, background: RESERVATION_STATUS_COLOR[r.status] || '#dc2626' }}
                        title={`${r.booking_no} ${r.customer_name}`}
                      >
                        <b>{r.customer_name}</b>
                        <div>{fmtTime(r.start_at)}–{fmtTime(r.end_at)} · {r.guest_count}{t('คน')}</div>
                      </div>
                    );
                  })}
                  {ses.map((s, i) => {
                    const p = pos(s.start, s.end);
                    return (
                      <div key={`s${i}`} className="tl-event busy" style={{ ...p, top: -54, height: 50 }}>
                        <b>{t('กำลังใช้งาน')}</b>
                        <div>{s.name || ''}</div>
                      </div>
                    );
                  })}
                </div>
              </div>,
            ];
          })}
        </div>
        {now > dayStart && now < dayEnd && <div className="tl-now" style={{ left: 150 + ((now - dayStart) / (SLOT * 60000)) * W }} />}
      </div>
    );
  };

  const WeekView = () => (
    <div className="grid" style={{ gridTemplateColumns: 'repeat(7, minmax(150px, 1fr))', overflowX: 'auto' }}>
      {Array.from({ length: 7 }).map((_, i) => {
        const d = addDays(date, i);
        const s = bkkDateTime(d, openT);
        const e = new Date(s.getTime() + (dayEnd - dayStart));
        const items = list.filter((r) => new Date(r.start_at) >= s && new Date(r.start_at) < e);
        return (
          <div key={d} className="card" style={{ padding: 10 }}>
            <div className="bold" style={{ cursor: 'pointer' }} onClick={() => { setDate(d); setView('day'); }}>{fmtDate(s, { weekday: 'short' })}</div>
            <div className="xs muted mb">{items.length} {t('การจอง')}</div>
            {items.map((r) => (
              <div key={r.id} className="small" style={{ borderLeft: `4px solid ${RESERVATION_STATUS_COLOR[r.status]}`, padding: '4px 8px', marginBottom: 6, background: 'var(--surface-2)', borderRadius: 6, cursor: 'pointer' }} onClick={() => setOpen(r.id)}>
                <b>{fmtTime(r.start_at)}</b> {r.room_name}
                <div className="xs ellipsis">{r.customer_name}</div>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );

  const MonthView = () => {
    const first = bkkDateTime(`${date.slice(0, 8)}01`, '12:00');
    const startOffset = new Date(first.getTime() + 7 * 3600000).getUTCDay();
    const gridStart = addDays(`${date.slice(0, 8)}01`, -startOffset);
    const today = bkkDateStr();
    return (
      <div>
        <div className="cal-month mb">{['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'].map((d) => <div key={d} className="center muted small">{t(d)}</div>)}</div>
        <div className="cal-month">
          {Array.from({ length: 42 }).map((_, i) => {
            const d = addDays(gridStart, i);
            const s = bkkDateTime(d, openT);
            const e = new Date(s.getTime() + (dayEnd - dayStart));
            const items = list.filter((r) => new Date(r.start_at) >= s && new Date(r.start_at) < e);
            return (
              <div key={d} className={`cal-day ${d === today ? 'today' : ''} ${d.slice(5, 7) !== date.slice(5, 7) ? 'dim' : ''}`} onClick={() => { setDate(d); setView('day'); }}>
                <div className="bold">{Number(d.slice(8))}</div>
                {items.slice(0, 3).map((r) => <div key={r.id} className="ellipsis" style={{ color: RESERVATION_STATUS_COLOR[r.status] }}>● {fmtTime(r.start_at)} {r.room_name}</div>)}
                {items.length > 3 && <div className="muted">+{items.length - 3}</div>}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div>
      <PageHead icon={CalendarDays} title="ตารางการจอง">
        <Button variant="primary" icon={CalendarPlus} onClick={() => setCreate({})}>{t('สร้างการจอง')}</Button>
      </PageHead>
      <div className="row mb">
        <Seg value={view} onChange={setView} options={[{ value: 'day', label: 'รายวัน / Timeline ตามห้อง' }, { value: 'type', label: 'Timeline ตาม Type ห้อง' }, { value: 'week', label: 'รายสัปดาห์' }, { value: 'month', label: 'รายเดือน' }, { value: 'list', label: 'รายการทั้งหมด' }]} />
        <div className="row nowrap">
          <Button icon={ChevronLeft} onClick={() => nav(-1)} />
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: 160 }} />
          <Button icon={ChevronRight} onClick={() => nav(1)} />
          <Button onClick={() => setDate(bkkDateStr())}>{t('วันนี้')}</Button>
        </div>
        <span className="small muted"><span style={{ color: '#22c55e' }}>■</span> {t('ว่าง')} <span style={{ color: '#dc2626' }}>■</span> {t('ถูกจอง/ใช้งาน')} · {t('ลากการจองเพื่อเปลี่ยนเวลา/ห้อง')}</span>
      </div>
      {loading ? <Loading /> : view === 'day' || view === 'type' ? <Timeline /> : view === 'week' ? <WeekView /> : view === 'month' ? <MonthView /> : <ReservationTable rows={resv} onOpen={setOpen} />}
      {open && <ReservationDrawer id={open} onClose={() => setOpen(null)} onChanged={reload} />}
      {create && <ReservationForm initial={create} onClose={() => setCreate(null)} onSaved={() => { setCreate(null); reload(); }} />}
    </div>
  );
}

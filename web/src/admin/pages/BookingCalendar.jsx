import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, CalendarPlus, LocateFixed } from 'lucide-react';
import { PageHead, Button, Seg, Input, Loading, useToast, Badge } from '../../components/ui.jsx';
import { ReservationForm, ReservationDrawer, ReservationTable } from '../../components/ReservationParts.jsx';
import { useT } from '../../lib/i18n.jsx';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/store.jsx';
import { useLive, useServerNow } from '../../lib/socket.js';
import { RESERVATION_STATUS_COLOR } from '@beatbox/shared/constants.js';
import { bkkDateStr, bkkDateTime, fmtTime, fmtDate } from '@beatbox/shared/format.js';
import { zonedNow } from '@beatbox/shared/time.js';
import { LS } from '../../lib/api.js';

const SLOT = 30;
const ACTIVE = ['HOLD', 'PENDING', 'CONFIRMED', 'DEPOSIT_PAID', 'WAITING', 'ARRIVED', 'IN_USE'];

function addDays(dateStr, n) {
  return bkkDateStr(bkkDateTime(dateStr, '12:00').getTime() + n * 86400000);
}

export default function BookingCalendar() {
  const { t } = useT();
  const toast = useToast();
  const { settings } = useAuth();
  const now = useServerNow(15000);
  const tz = settings?.store?.timezone || 'Asia/Bangkok';
  const openTime = settings?.store?.openTime || '12:00';
  const closeTime = settings?.store?.closeTime || '02:00';
  // the business day that contains "now" (a night that runs past midnight still belongs to the evening's date)
  const businessDate = (ms) => {
    const d = bkkDateStr(ms);
    return closeTime < openTime && ms < bkkDateTime(d, closeTime).getTime() ? addDays(d, -1) : d;
  };
  const [view, setView] = useState('day');
  const [date, setDate] = useState(() => businessDate(Date.now()));
  // display only — the bookings are the same; each device remembers its own choice
  const [orientation, setOrientationState] = useState(() => LS.get('bb_cal_orientation') || settings?.calendar?.orientation || 'TIME_X');
  const setOrientation = (o) => {
    LS.set('bb_cal_orientation', o);
    setOrientationState(o);
    scrollRef.current?.scrollTo({ left: 0, top: 0 });
  };
  const nowCfg = { enabled: true, color: '#ef4444', glow: true, speed: 2, ...(settings?.calendar?.nowLine || {}) };
  const scrollRef = useRef(null);
  const [jump, setJump] = useState(0);
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

  useEffect(() => {
    if (!jump) return;
    const id = setTimeout(() => {
      const el = scrollRef.current;
      const line = el?.querySelector('.now-line');
      if (!el || !line) return;
      if (orientation === 'TIME_X') el.scrollTo({ left: Math.max(0, line.offsetLeft - el.clientWidth / 3), behavior: 'smooth' });
      else el.scrollTo({ top: Math.max(0, line.offsetTop - el.clientHeight / 3), behavior: 'smooth' });
    }, 150);
    return () => clearTimeout(id);
  }, [jump, date, orientation]);
  const nav = (n) => setDate(view === 'month' ? addDays(`${date.slice(0, 8)}15`, n * 30) : addDays(date, n * (view === 'week' ? 7 : 1)));
  const sortedRooms = [...(rooms || [])].filter((r) => r.is_active).sort((a, b) => (view === 'type' ? a.room_type_id - b.room_type_id || a.sort_order - b.sort_order : a.sort_order - b.sort_order));

  const tl = { rooms: sortedRooms, slots, dayStart, dayEnd, list, sessions, dropCell, setDropCell, move, setOpen, setCreate, grouped: view === 'type' };
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
          <Button onClick={() => setDate(businessDate(now))}>{t('วันนี้')}</Button>
        </div>
        {(view === 'day' || view === 'type') && (
          <>
            <Seg value={orientation} onChange={setOrientation} options={[{ value: 'TIME_X', label: '⟷ เวลาแนวนอน' }, { value: 'TIME_Y', label: '↕ เวลาแนวตั้ง' }]} />
            <Button icon={LocateFixed} onClick={() => { if (date !== businessDate(now)) setDate(businessDate(now)); setJump((j) => j + 1); }}>{t('ไปยังเวลาปัจจุบัน')}</Button>
          </>
        )}
        <span className="small muted"><span style={{ color: '#22c55e' }}>■</span> {t('ว่าง')} <span style={{ color: '#dc2626' }}>■</span> {t('ถูกจอง/ใช้งาน')} · {t('ลากการจองเพื่อเปลี่ยนเวลา/ห้อง')}</span>
      </div>
      {loading ? <Loading /> : view === 'day' || view === 'type' ? <TimelineGrid {...tl} orientation={orientation} now={now} nowCfg={nowCfg} tz={tz} scrollRef={scrollRef} /> : view === 'week' ? <WeekView /> : view === 'month' ? <MonthView /> : <ReservationTable rows={resv} onOpen={setOpen} />}
      {open && <ReservationDrawer id={open} onClose={() => setOpen(null)} onChanged={reload} />}
      {create && <ReservationForm initial={create} onClose={() => setCreate(null)} onSaved={() => { setCreate(null); reload(); }} />}
    </div>
  );
}

/**
 * Day timeline in two orientations (display only):
 *  TIME_X — time runs horizontally, rooms are rows; TIME_Y — time runs vertically, rooms are columns.
 * Sticky headers both ways, click a free slot to book, click a booking to open it, drag to move it.
 */
function TimelineGrid({ rooms, slots, dayStart, dayEnd, list, sessions, dropCell, setDropCell, move, setOpen, setCreate, grouped, orientation, now, nowCfg, tz, scrollRef }) {
  const { t } = useT();
  const horiz = orientation !== 'TIME_Y';
  const narrow = typeof window !== 'undefined' && window.innerWidth < 720;
  const LABEL = horiz ? (narrow ? 104 : 150) : narrow ? 54 : 64; // room label column (TIME_X) / time label column (TIME_Y)
  const HEAD = horiz ? 34 : 54;
  const W = narrow ? 40 : 46; // slot width (TIME_X)
  const RH = 58; // room row height (TIME_X)
  const CW = narrow ? 112 : 140; // room column width (TIME_Y)
  const SH = 34; // slot height (TIME_Y)
  const slotMs = SLOT * 60000;
  const areaW = horiz ? slots * W : rooms.length * CW;
  const areaH = horiz ? rooms.length * RH : slots * SH;
  const at = (ms) => ((ms - dayStart.getTime()) / slotMs) * (horiz ? W : SH);
  const box = (roomIdx, s, e) => {
    const a = at(Math.max(s, dayStart.getTime()));
    const b = at(Math.min(e, dayEnd.getTime()));
    const len = Math.max((horiz ? W : SH) - 4, b - a - 4);
    return horiz ? { left: a + 2, width: len, top: roomIdx * RH + 4, height: RH - 8 } : { top: a + 2, height: len, left: roomIdx * CW + 4, width: CW - 8 };
  };
  const timeLabel = (i) => fmtTime(dayStart.getTime() + i * slotMs);
  const showNow = nowCfg.enabled !== false && now >= dayStart.getTime() && now <= dayEnd.getTime();
  const nowPos = at(now);
  const nowStyle = { '--now-color': nowCfg.color || '#ef4444', '--now-speed': `${Number(nowCfg.speed) || 2}s` };
  const nowText = `${t('เวลาปัจจุบัน')} ${zonedNow(now, tz).hhmm}`;
  const typeStart = (i) => grouped && (i === 0 || rooms[i - 1].room_type_id !== rooms[i].room_type_id);
  const roomLabel = (room, i) => (
    <div className={`tlx-roomlabel ${typeStart(i) ? 'type-start' : ''}`}>
      {typeStart(i) && <span className="tlx-type" style={{ background: room.type_color || 'var(--primary)' }}>{room.type_name}</span>}
      <b className="ellipsis">{room.name}</b>
      <span className="xs muted ellipsis">{t('ห้อง')} {room.number} · {room.type_name} · {room.capacity} {t('คน')}</span>
    </div>
  );
  const cells = [];
  for (let r = 0; r < rooms.length; r++) {
    for (let i = 0; i < slots; i++) {
      const room = rooms[r];
      const key = `${room.id}:${i}`;
      cells.push(
        <div
          key={key}
          className={`tl-cell ${dropCell === key ? 'drop' : ''} ${i % 2 === 0 ? 'hour' : ''}`}
          style={horiz ? { left: i * W, top: r * RH, width: W, height: RH } : { left: r * CW, top: i * SH, width: CW, height: SH }}
          onClick={() => setCreate({ roomId: room.id, startAt: new Date(dayStart.getTime() + i * slotMs + 7 * 3600000).toISOString().slice(0, 16) })}
          title={`${room.name} · ${timeLabel(i)}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDropCell(key);
          }}
          onDragLeave={() => setDropCell(null)}
          onDrop={(e) => {
            e.preventDefault();
            setDropCell(null);
            const rv = list.find((x) => x.id === Number(e.dataTransfer.getData('text/plain')));
            if (rv) move(rv, room.id, i);
          }}
        />,
      );
    }
  }
  const events = [];
  rooms.forEach((room, r) => {
    const evs = list.filter((x) => x.room_id === room.id && new Date(x.end_at) > dayStart && new Date(x.start_at) < dayEnd);
    for (const x of evs) {
      events.push(
        <div
          key={`r${x.id}`}
          className="tl-event"
          draggable={['PENDING', 'CONFIRMED', 'DEPOSIT_PAID', 'WAITING', 'HOLD'].includes(x.status)}
          onDragStart={(e) => e.dataTransfer.setData('text/plain', String(x.id))}
          onClick={() => setOpen(x.id)}
          style={{ ...box(r, new Date(x.start_at).getTime(), new Date(x.end_at).getTime()), background: RESERVATION_STATUS_COLOR[x.status] || '#dc2626' }}
          title={`${x.booking_no} ${x.customer_name} · ${room.name}`}
        >
          <b className="ellipsis">{x.customer_name}</b>
          <div className="ellipsis">{fmtTime(x.start_at)}–{fmtTime(x.end_at)} · {x.guest_count}{t('คน')}</div>
        </div>,
      );
    }
    sessions
      .filter((s) => s.roomId === room.id && s.end > dayStart && s.start < dayEnd && !evs.some((e) => e.id === s.reservationId))
      .forEach((s, k) => {
        events.push(
          <div key={`s${room.id}-${k}`} className="tl-event busy" style={box(r, s.start.getTime(), s.end.getTime())} title={room.name}>
            <b className="ellipsis">{t('กำลังใช้งาน')}</b>
            <div className="ellipsis">{s.name || ''}</div>
          </div>,
        );
      });
  });
  return (
    <div className={`tlx ${horiz ? 'tlx-h' : 'tlx-v'}`} ref={scrollRef} style={nowStyle}>
      <div className="tlx-inner" style={{ width: LABEL + areaW, minHeight: HEAD + areaH }}>
        {/* sticky top header: times (TIME_X) or rooms (TIME_Y) */}
        <div className="tlx-top" style={{ height: HEAD, width: LABEL + areaW }}>
          <div className="tlx-corner" style={{ width: LABEL }}>{horiz ? t('ห้อง') : t('เวลา')}</div>
          <div className="tlx-heads" style={{ width: areaW }}>
            {horiz
              ? Array.from({ length: slots }).map((_, i) => <div key={i} className="tlx-head" style={{ left: i * W, width: W }}>{i % 2 === 0 ? timeLabel(i) : ''}</div>)
              : rooms.map((room, i) => <div key={room.id} className="tlx-head" style={{ left: i * CW, width: CW }}>{roomLabel(room, i)}</div>)}
            {showNow && horiz && <div className="now-label" style={{ left: nowPos }}>{nowText}</div>}
          </div>
        </div>
        <div className="tlx-body">
          {/* sticky side: rooms (TIME_X) or times (TIME_Y) */}
          <div className="tlx-side" style={{ width: LABEL, height: areaH }}>
            {horiz
              ? rooms.map((room, i) => <div key={room.id} className="tlx-sidecell" style={{ top: i * RH, height: RH }}>{roomLabel(room, i)}</div>)
              : Array.from({ length: slots }).map((_, i) => <div key={i} className="tlx-sidecell time" style={{ top: i * SH, height: SH }}>{i % 2 === 0 ? timeLabel(i) : ''}</div>)}
            {showNow && !horiz && <div className="now-label side" style={{ top: nowPos }}>{nowText}</div>}
          </div>
          <div className="tlx-area" style={{ width: areaW, height: areaH }}>
            {cells}
            {events}
            {showNow && <div className={`now-line ${horiz ? 'v' : 'h'} ${nowCfg.glow !== false ? 'glow' : ''}`} style={horiz ? { left: nowPos } : { top: nowPos }} aria-label={nowText} />}
          </div>
        </div>
      </div>
    </div>
  );
}

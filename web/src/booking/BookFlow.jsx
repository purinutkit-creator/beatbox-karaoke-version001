import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { Search, Users, Clock, CalendarDays, Lock, Upload, CheckCircle2, AlertTriangle, ChevronLeft, Ticket, BadgePercent, Timer } from 'lucide-react';
import { useT } from '../lib/i18n.jsx';
import { useApp } from '../lib/store.jsx';
import { api, LS } from '../lib/api.js';
import { getSocket, serverNow, useServerNow } from '../lib/socket.js';
import { Button, Field, Input, Select, Textarea, Badge, Loading, Empty, QRCode, Spinner, Switch, money, useToast } from '../components/ui.jsx';
import { useMember } from './BookingApp.jsx';
import { useCatalog } from './Pages.jsx';
import { bkkDateStr, fmtDate, fmtTime, fmtCountdown } from '@beatbox/shared/format.js';
import { formatMinutesShort } from '@beatbox/shared/roomPricing.js';

const STEPS = ['เลือกวันเวลา', 'เลือกห้อง', 'ข้อมูลลูกค้า', 'ชำระมัดจำ', 'ยืนยันการจอง'];

function Steps({ step }) {
  const { t } = useT();
  return (
    <div className="steps">
      {STEPS.map((s, i) => (
        <div key={s} className={`s ${i <= step ? 'on' : ''}`}>
          <div className="bar" />
          {t(s)}
        </div>
      ))}
    </div>
  );
}

function HoldTimer({ expiresAt, onExpire }) {
  const { t } = useT();
  const now = useServerNow(1000);
  const left = new Date(expiresAt).getTime() - now;
  useEffect(() => {
    if (left <= 0) onExpire?.();
  }, [left <= 0]);
  if (!expiresAt) return null;
  return (
    <div className="hold-timer">
      <Lock size={18} />
      {left > 0 ? (
        <span>{t('ห้องนี้ถูกล็อกไว้สำหรับคุณอีก')} <b className="num">{fmtCountdown(left)}</b> {t('นาที กรุณาชำระเงินมัดจำเพื่อยืนยันการจอง')}</span>
      ) : (
        <span>{t('หมดเวลาล็อกห้อง ห้องถูกปล่อยให้ลูกค้าท่านอื่นแล้ว')}</span>
      )}
    </div>
  );
}

export default function BookFlow() {
  const { t } = useT();
  const toast = useToast();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const { publicSettings } = useApp();
  const { me } = useMember();
  const cat = useCatalog();
  const b = publicSettings?.booking || {};
  const durations = b.durations?.length ? b.durations : [60, 90, 120, 180];
  const [step, setStep] = useState(0);
  const [q, setQ] = useState({ branchId: '', date: bkkDateStr(), time: '20:00', durationMinutes: 120, guests: 4, roomTypeId: params.get('type') || '' });
  const [result, setResult] = useState(null);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState(null); // { room, packageId }
  const [hold, setHold] = useState(() => {
    try {
      return JSON.parse(sessionStorage.getItem('bb_hold') || 'null');
    } catch {
      return null;
    }
  });
  const [info, setInfo] = useState({ customerName: '', phone: '', email: '', note: '', promotionId: '', promoCode: '', acceptPolicy: false });
  const [payment, setPayment] = useState(null);
  const [verify, setVerify] = useState(null); // { status, error }
  const [busy, setBusy] = useState(false);
  const fileRef = useRef();
  const setQ2 = (k, v) => setQ((x) => ({ ...x, [k]: v }));

  useEffect(() => {
    if (me) setInfo((i) => ({ ...i, customerName: i.customerName || `${me.first_name} ${me.last_name || ''}`.trim(), phone: i.phone || me.phone, email: i.email || me.email || '' }));
  }, [me]);
  useEffect(() => {
    if (hold) sessionStorage.setItem('bb_hold', JSON.stringify(hold));
    else sessionStorage.removeItem('bb_hold');
  }, [hold]);
  // resume an existing hold after refresh
  useEffect(() => {
    if (!hold?.holdToken) return;
    api.get(`/public/holds/${hold.holdToken}`, { auth: false }).then((h) => {
      if (h.status === 'HOLD') {
        setStep(h.payment ? 3 : 2);
        if (h.payment) setPayment({ ...h.payment, qrData: h.payment.qr_data, qrImageUrl: h.payment.qr_image_url, expiresAt: h.payment.expires_at });
        setHold((x) => ({ ...x, expiresAt: h.holdExpiresAt, booking: h }));
      } else if (['DEPOSIT_PAID', 'CONFIRMED', 'PENDING'].includes(h.status)) nav(`/book/booking/${hold.holdToken}`);
      else setHold(null);
    }).catch(() => setHold(null));
  }, []);

  const search = async (silent = false) => {
    if (!silent) setSearching(true);
    try {
      const qs = new URLSearchParams({ date: q.date, time: q.time, durationMinutes: q.durationMinutes, guests: q.guests, ...(q.branchId ? { branchId: q.branchId } : {}), ...(q.roomTypeId ? { roomTypeId: q.roomTypeId } : {}) });
      const r = await api.get(`/public/availability?${qs}`, { auth: false });
      setResult(r);
      if (!silent) setStep(1);
    } catch (e) {
      if (!silent) toast.error(e);
    } finally {
      setSearching(false);
    }
  };
  // real-time: refresh availability when anything changes in the store
  useEffect(() => {
    const s = getSocket();
    if (!s || step !== 1) return;
    const h = () => search(true);
    s.on('availability:changed', h);
    return () => s.off('availability:changed', h);
  }, [step, q]);

  const choose = async (room, packageId) => {
    setBusy(true);
    try {
      const h = await api.post('/public/holds', { roomId: room.id, startAt: result.startAt, durationMinutes: Number(q.durationMinutes), guestCount: Number(q.guests), packageId: packageId || null }, { member: true });
      setHold({ ...h, room });
      setSelected({ room, packageId });
      setStep(2);
      window.scrollTo(0, 0);
    } catch (e) {
      toast.error(e);
      if (e.data?.suggestions || e.code === 'ROOM_TAKEN') search(true);
    } finally {
      setBusy(false);
    }
  };

  const release = async () => {
    if (hold?.holdToken) await api.del(`/public/holds/${hold.holdToken}`, undefined, { auth: false }).catch(() => {});
    setHold(null);
    setPayment(null);
    setStep(1);
    search(true);
  };

  const submitDetails = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/public/holds/${hold.holdToken}/details`, { ...info, promotionId: info.promotionId ? Number(info.promotionId) : null, promoCode: info.promoCode || null }, { member: true });
      setHold((h) => ({ ...h, booking: r.booking }));
      if (!r.requiresPayment) {
        nav(`/book/booking/${hold.holdToken}`);
        return;
      }
      setPayment(r.payment);
      setStep(3);
      window.scrollTo(0, 0);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const uploadSlip = async (file) => {
    if (!file) return;
    if (!/image\/(jpe?g|png)/.test(file.type)) return toast.error('รองรับเฉพาะไฟล์ JPG, JPEG, PNG');
    setVerify({ status: 'VERIFYING' });
    const fd = new FormData();
    fd.append('slip', file);
    try {
      const r = await api.post(`/public/holds/${hold.holdToken}/slip`, fd, { auth: false });
      if (r.status === 'PAID') {
        setVerify({ status: 'PAID' });
        setTimeout(() => nav(`/book/booking/${hold.holdToken}`), 1500);
      } else if (r.status === 'MANUAL_REVIEW') setVerify({ status: 'MANUAL_REVIEW' });
      else setVerify({ status: r.status });
    } catch (e) {
      setVerify({ status: 'FAILED', error: e.message });
    }
  };
  // poll while waiting for manual review
  useEffect(() => {
    if (verify?.status !== 'MANUAL_REVIEW') return;
    const id = setInterval(async () => {
      const h = await api.get(`/public/holds/${hold.holdToken}`, { auth: false }).catch(() => null);
      if (h && ['DEPOSIT_PAID', 'CONFIRMED'].includes(h.status)) nav(`/book/booking/${hold.holdToken}`);
      if (h?.verification?.result === 'FAILED') setVerify({ status: 'FAILED', error: h.verification.failure_reason });
    }, 5000);
    return () => clearInterval(id);
  }, [verify?.status]);

  const grouped = useMemo(() => {
    const g = {};
    for (const r of result?.rooms || []) (g[r.typeName] ||= []).push(r);
    return g;
  }, [result]);
  const promos = (cat?.promotions || []).filter((p) => !p.needs_code);
  const bk = hold?.booking;
  const branches = publicSettings?.branches || [];

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <h1>{t('จองห้องคาราโอเกะ')}</h1>
      <Steps step={step} />
      {hold?.expiresAt && step >= 2 && step <= 3 && <HoldTimer expiresAt={hold.expiresAt} onExpire={() => { toast.warning('หมดเวลาล็อกห้อง กรุณาเลือกใหม่'); setHold(null); setStep(1); search(true); }} />}

      {step === 0 && (
        <div className="card">
          <div className="grid grid-2">
            {branches.length > 1 && <Field label="1. เลือกสาขา"><Select value={q.branchId} onChange={(e) => setQ2('branchId', e.target.value)} options={branches.map((x) => ({ value: x.id, label: x.name }))} placeholder="ทุกสาขา" /></Field>}
            <Field label="2. วันที่ต้องการใช้บริการ"><Input type="date" min={bkkDateStr()} value={q.date} onChange={(e) => setQ2('date', e.target.value)} /></Field>
            <Field label="3. เวลาเริ่มต้น"><Input type="time" step={1800} value={q.time} onChange={(e) => setQ2('time', e.target.value)} /></Field>
            <Field label="4. ระยะเวลา"><Select value={q.durationMinutes} onChange={(e) => setQ2('durationMinutes', Number(e.target.value))} options={durations.map((m) => ({ value: m, label: formatMinutesShort(m) }))} /></Field>
            <Field label="5. จำนวนผู้ใช้บริการ"><Input type="number" min={1} value={q.guests} onChange={(e) => setQ2('guests', e.target.value)} /></Field>
            <Field label="Type ห้อง (ไม่บังคับ)"><Select value={q.roomTypeId} onChange={(e) => setQ2('roomTypeId', e.target.value)} options={(cat?.types || []).map((x) => ({ value: x.id, label: x.name }))} placeholder="ทุก Type" /></Field>
          </div>
          <div className="small muted mt">{t('ร้านเปิด')} {publicSettings?.store?.openTime}–{publicSettings?.store?.closeTime} {t('น.')}</div>
          <Button className="mt" variant="primary" size="lg" block icon={Search} loading={searching} onClick={() => search()}>{t('ค้นหาห้องว่าง')}</Button>
        </div>
      )}

      {step === 1 && result && (
        <div className="col">
          <div className="card flat row between">
            <span><CalendarDays size={16} /> {fmtDate(result.startAt)} · <Clock size={16} /> {fmtTime(result.startAt)}–{fmtTime(result.endAt)} · <Users size={16} /> {q.guests} {t('คน')}</span>
            <Button size="sm" icon={ChevronLeft} onClick={() => setStep(0)}>{t('แก้ไข')}</Button>
          </div>
          {!result.rooms.length && (
            <div className="card">
              <Empty icon={AlertTriangle} text="ไม่มีห้องว่างในช่วงเวลานี้" />
              {result.suggestions && (
                <div className="col">
                  {result.suggestions.nearbyTimes.length > 0 && <div><b>{t('เวลาใกล้เคียงที่ว่าง')}</b><div className="row mt">{result.suggestions.nearbyTimes.map((s, i) => <Button key={i} size="sm" onClick={() => { setQ2('time', fmtTime(s.startAt).replace('.', ':')); setTimeout(() => search(), 0); }}>{fmtTime(s.startAt)} ({s.rooms} {t('ห้อง')})</Button>)}</div></div>}
                  {result.suggestions.otherTypes.length > 0 && <div><b>{t('ห้อง Type อื่นที่ว่าง')}</b><div className="row mt">{result.suggestions.otherTypes.map((s) => <Button key={s.roomTypeId} size="sm" onClick={() => { setQ2('roomTypeId', s.roomTypeId); setTimeout(() => search(), 0); }}>{s.typeName} ({s.rooms})</Button>)}</div></div>}
                  {result.suggestions.otherDays.length > 0 && <div><b>{t('วันอื่นที่ใกล้ที่สุด')}</b><div className="row mt">{result.suggestions.otherDays.map((s, i) => <Button key={i} size="sm" onClick={() => { setQ2('date', bkkDateStr(s.startAt)); setTimeout(() => search(), 0); }}>{fmtDate(s.startAt)}</Button>)}</div></div>}
                </div>
              )}
            </div>
          )}
          {Object.entries(grouped).map(([type, rooms]) => (
            <div key={type}>
              <h2>{type}</h2>
              <div className="grid grid-auto">
                {rooms.map((r) => <RoomOption key={r.id} room={r} q={q} cat={cat} busy={busy} onChoose={choose} />)}
              </div>
            </div>
          ))}
        </div>
      )}

      {step === 2 && hold && (
        <div className="grid grid-2">
          <div className="card col">
            <h3>{t('11. ข้อมูลลูกค้า')}</h3>
            {!me && <div className="small">{t('เป็นสมาชิกแล้ว?')} <Link to="/book/login?redirect=/book/reserve">{t('เข้าสู่ระบบเพื่อสะสมคะแนน')}</Link></div>}
            <Field label="ชื่อผู้จอง *"><Input value={info.customerName} onChange={(e) => setInfo({ ...info, customerName: e.target.value })} /></Field>
            <Field label="เบอร์โทรศัพท์ *"><Input type="tel" value={info.phone} onChange={(e) => setInfo({ ...info, phone: e.target.value })} /></Field>
            <Field label="อีเมล"><Input type="email" value={info.email} onChange={(e) => setInfo({ ...info, email: e.target.value })} /></Field>
            <Field label="หมายเหตุ"><Textarea value={info.note} onChange={(e) => setInfo({ ...info, note: e.target.value })} /></Field>
            <h3>{t('10. โปรโมชั่น')}</h3>
            <Select value={info.promotionId} onChange={(e) => setInfo({ ...info, promotionId: e.target.value, promoCode: '' })} options={promos.map((p) => ({ value: p.id, label: p.name }))} placeholder="ไม่ใช้โปรโมชั่น" />
            <Field label="Promo Code"><Input value={info.promoCode} onChange={(e) => setInfo({ ...info, promoCode: e.target.value.toUpperCase(), promotionId: '' })} /></Field>
          </div>
          <div className="card col">
            <h3>{t('12. ตรวจสอบรายละเอียดการจอง')}</h3>
            <div className="row nowrap"><img src={hold.room?.imageUrl} alt="" style={{ width: 90, height: 64, objectFit: 'cover', borderRadius: 10 }} /><div><b>{hold.room?.name}</b><div className="small muted">{hold.room?.typeName}</div></div></div>
            <div className="sum-line"><span>{t('วันที่')}</span><b>{fmtDate(result?.startAt || bk?.startAt)}</b></div>
            <div className="sum-line"><span>{t('เวลา')}</span><b>{fmtTime(result?.startAt || bk?.startAt)}–{fmtTime(result?.endAt || bk?.endAt)}</b></div>
            <div className="sum-line"><span>{t('จำนวนลูกค้า')}</span><b>{q.guests}</b></div>
            {(hold.estimate?.lines || []).map((l, i) => <div key={i} className="sum-line small"><span>{l.name}</span><span>{money(l.net)}</span></div>)}
            {hold.estimate?.discounts?.map((d, i) => <div key={i} className="sum-line small" style={{ color: 'var(--ok)' }}><span>{d.name}</span><span>-{money(d.amount)}</span></div>)}
            <div className="sum-line total"><span>{t('ยอดรวมโดยประมาณ')}</span><span>฿{money(hold.estimate?.grandTotal)}</span></div>
            <div className="sum-line bold" style={{ color: 'var(--primary)' }}><span>{t('ยอดมัดจำ')}</span><span>฿{money(hold.deposit)}</span></div>
            <div className="small muted">{t('ยอดสุดท้ายคำนวณตามเวลาใช้งานจริงที่หน้าร้าน')}</div>
            <div className="card flat small">
              <b>{t('นโยบายการยกเลิก')}</b>
              {(b.cancellation?.tiers || []).map((x, i) => <div key={i}>• {t('ยกเลิกก่อน')} {x.hoursBefore} {t('ชั่วโมง คืน')} {x.percent}%</div>)}
              <div>• {t('น้อยกว่านั้น คืน')} {b.cancellation?.defaultPercent ?? 0}%</div>
            </div>
            <Switch checked={info.acceptPolicy} onChange={(v) => setInfo({ ...info, acceptPolicy: v })} label="ยอมรับเงื่อนไขการจองและนโยบายการยกเลิก" />
            <Button variant="primary" size="lg" loading={busy} disabled={!info.customerName || !info.phone || !info.acceptPolicy} onClick={submitDetails}>{t('ไปชำระเงินมัดจำ')}</Button>
            <Button variant="ghost" onClick={release}>{t('ยกเลิกและเลือกห้องใหม่')}</Button>
          </div>
        </div>
      )}

      {step === 3 && payment && (
        <div className="grid grid-2">
          <div className="card center">
            <h3>{t('13. ชำระเงินมัดจำ')}</h3>
            {payment.qrData ? <QRCode value={payment.qrData} size={260} /> : payment.qrImageUrl ? <img src={payment.qrImageUrl} alt="QR" style={{ width: 260, background: '#fff', borderRadius: 8 }} /> : null}
            <div className="big-money" style={{ color: 'var(--primary)' }}>฿{money(payment.amount)}</div>
            <div className="bold">{publicSettings?.payment?.accountName}</div>
            <div className="muted">{publicSettings?.payment?.bankName} · {publicSettings?.payment?.accountNumber}</div>
            {publicSettings?.payment?.promptPayId && <div className="small muted">PromptPay {publicSettings.payment.promptPayId}</div>}
            <div className="small mt">{publicSettings?.payment?.instruction}</div>
          </div>
          <div className="card col">
            <div className="sum-line"><span>{t('เลขที่การจอง')}</span><b>{bk?.bookingNo || hold.bookingNo}</b></div>
            <div className="sum-line"><span>{t('ชื่อผู้จอง')}</span><b>{bk?.customerName || info.customerName}</b></div>
            <div className="sum-line"><span>{t('ห้อง')}</span><b>{bk?.roomName || hold.room?.name}</b></div>
            <div className="sum-line"><span>{t('วันที่')}</span><b>{fmtDate(bk?.startAt)}</b></div>
            <div className="sum-line"><span>{t('เวลา')}</span><b>{fmtTime(bk?.startAt)}–{fmtTime(bk?.endAt)}</b></div>
            <div className="sum-line"><span>{t('ยอดรวมโดยประมาณ')}</span><b>฿{money(bk?.estimatedTotal)}</b></div>
            <div className="sum-line total"><span>{t('ยอดมัดจำ')}</span><span>฿{money(payment.amount)}</span></div>
            <h3 className="mt">{t('14. อัปโหลดสลิปเพื่อตรวจสอบการชำระเงิน')}</h3>
            {!verify || verify.status === 'FAILED' ? (
              <>
                {verify?.status === 'FAILED' && <div className="card flat" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}><AlertTriangle size={16} /> {verify.error || t('ไม่สามารถตรวจสอบรายการได้')}<div className="small">{t('กรุณาตรวจสอบสลิปแล้วลองใหม่ หรือติดต่อพนักงาน')}</div></div>}
                <input ref={fileRef} type="file" accept="image/jpeg,image/png" hidden onChange={(e) => uploadSlip(e.target.files[0])} />
                <Button variant="primary" size="lg" icon={Upload} onClick={() => fileRef.current.click()}>{t('อัปโหลดสลิป (JPG/PNG)')}</Button>
              </>
            ) : verify.status === 'VERIFYING' ? (
              <div className="center" style={{ padding: 20 }}><Spinner lg /><h3>{t('กำลังตรวจสอบการชำระเงิน…')}</h3></div>
            ) : verify.status === 'PAID' ? (
              <div className="center"><CheckCircle2 size={80} color="var(--ok)" /><h2>{t('ชำระเงินสำเร็จ')}</h2></div>
            ) : verify.status === 'MANUAL_REVIEW' ? (
              <div className="center"><Spinner /><h3>{t('สลิปอยู่ระหว่างให้พนักงานตรวจสอบ')}</h3><p className="small muted">{t('ห้องยังถูกล็อกไว้ให้คุณ ระบบจะยืนยันอัตโนมัติเมื่อพนักงานตรวจสอบเรียบร้อย')}</p></div>
            ) : (
              <div className="center"><h3>{verify.status}</h3></div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function RoomOption({ room, q, cat, busy, onChoose }) {
  const { t } = useT();
  const [pkg, setPkg] = useState('');
  const [slots, setSlots] = useState(null);
  const pkgs = room.packages.filter((p) => p.minutes <= Number(q.durationMinutes));
  const promos = (cat?.promotions || []).filter((p) => !p.conditions?.room_type_ids?.length || p.conditions.room_type_ids.includes(room.roomTypeId)).slice(0, 2);
  const loadSlots = async () => setSlots(await api.get(`/public/rooms/${room.id}/slots?date=${q.date}&durationMinutes=${q.durationMinutes}`, { auth: false }));
  return (
    <div className="room-tile">
      <div className="img" style={{ backgroundImage: `url(${room.imageUrl})` }}>
        <span className="badge" style={{ position: 'absolute', top: 10, left: 10, background: '#16a34a', color: '#fff' }}>{t('ว่าง')}</span>
      </div>
      <div className="body">
        <div className="row between"><h3 style={{ margin: 0 }}>{room.name}</h3><Badge color={room.typeColor}>{room.typeName}</Badge></div>
        <div className="small muted"><Users size={13} /> {t('รองรับ')} {room.capacity} {t('คน')} · {(room.amenities || []).join(' · ')}</div>
        <div className="row between small"><span>{t('ราคาต่อชั่วโมง')} <b>฿{money(room.priceHour, 0)}</b></span><span>{t('30 นาที')} <b>฿{money(room.priceHalf, 0)}</b></span></div>
        {pkgs.length > 0 && (
          <Select value={pkg} onChange={(e) => setPkg(e.target.value)} options={pkgs.map((p) => ({ value: p.id, label: `${p.name} ฿${money(p.price, 0)}` }))} placeholder="9. เลือกแพ็กเกจ (ไม่บังคับ)" />
        )}
        {promos.map((p) => <div key={p.id} className="xs"><BadgePercent size={12} color="var(--accent)" /> {p.name}</div>)}
        <div className="sum-line"><span>{t('ยอดโดยประมาณ')}</span><b>฿{money(room.estimate, 0)}</b></div>
        <div className="sum-line small"><span>{t('มัดจำ')}</span><b>฿{money(room.deposit, 0)}</b></div>
        <Button size="sm" variant="ghost" icon={Timer} onClick={loadSlots}>{t('ช่วงเวลาที่สามารถจองได้')}</Button>
        {slots && (
          <div className="slot-grid">
            {slots.slots.map((s) => <div key={s.time} className={`slot ${s.available ? 'free' : 'busy'}`}>{s.time}</div>)}
          </div>
        )}
        <Button variant="primary" loading={busy} onClick={() => onChoose(room, pkg)}>{t('เลือกห้องนี้')}</Button>
      </div>
    </div>
  );
}

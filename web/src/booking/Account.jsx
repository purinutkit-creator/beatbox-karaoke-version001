import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CheckCircle2, CalendarPlus, Phone, MessageCircle, XCircle, Search, LogOut, Crown, Gift, Coins, Smartphone, Link2, Unlink, QrCode, User } from 'lucide-react';
import { useT } from '../lib/i18n.jsx';
import { useApp } from '../lib/store.jsx';
import { api, uid, download } from '../lib/api.js';
import { Button, Field, Input, Modal, Badge, Loading, Empty, QRCode, Barcode, Tabs, Switch, money, useToast, useDialog, Img } from '../components/ui.jsx';
import { useMember } from './BookingApp.jsx';
import { fmtDate, fmtTime, fmtDateTime } from '@beatbox/shared/format.js';
import { formatMinutesShort } from '@beatbox/shared/roomPricing.js';
import { RESERVATION_STATUS_LABEL, RESERVATION_STATUS_COLOR, REWARD_TYPES } from '@beatbox/shared/constants.js';

function Status({ s }) {
  const { t } = useT();
  return <Badge color={RESERVATION_STATUS_COLOR[s]}>{t(RESERVATION_STATUS_LABEL[s] || s)}</Badge>;
}

/** Booking card with booking number + QR / barcode that staff can scan (or customer can tell their phone number). */
export function BookingCard({ b, onCancel, compact }) {
  const { t } = useT();
  const { publicSettings } = useApp();
  const store = publicSettings?.store;
  const lineUrl = publicSettings?.booking?.lineOaUrl;
  return (
    <div className="card">
      <div className="grid grid-2">
        <div className="col" style={{ gap: 4 }}>
          <div className="row"><b style={{ fontSize: '1.3rem' }}>{b.bookingNo}</b><Status s={b.status} /></div>
          <div className="row nowrap">{b.roomImage && <Img src={b.roomImage} style={{ width: 64, height: 46, borderRadius: 8, objectFit: 'cover' }} />}<div><b>{b.roomName}</b><div className="small muted">{b.typeName}{b.packageName ? ` · ${b.packageName}` : ''}</div></div></div>
          <div>{fmtDate(b.startAt, { weekday: 'short' })} · {fmtTime(b.startAt)}–{fmtTime(b.endAt)} ({formatMinutesShort(b.durationMinutes)})</div>
          <div>{b.customerName} · {b.phone} · {b.guestCount} {t('ท่าน')}</div>
          {!compact && (
            <>
              <div className="sum-line small"><span>{t('ยอดโดยประมาณ')}</span><b>฿{money(b.estimatedTotal)}</b></div>
              <div className="sum-line small"><span>{t('มัดจำที่ชำระ')}</span><b>฿{money(b.depositPaid)}</b></div>
              <div className="sum-line small"><span>{t('ยอดประมาณการคงเหลือ')}</span><b>฿{money(b.remainingEstimate)}</b></div>
            </>
          )}
        </div>
        {b.checkInToken ? (
          <div className="center">
            <QRCode value={`CHECKIN:${b.checkInToken}`} size={compact ? 130 : 180} />
            <Barcode value={b.bookingNo} height={40} />
            <div className="xs muted">{t('แสดง QR/Barcode นี้ หรือแจ้งเบอร์โทรที่ใช้จองกับพนักงานเพื่อ Check-in')}</div>
          </div>
        ) : (
          <div className="center muted small">{t('QR Code สำหรับ Check-in จะแสดงเมื่อการจองได้รับการยืนยัน')}</div>
        )}
      </div>
      {!compact && (
        <div className="row mt">
          <Button size="sm" icon={CalendarPlus} onClick={() => download(`/public/bookings/${b.bookingNo}/ics?phone=${b.phone}`, `${b.bookingNo}.ics`)}>{t('เพิ่มลงปฏิทิน')}</Button>
          {store?.phone && <a className="btn sm" href={`tel:${store.phone}`}><Phone size={16} /> {t('ติดต่อร้าน')}</a>}
          {lineUrl && <a className="btn sm" style={{ background: '#06c755', color: '#fff' }} href={lineUrl} target="_blank" rel="noreferrer"><MessageCircle size={16} /> {t('เปิด LINE')}</a>}
          {onCancel && <Button size="sm" variant="danger" icon={XCircle} onClick={onCancel}>{t('ยกเลิกการจอง')}</Button>}
        </div>
      )}
    </div>
  );
}

export function BookingDetailPage() {
  const { t } = useT();
  const { token } = useParams();
  const [b, setB] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    sessionStorage.removeItem('bb_hold');
    api.get(`/public/holds/${token}`, { auth: false }).then(setB).catch((e) => setErr(e.message));
  }, [token]);
  if (err) return <Empty text={err} />;
  if (!b) return <Loading />;
  const ok = ['DEPOSIT_PAID', 'CONFIRMED', 'PENDING'].includes(b.status);
  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }} className="col">
      {ok && (
        <div className="center">
          <CheckCircle2 size={90} color="var(--ok)" />
          <h1>{b.status === 'PENDING' ? t('ส่งคำขอจองเรียบร้อย รอร้านยืนยัน') : t('จองห้องเรียบร้อยแล้ว')}</h1>
          <p className="muted">{t('กรุณามาถึงก่อนเวลา')} {10} {t('นาที')}</p>
        </div>
      )}
      <BookingCard b={b} />
      <div className="row" style={{ justifyContent: 'center' }}>
        <Link className="btn" to="/book/my-bookings">{t('ดูรายละเอียดการจอง')}</Link>
        <Link className="btn primary" to="/book">{t('กลับหน้าแรก')}</Link>
      </div>
    </div>
  );
}

function CancelFlow({ booking, onDone, onClose }) {
  const { t } = useT();
  const toast = useToast();
  const { me } = useMember();
  const [busy, setBusy] = useState(false);
  const preview = booking.cancelPreview;
  const confirmCancel = async () => {
    setBusy(true);
    try {
      await api.post(`/public/bookings/${booking.bookingNo}/cancel`, { phone: booking.phone }, { member: true });
      toast.success('ยกเลิกการจองเรียบร้อย');
      onDone();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={t('ยกเลิกการจอง')} onClose={onClose} footer={me ? <Button variant="danger" loading={busy} onClick={confirmCancel}>{t('ยืนยันยกเลิก')}</Button> : null}>
      {preview && (
        <div className="card flat">
          {t('ยอดที่จะได้รับคืน')}: <b style={{ fontSize: '1.3rem' }}>฿{money(preview.amount)}</b> ({preview.percent}%)
          <div className="small muted">{t('ยกเลิกล่วงหน้า')} {preview.hoursLeft} {t('ชั่วโมงก่อนเวลาจอง')}</div>
        </div>
      )}
      {!me && (
        <div className="mt col">
          <p className="small">{t('กรุณาเข้าสู่ระบบสมาชิกด้วยเบอร์โทรศัพท์ที่ใช้จอง')} ({booking.phone})</p>
          <Link className="btn primary" to={`/book/login?phone=${encodeURIComponent(booking.phone)}&redirect=${encodeURIComponent(`/book/check`)}`}>{t('เข้าสู่ระบบ / สมัครสมาชิก')}</Link>
        </div>
      )}
    </Modal>
  );
}

export function CheckBookingPage() {
  const { t } = useT();
  const toast = useToast();
  const [f, setF] = useState({ bookingNo: '', phone: '' });
  const [b, setB] = useState(null);
  const [cancel, setCancel] = useState(false);
  const find = async () => {
    try {
      setB(await api.get(`/public/bookings/lookup?bookingNo=${encodeURIComponent(f.bookingNo)}&phone=${encodeURIComponent(f.phone)}`, { auth: false }));
    } catch (e) {
      toast.error(e);
      setB(null);
    }
  };
  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }} className="col">
      <h1>{t('ตรวจสอบการจอง')}</h1>
      <div className="card grid grid-2">
        <Field label="เลขที่การจอง"><Input value={f.bookingNo} onChange={(e) => setF({ ...f, bookingNo: e.target.value.toUpperCase() })} placeholder="BK20261005001" /></Field>
        <Field label="เบอร์โทรศัพท์ที่ใช้จอง"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        <Button variant="primary" icon={Search} onClick={find} style={{ gridColumn: '1/-1' }}>{t('ตรวจสอบ')}</Button>
      </div>
      {b && <BookingCard b={b} onCancel={b.canCancel ? () => setCancel(true) : null} />}
      {cancel && <CancelFlow booking={b} onClose={() => setCancel(false)} onDone={() => { setCancel(false); find(); }} />}
    </div>
  );
}

function RequireMember({ children }) {
  const { me, ready } = useMember();
  const { t } = useT();
  if (!ready) return <Loading />;
  if (!me)
    return (
      <div className="card center" style={{ maxWidth: 480, margin: '0 auto' }}>
        <User size={48} />
        <h2>{t('กรุณาเข้าสู่ระบบสมาชิก')}</h2>
        <Link className="btn primary" to={`/book/login?redirect=${encodeURIComponent(window.location.pathname)}`}>{t('เข้าสู่ระบบ')}</Link>
        <p className="small muted mt">{t('หรือ')} <Link to="/book/check">{t('ตรวจสอบการจองด้วยเลขที่จองและเบอร์โทร')}</Link></p>
      </div>
    );
  return children;
}

export function MyBookingsPage() {
  return (
    <RequireMember>
      <MyBookings />
    </RequireMember>
  );
}

function MyBookings() {
  const { t } = useT();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('upcoming');
  const [cancel, setCancel] = useState(null);
  const load = () => api.get('/public/me/bookings', { member: true }).then(setData).catch((e) => toast.error(e));
  useEffect(() => {
    load();
  }, []);
  if (!data) return <Loading />;
  const list = data[tab];
  const openCancel = async (b) => {
    const d = await api.get(`/public/bookings/lookup?bookingNo=${b.bookingNo}&phone=${b.phone}`, { auth: false });
    if (!d.canCancel) return toast.warning('การจองนี้ไม่สามารถยกเลิกออนไลน์ได้ กรุณาติดต่อร้าน');
    setCancel(d);
  };
  return (
    <div className="col" style={{ maxWidth: 860, margin: '0 auto' }}>
      <h1>{t('การจองของฉัน')}</h1>
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'upcoming', label: 'การจองที่กำลังจะมาถึง', count: data.upcoming.length }, { value: 'history', label: 'ประวัติการจอง' }]} />
      {!list.length && <Empty text="ยังไม่มีการจอง"><div className="mt"><Link className="btn primary" to="/book/reserve">{t('จองห้อง')}</Link></div></Empty>}
      {list.map((b) => <BookingCard key={b.bookingNo} b={b} compact={tab === 'history'} onCancel={tab === 'upcoming' ? () => openCancel(b) : null} />)}
      {cancel && <CancelFlow booking={cancel} onClose={() => setCancel(null)} onDone={() => { setCancel(null); load(); }} />}
    </div>
  );
}

export function PointsPage() {
  return (
    <RequireMember>
      <Points />
    </RequireMember>
  );
}

function Points() {
  const { t } = useT();
  const { me } = useMember();
  const [rows, setRows] = useState(null);
  const [visits, setVisits] = useState(null);
  const [tab, setTab] = useState('points');
  useEffect(() => {
    api.get('/public/me/points', { member: true }).then(setRows);
    api.get('/public/me/visits', { member: true }).then(setVisits);
  }, []);
  return (
    <div className="col" style={{ maxWidth: 860, margin: '0 auto' }}>
      <div className="card center" style={{ background: `linear-gradient(135deg, ${me.tier_color || '#8b5cf6'}, var(--accent))`, color: '#fff' }}>
        <div><Crown size={18} /> {me.tier_name}</div>
        <div className="big-money">{Number(me.points_balance)} {t('คะแนน')}</div>
        <div className="small">{t('ยอดใช้จ่ายสะสม')} ฿{money(me.total_spending, 0)} · {me.visit_count} {t('ครั้ง')} · {(me.total_minutes / 60).toFixed(1)} {t('ชั่วโมง')}</div>
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'points', label: 'ประวัติคะแนน' }, { value: 'visits', label: 'ประวัติการใช้บริการ' }]} />
      {tab === 'points' && (!rows ? <Loading /> : !rows.length ? <Empty /> : rows.map((r) => (
        <div key={r.id} className="card flat row between">
          <div><Badge>{r.type}</Badge> {r.reason}<div className="xs muted">{fmtDateTime(r.created_at)} {r.expires_at && `· ${t('หมดอายุ')} ${fmtDate(r.expires_at)}`}</div></div>
          <div className="right"><b style={{ color: r.points > 0 ? 'var(--ok)' : 'var(--danger)' }}>{r.points > 0 ? '+' : ''}{Number(r.points)}</b><div className="xs muted">{t('คงเหลือ')} {Number(r.balance_after)}</div></div>
        </div>
      )))}
      {tab === 'visits' && (!visits ? <Loading /> : !visits.length ? <Empty /> : visits.map((v, i) => (
        <div key={i} className="card flat row between"><div>{v.room_name || t('หน้าร้าน')} · {fmtDateTime(v.paid_at)}<div className="xs muted">{v.receipt_no} · {formatMinutesShort(v.billed_minutes)}</div></div><div className="right">฿{money(v.grand_total)}<div className="xs" style={{ color: 'var(--ok)' }}>+{v.points_earned}</div></div></div>
      )))}
    </div>
  );
}

export function RewardsPage() {
  const { t } = useT();
  const { me } = useMember();
  const toast = useToast();
  const { confirm } = useDialog();
  const [data, setData] = useState(null);
  const [coupons, setCoupons] = useState([]);
  const [show, setShow] = useState(null);
  const load = () => {
    if (me) {
      api.get('/public/me/rewards', { member: true }).then(setData);
      api.get('/public/me/coupons', { member: true }).then(setCoupons);
    } else api.get('/public/catalog', { auth: false }).then((c) => setData({ rewards: c.rewards, redemptions: [] }));
  };
  useEffect(load, [me?.id]);
  const redeem = async (r) => {
    if (!(await confirm({ message: `${t('แลก')} ${r.name} ${t('ใช้')} ${r.points_cost} ${t('คะแนน')}?` }))) return;
    try {
      const rd = await api.post(`/public/me/rewards/${r.id}/redeem`, {}, { member: true, idempotencyKey: uid() });
      setShow(rd);
      load();
    } catch (e) {
      toast.error(e);
    }
  };
  if (!data) return <Loading />;
  return (
    <div className="col" style={{ maxWidth: 960, margin: '0 auto' }}>
      <h1>Rewards</h1>
      {me && <div className="card flat"><Coins size={16} /> {t('คะแนนของคุณ')}: <b>{Number(me.points_balance)}</b></div>}
      <div className="grid grid-auto">
        {data.rewards.map((r) => (
          <div key={r.id} className="room-tile">
            <div className="img" style={{ backgroundImage: `url(${r.image_url})` }} />
            <div className="body">
              <b>{r.name}</b>
              <div className="small muted">{t(REWARD_TYPES[r.reward_type])} {r.description || ''}</div>
              <div style={{ fontSize: '1.3rem', fontWeight: 800 }}>{r.points_cost} {t('คะแนน')}</div>
              {me ? <Button size="sm" variant="primary" disabled={Number(me.points_balance) < r.points_cost} onClick={() => redeem(r)}>{t('แลก')}</Button> : <Link className="btn sm" to="/book/login?redirect=/book/rewards">{t('เข้าสู่ระบบเพื่อแลก')}</Link>}
            </div>
          </div>
        ))}
      </div>
      {me && (
        <>
          <h2>{t('รหัสแลกรางวัลของฉัน')}</h2>
          {!data.redemptions.length && <div className="muted">-</div>}
          {data.redemptions.map((rd) => (
            <div key={rd.id} className="card flat row between">
              <div><b>{rd.reward_name}</b><div className="xs muted">{rd.code} · {t('หมดอายุ')} {rd.expires_at ? fmtDate(rd.expires_at) : '-'}</div></div>
              <div className="row nowrap"><Badge>{rd.status}</Badge>{rd.status === 'ISSUED' && <Button size="sm" icon={QrCode} onClick={() => setShow(rd)} />}</div>
            </div>
          ))}
          <h2>Coupon & {t('โปรโมชั่นสำหรับสมาชิก')}</h2>
          {coupons.map((c) => <div key={c.id} className="card flat"><b>{c.name}</b> {c.code && <Badge color="#8b5cf6">{c.code}</Badge>}<div className="small muted">{c.description}</div></div>)}
        </>
      )}
      {show && (
        <Modal title={show.reward_name} onClose={() => setShow(null)}>
          <div className="center">
            <QRCode value={show.code} size={200} />
            <Barcode value={show.code} />
            <h2>{show.code}</h2>
            <p className="small muted">{t('แสดงรหัสนี้ให้พนักงานเพื่อใช้สิทธิ์')}</p>
          </div>
        </Modal>
      )}
    </div>
  );
}

export function LoginPage() {
  const { t } = useT();
  const toast = useToast();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const { login, me } = useMember();
  const { publicSettings } = useApp();
  const redirect = params.get('redirect') || '/book/account';
  const [phone, setPhone] = useState(params.get('phone') || '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (me && !me.mustChangePassword) nav(redirect, { replace: true });
  }, [me]);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      const r = await api.post('/public/auth/login', { phone, password }, { auth: false });
      await login(r.token);
      if (!r.mustChangePassword) nav(redirect, { replace: true });
    } catch (er) {
      setErr(er.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card" style={{ maxWidth: 440, margin: '0 auto' }}>
      <h1>{t('เข้าสู่ระบบสมาชิก')}</h1>
      <p className="muted">{t('ใช้เบอร์โทรศัพท์และรหัสผ่าน — ไม่ต้องใช้รหัส OTP')}</p>
      {params.get('error') && <p style={{ color: 'var(--danger)' }}>{t('เข้าสู่ระบบด้วย LINE ไม่สำเร็จ')}</p>}
      <form className="col" onSubmit={submit}>
        <Field label="เบอร์โทรศัพท์"><Input type="tel" autoComplete="username" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="08xxxxxxxx" required /></Field>
        <Field label="รหัสผ่าน" hint="สมาชิกใหม่: รหัสผ่านเริ่มต้นคือเลข 4 ตัวท้ายของเบอร์โทรศัพท์"><Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
        {err && <div style={{ color: 'var(--danger)' }}>{t(err)}</div>}
        <Button type="submit" variant="primary" icon={Smartphone} loading={busy} disabled={phone.length < 9 || !password}>{t('เข้าสู่ระบบ')}</Button>
      </form>
      <div className="center mt small">{t('ยังไม่เป็นสมาชิก?')} <Link to={`/book/signup?redirect=${encodeURIComponent(redirect)}${phone ? `&phone=${encodeURIComponent(phone)}` : ''}`}>{t('สมัครสมาชิก')}</Link></div>
      <div className="divider" />
      <a className="btn block" style={{ background: '#06c755', color: '#fff' }} href={`/api/public/auth/line/start?redirect=${encodeURIComponent(redirect)}`}><MessageCircle size={18} /> {t('เข้าสู่ระบบด้วย LINE')}</a>
      {!publicSettings?.runtime?.lineLoginEnabled && <div className="xs muted center">{t('LINE Login ยังไม่ได้ตั้งค่า (โหมดทดสอบ)')}</div>}
    </div>
  );
}

/** Member sign-up for this store (QR at the end of a receipt opens this page). Same phone → log in instead. */
export function SignupPage() {
  const { t } = useT();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const { publicSettings } = useApp();
  const ms = publicSettings?.memberSignup || {};
  const extraFields = ms.extraFields || [];
  const link = params.get('link');
  const [f, setF] = useState({ phone: params.get('phone') || '', firstName: params.get('name') || '', lastName: '', consent: true, extra: {} });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      const r = await api.post('/public/auth/signup', { ...f, linkToken: link || null }, { auth: false });
      setDone(r);
    } catch (er) {
      if (er.code === 'MEMBER_EXISTS') return nav(`/book/login?phone=${encodeURIComponent(f.phone)}&exists=1&redirect=${encodeURIComponent(params.get('redirect') || '/book/account')}`, { replace: true });
      setErr(er.message);
    } finally {
      setBusy(false);
    }
  };
  if (ms.enabled === false) return <div className="card center" style={{ maxWidth: 460, margin: '0 auto' }}>{t('ร้านนี้ปิดการสมัครสมาชิกออนไลน์ กรุณาติดต่อพนักงาน')}</div>;
  if (done) {
    return (
      <div className="card center col" style={{ maxWidth: 460, margin: '0 auto' }}>
        <CheckCircle2 size={64} color="var(--ok)" />
        <h2 style={{ margin: 0 }}>{t('สมัครสมาชิกสำเร็จ')}</h2>
        <div className="card flat" style={{ borderColor: 'var(--ok)' }}>{t(done.message)}</div>
        {done.memberCode && <div className="small muted">{t('รหัสสมาชิก')}: <b>{done.memberCode}</b></div>}
        <Link className="btn primary" to={`/book/login?phone=${encodeURIComponent(f.phone)}&redirect=${encodeURIComponent(params.get('redirect') || '/book/account')}`}>{t('เข้าสู่ระบบ')}</Link>
      </div>
    );
  }
  const setExtra = (k, v) => setF((x) => ({ ...x, extra: { ...x.extra, [k]: v } }));
  return (
    <div className="card" style={{ maxWidth: 480, margin: '0 auto' }}>
      <h1>{t('สมัครสมาชิก')}{publicSettings?.store?.name ? ` · ${publicSettings.store.name}` : ''}</h1>
      <p className="muted small">{t('สมัครฟรี ไม่ต้องใช้รหัส OTP · รหัสผ่านเริ่มต้นคือเลข 4 ตัวท้ายของเบอร์โทรศัพท์ และเปลี่ยนได้หลังเข้าสู่ระบบ')}</p>
      <form className="col" onSubmit={submit}>
        <Field label="เบอร์โทรศัพท์ *"><Input type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="08xxxxxxxx" required /></Field>
        <div className="grid grid-2">
          <Field label="ชื่อ *"><Input value={f.firstName} onChange={(e) => setF({ ...f, firstName: e.target.value })} required /></Field>
          <Field label="นามสกุล *"><Input value={f.lastName} onChange={(e) => setF({ ...f, lastName: e.target.value })} required /></Field>
        </div>
        {extraFields.map((x) => (
          <Field key={x.key} label={`${x.label}${x.required ? ' *' : ''}`}>
            {x.type === 'select' ? (
              <select className="input" value={f.extra[x.key] || ''} onChange={(e) => setExtra(x.key, e.target.value)} required={x.required}>
                <option value="">-</option>
                {(x.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : (
              <Input type={x.type === 'date' ? 'date' : x.type === 'email' ? 'email' : 'text'} value={f.extra[x.key] || ''} onChange={(e) => setExtra(x.key, e.target.value)} required={x.required} />
            )}
          </Field>
        ))}
        <Switch checked={f.consent} onChange={(v) => setF({ ...f, consent: v })} label="รับข่าวสารและโปรโมชั่นจากร้าน" />
        {err && <div style={{ color: 'var(--danger)' }}>{t(err)}</div>}
        <Button type="submit" variant="primary" loading={busy}>{t('สมัครสมาชิก')}</Button>
      </form>
      <div className="center mt small">{t('เป็นสมาชิกอยู่แล้ว?')} <Link to={`/book/login${f.phone ? `?phone=${encodeURIComponent(f.phone)}` : ''}`}>{t('เข้าสู่ระบบ')}</Link></div>
    </div>
  );
}

/** Shown after logging in with the default password (first login or reset by staff): a new password is required. */
export function SetPasswordPage() {
  const { t } = useT();
  const toast = useToast();
  const { me, reload, logout } = useMember();
  const [f, setF] = useState({ current: '', password: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const save = async (e) => {
    e.preventDefault();
    if (f.password !== f.confirm) return toast.error(t('รหัสผ่านใหม่และการยืนยันไม่ตรงกัน'));
    setBusy(true);
    try {
      await api.post('/public/me/password', { current: f.current, password: f.password }, { member: true });
      toast.success('ตั้งรหัสผ่านใหม่เรียบร้อย');
      await reload();
    } catch (er) {
      toast.error(er);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card" style={{ maxWidth: 460, margin: '0 auto' }}>
      <h1>{t('ตั้งรหัสผ่านใหม่')}</h1>
      <p className="muted small">{t('คุณเข้าสู่ระบบด้วยรหัสผ่านเริ่มต้น (เลข 4 ตัวท้ายของเบอร์โทรศัพท์) กรุณาตั้งรหัสผ่านใหม่ก่อนใช้งาน')}</p>
      {me && <div className="small">{t('สมาชิก')}: <b>{me.first_name}</b> · {me.phone}</div>}
      <form className="col mt" onSubmit={save}>
        <Field label="รหัสผ่านปัจจุบัน"><Input type="password" autoComplete="current-password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} required /></Field>
        <Field label="รหัสผ่านใหม่ (อย่างน้อย 6 ตัวอักษร)"><Input type="password" autoComplete="new-password" minLength={6} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required /></Field>
        <Field label="ยืนยันรหัสผ่านใหม่"><Input type="password" autoComplete="new-password" minLength={6} value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} required /></Field>
        <Button type="submit" variant="primary" loading={busy}>{t('บันทึกรหัสผ่านใหม่')}</Button>
      </form>
      <Button variant="ghost" icon={LogOut} onClick={logout} className="mt">{t('ออกจากระบบ')}</Button>
    </div>
  );
}

/** First LINE login: link to an existing member (phone + password) or sign up — never merged by name. */
export function LineLinkPage() {
  const { t } = useT();
  const toast = useToast();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const { login } = useMember();
  const link = params.get('link');
  const redirect = params.get('redirect') || '/book/account';
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [consent, setConsent] = useState(true);
  const submit = async (e) => {
    e.preventDefault();
    try {
      const r = await api.post('/public/auth/login', { phone, password, linkToken: link, consent }, { auth: false });
      await login(r.token);
      toast.success('เชื่อมบัญชี LINE เรียบร้อย');
      if (!r.mustChangePassword) nav(redirect, { replace: true });
    } catch (er) {
      toast.error(er);
    }
  };
  return (
    <div className="card" style={{ maxWidth: 460, margin: '0 auto' }}>
      <h1><Link2 size={22} /> {t('เชื่อมบัญชี LINE')}</h1>
      <p>{t('สวัสดี')} <b>{params.get('name')}</b> — {t('เข้าสู่ระบบสมาชิกเพื่อเชื่อมกับบัญชี LINE หรือสมัครสมาชิกใหม่')}</p>
      <form className="col" onSubmit={submit}>
        <Field label="เบอร์โทรศัพท์"><Input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} required /></Field>
        <Field label="รหัสผ่าน"><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
        <Switch checked={consent} onChange={setConsent} label="ยินยอมรับข้อความแจ้งเตือนการจองทาง LINE" />
        <Button type="submit" variant="primary">{t('ยืนยันและเชื่อมบัญชี')}</Button>
      </form>
      <div className="center mt small">{t('ยังไม่เป็นสมาชิก?')} <Link to={`/book/signup?link=${encodeURIComponent(link || '')}&name=${encodeURIComponent(params.get('name') || '')}&redirect=${encodeURIComponent(redirect)}`}>{t('สมัครสมาชิกใหม่และเชื่อม LINE')}</Link></div>
    </div>
  );
}

export function LineDemoPage() {
  const { t } = useT();
  const [params] = useSearchParams();
  const [name, setName] = useState('LINE User');
  const [id, setId] = useState(String(Math.floor(Math.random() * 1e6)));
  const go = async () => {
    const r = await api.post('/public/auth/line/demo', { lineUserId: id, displayName: name, redirect: params.get('redirect') || '/book/account' }, { auth: false });
    window.location.href = r.url;
  };
  return (
    <div className="card" style={{ maxWidth: 420, margin: '0 auto' }}>
      <h2>LINE Login (Demo)</h2>
      <p className="small muted">{t('ยังไม่ได้ตั้งค่า LINE_LOGIN_CHANNEL_ID — หน้านี้จำลองการเข้าสู่ระบบด้วย LINE สำหรับการทดสอบเท่านั้น')}</p>
      <Field label="Display Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="LINE User ID (demo)"><Input value={id} onChange={(e) => setId(e.target.value)} /></Field>
      <Button className="mt" style={{ background: '#06c755', color: '#fff' }} onClick={go}>{t('เข้าสู่ระบบด้วย LINE')}</Button>
    </div>
  );
}

export function AccountPage() {
  return (
    <RequireMember>
      <Account />
    </RequireMember>
  );
}

function Account() {
  const { t } = useT();
  const toast = useToast();
  const { me, reload, logout } = useMember();
  const [edit, setEdit] = useState(null);
  const [disc, setDisc] = useState(null);
  const [pw, setPw] = useState(null);
  const [up, setUp] = useState(null);
  useEffect(() => {
    api.get('/public/me/bookings', { member: true }).then((d) => setUp(d.upcoming)).catch(() => {});
  }, []);
  const save = async () => {
    try {
      await api.put('/public/me', edit, { member: true });
      toast.success('บันทึกเรียบร้อย');
      setEdit(null);
      reload();
    } catch (e) {
      toast.error(e);
    }
  };
  const next = me.nextTier;
  return (
    <div className="col" style={{ maxWidth: 860, margin: '0 auto' }}>
      <div className="card row nowrap" style={{ background: `linear-gradient(135deg, ${me.tier_color || '#8b5cf6'}cc, var(--accent))`, color: '#fff' }}>
        <Img src={me.photo_url || me.line?.picture_url} style={{ width: 84, height: 84, borderRadius: 99, objectFit: 'cover' }} />
        <div className="grow">
          <h2 style={{ margin: 0 }}>{me.first_name} {me.last_name || ''}</h2>
          <div>Member ID: <b>{me.member_code}</b> · {me.phone}</div>
          <div><Crown size={16} /> {me.tier_name} · ×{Number(me.point_multiplier || 1)} {t('คะแนน')}</div>
        </div>
        <QRCode value={`MEMBER:${me.member_code}`} size={90} />
      </div>
      <div className="grid grid-4">
        <div className="card kpi"><div className="label">{t('คะแนนปัจจุบัน')}</div><div className="value">{Number(me.points_balance)}</div></div>
        <div className="card kpi"><div className="label">{t('ยอดใช้จ่ายสะสม')}</div><div className="value">฿{money(me.total_spending, 0)}</div></div>
        <div className="card kpi"><div className="label">{t('จำนวนครั้งที่ใช้บริการ')}</div><div className="value">{me.visit_count}</div></div>
        <div className="card kpi"><div className="label">{t('ชั่วโมงที่ใช้บริการสะสม')}</div><div className="value">{(me.total_minutes / 60).toFixed(1)}</div></div>
      </div>
      {next && <div className="card flat small">{t('ระดับถัดไป')}: <b>{next.name}</b> {next.min_spending != null && `· ${t('ยอดสะสม')} ฿${money(next.min_spending, 0)}`} {next.min_points != null && `· ${next.min_points} ${t('คะแนน')}`}</div>}
      <h2>{t('การจองที่กำลังจะมาถึง')}</h2>
      {up?.length ? up.map((b) => <BookingCard key={b.bookingNo} b={b} compact />) : <div className="muted">-</div>}
      <div className="grid grid-3">
        <Link className="btn" to="/book/my-bookings">{t('ประวัติการจอง')}</Link>
        <Link className="btn" to="/book/points"><Coins size={16} /> {t('ประวัติคะแนน')}</Link>
        <Link className="btn" to="/book/rewards"><Gift size={16} /> Rewards & Coupon</Link>
      </div>
      <div className="card">
        <div className="card-title"><span>{t('ข้อมูลส่วนตัว')}</span><Button size="sm" onClick={() => setEdit({ firstName: me.first_name, lastName: me.last_name, nickname: me.nickname, birthday: me.birthday, gender: me.gender, email: me.email, photoUrl: me.photo_url, marketingConsent: me.marketing_consent })}>{t('แก้ไข')}</Button></div>
        <div className="small">{t('ชื่อเล่น')}: {me.nickname || '-'} · {t('วันเกิด')}: {me.birthday ? fmtDate(me.birthday) : '-'} · {t('อีเมล')}: {me.email || '-'}</div>
      </div>
      <div className="card">
        <div className="card-title"><span>LINE</span></div>
        {me.line ? (
          <div className="row between">
            <span className="row nowrap"><Img src={me.line.picture_url} style={{ width: 36, height: 36, borderRadius: 99 }} /> {me.line.display_name} · {t('เชื่อมเมื่อ')} {fmtDate(me.line.linked_at)}</span>
            <div className="row">
              <Switch checked={me.line.messaging_consent} onChange={async (v) => { await api.post('/public/me/line/consent', { consent: v }, { member: true }); reload(); }} label="รับการแจ้งเตือนทาง LINE" />
              <Button size="sm" variant="danger" icon={Unlink} onClick={() => setDisc({ code: '' })}>{t('ยกเลิกการเชื่อมต่อ')}</Button>
            </div>
          </div>
        ) : (
          <a className="btn" style={{ background: '#06c755', color: '#fff' }} href={`/api/public/auth/line/start?redirect=/book/account`}><MessageCircle size={16} /> {t('เชื่อมบัญชี LINE')}</a>
        )}
      </div>
      <div className="card">
        <div className="card-title"><span>{t('รหัสผ่าน')}</span><Button size="sm" onClick={() => setPw({ current: '', password: '', confirm: '' })}>{t('เปลี่ยนรหัสผ่าน')}</Button></div>
        <div className="small muted">{t('เข้าสู่ระบบด้วยเบอร์')} {me.phone} {me.passwordChangedAt ? `· ${t('เปลี่ยนรหัสผ่านล่าสุด')} ${fmtDate(me.passwordChangedAt)}` : ''}</div>
      </div>
      <Button variant="ghost" icon={LogOut} onClick={logout}>{t('ออกจากระบบ')}</Button>
      {pw && (
        <Modal title={t('เปลี่ยนรหัสผ่าน')} onClose={() => setPw(null)} footer={<Button variant="primary" onClick={async () => { if (pw.password !== pw.confirm) return toast.error(t('รหัสผ่านใหม่และการยืนยันไม่ตรงกัน')); try { await api.post('/public/me/password', { current: pw.current, password: pw.password }, { member: true }); toast.success('เปลี่ยนรหัสผ่านแล้ว'); setPw(null); reload(); } catch (e) { toast.error(e); } }}>{t('บันทึก')}</Button>}>
          <Field label="รหัสผ่านปัจจุบัน"><Input type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></Field>
          <Field label="รหัสผ่านใหม่ (อย่างน้อย 6 ตัวอักษร)"><Input type="password" value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} /></Field>
          <Field label="ยืนยันรหัสผ่านใหม่"><Input type="password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} /></Field>
        </Modal>
      )}
      {edit && (
        <Modal title={t('แก้ไขข้อมูล')} onClose={() => setEdit(null)} footer={<Button variant="primary" onClick={save}>{t('บันทึก')}</Button>}>
          <div className="grid grid-2">
            <Field label="ชื่อ"><Input value={edit.firstName || ''} onChange={(e) => setEdit({ ...edit, firstName: e.target.value })} /></Field>
            <Field label="นามสกุล"><Input value={edit.lastName || ''} onChange={(e) => setEdit({ ...edit, lastName: e.target.value })} /></Field>
            <Field label="ชื่อเล่น"><Input value={edit.nickname || ''} onChange={(e) => setEdit({ ...edit, nickname: e.target.value })} /></Field>
            <Field label="วันเกิด"><Input type="date" value={edit.birthday || ''} disabled={!!me.birthday} onChange={(e) => setEdit({ ...edit, birthday: e.target.value })} /></Field>
            <Field label="อีเมล"><Input value={edit.email || ''} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></Field>
            <Field label="รูปโปรไฟล์ (URL)"><Input value={edit.photoUrl || ''} onChange={(e) => setEdit({ ...edit, photoUrl: e.target.value })} /></Field>
            <Switch checked={edit.marketingConsent} onChange={(v) => setEdit({ ...edit, marketingConsent: v })} label="รับข่าวสารโปรโมชั่น" />
          </div>
        </Modal>
      )}
      {disc && (
        <Modal title={t('ยกเลิกการเชื่อมต่อ LINE')} onClose={() => setDisc(null)} footer={<Button variant="danger" onClick={async () => { try { await api.post('/public/me/line/disconnect', { password: disc.code }, { member: true }); toast.success('ยกเลิกการเชื่อมต่อแล้ว'); setDisc(null); reload(); } catch (e) { toast.error(e); } }}>{t('ยืนยัน')}</Button>}>
          <p>{t('กรอกรหัสผ่านสมาชิกเพื่อยืนยัน')}</p>
          <Input type="password" value={disc.code} onChange={(e) => setDisc({ ...disc, code: e.target.value })} />
        </Modal>
      )}
    </div>
  );
}

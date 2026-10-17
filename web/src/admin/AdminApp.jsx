import { lazy, Suspense, useEffect, useState, useRef, useCallback } from 'react';
import { Routes, Route, Navigate, NavLink, useNavigate, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, ShoppingCart, DoorOpen, CalendarDays, ClipboardList, Users, Package, Tags, Boxes, LayoutGrid, Timer, BadgePercent, Wallet,
  Receipt, Clock, BarChart3, UserCog, MonitorSmartphone, Printer, Settings, History, Bell, Sun, Moon, LogOut, Menu, Wifi, WifiOff, Globe, ScanLine,
  Gift, AlertTriangle, VolumeX, Plus, CreditCard, X, Mic2, Lock, KeyRound, Mail, Store, Shield, FileText, Cpu,
} from 'lucide-react';
import { useAuth, useApp } from '../lib/store.jsx';
import { useT } from '../lib/i18n.jsx';
import { api, offlineQueue } from '../lib/api.js';
import { useServerNow, useSocketEvent, useSync, getSocket } from '../lib/socket.js';
import { Button, Modal, Loading, PinPad, useToast, Badge, Field, Input, Seg } from '../components/ui.jsx';
import { LicenseWidget, ExpiredScreen, SuperOwnerBanner } from '../components/License.jsx';
import { PrintProvider, usePrint } from '../components/PrintPreview.jsx';
import { PrepayReview } from '../components/RoomService.jsx';
import { fmtTime, fmtDateTime } from '@beatbox/shared/format.js';

const RegisterStore = lazy(() => import('../platform/RegisterStore.jsx'));
const PlatformApp = lazy(() => import('../platform/PlatformApp.jsx'));

const pages = {
  dashboard: lazy(() => import('./pages/Dashboard.jsx')),
  pos: lazy(() => import('./pages/Pos.jsx')),
  rooms: lazy(() => import('./pages/Rooms.jsx')),
  calendar: lazy(() => import('./pages/BookingCalendar.jsx')),
  reservations: lazy(() => import('./pages/Reservations.jsx')),
  online: lazy(() => import('./pages/OnlineBookings.jsx')),
  checkin: lazy(() => import('./pages/CheckIn.jsx')),
  members: lazy(() => import('./pages/Members.jsx')),
  rewards: lazy(() => import('./pages/Rewards.jsx')),
  products: lazy(() => import('./pages/Products.jsx')),
  categories: lazy(() => import('./pages/Categories.jsx')),
  stock: lazy(() => import('./pages/Stock.jsx')),
  roomTypes: lazy(() => import('./pages/RoomTypes.jsx')),
  roomsManage: lazy(() => import('./pages/RoomsManage.jsx')),
  packages: lazy(() => import('./pages/Packages.jsx')),
  promotions: lazy(() => import('./pages/Promotions.jsx')),
  deposits: lazy(() => import('./pages/Deposits.jsx')),
  receipts: lazy(() => import('./pages/Receipts.jsx')),
  shifts: lazy(() => import('./pages/Shifts.jsx')),
  reports: lazy(() => import('./pages/Reports.jsx')),
  employees: lazy(() => import('./pages/Employees.jsx')),
  display: lazy(() => import('./pages/DisplaySettings.jsx')),
  printers: lazy(() => import('./pages/Printers.jsx')),
  smart: lazy(() => import('./pages/SmartDevices.jsx')),
  documents: lazy(() => import('./pages/Documents.jsx')),
  settings: lazy(() => import('./pages/Settings.jsx')),
  activity: lazy(() => import('./pages/ActivityLog.jsx')),
  notifications: lazy(() => import('./pages/Notifications.jsx')),
};

export const MENU = [
  { group: 'ภาพรวม' },
  { to: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, perm: 'sales.view', feature: 'reports' },
  { to: 'pos', label: 'หน้าขาย POS', icon: ShoppingCart, perm: 'pos.access', feature: 'pos' },
  { to: 'rooms', label: 'ห้องทั้งหมด', icon: DoorOpen, feature: 'rooms' },
  { group: 'การจอง' },
  { to: 'calendar', label: 'ตารางการจอง', icon: CalendarDays, feature: 'booking' },
  { to: 'reservations', label: 'รายการจอง', icon: ClipboardList, feature: 'booking' },
  { to: 'online', label: 'Online Booking', icon: Globe, badge: 'online', feature: 'booking' },
  { to: 'checkin', label: 'Check-in / ค้นหาการจอง', icon: ScanLine, feature: 'booking' },
  { to: 'deposits', label: 'เงินมัดจำ', icon: Wallet, feature: 'pos' },
  { group: 'ลูกค้า' },
  { to: 'members', label: 'สมาชิก', icon: Users, perm: 'member.view', feature: 'members' },
  { to: 'rewards', label: 'Rewards & Tier', icon: Gift, perm: 'member.view', feature: 'members' },
  { group: 'สินค้าและห้อง' },
  { to: 'products', label: 'สินค้า', icon: Package, feature: 'pos' },
  { to: 'categories', label: 'หมวดหมู่', icon: Tags, feature: 'pos' },
  { to: 'stock', label: 'สต็อก', icon: Boxes, feature: 'stock' },
  { to: 'room-types', label: 'Type ห้อง', icon: LayoutGrid, feature: 'rooms' },
  { to: 'rooms-manage', label: 'จัดการห้อง', icon: DoorOpen, feature: 'rooms' },
  { to: 'packages', label: 'แพ็กเกจเวลา', icon: Timer, feature: 'rooms' },
  { to: 'promotions', label: 'โปรโมชั่น', icon: BadgePercent, feature: 'promotions' },
  { group: 'การเงิน' },
  { to: 'receipts', label: 'ประวัติใบเสร็จ', icon: Receipt, feature: 'pos' },
  { to: 'shifts', label: 'เปิดและปิดรอบ', icon: Clock, feature: 'pos' },
  { to: 'reports', label: 'รายงาน', icon: BarChart3, perm: 'reports.view', feature: 'reports' },
  { group: 'ระบบ' },
  { to: 'employees', label: 'พนักงาน', icon: UserCog, perm: 'employee.manage', feature: 'staff' },
  { to: 'display', label: 'Customer Display', icon: MonitorSmartphone, feature: 'display' },
  { to: 'printers', label: 'เครื่องพิมพ์', icon: Printer, feature: 'printing' },
  { to: 'smart', label: 'อุปกรณ์อัจฉริยะ (Tuya)', icon: Cpu, perm: 'settings.manage' },
  { to: 'documents', label: 'ออกแบบเอกสาร/ใบเสร็จ', icon: FileText, perm: 'settings.manage', feature: 'receipt_settings' },
  { to: 'settings', label: 'ตั้งค่าร้าน', icon: Settings, perm: 'settings.manage' },
  { to: 'activity', label: 'Activity Log', icon: History, perm: 'activity.view' },
  { to: 'notifications', label: 'การแจ้งเตือน', icon: Bell, badge: 'notifications' },
];

function Login() {
  const { login, loginOwner, employee } = useAuth();
  const { publicSettings } = useApp();
  const { t, lang, setLang } = useT();
  const [mode, setMode] = useState(() => localStorage.getItem('bb_login_mode') || 'pin');
  const [pin, setPin] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState(sessionStorage.getItem('bb_logout_reason') || '');
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  useEffect(() => {
    if (employee) nav('/admin/rooms', { replace: true });
  }, [employee]);
  const switchMode = (m) => {
    setMode(m);
    setErr('');
    try {
      localStorage.setItem('bb_login_mode', m);
    } catch {
      /* ignore */
    }
  };
  const run = async (fn) => {
    setBusy(true);
    setErr('');
    sessionStorage.removeItem('bb_logout_reason');
    try {
      const r = await fn();
      if (!r?.platform) nav('/admin/rooms', { replace: true });
    } catch (e) {
      setErr(e.message);
      setPin('');
    } finally {
      setBusy(false);
    }
  };
  const store = publicSettings?.store;
  return (
    <div className="login-wrap">
      <div className="card login-card">
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button size="sm" variant="ghost" icon={Globe} onClick={() => setLang(lang === 'th' ? 'en' : 'th')}>
            {lang === 'th' ? 'EN' : 'TH'}
          </Button>
        </div>
        <div className="brand-logo" style={{ width: 72, height: 72, margin: '0 auto', borderRadius: 20 }}>
          {store?.logoUrl ? <img src={store.logoUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 20 }} /> : <Mic2 size={36} />}
        </div>
        <h2 style={{ marginTop: 12 }}>{store?.name || 'BEATBOX Karaoke'}</h2>
        <Seg value={mode} onChange={switchMode} options={[{ value: 'pin', label: 'พนักงาน (PIN)' }, { value: 'owner', label: 'เจ้าของร้าน (อีเมล)' }]} />
        {mode === 'pin' ? (
          <>
            <p className="muted">{t('กรอกรหัสพนักงาน 4 หลัก')}</p>
            <PinPad value={pin} onChange={setPin} onComplete={(p) => run(() => login(p))} busy={busy} />
            {busy && <div className="mt"><span className="spinner" /></div>}
          </>
        ) : (
          <form
            className="col mt"
            style={{ textAlign: 'left' }}
            onSubmit={(e) => {
              e.preventDefault();
              run(() => loginOwner(email, password));
            }}
          >
            <Field label="อีเมล">
              <Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </Field>
            <Field label="รหัสผ่าน">
              <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </Field>
            <Button type="submit" variant="primary" icon={Mail} loading={busy} block>{t('เข้าสู่ระบบ')}</Button>
          </form>
        )}
        {err && <p style={{ color: 'var(--danger)' }}>{t(err)}</p>}
        <div className="row mt" style={{ justifyContent: 'center' }}>
          <a href="/register" className="small"><Store size={13} /> {t('สมัครใช้งานสำหรับร้านใหม่')}</a>
        </div>
        <div className="row mt" style={{ justifyContent: 'center' }}>
          <a href="/display" className="small">Customer Display</a>
          <span className="muted">·</span>
          <a href="/book" className="small">{t('เว็บไซต์จองห้อง')}</a>
          <span className="muted">·</span>
          <a href="/platform" className="small"><Shield size={12} /> Super Owner</a>
        </div>
      </div>
    </div>
  );
}

/** Store owner: change own password (owner accounts log in with e-mail + password). */
function ChangePassword({ onClose }) {
  const { t } = useT();
  const toast = useToast();
  const [f, setF] = useState({ current: '', password: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const save = async (e) => {
    e.preventDefault();
    if (f.password !== f.confirm) return toast.error(t('รหัสผ่านใหม่และการยืนยันไม่ตรงกัน'));
    setBusy(true);
    try {
      await api.post('/auth/password', { current: f.current, password: f.password });
      toast.success(t('เปลี่ยนรหัสผ่านแล้ว'));
      onClose();
    } catch (er) {
      toast.error(er);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} title={t('เปลี่ยนรหัสผ่าน')}>
      <form className="col" onSubmit={save}>
        <Field label="รหัสผ่านปัจจุบัน"><Input type="password" autoComplete="current-password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} required /></Field>
        <Field label="รหัสผ่านใหม่ (อย่างน้อย 8 ตัวอักษร)"><Input type="password" autoComplete="new-password" minLength={8} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required /></Field>
        <Field label="ยืนยันรหัสผ่านใหม่"><Input type="password" autoComplete="new-password" minLength={8} value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} required /></Field>
        <Button type="submit" variant="primary" loading={busy}>{t('บันทึก')}</Button>
      </form>
    </Modal>
  );
}

// ───── Alert sounds / speech ─────
let audioCtx;
function beep(times = 3) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    for (let i = 0; i < times; i++) {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'square';
      o.frequency.value = i % 2 ? 660 : 880;
      g.gain.value = 0.12;
      o.connect(g).connect(audioCtx.destination);
      const t0 = audioCtx.currentTime + i * 0.35;
      o.start(t0);
      o.stop(t0 + 0.22);
    }
  } catch {
    /* audio blocked */
  }
}
function speak(text, lang) {
  try {
    if (!window.speechSynthesis || !text) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang === 'en' ? 'en-US' : 'th-TH';
    u.rate = 0.95;
    window.speechSynthesis.speak(u);
  } catch {
    /* ignore */
  }
}

function AlertCenter() {
  const { t, lang } = useT();
  const toast = useToast();
  const nav = useNavigate();
  const [popup, setPopup] = useState(null);
  const [muted, setMuted] = useState(false);
  const audioRef = useRef(null);
  const loopRef = useRef(null);
  const stopSound = () => {
    clearInterval(loopRef.current);
    audioRef.current?.pause();
    window.speechSynthesis?.cancel();
  };
  const play = (a) => {
    if (muted) return;
    if (a.soundUrl) {
      audioRef.current = new Audio(a.soundUrl);
      audioRef.current.play().catch(() => beep());
    } else beep(a.kind === 'TIME_UP' ? 4 : 2);
    if (a.useSpeech !== false) setTimeout(() => speak(lang === 'en' ? (a.kind === 'TIME_UP' ? `Room ${a.roomName} time is up. Please check the room.` : `Room ${a.roomName} has ${a.minutes} minutes left`) : a.speech, lang), 900);
  };
  useSocketEvent('room:alert', (a) => {
    if (a.kind === 'TIME_UP') {
      stopSound();
      setPopup(a);
      play(a);
      loopRef.current = setInterval(() => play(a), 20000);
    } else {
      play(a);
      toast.warning(`${t('ห้อง')} ${a.roomName} ${t('เหลือเวลา')} ${a.minutes} ${t('นาที')}`, { title: t('ใกล้หมดเวลา'), duration: 8000 });
    }
  });
  useSocketEvent('notification:new', (n) => {
    if (['ROOM_TIME_UP', 'ROOM_NEAR_END'].includes(n.type)) return;
    const lvl = n.level === 'error' ? 'error' : n.level === 'warning' ? 'warning' : n.level === 'success' ? 'success' : 'info';
    toast[lvl](n.message || '', { title: n.title });
    if (['ONLINE_BOOKING', 'SLIP_REVIEW', 'REFUND_REQUEST'].includes(n.type) && !muted) beep(2);
  });
  useEffect(() => () => stopSound(), []);
  if (!popup) return null;
  const close = () => {
    stopSound();
    setPopup(null);
  };
  const extend = async (m) => {
    try {
      await api.post(`/sessions/${popup.sessionId}/extend`, { minutes: m });
      toast.success(`${t('เพิ่มเวลา')} ${m} ${t('นาที')}`);
      close();
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <Modal onClose={close} closeOnBack={false}>
      <div className="center" style={{ padding: 10 }}>
        <AlertTriangle size={80} color="var(--danger)" style={{ animation: 'pulse 1s infinite' }} />
        <h1 style={{ fontSize: '2.4rem', color: 'var(--danger)', margin: '10px 0' }}>{t('หมดเวลาแล้ว')}</h1>
        <div style={{ fontSize: '2rem', fontWeight: 800 }}>
          {t('ห้อง')} {popup.roomName}
        </div>
        <div className="muted">
          {t('หมายเลขห้อง')} {popup.roomNumber} · {popup.customerName || '-'}
        </div>
        <div className="grid grid-2 mt">
          <Button size="lg" icon={VolumeX} onClick={() => { setMuted(true); stopSound(); }}>{t('ปิดเสียง')}</Button>
          <Button size="lg" icon={Plus} variant="warn" onClick={() => extend(30)}>{t('เพิ่ม 30 นาที')}</Button>
          <Button size="lg" icon={Plus} variant="warn" onClick={() => extend(60)}>{t('เพิ่ม 1 ชั่วโมง')}</Button>
          <Button size="lg" icon={CreditCard} variant="primary" onClick={() => { close(); nav(`/admin/rooms?session=${popup.sessionId}&checkout=1`); }}>{t('ไปหน้าชำระเงิน')}</Button>
        </div>
        <Button className="mt" variant="ghost" icon={X} onClick={close}>{t('ปิด')}</Button>
      </div>
    </Modal>
  );
}

/** Customer problem reports and in-room prepayments → sound + popup on every POS. */
function RoomServiceAlerts() {
  const { t, lang } = useT();
  const nav = useNavigate();
  const [queue, setQueue] = useState([]); // [{ kind: 'ISSUE' | 'PAY', ... }]
  const loopRef = useRef(null);
  const ring = (a) => {
    if (a.soundUrl) new Audio(a.soundUrl).play().catch(() => beep(3));
    else beep(3);
    setTimeout(() => speak(a.kind === 'ISSUE' ? (lang === 'en' ? `Room ${a.roomName} needs help: ${a.category}` : `ห้อง ${a.roomName} ลูกค้าพบปัญหา ${a.category}`) : lang === 'en' ? `Room ${a.roomName} paid, please check the slip` : `ห้อง ${a.roomName} ชำระเงินมา กรุณาตรวจสอบสลิป`, lang), 700);
  };
  useSocketEvent('room:issue', (a) => {
    const item = { kind: 'ISSUE', key: `i${a.id}`, ...a };
    setQueue((q) => [...q.filter((x) => x.key !== item.key), item]);
    ring(item);
  });
  useSocketEvent('room:payment', (a) => {
    const item = { kind: 'PAY', key: `p${a.roomOrderId}`, at: Date.now(), ...a };
    setQueue((q) => [...q.filter((x) => x.key !== item.key), item]);
    ring(item);
  });
  useSocketEvent('room:payment-resolved', ({ roomOrderId }) => setQueue((q) => q.filter((x) => x.key !== `p${roomOrderId}`)));
  useSocketEvent('room:issue-updated', ({ id }) => setQueue((q) => q.filter((x) => x.key !== `i${id}`)));
  const cur = queue[0];
  // repeat the sound every 20s while something is waiting
  useEffect(() => {
    clearInterval(loopRef.current);
    if (cur) loopRef.current = setInterval(() => ring(cur), 20000);
    return () => clearInterval(loopRef.current);
  }, [cur?.key]);
  const [pay, setPay] = useState(null);
  useEffect(() => {
    setPay(null);
    if (cur?.kind === 'PAY') api.get('/room-service').then((s) => setPay(s.payments.find((p) => p.id === cur.roomOrderId) || null)).catch(() => {});
  }, [cur?.key]);
  const now = useServerNow(1000);
  if (!cur) return null;
  const dismiss = () => setQueue((q) => q.slice(1));
  const ack = async () => {
    try {
      await api.post(`/room-issues/${cur.id}/ack`);
    } catch {
      /* already handled */
    }
    dismiss();
  };
  const left = cur.kind === 'PAY' ? Math.max(0, Math.ceil(cur.autoAcceptSeconds - (now - cur.at) / 1000)) : 0;
  return (
    <Modal onClose={dismiss} closeOnBack={false} title={cur.kind === 'ISSUE' ? `${t('ห้อง')} ${cur.roomName}: ${t('ลูกค้าพบปัญหา')}` : `${t('ห้อง')} ${cur.roomName}: ${t('ชำระเงินมา กรุณาตรวจสอบสลิป')}`}>
      {cur.kind === 'ISSUE' ? (
        <div className="center">
          <AlertTriangle size={70} color="var(--danger)" style={{ animation: 'pulse 1s infinite' }} />
          <h1 style={{ margin: '8px 0', color: 'var(--danger)' }}>{t('ห้อง')} {cur.roomName}</h1>
          <div style={{ fontSize: '1.6rem', fontWeight: 800 }}>{cur.category}</div>
          {cur.message && <div className="card flat mt" style={{ fontSize: '1.1rem' }}>{cur.message}</div>}
          <div className="small muted mt">{fmtTime(cur.createdAt)}</div>
          <div className="grid grid-2 mt">
            <Button size="lg" variant="primary" onClick={ack}>{t('รับเรื่อง (กำลังไปที่ห้อง)')}</Button>
            <Button size="lg" onClick={() => { dismiss(); nav(`/admin/rooms?room=${cur.roomId}&tab=issues`); }}>{t('ไปหน้าห้อง')}</Button>
          </div>
        </div>
      ) : (
        <div className="col">
          {left > 0 ? <div className="small" style={{ color: 'var(--warn)' }}>{t('ถ้าไม่ตรวจภายใน')} {left}s {t('ลูกค้าจะเห็นว่าชำระสำเร็จ (ยังต้องตรวจสลิปภายหลัง)')}</div> : <div className="small" style={{ color: 'var(--danger)' }}>{t('ระบบแจ้งลูกค้าว่าชำระสำเร็จแล้ว กรุณาตรวจสลิปให้เรียบร้อย')}</div>}
          {pay ? <PrepayReview p={pay} onDone={dismiss} /> : <div className="center"><span className="spinner" /></div>}
          <Button variant="ghost" onClick={dismiss}>{t('ตรวจภายหลัง')}</Button>
        </div>
      )}
    </Modal>
  );
}

/** Prints kitchen tickets of in-room QR orders. Every POS can print; a server-side claim makes sure each job prints once. */
function QueuedPrintWorker() {
  const { print } = usePrint();
  const busy = useRef(false);
  const enabled = () => localStorage.getItem('bb_print_qr_orders') !== 'false';
  const run = useCallback(async () => {
    if (busy.current || !enabled()) return;
    busy.current = true;
    try {
      const jobs = (await api.get('/print-jobs?status=QUEUED', { passive: true })).filter((j) => j.source && j.payload);
      for (const j of jobs.reverse()) {
        const c = await api.post(`/print-jobs/${j.id}/claim`, { device: localStorage.getItem('bb_device_key') || '' });
        if (!c.claimed) continue;
        // printed through the single queue; the job record (status / errors / reprint) is the server's claimed job
        await print({ docType: 'KITCHEN', data: j.payload }, { reference: j.reference, jobId: j.id, force: true });
      }
    } catch {
      /* retry on next tick */
    } finally {
      busy.current = false;
    }
  }, [print]);
  useSocketEvent('print:queued', run);
  useEffect(() => {
    run();
    const id = setInterval(run, 30000);
    return () => clearInterval(id);
  }, [run]);
  return null;
}

function IdleGuard() {
  const { settings, logout } = useAuth();
  const last = useRef(Date.now());
  const lastPing = useRef(0);
  useEffect(() => {
    const touch = () => {
      last.current = Date.now();
      if (Date.now() - lastPing.current > 60000) {
        lastPing.current = Date.now();
        api.post('/auth/ping').catch(() => {});
      }
    };
    ['mousedown', 'keydown', 'touchstart'].forEach((e) => window.addEventListener(e, touch, { passive: true }));
    const id = setInterval(() => {
      const idle = Number(settings?.security?.sessionIdleMinutes || 30) * 60000;
      if (Date.now() - last.current > idle) {
        sessionStorage.setItem('bb_logout_reason', 'หมดเวลาการใช้งาน กรุณาเข้าสู่ระบบใหม่');
        logout();
      }
    }, 15000);
    return () => {
      ['mousedown', 'keydown', 'touchstart'].forEach((e) => window.removeEventListener(e, touch));
      clearInterval(id);
    };
  }, [settings]);
  return null;
}

function Clock2() {
  const now = useServerNow(1000);
  return <span className="status-pill num hide-sm"><Clock size={14} />{new Date(now).toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok' })}</span>;
}

function Layout() {
  const { employee, logout, can, hasFeature, shift, settings, device } = useAuth();
  const [pwOpen, setPwOpen] = useState(false);
  const { theme, setTheme } = useApp();
  const { t, lang, setLang } = useT();
  const [open, setOpen] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [sockOk, setSockOk] = useState(true);
  const [queue, setQueue] = useState(offlineQueue.size());
  const [counts, setCounts] = useState({ notifications: 0, online: 0 });
  const loc = useLocation();
  const nav = useNavigate();
  useEffect(() => setOpen(false), [loc.pathname]);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    const un = offlineQueue.subscribe(setQueue);
    const s = getSocket();
    const c1 = () => setSockOk(true);
    const c2 = () => setSockOk(false);
    s?.on('connect', c1);
    s?.on('disconnect', c2);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
      un();
      s?.off('connect', c1);
      s?.off('disconnect', c2);
    };
  }, []);
  const loadCounts = useCallback(async () => {
    try {
      const [n, o] = await Promise.all([api.get('/notifications?unread=true&limit=1', { passive: true }), api.get('/reservations?source=ONLINE&status=HOLD,PENDING,DEPOSIT_PAID', { passive: true })]);
      setCounts({ notifications: n.unread, online: o.filter((x) => new Date(x.end_at) > new Date()).length });
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    loadCounts();
  }, []);
  useSync(['reservations', 'notifications'], loadCounts);
  useSocketEvent('notification:new', loadCounts);
  useSocketEvent('notification:read', loadCounts);
  const isOffline = !online || !sockOk;
  const gate = (path, el) => {
    const m = MENU.find((x) => x.to === path);
    return m?.feature && !hasFeature(m.feature) ? <NotInPlan /> : el;
  };
  const store = settings?.store;
  return (
    <div className="app">
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <div className="brand">
          <div className="brand-logo">{store?.logoUrl ? <img src={store.logoUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 10 }} /> : <Mic2 size={20} />}</div>
          <div className="grow">
            <div className="ellipsis">{store?.name || 'BEATBOX'}</div>
            <div className="xs muted ellipsis">{store?.branchName}</div>
          </div>
        </div>
        <nav>
          {MENU.filter((m) => m.group || ((!m.perm || can(m.perm)) && hasFeature(m.feature))).map((m, i) =>
            m.group ? (
              <div key={i} className="nav-group">{t(m.group)}</div>
            ) : (
              <NavLink key={m.to} to={`/admin/${m.to}`} className={({ isActive }) => `nav-item ${isActive ? 'on' : ''}`}>
                <m.icon size={18} />
                <span className="ellipsis">{t(m.label)}</span>
                {m.badge && counts[m.badge] > 0 && <span className="count">{counts[m.badge]}</span>}
              </NavLink>
            ),
          )}
        </nav>
        <div style={{ padding: 10, borderTop: '1px solid var(--border)' }} className="row nowrap">
          <div className="brand-logo" style={{ width: 34, height: 34 }}>{employee?.photoUrl ? <img src={employee.photoUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 10 }} /> : (employee?.name || '?')[0]}</div>
          <div className="grow">
            <div className="small bold ellipsis">{employee?.name}</div>
            <div className="xs muted">{employee?.role}</div>
          </div>
          {employee?.isOwner && <Button variant="ghost icon" icon={KeyRound} title={t('เปลี่ยนรหัสผ่าน')} onClick={() => setPwOpen(true)} />}
          <Button variant="ghost icon" icon={LogOut} title={t('ออกจากระบบ')} onClick={logout} />
        </div>
      </aside>
      {open && <div className="drawer-back" style={{ zIndex: 45 }} onClick={() => setOpen(false)} />}
      <div className="main">
        <SuperOwnerBanner />
        {isOffline && <div className="offline-bar">OFFLINE — {t('ระบบจะซิงก์ข้อมูลอัตโนมัติเมื่อกลับมาออนไลน์')} {queue > 0 && `(${queue} ${t('รายการรอซิงก์')})`}</div>}
        <header className="topbar">
          <Button variant="ghost icon" className="menu-btn" icon={Menu} onClick={() => setOpen(true)} />
          <button className="status-pill" style={{ cursor: 'pointer' }} onClick={() => nav('/admin/shifts')}>
            {shift ? <><span style={{ color: 'var(--ok)' }}>●</span> {t('รอบ')} {shift.shift_no}</> : <><Lock size={14} color="var(--warn)" /> {t('ยังไม่เปิดรอบ')}</>}
          </button>
          <span className="status-pill hide-sm">{device?.name || `POS #${device?.id || '-'}`}</span>
          <div className="grow" />
          <LicenseWidget />
          <Clock2 />
          <span className="status-pill" title={isOffline ? 'Offline' : 'Online'}>{isOffline ? <WifiOff size={14} color="var(--danger)" /> : <Wifi size={14} color="var(--ok)" />}<span className="hide-sm">{isOffline ? 'Offline' : 'Online'}</span></span>
          <Button variant="ghost" size="sm" icon={Globe} onClick={() => setLang(lang === 'th' ? 'en' : 'th')}>{lang === 'th' ? 'EN' : 'TH'}</Button>
          <Button variant="ghost icon" icon={theme === 'dark' ? Sun : Moon} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} />
          <Button variant="ghost icon" onClick={() => nav('/admin/notifications')} style={{ position: 'relative' }}>
            <Bell size={18} />
            {counts.notifications > 0 && <span className="badge" style={{ position: 'absolute', top: -2, right: -4, background: 'var(--accent)', color: '#fff', padding: '0 5px' }}>{counts.notifications}</span>}
          </Button>
        </header>
        <main className="content">
          <Suspense fallback={<Loading />}>
            <Routes>
              <Route path="dashboard" element={gate('dashboard', can('sales.view') ? <pages.dashboard /> : <Navigate to="/admin/rooms" />)} />
              <Route path="pos" element={gate('pos', <pages.pos />)} />
              <Route path="rooms" element={gate('rooms', <pages.rooms />)} />
              <Route path="calendar" element={gate('calendar', <pages.calendar />)} />
              <Route path="reservations" element={gate('reservations', <pages.reservations />)} />
              <Route path="online" element={gate('online', <pages.online />)} />
              <Route path="checkin" element={gate('checkin', <pages.checkin />)} />
              <Route path="members" element={gate('members', <pages.members />)} />
              <Route path="rewards" element={gate('rewards', <pages.rewards />)} />
              <Route path="products" element={gate('products', <pages.products />)} />
              <Route path="categories" element={gate('categories', <pages.categories />)} />
              <Route path="stock" element={gate('stock', <pages.stock />)} />
              <Route path="room-types" element={gate('room-types', <pages.roomTypes />)} />
              <Route path="rooms-manage" element={gate('rooms-manage', <pages.roomsManage />)} />
              <Route path="packages" element={gate('packages', <pages.packages />)} />
              <Route path="promotions" element={gate('promotions', <pages.promotions />)} />
              <Route path="deposits" element={gate('deposits', <pages.deposits />)} />
              <Route path="receipts" element={gate('receipts', <pages.receipts />)} />
              <Route path="shifts" element={gate('shifts', <pages.shifts />)} />
              <Route path="reports" element={gate('reports', <pages.reports />)} />
              <Route path="employees" element={gate('employees', can('employee.manage') ? <pages.employees /> : <Forbidden />)} />
              <Route path="display" element={gate('display', <pages.display />)} />
              <Route path="printers" element={gate('printers', <pages.printers />)} />
              <Route path="smart" element={gate('smart', <pages.smart />)} />
              <Route path="documents" element={gate('documents', can('settings.manage') ? <pages.documents /> : <Forbidden />)} />
              <Route path="settings" element={gate('settings', can('settings.manage') ? <pages.settings /> : <Forbidden />)} />
              <Route path="activity" element={gate('activity', can('activity.view') ? <pages.activity /> : <Forbidden />)} />
              <Route path="notifications" element={gate('notifications', <pages.notifications />)} />
              <Route path="*" element={<Navigate to="/admin/rooms" />} />
            </Routes>
          </Suspense>
        </main>
      </div>
      <AlertCenter />
      <RoomServiceAlerts />
      <QueuedPrintWorker />
      <IdleGuard />
      {pwOpen && <ChangePassword onClose={() => setPwOpen(false)} />}
    </div>
  );
}

/** Page of a feature outside the store's plan (the API refuses it too). */
function NotInPlan() {
  const { t } = useT();
  return (
    <div className="card center" style={{ padding: 40 }}>
      <Lock size={48} color="var(--warn)" />
      <h2>{t('แพ็กเกจปัจจุบันไม่รวมฟังก์ชันนี้')}</h2>
      <p className="muted">{t('กดที่แถบแพ็กเกจมุมขวาบนเพื่อดูแพ็กเกจและขออัปเกรด')}</p>
    </div>
  );
}

function Forbidden() {
  const { t } = useT();
  return (
    <div className="card center" style={{ padding: 40 }}>
      <Lock size={48} color="var(--danger)" />
      <h2>{t('คุณไม่มีสิทธิ์เข้าถึงหน้านี้')}</h2>
    </div>
  );
}

function StoreGate() {
  const { subscription } = useAuth();
  // package expired / suspended → every screen of the store switches to the expired page (data is kept)
  if (subscription && subscription.usable === false) return <ExpiredScreen />;
  return (
    <PrintProvider>
      <Layout />
    </PrintProvider>
  );
}

export default function AdminApp() {
  const { employee, ready } = useAuth();
  if (!ready) return <Loading />;
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Suspense fallback={<Loading />}><RegisterStore /></Suspense>} />
      <Route path="/platform/*" element={<Suspense fallback={<Loading />}><PlatformApp /></Suspense>} />
      <Route
        path="/admin/*"
        element={
          employee ? (
            <StoreGate />
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
      <Route path="*" element={<Navigate to={employee ? '/admin/rooms' : '/login'} replace />} />
    </Routes>
  );
}

import { lazy, Suspense, useEffect, useState, useRef, useCallback } from 'react';
import { Routes, Route, Navigate, NavLink, useNavigate, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, ShoppingCart, DoorOpen, CalendarDays, ClipboardList, Users, Package, Tags, Boxes, LayoutGrid, Timer, BadgePercent, Wallet,
  Receipt, Clock, BarChart3, UserCog, MonitorSmartphone, Printer, Settings, History, Bell, Sun, Moon, LogOut, Menu, Wifi, WifiOff, Globe, ScanLine,
  Gift, AlertTriangle, VolumeX, Plus, CreditCard, X, Mic2, Lock,
} from 'lucide-react';
import { useAuth, useApp } from '../lib/store.jsx';
import { useT } from '../lib/i18n.jsx';
import { api, offlineQueue } from '../lib/api.js';
import { useServerNow, useSocketEvent, useSync, getSocket } from '../lib/socket.js';
import { Button, Modal, Loading, PinPad, useToast, Badge } from '../components/ui.jsx';
import { PrintProvider } from '../components/PrintPreview.jsx';
import { fmtTime, fmtDateTime } from '@beatbox/shared/format.js';

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
  settings: lazy(() => import('./pages/Settings.jsx')),
  activity: lazy(() => import('./pages/ActivityLog.jsx')),
  notifications: lazy(() => import('./pages/Notifications.jsx')),
};

export const MENU = [
  { group: 'ภาพรวม' },
  { to: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, perm: 'sales.view' },
  { to: 'pos', label: 'หน้าขาย POS', icon: ShoppingCart, perm: 'pos.access' },
  { to: 'rooms', label: 'ห้องทั้งหมด', icon: DoorOpen },
  { group: 'การจอง' },
  { to: 'calendar', label: 'ตารางการจอง', icon: CalendarDays },
  { to: 'reservations', label: 'รายการจอง', icon: ClipboardList },
  { to: 'online', label: 'Online Booking', icon: Globe, badge: 'online' },
  { to: 'checkin', label: 'Check-in / ค้นหาการจอง', icon: ScanLine },
  { to: 'deposits', label: 'เงินมัดจำ', icon: Wallet },
  { group: 'ลูกค้า' },
  { to: 'members', label: 'สมาชิก', icon: Users, perm: 'member.view' },
  { to: 'rewards', label: 'Rewards & Tier', icon: Gift, perm: 'member.view' },
  { group: 'สินค้าและห้อง' },
  { to: 'products', label: 'สินค้า', icon: Package },
  { to: 'categories', label: 'หมวดหมู่', icon: Tags },
  { to: 'stock', label: 'สต็อก', icon: Boxes },
  { to: 'room-types', label: 'Type ห้อง', icon: LayoutGrid },
  { to: 'rooms-manage', label: 'จัดการห้อง', icon: DoorOpen },
  { to: 'packages', label: 'แพ็กเกจเวลา', icon: Timer },
  { to: 'promotions', label: 'โปรโมชั่น', icon: BadgePercent },
  { group: 'การเงิน' },
  { to: 'receipts', label: 'ประวัติใบเสร็จ', icon: Receipt },
  { to: 'shifts', label: 'เปิดและปิดรอบ', icon: Clock },
  { to: 'reports', label: 'รายงาน', icon: BarChart3, perm: 'reports.view' },
  { group: 'ระบบ' },
  { to: 'employees', label: 'พนักงาน', icon: UserCog, perm: 'employee.manage' },
  { to: 'display', label: 'Customer Display', icon: MonitorSmartphone },
  { to: 'printers', label: 'เครื่องพิมพ์', icon: Printer },
  { to: 'settings', label: 'ตั้งค่าร้าน', icon: Settings, perm: 'settings.manage' },
  { to: 'activity', label: 'Activity Log', icon: History, perm: 'activity.view' },
  { to: 'notifications', label: 'การแจ้งเตือน', icon: Bell, badge: 'notifications' },
];

function Login() {
  const { login, employee } = useAuth();
  const { publicSettings } = useApp();
  const { t, lang, setLang } = useT();
  const [pin, setPin] = useState('');
  const [err, setErr] = useState(sessionStorage.getItem('bb_logout_reason') || '');
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  useEffect(() => {
    if (employee) nav('/admin/rooms', { replace: true });
  }, [employee]);
  const submit = async (p) => {
    setBusy(true);
    setErr('');
    sessionStorage.removeItem('bb_logout_reason');
    try {
      await login(p);
      nav('/admin/rooms', { replace: true });
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
        <p className="muted">{t('กรอกรหัสพนักงาน 4 หลัก')}</p>
        <PinPad value={pin} onChange={setPin} onComplete={submit} busy={busy} />
        {busy && <div className="mt"><span className="spinner" /></div>}
        {err && <p style={{ color: 'var(--danger)' }}>{t(err)}</p>}
        <div className="row mt" style={{ justifyContent: 'center' }}>
          <a href="/display" className="small">Customer Display</a>
          <span className="muted">·</span>
          <a href="/book" className="small">{t('เว็บไซต์จองห้อง')}</a>
        </div>
      </div>
    </div>
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
  const { employee, logout, can, shift, settings, device } = useAuth();
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
          {MENU.filter((m) => m.group || !m.perm || can(m.perm)).map((m, i) =>
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
          <Button variant="ghost icon" icon={LogOut} title={t('ออกจากระบบ')} onClick={logout} />
        </div>
      </aside>
      {open && <div className="drawer-back" style={{ zIndex: 45 }} onClick={() => setOpen(false)} />}
      <div className="main">
        {isOffline && <div className="offline-bar">OFFLINE — {t('ระบบจะซิงก์ข้อมูลอัตโนมัติเมื่อกลับมาออนไลน์')} {queue > 0 && `(${queue} ${t('รายการรอซิงก์')})`}</div>}
        <header className="topbar">
          <Button variant="ghost icon" className="menu-btn" icon={Menu} onClick={() => setOpen(true)} />
          <button className="status-pill" style={{ cursor: 'pointer' }} onClick={() => nav('/admin/shifts')}>
            {shift ? <><span style={{ color: 'var(--ok)' }}>●</span> {t('รอบ')} {shift.shift_no}</> : <><Lock size={14} color="var(--warn)" /> {t('ยังไม่เปิดรอบ')}</>}
          </button>
          <span className="status-pill hide-sm">{device?.name || `POS #${device?.id || '-'}`}</span>
          <div className="grow" />
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
              <Route path="dashboard" element={can('sales.view') ? <pages.dashboard /> : <Navigate to="/admin/rooms" />} />
              <Route path="pos" element={<pages.pos />} />
              <Route path="rooms" element={<pages.rooms />} />
              <Route path="calendar" element={<pages.calendar />} />
              <Route path="reservations" element={<pages.reservations />} />
              <Route path="online" element={<pages.online />} />
              <Route path="checkin" element={<pages.checkin />} />
              <Route path="members" element={<pages.members />} />
              <Route path="rewards" element={<pages.rewards />} />
              <Route path="products" element={<pages.products />} />
              <Route path="categories" element={<pages.categories />} />
              <Route path="stock" element={<pages.stock />} />
              <Route path="room-types" element={<pages.roomTypes />} />
              <Route path="rooms-manage" element={<pages.roomsManage />} />
              <Route path="packages" element={<pages.packages />} />
              <Route path="promotions" element={<pages.promotions />} />
              <Route path="deposits" element={<pages.deposits />} />
              <Route path="receipts" element={<pages.receipts />} />
              <Route path="shifts" element={<pages.shifts />} />
              <Route path="reports" element={<pages.reports />} />
              <Route path="employees" element={can('employee.manage') ? <pages.employees /> : <Forbidden />} />
              <Route path="display" element={<pages.display />} />
              <Route path="printers" element={<pages.printers />} />
              <Route path="settings" element={can('settings.manage') ? <pages.settings /> : <Forbidden />} />
              <Route path="activity" element={can('activity.view') ? <pages.activity /> : <Forbidden />} />
              <Route path="notifications" element={<pages.notifications />} />
              <Route path="*" element={<Navigate to="/admin/rooms" />} />
            </Routes>
          </Suspense>
        </main>
      </div>
      <AlertCenter />
      <IdleGuard />
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

export default function AdminApp() {
  const { employee, ready } = useAuth();
  if (!ready) return <Loading />;
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/admin/*"
        element={
          employee ? (
            <PrintProvider>
              <Layout />
            </PrintProvider>
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
      <Route path="*" element={<Navigate to={employee ? '/admin/rooms' : '/login'} replace />} />
    </Routes>
  );
}

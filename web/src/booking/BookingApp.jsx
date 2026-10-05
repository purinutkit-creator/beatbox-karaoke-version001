// Customer Online Booking website (mobile-first). Same backend & database as the POS.
import { createContext, useContext, useEffect, useState, useCallback, lazy, Suspense } from 'react';
import { Routes, Route, NavLink, Link, useNavigate } from 'react-router-dom';
import { Home, CalendarPlus, DoorOpen, Package, BadgePercent, Search, CalendarCheck, Coins, Gift, User, Phone, Mic2, Sun, Moon, Globe, LogIn } from 'lucide-react';
import { useT } from '../lib/i18n.jsx';
import { useApp } from '../lib/store.jsx';
import { api, LS } from '../lib/api.js';
import { connectSocket } from '../lib/socket.js';
import { Button, Loading } from '../components/ui.jsx';

const BookFlow = lazy(() => import('./BookFlow.jsx'));
const P = {
  home: lazy(() => import('./Pages.jsx').then((m) => ({ default: m.HomePage }))),
  rooms: lazy(() => import('./Pages.jsx').then((m) => ({ default: m.RoomsPage }))),
  packages: lazy(() => import('./Pages.jsx').then((m) => ({ default: m.PackagesPage }))),
  promotions: lazy(() => import('./Pages.jsx').then((m) => ({ default: m.PromotionsPage }))),
  contact: lazy(() => import('./Pages.jsx').then((m) => ({ default: m.ContactPage }))),
  check: lazy(() => import('./Account.jsx').then((m) => ({ default: m.CheckBookingPage }))),
  mine: lazy(() => import('./Account.jsx').then((m) => ({ default: m.MyBookingsPage }))),
  points: lazy(() => import('./Account.jsx').then((m) => ({ default: m.PointsPage }))),
  rewards: lazy(() => import('./Account.jsx').then((m) => ({ default: m.RewardsPage }))),
  account: lazy(() => import('./Account.jsx').then((m) => ({ default: m.AccountPage }))),
  login: lazy(() => import('./Account.jsx').then((m) => ({ default: m.LoginPage }))),
  lineLink: lazy(() => import('./Account.jsx').then((m) => ({ default: m.LineLinkPage }))),
  lineDemo: lazy(() => import('./Account.jsx').then((m) => ({ default: m.LineDemoPage }))),
  booking: lazy(() => import('./Account.jsx').then((m) => ({ default: m.BookingDetailPage }))),
};

const MemberCtx = createContext(null);
export const useMember = () => useContext(MemberCtx);

export function MemberProvider({ children }) {
  const [me, setMe] = useState(null);
  const [ready, setReady] = useState(false);
  const load = useCallback(async () => {
    if (!LS.get('bb_member_token')) {
      setMe(null);
      return setReady(true);
    }
    try {
      setMe(await api.get('/public/me', { member: true }));
    } catch {
      LS.set('bb_member_token', null);
      setMe(null);
    } finally {
      setReady(true);
    }
  }, []);
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get('token')) {
      LS.set('bb_member_token', p.get('token'));
      p.delete('token');
      window.history.replaceState(null, '', `${window.location.pathname}${p.toString() ? `?${p}` : ''}`);
    }
    load();
  }, []);
  const login = (token) => {
    LS.set('bb_member_token', token);
    return load();
  };
  const logout = async () => {
    try {
      await api.post('/public/me/logout', {}, { member: true });
    } catch {
      /* ignore */
    }
    LS.set('bb_member_token', null);
    setMe(null);
  };
  return <MemberCtx.Provider value={{ me, ready, reload: load, login, logout }}>{children}</MemberCtx.Provider>;
}

const LINKS = [
  { to: '/book', label: 'หน้าแรก', icon: Home, end: true },
  { to: '/book/reserve', label: 'จองห้อง', icon: CalendarPlus },
  { to: '/book/rooms', label: 'ห้องของเรา', icon: DoorOpen },
  { to: '/book/packages', label: 'แพ็กเกจ', icon: Package },
  { to: '/book/promotions', label: 'โปรโมชั่น', icon: BadgePercent },
  { to: '/book/check', label: 'ตรวจสอบการจอง', icon: Search },
  { to: '/book/my-bookings', label: 'การจองของฉัน', icon: CalendarCheck },
  { to: '/book/points', label: 'คะแนนของฉัน', icon: Coins },
  { to: '/book/rewards', label: 'Rewards', icon: Gift },
  { to: '/book/account', label: 'สมาชิก', icon: User },
  { to: '/book/contact', label: 'ติดต่อร้าน', icon: Phone },
];

function Shell() {
  const { t, lang, setLang } = useT();
  const { publicSettings, theme, setTheme } = useApp();
  const { me } = useMember();
  const store = publicSettings?.store;
  useEffect(() => {
    connectSocket('public');
  }, []);
  return (
    <div className="bk">
      <header className="bk-nav">
        <div className="inner">
          <Link to="/book" className="row nowrap" style={{ color: 'var(--text)', fontWeight: 800 }}>
            <div className="brand-logo">{store?.logoUrl ? <img src={store.logoUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 10 }} /> : <Mic2 size={20} />}</div>
            <span className="ellipsis" style={{ maxWidth: 180 }}>{store?.name || 'BEATBOX'}</span>
          </Link>
          <nav className="bk-links grow">
            {LINKS.slice(1).map((l) => (
              <NavLink key={l.to} to={l.to} className={({ isActive }) => (isActive ? 'on' : '')}>{t(l.label)}</NavLink>
            ))}
          </nav>
          <div className="grow hide-desktop" />
          <Button size="sm" variant="ghost" icon={Globe} onClick={() => setLang(lang === 'th' ? 'en' : 'th')}>{lang === 'th' ? 'EN' : 'TH'}</Button>
          <Button size="sm" variant="ghost icon" icon={theme === 'dark' ? Sun : Moon} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} />
          {me ? (
            <Link to="/book/account" className="btn sm">{me.first_name}</Link>
          ) : (
            <Link to="/book/login" className="btn sm primary"><LogIn size={16} /> {t('เข้าสู่ระบบ')}</Link>
          )}
        </div>
      </header>
      <main className="bk-main">
        <Suspense fallback={<Loading />}>
          <Routes>
            <Route index element={<P.home />} />
            <Route path="reserve" element={<BookFlow />} />
            <Route path="rooms" element={<P.rooms />} />
            <Route path="packages" element={<P.packages />} />
            <Route path="promotions" element={<P.promotions />} />
            <Route path="check" element={<P.check />} />
            <Route path="my-bookings" element={<P.mine />} />
            <Route path="points" element={<P.points />} />
            <Route path="rewards" element={<P.rewards />} />
            <Route path="account" element={<P.account />} />
            <Route path="login" element={<P.login />} />
            <Route path="line-link" element={<P.lineLink />} />
            <Route path="line-demo" element={<P.lineDemo />} />
            <Route path="booking/:token" element={<P.booking />} />
            <Route path="contact" element={<P.contact />} />
          </Routes>
        </Suspense>
      </main>
      <footer className="center muted small" style={{ padding: 20, borderTop: '1px solid var(--border)' }}>
        {store?.name} · {store?.address} · {t('โทร')} {store?.phone} · {t('ร้านเปิด')} {store?.openTime}–{store?.closeTime} {t('น.')}
      </footer>
      <nav className="bottom-tabs">
        {[LINKS[0], LINKS[1], LINKS[6], LINKS[8], LINKS[9]].map((l) => (
          <NavLink key={l.to} to={l.to} end={l.end} className={({ isActive }) => (isActive ? 'on' : '')}>
            <l.icon size={20} />
            {t(l.label)}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

export default function BookingApp() {
  return (
    <MemberProvider>
      <Shell />
    </MemberProvider>
  );
}

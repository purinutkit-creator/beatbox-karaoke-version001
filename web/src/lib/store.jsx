import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api, LS, getDeviceKey, setDeviceStore } from './api.js';
import { applyAppearance, applyTheme } from './fonts.js';
import { useT } from './i18n.jsx';
import { connectSocket, disconnectSocket, useSync, useSocketEvent } from './socket.js';

const AppCtx = createContext(null);

/** Public settings (store, fonts, theme) shared by POS, Customer Display and Booking website. */
export function AppProvider({ children }) {
  const { lang } = useT();
  const [publicSettings, setPublicSettings] = useState(null);
  const [theme, setThemeState] = useState(LS.get('bb_theme') || null);
  const loadPublic = useCallback(async () => {
    try {
      setPublicSettings(await api.get('/public/settings', { auth: false }));
    } catch {
      /* offline */
    }
  }, []);
  useEffect(() => {
    loadPublic();
  }, [loadPublic]);
  useEffect(() => {
    const t = theme || publicSettings?.general?.defaultTheme || 'dark';
    document.documentElement.dataset.theme = t;
  }, [theme, publicSettings]);
  useEffect(() => {
    if (!publicSettings) return;
    applyAppearance(publicSettings.appearance, lang);
    applyTheme(publicSettings.general);
    document.title = publicSettings.store?.name || 'BEATBOX Karaoke';
  }, [publicSettings, lang]);
  const setTheme = (t) => {
    LS.set('bb_theme', t);
    setThemeState(t);
  };
  return <AppCtx.Provider value={{ publicSettings, reloadPublic: loadPublic, theme: theme || publicSettings?.general?.defaultTheme || 'dark', setTheme }}>{children}</AppCtx.Provider>;
}

export const useApp = () => useContext(AppCtx);

const AuthCtx = createContext(null);

/** Staff authentication, device registration, full settings and the current shift. */
export function AuthProvider({ children }) {
  const { reloadPublic } = useApp();
  const [employee, setEmployee] = useState(LS.get('bb_employee'));
  const [permissions, setPermissions] = useState(LS.get('bb_perms') || []);
  const [settings, setSettings] = useState(null);
  const [device, setDevice] = useState(LS.get('bb_device'));
  const [shift, setShift] = useState(null);
  const [ready, setReady] = useState(false);
  const [store, setStore] = useState(LS.get('bb_store_info'));
  const [subscription, setSubscription] = useState(null);

  const logoutLocal = useCallback((reason) => {
    LS.set('bb_token', null);
    LS.set('bb_employee', null);
    LS.set('bb_perms', null);
    setEmployee(null);
    setSubscription(null);
    setPermissions([]);
    disconnectSocket();
    if (reason) sessionStorage.setItem('bb_logout_reason', reason);
  }, []);

  const loadSettings = useCallback(async () => {
    const s = await api.get('/settings');
    setSettings(s);
    return s;
  }, []);
  const loadShift = useCallback(async () => {
    const d = LS.get('bb_device_id');
    if (!d) return null;
    const s = await api.get(`/shifts/current?deviceId=${d}`);
    setShift(s);
    return s;
  }, []);

  const bootstrap = useCallback(async () => {
    if (!LS.get('bb_token')) return setReady(true);
    try {
      const me = await api.get('/auth/me');
      setEmployee(me.employee);
      setPermissions(me.permissions);
      setSubscription(me.subscription);
      if (me.store) {
        // a Super Owner visiting a store must not re-assign this device to that store
        if (!me.employee?.superOwnerName) setDeviceStore(me.store);
        LS.set('bb_store_info', me.store);
        setStore(me.store);
      }
      if (!LS.get('bb_device_id') && !me.employee?.superOwnerName && me.subscription?.usable) {
        const dev = await api.post('/devices/register', { name: LS.get('bb_device_name') || `POS ${navigator.platform || ''}`.trim(), deviceKey: getDeviceKey() });
        LS.set('bb_device_id', dev.id);
        LS.set('bb_device', dev);
        setDevice(dev);
      }
      connectSocket('staff');
      if (me.subscription?.usable) await Promise.all([loadSettings(), loadShift()]);
    } catch (e) {
      if (e.status === 401) logoutLocal();
      if (e.status === 402) refreshSubscription();
    } finally {
      setReady(true);
    }
  }, [loadSettings, loadShift, logoutLocal]);

  useEffect(() => {
    bootstrap();
  }, []);
  useEffect(() => {
    const h = (e) => logoutLocal(e.detail || 'หมดเวลาการใช้งาน กรุณาเข้าสู่ระบบใหม่');
    window.addEventListener('bb:unauthorized', h);
    return () => window.removeEventListener('bb:unauthorized', h);
  }, [logoutLocal]);
  useSync(['settings'], () => {
    if (employee) loadSettings();
    reloadPublic();
  });
  useSync(['shifts'], () => employee && loadShift());

  /** Store the result of any login (PIN, owner e-mail, store registration, Super Owner "enter store"). */
  const applyLogin = async (r) => {
    LS.set('bb_token', r.token);
    LS.set('bb_employee', r.employee);
    LS.set('bb_perms', r.permissions);
    if (r.store) {
      if (!r.employee?.superOwnerName) setDeviceStore(r.store);
      LS.set('bb_store_info', r.store);
      setStore(r.store);
    }
    setEmployee(r.employee);
    setPermissions(r.permissions);
    setSubscription(r.subscription || null);
    await bootstrap();
    return r;
  };
  const login = async (pin) => applyLogin(await api.post('/auth/login', { pin, deviceId: LS.get('bb_device_id') }, { auth: false }));
  const loginOwner = async (email, password) => {
    const r = await api.post('/auth/owner-login', { email, password, deviceId: LS.get('bb_device_id') }, { auth: false });
    if (r.platform) {
      // Super Admin e-mail → central console
      LS.set('bb_platform_token', r.token);
      LS.set('bb_platform_user', r.user);
      window.location.assign('/platform');
      return r;
    }
    return applyLogin(r);
  };

  // subscription: re-read on push from the server (renewed / suspended / plan changed) or when an API call says it expired
  const refreshSubscription = useCallback(async () => {
    if (!LS.get('bb_token')) return null;
    try {
      const s = await api.get('/subscription', { passive: true });
      setSubscription(s.subscription);
      if (s.permissions) setPermissions(s.permissions);
      return s;
    } catch {
      return null;
    }
  }, []);
  useEffect(() => {
    const h = () => refreshSubscription();
    window.addEventListener('bb:subscription-expired', h);
    return () => window.removeEventListener('bb:subscription-expired', h);
  }, [refreshSubscription]);
  useSocketEvent('subscription:changed', async () => {
    const before = subscription?.usable;
    const s = await refreshSubscription();
    // renewed after expiry → load everything again (all data is still there)
    if (s?.subscription?.usable && !before) bootstrap();
  });
  // expiry is decided by the server clock: re-check exactly when the package should run out
  useEffect(() => {
    if (!subscription?.usable || !subscription.expiresAt) return;
    const skew = Number(subscription.serverNow || Date.now()) - Date.now();
    const ms = new Date(subscription.expiresAt).getTime() - (Date.now() + skew);
    if (ms > 2 ** 31 - 1) return;
    const id = setTimeout(refreshSubscription, Math.max(0, ms) + 1500);
    return () => clearTimeout(id);
  }, [subscription?.expiresAt, subscription?.usable, refreshSubscription]);

  const logout = async () => {
    try {
      await api.post('/auth/logout');
    } catch {
      /* ignore */
    }
    logoutLocal();
  };
  // permissions from the server are already "staff right AND plan feature"
  const can = (p) => permissions.includes(p);
  const hasFeature = (f) => !f || !subscription?.plan || !!subscription.plan.features?.[f];
  return (
    <AuthCtx.Provider value={{ employee, permissions, can, hasFeature, settings, setSettings, loadSettings, device, shift, loadShift, login, loginOwner, applyLogin, logout, ready, store, subscription, refreshSubscription }}>{children}</AuthCtx.Provider>
  );
}

export const useAuth = () => useContext(AuthCtx);

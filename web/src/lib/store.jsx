import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api, LS, getDeviceKey } from './api.js';
import { applyAppearance, applyTheme } from './fonts.js';
import { useT } from './i18n.jsx';
import { connectSocket, disconnectSocket, useSync } from './socket.js';

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

  const logoutLocal = useCallback((reason) => {
    LS.set('bb_token', null);
    LS.set('bb_employee', null);
    LS.set('bb_perms', null);
    setEmployee(null);
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
      if (!LS.get('bb_device_id')) {
        const dev = await api.post('/devices/register', { name: LS.get('bb_device_name') || `POS ${navigator.platform || ''}`.trim(), deviceKey: getDeviceKey() });
        LS.set('bb_device_id', dev.id);
        LS.set('bb_device', dev);
        setDevice(dev);
      }
      connectSocket('staff');
      await Promise.all([loadSettings(), loadShift()]);
    } catch (e) {
      if (e.status === 401) logoutLocal();
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

  const login = async (pin) => {
    const r = await api.post('/auth/login', { pin, deviceId: LS.get('bb_device_id') }, { auth: false });
    LS.set('bb_token', r.token);
    LS.set('bb_employee', r.employee);
    LS.set('bb_perms', r.permissions);
    setEmployee(r.employee);
    setPermissions(r.permissions);
    await bootstrap();
    return r;
  };
  const logout = async () => {
    try {
      await api.post('/auth/logout');
    } catch {
      /* ignore */
    }
    logoutLocal();
  };
  const can = (p) => employee?.role === 'ADMIN' || permissions.includes(p);
  return (
    <AuthCtx.Provider value={{ employee, permissions, can, settings, setSettings, loadSettings, device, shift, loadShift, login, logout, ready }}>{children}</AuthCtx.Provider>
  );
}

export const useAuth = () => useContext(AuthCtx);

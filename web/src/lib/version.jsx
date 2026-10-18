// New version watcher: a screen left open keeps running the code it loaded, so after an update it would still use the
// old behaviour (e.g. printing). The server reports its build; when it changes, the screen reloads itself as soon as
// nobody is using it (or shows a button). A screen with unsaved work (a POS cart) is never reloaded by itself.
import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useT } from './i18n.jsx';

/** The build this page runs (the main script's hashed file name), null in development. */
const myBuild = () => (document.querySelector('script[type="module"][src*="/assets/index-"]')?.getAttribute('src') || '').match(/index-[\w-]+\.js/)?.[0] || null;

/** Pages with work that a reload would lose call this (e.g. the POS while its cart has items). */
export function setUnsavedWork(key, on) {
  window.__bbUnsaved = { ...(window.__bbUnsaved || {}), [key]: !!on };
}
const hasUnsavedWork = () => Object.values(window.__bbUnsaved || {}).some(Boolean);

const IDLE_MS = 60_000;

export function UpdateWatcher() {
  const { t } = useT();
  const [fresh, setFresh] = useState(null); // the new build, once the server reports one
  const lastInput = useRef(Date.now());
  useEffect(() => {
    const mine = myBuild();
    if (!mine) return;
    const check = async () => {
      try {
        const r = await fetch('/api/version', { cache: 'no-store' }).then((x) => x.json());
        if (r.build && r.build !== mine) setFresh(r.build);
      } catch {
        /* offline */
      }
    };
    const touch = () => (lastInput.current = Date.now());
    const onVisible = () => document.visibilityState === 'visible' && check();
    ['pointerdown', 'keydown', 'touchstart'].forEach((e) => window.addEventListener(e, touch, { passive: true }));
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', check);
    const id = setInterval(check, 60_000);
    check();
    return () => {
      ['pointerdown', 'keydown', 'touchstart'].forEach((e) => window.removeEventListener(e, touch));
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', check);
      clearInterval(id);
    };
  }, []);
  useEffect(() => {
    if (!fresh) return;
    const p = window.location.pathname;
    // customer-facing pages in the middle of a booking / order only get the button
    const auto = !p.startsWith('/book') && !p.startsWith('/order');
    // reload by itself at most once per new build (while old and new servers overlap during an update the page could
    // still get the old one — then the button stays instead of reloading again and again)
    let tried = null;
    try {
      tried = sessionStorage.getItem('bb_reloaded_for');
    } catch {
      /* storage blocked */
    }
    const tryReload = () => {
      const busy = hasUnsavedWork() || document.querySelector('.modal') || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
      if (auto && tried !== fresh && !busy && (p.startsWith('/display') || Date.now() - lastInput.current > IDLE_MS)) {
        try {
          sessionStorage.setItem('bb_reloaded_for', fresh);
        } catch {
          /* storage blocked */
        }
        window.location.reload();
      }
    };
    tryReload();
    const id = setInterval(tryReload, 5000);
    return () => clearInterval(id);
  }, [fresh]);
  if (!fresh) return null;
  return (
    <button type="button" className="update-banner" onClick={() => window.location.reload()}>
      <RefreshCw size={16} /> {t('ระบบมีเวอร์ชันใหม่ — กดเพื่อโหลดใหม่')}
    </button>
  );
}

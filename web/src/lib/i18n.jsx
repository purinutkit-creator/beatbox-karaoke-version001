// TH/EN language switch. UI strings are written in Thai and translated with an EN dictionary keyed by the Thai text.
import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { EN } from './i18n-en.js';

let currentLang = (() => {
  try {
    return JSON.parse(localStorage.getItem('bb_lang')) || null;
  } catch {
    return null;
  }
})();

globalThis.__BB_LOCALE = currentLang === 'en' ? 'en-GB' : 'th-TH';

export function getLang() {
  return currentLang || 'th';
}

export function translate(text, vars, phrase = false) {
  if (text == null) return '';
  let s = String(text);
  if (getLang() === 'en') {
    if (EN[s] != null) s = EN[s];
    else if (phrase && THAI.test(s)) {
      // dynamic text (e.g. "ค่าห้อง 2 ชม. 30 นาที" or server messages): phrase-level replacement, longest phrases first
      for (const [th, en] of PHRASES) if (s.includes(th)) s = s.split(th).join(en);
      s = s.replace(/\s{2,}/g, ' ').trim();
    }
  }
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(v ?? '');
  return s;
}

// phrase-level fallbacks for dynamic server messages
const THAI = /[\u0E00-\u0E7F]/;
const PHRASES = Object.entries(EN)
  .filter(([th]) => th.trim().length >= 2 && !th.includes('{'))
  .sort((a, b) => b[0].length - a[0].length);

const Ctx = createContext({ lang: 'th', setLang: () => {}, t: translate, tp: translatePhrase });

export function LangProvider({ children, defaultLang = 'th' }) {
  const [lang, setLangState] = useState(currentLang || defaultLang);
  useEffect(() => {
    if (!currentLang) {
      currentLang = defaultLang;
      setLangState(defaultLang);
    }
  }, [defaultLang]);
  const setLang = useCallback((l) => {
    currentLang = l;
    globalThis.__BB_LOCALE = l === 'en' ? 'en-GB' : 'th-TH';
    try {
      localStorage.setItem('bb_lang', JSON.stringify(l));
    } catch {
      /* ignore */
    }
    setLangState(l);
  }, []);
  useEffect(() => {
    globalThis.__BB_LOCALE = lang === 'en' ? 'en-GB' : 'th-TH';
    document.documentElement.lang = lang;
    window.dispatchEvent(new CustomEvent('bb:lang', { detail: lang }));
  }, [lang]);
  const t = useCallback((s, v) => translate(s, v), [lang]);
  const tp = useCallback((s, v) => translate(s, v, true), [lang]);
  return <Ctx.Provider value={{ lang, setLang, t, tp }}>{children}</Ctx.Provider>;
}

export function useT() {
  return useContext(Ctx);
}

/** Inline component: <T>ข้อความ</T> */
/** Phrase-level translation for system-generated dynamic text (charge lines, server messages). Never use for user data. */
export function translatePhrase(text, vars) {
  return translate(text, vars, true);
}

export function T({ children, vars }) {
  const { t } = useT();
  return <>{t(children, vars)}</>;
}

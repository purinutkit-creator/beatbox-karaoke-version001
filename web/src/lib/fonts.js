// Font manager: any Google Font by family name, preset Thai fonts, Sukhumvit Set (system/local) and admin-imported fonts.
export const PRESET_FONTS = [
  { family: 'Sarabun', source: 'google', script: 'th' },
  { family: 'Kanit', source: 'google', script: 'th' },
  { family: 'Prompt', source: 'google', script: 'th' },
  { family: 'Noto Sans Thai', source: 'google', script: 'th' },
  { family: 'Sukhumvit Set', source: 'local', script: 'th', note: 'ฟอนต์ระบบของ Apple — อุปกรณ์อื่นต้องนำเข้าไฟล์ฟอนต์' },
  { family: 'IBM Plex Sans Thai', source: 'google', script: 'th' },
  { family: 'Mitr', source: 'google', script: 'th' },
  { family: 'Bai Jamjuree', source: 'google', script: 'th' },
  { family: 'Chakra Petch', source: 'google', script: 'th' },
  { family: 'Anuphan', source: 'google', script: 'th' },
  { family: 'Niramit', source: 'google', script: 'th' },
  { family: 'Pridi', source: 'google', script: 'th' },
  { family: 'Poppins', source: 'google', script: 'en' },
  { family: 'Inter', source: 'google', script: 'en' },
  { family: 'Roboto', source: 'google', script: 'en' },
  { family: 'Montserrat', source: 'google', script: 'en' },
  { family: 'Nunito', source: 'google', script: 'en' },
  { family: 'Open Sans', source: 'google', script: 'en' },
  { family: 'Lato', source: 'google', script: 'en' },
  { family: 'Raleway', source: 'google', script: 'en' },
  { family: 'Rubik', source: 'google', script: 'en' },
  { family: 'Space Grotesk', source: 'google', script: 'en' },
];

const loaded = new Set();

function addLink(href, id) {
  if (document.getElementById(id)) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = href;
  l.id = id;
  document.head.appendChild(l);
}

function addStyle(css, id) {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('style');
    el.id = id;
    document.head.appendChild(el);
  }
  el.textContent = css;
}

const slug = (s) => String(s).replace(/[^a-z0-9]+/gi, '-').toLowerCase();

/** Load a font family (custom import → local system font → Google Fonts). */
export function loadFont(family, customFonts = []) {
  if (!family || loaded.has(family)) return;
  loaded.add(family);
  const customs = customFonts.filter((f) => f.family === family);
  if (customs.length) {
    const css = customs
      .filter((f) => f.format !== 'css')
      .map((f) => `@font-face{font-family:'${family}';src:url('${f.url}') format('${f.format}');font-weight:${f.weight || 400};font-style:${f.style || 'normal'};font-display:swap;}`)
      .join('\n');
    if (css) addStyle(css, `font-custom-${slug(family)}`);
    customs.filter((f) => f.format === 'css').forEach((f, i) => addLink(f.url, `font-css-${slug(family)}-${i}`));
    return;
  }
  const preset = PRESET_FONTS.find((p) => p.family === family);
  if (preset?.source === 'local') {
    addStyle(
      `@font-face{font-family:'${family}';src:local('${family}'),local('SukhumvitSet-Text'),local('Sukhumvit Set Text');font-weight:400;font-display:swap;}
@font-face{font-family:'${family}';src:local('SukhumvitSet-Bold'),local('Sukhumvit Set Bold'),local('${family} Bold');font-weight:700;font-display:swap;}`,
      `font-local-${slug(family)}`,
    );
    return;
  }
  const fam = encodeURIComponent(family).replace(/%20/g, '+');
  // weighted request (works for most fonts) + plain request as a fallback for single-weight fonts
  addLink(`https://fonts.googleapis.com/css2?family=${fam}:wght@300;400;500;600;700&display=swap`, `gf-${slug(family)}`);
  addLink(`https://fonts.googleapis.com/css2?family=${fam}&display=swap`, `gf-plain-${slug(family)}`);
}

const q = (f) => `'${String(f).replace(/'/g, '')}'`;

/** Apply website + receipt fonts for the current language. */
export function applyAppearance(appearance = {}, lang = 'th') {
  const a = { thFont: 'Sarabun', enFont: 'Poppins', receiptThFont: 'Kanit', receiptEnFont: 'Kanit', customFonts: [], ...appearance };
  [a.thFont, a.enFont, a.receiptThFont, a.receiptEnFont].forEach((f) => loadFont(f, a.customFonts));
  const root = document.documentElement.style;
  root.setProperty('--font-th', q(a.thFont));
  root.setProperty('--font-en', q(a.enFont));
  const receiptMain = lang === 'en' ? a.receiptEnFont : a.receiptThFont;
  const receiptAlt = lang === 'en' ? a.receiptThFont : a.receiptEnFont;
  root.setProperty('--font-receipt', `${q(receiptMain)}, ${q(receiptAlt)}, sans-serif`);
}

export function applyTheme({ primaryColor, accentColor, backgroundUrl } = {}) {
  const root = document.documentElement.style;
  if (primaryColor) root.setProperty('--primary', primaryColor);
  if (accentColor) root.setProperty('--accent', accentColor);
  if (backgroundUrl) {
    document.body.classList.add('has-bg-image');
    document.body.style.setProperty('--bg-image', `url("${backgroundUrl}")`);
  } else document.body.classList.remove('has-bg-image');
}

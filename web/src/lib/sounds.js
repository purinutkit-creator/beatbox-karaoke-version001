// Kitchen / bar ticket alert sounds played on the device that prints: built-in sounds (made with Web Audio, no files),
// a spoken message, or an uploaded / recorded sound file. playAlert() resolves when the sound has finished,
// so "sound first, then print" can wait for it.

export const ALERT_SOUNDS = [
  { value: 'beep', label: 'ปิ๊บๆ (แบบเครื่องพิมพ์)' },
  { value: 'ding', label: 'ติ๊ง-ด่อง (กริ่งประตู)' },
  { value: 'bell', label: 'กระดิ่งครัว' },
  { value: 'chime', label: 'เสียงไล่โน้ต (สดใส)' },
  { value: 'alarm', label: 'สัญญาณด่วน' },
  { value: 'pop', label: 'ป๊อปเบาๆ' },
  { value: 'speech', label: 'เสียงพูด "มีออเดอร์ใหม่"' },
];
export const isSoundFile = (s) => typeof s === 'string' && (s.startsWith('/') || /^https?:\/\//.test(s));

let ctx;
function audio() {
  ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

/** One tone: frequency (Hz), start / length (s), wave, peak volume; decays smoothly so it never clicks. */
function tone(c, out, { f, at, len, type = 'sine', vol = 1, decay = true }) {
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.value = f;
  const t0 = c.currentTime + at;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t0 + 0.01);
  if (decay) g.gain.exponentialRampToValueAtTime(0.0001, t0 + len);
  else {
    g.gain.setValueAtTime(vol, t0 + len - 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + len);
  }
  o.connect(g).connect(out);
  o.start(t0);
  o.stop(t0 + len + 0.02);
}

// each built-in sound: (context, output, start) → length in seconds of one ring
const SYNTH = {
  beep: (c, out, at) => {
    for (let i = 0; i < 2; i++) tone(c, out, { f: 2700, at: at + i * 0.18, len: 0.11, type: 'square', vol: 0.35, decay: false });
    return 0.5;
  },
  ding: (c, out, at) => {
    tone(c, out, { f: 659, at, len: 0.9, vol: 0.9 });
    tone(c, out, { f: 1318, at, len: 0.4, vol: 0.2 });
    tone(c, out, { f: 523, at: at + 0.45, len: 1.2, vol: 0.9 });
    tone(c, out, { f: 1046, at: at + 0.45, len: 0.5, vol: 0.2 });
    return 1.6;
  },
  bell: (c, out, at) => {
    // a struck bell: inharmonic partials that fade at different speeds
    for (const [m, v, l] of [[1, 0.8, 1.6], [2.76, 0.35, 0.9], [5.4, 0.2, 0.5], [8.93, 0.1, 0.3]]) tone(c, out, { f: 880 * m, at, len: l, vol: v });
    return 1.0;
  },
  chime: (c, out, at) => {
    [523, 659, 784, 1046].forEach((f, i) => tone(c, out, { f, at: at + i * 0.13, len: 0.6, type: 'triangle', vol: 0.7 }));
    return 1.0;
  },
  alarm: (c, out, at) => {
    for (let i = 0; i < 6; i++) tone(c, out, { f: i % 2 ? 740 : 1100, at: at + i * 0.14, len: 0.13, type: 'sawtooth', vol: 0.3, decay: false });
    return 0.95;
  },
  pop: (c, out, at) => {
    const o = c.createOscillator();
    const g = c.createGain();
    const t0 = c.currentTime + at;
    o.frequency.setValueAtTime(400, t0);
    o.frequency.exponentialRampToValueAtTime(1200, t0 + 0.08);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.8, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
    o.connect(g).connect(out);
    o.start(t0);
    o.stop(t0 + 0.2);
    return 0.45;
  },
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function speakOnce(text, lang, volume) {
  return new Promise((resolve) => {
    if (!window.speechSynthesis) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang === 'en' ? 'en-US' : 'th-TH';
    u.volume = volume;
    u.rate = 0.95;
    u.onend = u.onerror = () => resolve();
    window.speechSynthesis.speak(u);
    setTimeout(resolve, 8000); // some browsers never fire onend
  });
}

function playFileOnce(url, volume) {
  return new Promise((resolve) => {
    const a = new Audio(url);
    a.volume = volume;
    const done = () => resolve();
    a.onended = done;
    a.onerror = done;
    a.play().catch(done); // blocked by the browser → don't hold the print
    setTimeout(done, 15000);
  });
}

/**
 * Play an alert sound and resolve when it has finished.
 * sound: built-in key or a file URL · times: how many rings · volume: 0–100 · text: what "speech" says.
 */
export async function playAlert(sound = 'beep', { times = 1, volume = 80, text, lang = 'th' } = {}) {
  const vol = Math.min(1, Math.max(0, Number(volume ?? 80) / 100));
  const n = Math.min(9, Math.max(1, Number(times) || 1));
  if (!vol) return;
  try {
    if (isSoundFile(sound)) {
      for (let i = 0; i < n; i++) await playFileOnce(sound, vol);
      return;
    }
    if (sound === 'speech') {
      for (let i = 0; i < Math.min(n, 3); i++) await speakOnce(text || (lang === 'en' ? 'New order' : 'มีออเดอร์ใหม่'), lang, vol);
      return;
    }
    const c = audio();
    const out = c.createGain();
    out.gain.value = vol * 0.5;
    out.connect(c.destination);
    const ring = SYNTH[sound] || SYNTH.beep;
    let at = 0.02;
    for (let i = 0; i < n; i++) at += ring(c, out, at) + 0.12;
    await wait(at * 1000);
  } catch {
    /* no audio on this device */
  }
}

// LINE rich menu (the menu under the chat): three buttons — จองห้อง (the booking website), ตรวจสอบการจอง (the chat
// asks for the phone number) and สมาชิก (the member page of the website). The picture is drawn here: colours, font,
// button style and texts are the store's choice (kept in the LINE settings), or the store uploads its own picture
// (2500 × 843 in three equal columns).
import { useEffect, useRef, useState } from 'react';
import { LayoutPanelTop, Upload, Trash2, Send, RotateCcw } from 'lucide-react';
import { Button, Field, Input, Select, Switch, Badge, useToast, useDialog } from '../../components/ui.jsx';
import { useT } from '../../lib/i18n.jsx';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/store.jsx';
import { PRESET_FONTS, loadFont } from '../../lib/fonts.js';

const W = 2500;
const H = 843;

/** Ready-made colour sets; "store" takes the colours of the store's theme. */
const THEMES = {
  store: { label: 'สีของร้าน' },
  night: { label: 'Neon Night', color1: '#1e1b4b', color2: '#7c3aed', tileColor: '#ffffff', tileOpacity: 12, textColor: '#ffffff', iconColor: '#f0abfc' },
  line: { label: 'LINE Green', color1: '#06c755', color2: '#04a745', tileColor: '#ffffff', tileOpacity: 18, textColor: '#ffffff', iconColor: '#ffffff' },
  gold: { label: 'Black Gold', color1: '#0a0a0a', color2: '#2a2a2a', tileColor: '#d4af37', tileOpacity: 16, textColor: '#f5e7b2', iconColor: '#d4af37' },
  ocean: { label: 'Ocean', color1: '#0ea5e9', color2: '#1e3a8a', tileColor: '#ffffff', tileOpacity: 15, textColor: '#ffffff', iconColor: '#a5f3fc' },
  sunset: { label: 'Sunset', color1: '#f97316', color2: '#db2777', tileColor: '#ffffff', tileOpacity: 18, textColor: '#ffffff', iconColor: '#fff7ed' },
  light: { label: 'Clean White', color1: '#ffffff', color2: '#f1f5f9', tileColor: '#7c3aed', tileOpacity: 10, textColor: '#1e1b4b', iconColor: '#7c3aed' },
};

const DEFAULT = {
  bar: 'เมนู',
  theme: 'store',
  color1: '#8b5cf6',
  color2: '#ec4899',
  tileColor: '#ffffff',
  tileOpacity: 14,
  textColor: '#ffffff',
  iconColor: '#ffffff',
  font: '',
  tileStyle: 'card', // card = rounded cards with a gap · flat = three panels with lines between
  highlightFirst: true,
  tiles: [
    { title: 'จองห้อง', sub: 'เว็บไซต์จองห้อง' },
    { title: 'ตรวจสอบการจอง', sub: 'พิมพ์เบอร์โทรในแชท' },
    { title: 'สมาชิก', sub: 'หน้าสมาชิก · แต้มสะสม' },
  ],
};

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

const rgba = (hex, a) => {
  const h = String(hex || '#ffffff').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16) || 0;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

// simple icons drawn on the picture (no icon font needed)
function iconCalendar(g, cx, cy, s, c) {
  g.lineWidth = s * 0.07;
  g.strokeStyle = c;
  g.fillStyle = c;
  roundRect(g, cx - s / 2, cy - s * 0.42, s, s * 0.88, s * 0.12);
  g.stroke();
  g.fillRect(cx - s / 2, cy - s * 0.42, s, s * 0.22);
  for (const dx of [-0.25, 0.25]) g.fillRect(cx + dx * s - s * 0.04, cy - s * 0.56, s * 0.08, s * 0.24);
  for (let r = 0; r < 2; r++) for (let k = 0; k < 3; k++) g.fillRect(cx - s * 0.33 + k * s * 0.26, cy - s * 0.02 + r * s * 0.2, s * 0.14, s * 0.12);
}
function iconSearch(g, cx, cy, s, c) {
  g.lineWidth = s * 0.1;
  g.strokeStyle = c;
  g.beginPath();
  g.arc(cx - s * 0.08, cy - s * 0.08, s * 0.32, 0, Math.PI * 2);
  g.stroke();
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(cx + s * 0.16, cy + s * 0.16);
  g.lineTo(cx + s * 0.45, cy + s * 0.45);
  g.stroke();
  g.lineCap = 'butt';
}
function iconMember(g, cx, cy, s, c) {
  g.lineWidth = s * 0.07;
  g.strokeStyle = c;
  g.fillStyle = c;
  roundRect(g, cx - s * 0.55, cy - s * 0.38, s * 1.1, s * 0.76, s * 0.1);
  g.stroke();
  g.beginPath();
  g.arc(cx - s * 0.22, cy - s * 0.06, s * 0.13, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.arc(cx - s * 0.22, cy + s * 0.27, s * 0.22, Math.PI, 0);
  g.fill();
  for (const dy of [-0.12, 0.04, 0.2]) g.fillRect(cx + s * 0.05, cy + dy * s, s * 0.34, s * 0.07);
}

/** Draw the menu picture from the design. */
async function drawMenu(canvas, d, fontFamily) {
  const g = canvas.getContext('2d');
  const font = `'${fontFamily.replace(/'/g, '')}', sans-serif`;
  // the chosen font must be loaded before it is drawn, or the browser's default is used
  await Promise.all([document.fonts?.load(`700 120px ${font}`, 'จองห้อง'), document.fonts?.load(`500 58px ${font}`, 'จองห้อง')]).catch(() => {});
  g.clearRect(0, 0, W, H);
  const bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, d.color1);
  bg.addColorStop(1, d.color2);
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  const cols = [[0, 833], [833, 834], [1667, 833]];
  const icons = [iconCalendar, iconSearch, iconMember];
  const a = Number(d.tileOpacity) / 100;
  cols.forEach(([x, w], i) => {
    const alpha = Math.min(1, a + (d.highlightFirst && i === 0 ? 0.1 : 0));
    g.fillStyle = rgba(d.tileColor, alpha);
    if (d.tileStyle === 'flat') {
      g.fillRect(x, 0, w, H);
      if (i > 0) {
        g.fillStyle = rgba(d.textColor, 0.35);
        g.fillRect(x - 2, 120, 4, H - 240);
      }
    } else {
      roundRect(g, x + 40, 40, w - 80, H - 80, 60);
      g.fill();
    }
    icons[i](g, x + w / 2, 300, 230, d.iconColor);
    g.fillStyle = d.textColor;
    g.textAlign = 'center';
    g.font = `700 120px ${font}`;
    g.fillText(d.tiles[i].title, x + w / 2, 610, w - 120);
    g.font = `500 58px ${font}`;
    g.globalAlpha = 0.9;
    g.fillText(d.tiles[i].sub, x + w / 2, 700, w - 120);
    g.globalAlpha = 1;
  });
  g.textAlign = 'left';
}

export function RichMenuCard({ ready, current, onChanged }) {
  const { t } = useT();
  const toast = useToast();
  const { confirm } = useDialog();
  const { settings, setSettings } = useAuth();
  const canvas = useRef(null);
  const storeColors = { color1: settings.general?.primaryColor || '#8b5cf6', color2: settings.general?.accentColor || '#ec4899' };
  const [d, setD] = useState(() => ({ ...DEFAULT, ...storeColors, ...(settings.line?.richMenu || {}) }));
  const [own, setOwn] = useState(null); // a picture of the store's own
  const [busy, setBusy] = useState(false);
  const appFont = getComputedStyle(document.documentElement).getPropertyValue('--font-ui').split(',')[0].replace(/['"]/g, '').trim() || 'Sarabun';
  const fontFamily = d.font || appFont;
  const customFonts = [...new Set((settings.appearance?.customFonts || []).map((f) => f.family))];
  useEffect(() => {
    if (d.font) loadFont(d.font, settings.appearance?.customFonts || []);
  }, [d.font]);
  useEffect(() => {
    if (own || !canvas.current) return;
    drawMenu(canvas.current, d, fontFamily);
  }, [d, own, fontFamily]);
  const set = (patch) => setD((x) => ({ ...x, ...patch }));
  const setTile = (i, k, v) => setD((x) => ({ ...x, tiles: x.tiles.map((y, j) => (j === i ? { ...y, [k]: v } : y)) }));
  const pickTheme = (key) => {
    const { label: _label, ...colors } = key === 'store' ? { ...storeColors, tileColor: '#ffffff', tileOpacity: 14, textColor: '#ffffff', iconColor: '#ffffff' } : THEMES[key];
    set({ theme: key, ...colors });
  };
  const pickOwn = (file) => {
    if (!file) return;
    if (file.size > 1024 * 1024) return toast.error('รูปต้องไม่เกิน 1 MB');
    setOwn({ file, url: URL.createObjectURL(file) });
  };
  const publish = async () => {
    setBusy(true);
    try {
      const blob = own ? own.file : await new Promise((ok) => canvas.current.toBlob(ok, 'image/jpeg', 0.9));
      if (!blob) throw new Error(t('สร้างรูปไม่สำเร็จ ลองอีกครั้ง'));
      const r = await api.post(`/integrations/line/richmenu?bar=${encodeURIComponent(d.bar)}`, blob, { contentType: blob.type || 'image/jpeg' });
      // keep the design for next time
      setSettings(await api.put('/settings/line', { ...settings.line, richMenu: d }));
      toast.success(`${t('ตั้งริชเมนูใน LINE OA แล้ว')} → ${r.uri}`);
      onChanged?.();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!(await confirm({ message: 'เอาริชเมนูออกจาก LINE OA?' }))) return;
    try {
      await api.del('/integrations/line/richmenu');
      toast.success('เอาริชเมนูออกแล้ว');
      onChanged?.();
    } catch (e) {
      toast.error(e);
    }
  };
  const color = (k, label) => (
    <Field label={label}>
      <div className="row nowrap">
        <input type="color" className="richmenu-color" value={d[k]} onChange={(e) => set({ [k]: e.target.value, theme: 'custom' })} />
        <Input value={d[k]} onChange={(e) => set({ [k]: e.target.value, theme: 'custom' })} style={{ maxWidth: 120 }} />
      </div>
    </Field>
  );
  return (
    <div className="card flat mt">
      <div className="row between">
        <b className="row nowrap"><LayoutPanelTop size={18} /> {t('ริชเมนู LINE OA')}</b>
        {current ? <Badge color="#16a34a">{t('ใช้งานอยู่')}</Badge> : <Badge color="#6b7280">{t('ยังไม่มีริชเมนู')}</Badge>}
      </div>
      <div className="small muted">{t('เมนูใต้ช่องแชทของลูกค้า 3 ปุ่ม: จองห้อง (เปิดเว็บไซต์จอง) · ตรวจสอบการจอง (ให้พิมพ์เบอร์โทรในแชท) · สมาชิก (เปิดหน้าสมาชิกบนเว็บไซต์)')}</div>
      <div className="richmenu-preview mt">
        {own ? <img src={own.url} alt="" /> : <canvas ref={canvas} width={W} height={H} />}
      </div>
      {!own && (
        <>
          <h4 className="mt">{t('ชุดสี')}</h4>
          <div className="richmenu-themes">
            {Object.entries(THEMES).map(([k, th]) => (
              <button key={k} type="button" className={`richmenu-theme ${d.theme === k ? 'on' : ''}`} onClick={() => pickTheme(k)} style={{ background: `linear-gradient(135deg, ${k === 'store' ? storeColors.color1 : th.color1}, ${k === 'store' ? storeColors.color2 : th.color2})`, color: th.textColor || '#fff' }}>
                {t(th.label)}
              </button>
            ))}
          </div>
          <div className="grid grid-3 mt">
            {color('color1', 'สีพื้นหลัง 1')}
            {color('color2', 'สีพื้นหลัง 2')}
            {color('tileColor', 'สีปุ่ม')}
            {color('textColor', 'สีตัวอักษร')}
            {color('iconColor', 'สีไอคอน')}
            <Field label={`${t('ความเข้มของปุ่ม')} ${d.tileOpacity}%`}>
              <input type="range" min={0} max={100} value={d.tileOpacity} onChange={(e) => set({ tileOpacity: Number(e.target.value), theme: 'custom' })} style={{ width: '100%' }} />
            </Field>
            <Field label="ฟอนต์">
              <Select value={d.font} onChange={(e) => set({ font: e.target.value })} options={[{ value: '', label: `${t('ฟอนต์ของระบบ')} (${appFont})` }, ...customFonts.map((f) => ({ value: f, label: `${f} (${t('นำเข้า')})` })), ...PRESET_FONTS.filter((f) => f.source === 'google').map((f) => ({ value: f.family, label: f.family }))]} />
            </Field>
            <Field label="รูปแบบปุ่ม">
              <Select value={d.tileStyle} onChange={(e) => set({ tileStyle: e.target.value })} options={[{ value: 'card', label: 'การ์ดมุมมน' }, { value: 'flat', label: 'แบ่งช่องเต็มแถบ' }]} />
            </Field>
            <Field label="ปุ่มแรก (จองห้อง)"><Switch checked={!!d.highlightFirst} onChange={(v) => set({ highlightFirst: v })} label="เน้นให้เด่นกว่า" /></Field>
          </div>
          <h4 className="mt">{t('ข้อความบนปุ่ม')}</h4>
          <div className="grid grid-3">
            {d.tiles.map((tile, i) => (
              <div key={i} className="col" style={{ gap: 6 }}>
                <Field label={`${t('ปุ่ม')} ${i + 1}: ${t(['เปิดเว็บไซต์จองห้อง', 'ถามเบอร์โทร / แสดงการจอง', 'เปิดหน้าสมาชิกบนเว็บไซต์'][i])}`}>
                  <Input value={tile.title} onChange={(e) => setTile(i, 'title', e.target.value)} />
                </Field>
                <Input value={tile.sub} onChange={(e) => setTile(i, 'sub', e.target.value)} />
              </div>
            ))}
            <Field label="ข้อความแถบเมนู (ไม่เกิน 14 ตัว)"><Input maxLength={14} value={d.bar} onChange={(e) => set({ bar: e.target.value })} /></Field>
          </div>
        </>
      )}
      <div className="row mt">
        <label className="btn">
          <Upload size={16} /> {t('ใช้รูปของร้านเอง (2500 × 843 แบ่ง 3 ช่องเท่ากัน)')}
          <input type="file" accept="image/png,image/jpeg" hidden onChange={(e) => pickOwn(e.target.files?.[0])} />
        </label>
        {own && <Button onClick={() => setOwn(null)}>{t('ใช้แบบที่ระบบออกแบบ')}</Button>}
        {!own && <Button variant="ghost" icon={RotateCcw} onClick={() => setD({ ...DEFAULT, ...storeColors })}>{t('ค่าเริ่มต้น')}</Button>}
        <span className="grow" />
        {current && <Button variant="ghost" icon={Trash2} onClick={remove}>{t('เอาออก')}</Button>}
        <Button variant="primary" icon={Send} loading={busy} disabled={!ready} onClick={publish}>{current ? t('อัปเดตริชเมนู') : t('สร้างริชเมนู')}</Button>
      </div>
      {!ready && <div className="xs muted mt">{t('ใส่ Access Token ของ Messaging API และกดบันทึกก่อน')}</div>}
    </div>
  );
}

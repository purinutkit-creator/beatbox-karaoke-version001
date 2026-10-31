// LINE rich menu (the menu under the chat) "เว็บไซต์จองห้อง": a picture drawn here in the store's colours (or the
// store's own picture, 2500 × 843) — tapping anywhere on it opens the booking website.
import { useEffect, useRef, useState } from 'react';
import { LayoutPanelTop, Upload, Trash2, Send } from 'lucide-react';
import { Button, Field, Input, Badge, useToast, useDialog } from '../../components/ui.jsx';
import { useT } from '../../lib/i18n.jsx';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/store.jsx';

const W = 2500;
const H = 843;

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

const loadImg = (src) =>
  new Promise((ok) => {
    if (!src) return ok(null);
    const i = new Image();
    i.crossOrigin = 'anonymous'; // a picture from elsewhere without permission is left out (the menu still works)
    i.onload = () => ok(i);
    i.onerror = () => ok(null);
    i.src = src;
  });

/** Draw the menu picture: store colours, logo, the big title, a line under it and a "book now" button. */
async function drawMenu(canvas, { title, subtitle, button, primary, accent, logoUrl, storeName, font }) {
  const g = canvas.getContext('2d');
  await document.fonts?.ready;
  const bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, primary);
  bg.addColorStop(1, accent);
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  // soft circles
  g.fillStyle = 'rgba(255,255,255,0.08)';
  for (const [x, y, r] of [[2250, 120, 360], [1850, 820, 260], [120, 760, 220]]) {
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  const logo = await loadImg(logoUrl);
  let x = 140;
  if (logo) {
    g.save();
    roundRect(g, x, 160, 300, 300, 70);
    g.clip();
    g.fillStyle = '#fff';
    g.fillRect(x, 160, 300, 300);
    const s = Math.min(280 / logo.width, 280 / logo.height);
    g.drawImage(logo, x + 150 - (logo.width * s) / 2, 310 - (logo.height * s) / 2, logo.width * s, logo.height * s);
    g.restore();
    x += 360;
  }
  g.fillStyle = '#fff';
  g.textBaseline = 'alphabetic';
  g.font = `600 64px ${font}`;
  g.globalAlpha = 0.85;
  g.fillText(storeName, x, 250);
  g.globalAlpha = 1;
  g.font = `800 170px ${font}`;
  g.fillText(title, x, 430, 1380 - (x - 140));
  g.font = `500 70px ${font}`;
  g.globalAlpha = 0.92;
  g.fillText(subtitle, x, 560, 1380 - (x - 140));
  g.globalAlpha = 1;
  // the button
  roundRect(g, 1700, 260, 660, 280, 140);
  g.fillStyle = '#ffffff';
  g.shadowColor = 'rgba(0,0,0,0.25)';
  g.shadowBlur = 40;
  g.fill();
  g.shadowBlur = 0;
  g.fillStyle = primary;
  g.font = `800 110px ${font}`;
  g.textAlign = 'center';
  g.fillText(`${button} ›`, 2030, 440, 600);
  g.textAlign = 'left';
  // a strip at the bottom
  g.fillStyle = 'rgba(0,0,0,0.18)';
  g.fillRect(0, H - 110, W, 110);
  g.fillStyle = '#fff';
  g.font = `600 56px ${font}`;
  g.fillText('ดูห้องว่าง · เลือกเวลา · จองและชำระมัดจำออนไลน์', 140, H - 38, W - 280);
}

export function RichMenuCard({ ready, current, onChanged }) {
  const { t } = useT();
  const toast = useToast();
  const { confirm } = useDialog();
  const { settings } = useAuth();
  const canvas = useRef(null);
  const [f, setF] = useState({ title: 'จองห้องคาราโอเกะ', subtitle: 'BOOK A ROOM · จองง่าย ได้ห้องทันที', button: 'จองเลย', bar: 'จองห้อง' });
  const [own, setOwn] = useState(null); // a picture of the store's own
  const [busy, setBusy] = useState(false);
  const font = getComputedStyle(document.documentElement).getPropertyValue('--font-ui').trim() || 'sans-serif';
  useEffect(() => {
    if (own || !canvas.current) return;
    drawMenu(canvas.current, { ...f, primary: settings.general?.primaryColor || '#8b5cf6', accent: settings.general?.accentColor || '#ec4899', logoUrl: settings.store?.logoUrl, storeName: settings.store?.name || '', font });
  }, [f, own]);
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
      const r = await api.post(`/integrations/line/richmenu?bar=${encodeURIComponent(f.bar)}`, blob, { contentType: blob.type || 'image/jpeg' });
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
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  return (
    <div className="card flat mt">
      <div className="row between">
        <b className="row nowrap"><LayoutPanelTop size={18} /> {t('ริชเมนู LINE OA: เว็บไซต์จองห้อง')}</b>
        {current ? <Badge color="#16a34a">{t('ใช้งานอยู่')}</Badge> : <Badge color="#6b7280">{t('ยังไม่มีริชเมนู')}</Badge>}
      </div>
      <div className="small muted">{t('เมนูใต้ช่องแชทของลูกค้า กดที่ไหนก็ได้บนรูปเพื่อเปิดเว็บไซต์จองห้องของร้าน')}</div>
      <div className="richmenu-preview mt">
        {own ? <img src={own.url} alt="" /> : <canvas ref={canvas} width={W} height={H} />}
      </div>
      {!own && (
        <div className="grid grid-2 mt">
          <Field label="หัวข้อใหญ่"><Input value={f.title} onChange={(e) => set('title', e.target.value)} /></Field>
          <Field label="บรรทัดรอง"><Input value={f.subtitle} onChange={(e) => set('subtitle', e.target.value)} /></Field>
          <Field label="ข้อความบนปุ่ม"><Input value={f.button} onChange={(e) => set('button', e.target.value)} /></Field>
          <Field label="ข้อความแถบเมนู (ไม่เกิน 14 ตัว)"><Input maxLength={14} value={f.bar} onChange={(e) => set('bar', e.target.value)} /></Field>
        </div>
      )}
      <div className="row mt">
        <label className="btn">
          <Upload size={16} /> {t('ใช้รูปของร้านเอง (2500 × 843)')}
          <input type="file" accept="image/png,image/jpeg" hidden onChange={(e) => pickOwn(e.target.files?.[0])} />
        </label>
        {own && <Button onClick={() => setOwn(null)}>{t('ใช้แบบที่ระบบออกแบบ')}</Button>}
        <span className="grow" />
        {current && <Button variant="ghost" icon={Trash2} onClick={remove}>{t('เอาออก')}</Button>}
        <Button variant="primary" icon={Send} loading={busy} disabled={!ready} onClick={publish}>{current ? t('อัปเดตริชเมนู') : t('สร้างริชเมนู')}</Button>
      </div>
      {!ready && <div className="xs muted mt">{t('ใส่ Access Token ของ Messaging API และกดบันทึกก่อน')}</div>}
    </div>
  );
}

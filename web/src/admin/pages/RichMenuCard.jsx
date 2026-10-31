// LINE rich menu (the menu under the chat): three buttons — จองห้อง (the booking website), ตรวจสอบการจอง (the chat
// asks for the phone number) and สมาชิก (the member page of the website) — on a picture drawn here in the
// store's colours, or the store's own picture (2500 × 843 in three equal columns).
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

// simple white icons drawn on the picture (no icon font needed)
function iconCalendar(g, cx, cy, s) {
  g.lineWidth = s * 0.07;
  g.strokeStyle = '#fff';
  roundRect(g, cx - s / 2, cy - s * 0.42, s, s * 0.88, s * 0.12);
  g.stroke();
  g.fillStyle = '#fff';
  g.fillRect(cx - s / 2, cy - s * 0.42, s, s * 0.22);
  for (const dx of [-0.25, 0.25]) g.fillRect(cx + dx * s - s * 0.04, cy - s * 0.56, s * 0.08, s * 0.24);
  for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) g.fillRect(cx - s * 0.33 + c * s * 0.26, cy - s * 0.02 + r * s * 0.2, s * 0.14, s * 0.12);
}
function iconSearch(g, cx, cy, s) {
  g.lineWidth = s * 0.1;
  g.strokeStyle = '#fff';
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
function iconMember(g, cx, cy, s) {
  g.lineWidth = s * 0.07;
  g.strokeStyle = '#fff';
  roundRect(g, cx - s * 0.55, cy - s * 0.38, s * 1.1, s * 0.76, s * 0.1);
  g.stroke();
  g.fillStyle = '#fff';
  g.beginPath();
  g.arc(cx - s * 0.22, cy - s * 0.06, s * 0.13, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.arc(cx - s * 0.22, cy + s * 0.27, s * 0.22, Math.PI, 0);
  g.fill();
  for (const dy of [-0.12, 0.04, 0.2]) g.fillRect(cx + s * 0.05, cy + dy * s, s * 0.34, s * 0.07);
}

/** Draw the menu picture: three buttons (จองห้อง | ตรวจสอบการจอง | สมาชิก) in the store colours. */
async function drawMenu(canvas, { tiles, primary, accent, font }) {
  const g = canvas.getContext('2d');
  await document.fonts?.ready;
  const bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, primary);
  bg.addColorStop(1, accent);
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  const cols = [[0, 833], [833, 834], [1667, 833]];
  const icons = [iconCalendar, iconSearch, iconMember];
  cols.forEach(([x, w], i) => {
    // each button: a lighter card, the icon, the label and a small line
    g.fillStyle = i === 0 ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.12)';
    roundRect(g, x + 40, 40, w - 80, H - 80, 60);
    g.fill();
    icons[i](g, x + w / 2, 300, 230);
    g.fillStyle = '#fff';
    g.textAlign = 'center';
    g.font = `800 120px ${font}`;
    g.fillText(tiles[i].title, x + w / 2, 610, w - 120);
    g.font = `500 58px ${font}`;
    g.globalAlpha = 0.9;
    g.fillText(tiles[i].sub, x + w / 2, 700, w - 120);
    g.globalAlpha = 1;
  });
  g.textAlign = 'left';
}

export function RichMenuCard({ ready, current, onChanged }) {
  const { t } = useT();
  const toast = useToast();
  const { confirm } = useDialog();
  const { settings } = useAuth();
  const canvas = useRef(null);
  const [f, setF] = useState({
    bar: 'เมนู',
    tiles: [
      { title: 'จองห้อง', sub: 'เว็บไซต์จองห้อง' },
      { title: 'ตรวจสอบการจอง', sub: 'พิมพ์เบอร์โทรในแชท' },
      { title: 'สมาชิก', sub: 'หน้าสมาชิก · แต้มสะสม' },
    ],
  });
  const [own, setOwn] = useState(null); // a picture of the store's own
  const [busy, setBusy] = useState(false);
  const font = getComputedStyle(document.documentElement).getPropertyValue('--font-ui').trim() || 'sans-serif';
  useEffect(() => {
    if (own || !canvas.current) return;
    drawMenu(canvas.current, { tiles: f.tiles, primary: settings.general?.primaryColor || '#8b5cf6', accent: settings.general?.accentColor || '#ec4899', font });
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
        <div className="grid grid-3 mt">
          {f.tiles.map((tile, i) => (
            <div key={i} className="col" style={{ gap: 6 }}>
              <Field label={`${t('ปุ่ม')} ${i + 1}: ${t(['เปิดเว็บไซต์จองห้อง', 'ถามเบอร์โทร / แสดงการจอง', 'เปิดหน้าสมาชิกบนเว็บไซต์'][i])}`}>
                <Input value={tile.title} onChange={(e) => setF((x) => ({ ...x, tiles: x.tiles.map((y, k) => (k === i ? { ...y, title: e.target.value } : y)) }))} />
              </Field>
              <Input value={tile.sub} onChange={(e) => setF((x) => ({ ...x, tiles: x.tiles.map((y, k) => (k === i ? { ...y, sub: e.target.value } : y)) }))} />
            </div>
          ))}
          <Field label="ข้อความแถบเมนู (ไม่เกิน 14 ตัว)"><Input maxLength={14} value={f.bar} onChange={(e) => setF((x) => ({ ...x, bar: e.target.value }))} /></Field>
        </div>
      )}
      <div className="row mt">
        <label className="btn">
          <Upload size={16} /> {t('ใช้รูปของร้านเอง (2500 × 843 แบ่ง 3 ช่องเท่ากัน)')}
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

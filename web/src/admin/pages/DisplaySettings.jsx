import { useEffect, useRef, useState } from 'react';
import { MonitorSmartphone, RefreshCw, ArrowUp, ArrowDown, ExternalLink, Copy, Image as ImageIcon, Film, Upload, Link2 } from 'lucide-react';
import { CrudPage } from '../../components/Crud.jsx';
import { PageHead, Button, Badge, Img, Switch, QRCode, Input, useToast } from '../../components/ui.jsx';
import { useT } from '../../lib/i18n.jsx';
import { api, uploadInChunks } from '../../lib/api.js';
import { useAuth } from '../../lib/store.jsx';
import { useLive, useSocketEvent, getSocket } from '../../lib/socket.js';
import { ensurePairCode, pushDisplay, idleDisplay } from '../../lib/display.js';
import { slideKind, youtubeId } from '../../lib/media.js';

/** Small preview of a slide (picture, video file or YouTube thumbnail). */
function SlideThumb({ item, style }) {
  const kind = slideKind(item);
  if (kind === 'YOUTUBE') return <Img src={`https://img.youtube.com/vi/${youtubeId(item.image_url)}/hqdefault.jpg`} style={style} />;
  if (kind === 'VIDEO') return <video src={item.image_url} muted playsInline preload="metadata" style={{ ...style, background: '#000' }} />;
  return <Img src={item.image_url} style={style} />;
}

/** Picture or video for a promotion slide: upload a file (main way) or paste a link (video file / YouTube / picture). */
function MediaInput({ form, set }) {
  const { t } = useT();
  const toast = useToast();
  const fileRef = useRef(null);
  const [progress, setProgress] = useState(null); // null | 0..1 while uploading
  const [drag, setDrag] = useState(false);
  const [showUrl, setShowUrl] = useState(!!form.imageUrl && !form.imageUrl.startsWith('/uploads/media/'));
  const video = form.mediaType === 'VIDEO';
  const send = async (file) => {
    if (!file) return;
    const isVideo = file.type.startsWith('video/') || /\.(mp4|m4v|webm|mov)$/i.test(file.name);
    if (file.size > (isVideo ? 40 : 10) * 1024 * 1024) return toast.error(isVideo ? 'ไฟล์ใหญ่เกินไป (วิดีโอไม่เกิน 40 MB)' : 'ไฟล์ใหญ่เกินไป (รูปไม่เกิน 10 MB)');
    setProgress(0);
    try {
      const r = await uploadInChunks('/promotion-images/upload', file, setProgress);
      set('imageUrl', r.url);
      set('mediaType', r.mediaType);
      if (!form.title) set('title', file.name.replace(/\.[^.]+$/, ''));
      toast.success(r.mediaType === 'VIDEO' ? 'อัปโหลดวิดีโอแล้ว' : 'อัปโหลดรูปแล้ว');
    } catch (e) {
      toast.error(e);
    } finally {
      setProgress(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };
  const onUrl = (url) => {
    set('imageUrl', url);
    set('mediaType', slideKind({ image_url: url }) === 'IMAGE' ? 'IMAGE' : 'VIDEO');
  };
  return (
    <div className="col" style={{ gap: 8 }}>
      <input ref={fileRef} type="file" hidden accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime,.mp4,.m4v,.webm,.mov" onChange={(e) => send(e.target.files?.[0])} />
      <div
        className={`media-drop ${drag ? 'drag' : ''}`}
        role="button"
        tabIndex={0}
        onClick={() => progress == null && fileRef.current?.click()}
        onKeyDown={(e) => e.key === 'Enter' && fileRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); send(e.dataTransfer.files?.[0]); }}
      >
        {form.imageUrl ? (
          <SlideThumb item={{ image_url: form.imageUrl, media_type: form.mediaType }} style={{ width: 200, height: 112, borderRadius: 10, objectFit: 'cover', flex: 'none' }} />
        ) : (
          <div className="media-drop-icon"><Upload size={30} /></div>
        )}
        <div className="col" style={{ gap: 4, flex: 1, minWidth: 0 }}>
          {progress != null ? (
            <>
              <b>{t('กำลังอัปโหลด')} {Math.round(progress * 100)}%</b>
              <div className="media-progress"><span style={{ width: `${Math.round(progress * 100)}%` }} /></div>
            </>
          ) : (
            <>
              <b className="row nowrap" style={{ gap: 6 }}>{form.imageUrl ? <>{video ? <Film size={16} /> : <ImageIcon size={16} />} {t(video ? 'วิดีโอ' : 'รูปภาพ')} · {t('กดเพื่อเปลี่ยนไฟล์')}</> : t('กดเพื่ออัปโหลดรูปหรือวิดีโอ หรือลากไฟล์มาวางที่นี่')}</b>
              <span className="small muted">{t('รูป .jpg .png .webp .gif (ไม่เกิน 10 MB) · วิดีโอ .mp4 .webm .mov (ไม่เกิน 40 MB) · แนะนำแนวนอน 16:9')}</span>
              {video && <span className="small muted">{t('วิดีโอเล่นแบบปิดเสียงจนจบ แล้วจึงไปสไลด์ถัดไป')}</span>}
            </>
          )}
        </div>
      </div>
      <button type="button" className="link-btn small" onClick={() => setShowUrl((v) => !v)}><Link2 size={14} /> {t(showUrl ? 'ซ่อนช่องใส่ลิงก์' : 'หรือใส่เป็นลิงก์ (ลิงก์รูป / ไฟล์วิดีโอ / YouTube)')}</button>
      {showUrl && (
        <>
          <Input value={form.imageUrl || ''} onChange={(e) => onUrl(e.target.value.trim())} placeholder="https://.../promo.jpg  ·  https://.../promo.mp4  ·  https://youtu.be/..." />
          <div className="small muted">{t('ลิงก์ YouTube จะเปลี่ยนสไลด์ตาม "เวลาแสดงต่อสไลด์"')}</div>
        </>
      )}
    </div>
  );
}

export default function DisplaySettings() {
  const { t } = useT();
  const toast = useToast();
  const { settings, can, loadSettings } = useAuth();
  const [pair, setPair] = useState(null);
  const [online, setOnline] = useState(false);
  const { data: images, reload } = useLive(() => api.get('/promotion-images'), ['promotion-images'], []);
  const load = async (regen = false) => {
    try {
      const p = await ensurePairCode(regen);
      setPair(p);
      setOnline(p.online);
    } catch (e) {
      toast.error(e);
    }
  };
  useEffect(() => {
    load();
  }, []);
  useSocketEvent('display:presence', (p) => {
    if (p.code === pair?.pair_code) setOnline(p.online);
  });
  const url = pair ? `${window.location.origin}/display?code=${pair.pair_code}` : '';
  const move = async (idx, dir) => {
    const ids = images.map((i) => i.id);
    const j = idx + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[idx], ids[j]] = [ids[j], ids[idx]];
    await api.post('/promotion-images/reorder', { ids });
    reload();
  };
  const autoplay = settings?.general?.displayAutoplay !== false;
  return (
    <div>
      <PageHead icon={MonitorSmartphone} title="Customer Display" />
      <div className="grid grid-2">
        <div className="card center">
          <div className="muted">{t('รหัสเชื่อมต่อหน้าจอลูกค้าของเครื่องนี้')}</div>
          <div style={{ fontSize: '4rem', fontWeight: 800, letterSpacing: 10 }}>{pair?.pair_code || '----'}</div>
          <Badge color={online ? '#16a34a' : '#dc2626'}>{online ? t('เชื่อมต่อแล้ว') : t('ยังไม่เชื่อมต่อ')}</Badge>
          <p className="small muted">{t('เปิด')} <b>{window.location.origin}/display</b> {t('บนอุปกรณ์อื่น (แท็บเล็ต / Smart TV / มือถือ / จอที่สอง) แล้วกรอกรหัสนี้')}</p>
          {url && <QRCode value={url} size={150} />}
          <div className="row mt" style={{ justifyContent: 'center' }}>
            <Button icon={ExternalLink} onClick={() => window.open(url, '_blank')}>{t('เปิดหน้าจอลูกค้า')}</Button>
            <Button icon={Copy} onClick={() => navigator.clipboard?.writeText(url).then(() => toast.success('คัดลอกลิงก์แล้ว'))}>{t('คัดลอกลิงก์')}</Button>
            <Button icon={RefreshCw} onClick={() => load(true)}>{t('สร้างรหัสใหม่')}</Button>
          </div>
        </div>
        <div className="card">
          <h3>{t('ทดสอบหน้าจอลูกค้า')}</h3>
          <div className="col">
            <Button onClick={() => idleDisplay()}>{t('แสดงรูปโปรโมชั่นเต็มจอ')}</Button>
            <Button onClick={() => pushDisplay({ mode: 'CART', items: [{ name: 'โค้ก', qty: 2, unitPrice: 35, total: 70 }, { name: 'ค่าห้อง 2 ชม.', qty: 1, unitPrice: 798, total: 798 }], subtotal: 868, total: 868, net: 868, roomName: 'BEATBOX 01', roomType: 'Deluxe', minutes: 120 })}>{t('แสดงรายการขาย')}</Button>
            <Button onClick={() => pushDisplay({ mode: 'PAY_CASH', total: 868, net: 868, due: 868, received: 1000, change: 132, items: [] })}>{t('แสดงรับเงินสด/เงินทอน')}</Button>
            <Button onClick={() => pushDisplay({ mode: 'PAY_QR', net: 868, due: 868, items: [], qr: { data: '00020101021229370016A000000677010111011300668123456785303764540586800.005802TH6304ABCD', accountName: settings?.payment?.accountName, accountNumber: settings?.payment?.accountNumber, bankName: settings?.payment?.bankName } })}>{t('แสดง QR Code')}</Button>
            <Button onClick={() => pushDisplay({ mode: 'SUCCESS', total: 868, paid: 1000, change: 132 })}>{t('แสดงชำระเงินเรียบร้อย')}</Button>
            {can('settings.manage') && (
              <Switch checked={autoplay} onChange={async (v) => { await api.put('/settings/general', { ...settings.general, displayAutoplay: v }); loadSettings(); }} label="ให้รูปเลื่อนอัตโนมัติ" />
            )}
            {can('settings.manage') && (
              <div className="col" style={{ gap: 4 }}>
                <b className="small">{t('กล้องสแกน QR การจองที่จอลูกค้า')}</b>
                <div className="seg">
                  {[{ v: 'user', l: 'กล้องหน้า (ฝั่งลูกค้า)' }, { v: 'environment', l: 'กล้องหลัง' }].map((o) => (
                    <button key={o.v} type="button" className={(settings?.general?.displayCameraFacing || 'user') === o.v ? 'on' : ''} onClick={async () => { await api.put('/settings/general', { ...settings.general, displayCameraFacing: o.v }); loadSettings(); }}>{t(o.l)}</button>
                  ))}
                </div>
                <div className="xs muted">{t('หน้าจอลูกค้าเปิดกล้องค้างไว้ระหว่างลูกค้าแต่ละคน จึงขออนุญาตกล้องแค่ครั้งแรก · ให้อนุญาตถาวร: iPad → การตั้งค่า > Safari > กล้อง > อนุญาต · Android/Chrome → แตะไอคอนแม่กุญแจข้างที่อยู่เว็บ > กล้อง > อนุญาต')}</div>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="mt">
        <CrudPage
          title="รูป / วิดีโอโปรโมชั่นบนหน้าจอลูกค้า"
          endpoint="/promotion-images"
          topics={['promotion-images']}
          createPerm="settings.manage"
          editPerm="settings.manage"
          deletePerm="settings.manage"
          searchKeys={['title']}
          defaults={{ mediaType: 'IMAGE', durationSeconds: 8, sortOrder: (images?.length || 0) + 1, showOnDisplay: true, showOnWebsite: true, isActive: true }}
          toForm={(r) => ({ id: r.id, title: r.title, imageUrl: r.image_url, mediaType: slideKind(r) === 'IMAGE' ? 'IMAGE' : 'VIDEO', linkUrl: r.link_url, durationSeconds: r.duration_seconds, sortOrder: r.sort_order, showOnDisplay: r.show_on_display, showOnWebsite: r.show_on_website, isActive: r.is_active })}
          columns={[
            { label: 'ลำดับ', render: (r) => { const i = images?.findIndex((x) => x.id === r.id); return <div className="row nowrap"><Button size="sm" variant="ghost" icon={ArrowUp} onClick={() => move(i, -1)} /><Button size="sm" variant="ghost" icon={ArrowDown} onClick={() => move(i, 1)} /></div>; } },
            { label: 'รูป / วิดีโอ', render: (r) => <div style={{ position: 'relative', width: 120 }}><SlideThumb item={r} style={{ width: 120, height: 68, objectFit: 'cover', borderRadius: 8, display: 'block' }} />{slideKind(r) !== 'IMAGE' && <span className="slide-tag"><Film size={12} /> {slideKind(r) === 'YOUTUBE' ? 'YouTube' : t('วิดีโอ')}</span>}</div> },
            { key: 'title', label: 'ชื่อ' },
            { label: 'เวลาแสดง', render: (r) => (slideKind(r) === 'VIDEO' ? t('จนวิดีโอจบ') : `${r.duration_seconds} ${t('วินาที')}`) },
            { key: 'link_url', label: 'ลิงก์' },
            { label: 'แสดงที่', render: (r) => <>{r.show_on_display && <Badge>Display</Badge>} {r.show_on_website && <Badge>Website</Badge>}</> },
            { label: 'สถานะ', render: (r) => (r.is_active ? <Badge color="#16a34a">{t('เปิด')}</Badge> : <Badge color="#6b7280">{t('ปิด')}</Badge>) },
          ]}
          fields={[
            { key: 'title', label: 'ชื่อสไลด์' },
            { key: 'durationSeconds', label: 'เวลาแสดงต่อสไลด์ (วินาที)', type: 'number', hint: 'วิดีโอไฟล์จะเล่นจนจบเอง' },
            { key: 'imageUrl', label: 'รูปภาพ / วิดีโอ', type: 'custom', full: true, required: true, render: (form, set) => <MediaInput form={form} set={set} /> },
            { key: 'linkUrl', label: 'ลิงก์ของรูป', full: true },
            { key: 'sortOrder', label: 'ลำดับ', type: 'number' },
            { key: 'isActive', label: 'สถานะ', type: 'switch', switchLabel: 'เปิดแสดง' },
            { key: 'showOnDisplay', label: 'หน้าจอลูกค้า', type: 'switch', switchLabel: 'แสดง' },
            { key: 'showOnWebsite', label: 'เว็บไซต์จอง (Banner)', type: 'switch', switchLabel: 'แสดง' },
          ]}
        />
      </div>
    </div>
  );
}

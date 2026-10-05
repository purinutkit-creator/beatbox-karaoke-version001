import { useEffect, useState } from 'react';
import { MonitorSmartphone, RefreshCw, ArrowUp, ArrowDown, ExternalLink, Copy } from 'lucide-react';
import { CrudPage } from '../../components/Crud.jsx';
import { PageHead, Button, Badge, Img, Switch, QRCode, useToast } from '../../components/ui.jsx';
import { useT } from '../../lib/i18n.jsx';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/store.jsx';
import { useLive, useSocketEvent, getSocket } from '../../lib/socket.js';
import { ensurePairCode, pushDisplay, idleDisplay } from '../../lib/display.js';

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
          </div>
        </div>
      </div>
      <div className="mt">
        <CrudPage
          title="รูปโปรโมชั่นบนหน้าจอลูกค้า"
          endpoint="/promotion-images"
          topics={['promotion-images']}
          createPerm="settings.manage"
          editPerm="settings.manage"
          deletePerm="settings.manage"
          searchKeys={['title']}
          defaults={{ durationSeconds: 8, sortOrder: (images?.length || 0) + 1, showOnDisplay: true, showOnWebsite: true, isActive: true }}
          toForm={(r) => ({ id: r.id, title: r.title, imageUrl: r.image_url, linkUrl: r.link_url, durationSeconds: r.duration_seconds, sortOrder: r.sort_order, showOnDisplay: r.show_on_display, showOnWebsite: r.show_on_website, isActive: r.is_active })}
          columns={[
            { label: 'ลำดับ', render: (r) => { const i = images?.findIndex((x) => x.id === r.id); return <div className="row nowrap"><Button size="sm" variant="ghost" icon={ArrowUp} onClick={() => move(i, -1)} /><Button size="sm" variant="ghost" icon={ArrowDown} onClick={() => move(i, 1)} /></div>; } },
            { label: 'รูป', render: (r) => <Img src={r.image_url} style={{ width: 120, height: 68, objectFit: 'cover', borderRadius: 8 }} /> },
            { key: 'title', label: 'ชื่อ' },
            { label: 'เวลาแสดง', render: (r) => `${r.duration_seconds} ${t('วินาที')}` },
            { key: 'link_url', label: 'ลิงก์' },
            { label: 'แสดงที่', render: (r) => <>{r.show_on_display && <Badge>Display</Badge>} {r.show_on_website && <Badge>Website</Badge>}</> },
            { label: 'สถานะ', render: (r) => (r.is_active ? <Badge color="#16a34a">{t('เปิด')}</Badge> : <Badge color="#6b7280">{t('ปิด')}</Badge>) },
          ]}
          fields={[
            { key: 'title', label: 'ชื่อรูป' },
            { key: 'durationSeconds', label: 'เวลาแสดงต่อรูป (วินาที)', type: 'number' },
            { key: 'imageUrl', label: 'URL รูปภาพ', type: 'image', full: true, required: true },
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

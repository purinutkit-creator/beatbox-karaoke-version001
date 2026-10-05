import { useState } from 'react';
import { Printer, Search, Bluetooth, Usb, Network, Cable, Activity, FileText, Wallet } from 'lucide-react';
import { CrudPage } from '../../components/Crud.jsx';
import { Button, Modal, Badge, Input, Field, Loading, Switch, useToast } from '../../components/ui.jsx';
import { TestPage } from '../../components/Receipt.jsx';
import { usePrint } from '../../components/PrintPreview.jsx';
import { useT } from '../../lib/i18n.jsx';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/store.jsx';
import { pairDevice, transportStatus, printElement, openDrawer, getLocalPrinterId, setLocalPrinterId } from '../../lib/print.jsx';

const CONN = [
  { value: 'BROWSER', label: 'USB / สายเชื่อมต่อกับเครื่อง POS (ผ่านไดรเวอร์ OS)' },
  { value: 'USB', label: 'USB โดยตรง (WebUSB)' },
  { value: 'SERIAL', label: 'สาย Serial/USB-Serial (Web Serial)' },
  { value: 'BLUETOOTH', label: 'Bluetooth' },
  { value: 'NETWORK', label: 'Network Printer / IP Address' },
];
const ICON = { BROWSER: Cable, USB: Usb, SERIAL: Cable, BLUETOOTH: Bluetooth, NETWORK: Network };

export default function Printers() {
  const { t } = useT();
  const toast = useToast();
  const { settings } = useAuth();
  const { preview } = usePrint();
  const [discover, setDiscover] = useState(null);
  const [local, setLocal] = useState(getLocalPrinterId());
  const [key, setKey] = useState(0);
  const [qrPrint, setQrPrint] = useState(localStorage.getItem('bb_print_qr_orders') !== 'false');
  const test = async (p) => {
    const r = await printElement(<TestPage store={settings.store} printer={p} />, p, { jobType: 'TEST', copies: 1 });
    r.ok ? toast.success('ส่งงานทดสอบพิมพ์แล้ว') : toast.error(`${t('พิมพ์ไม่สำเร็จ')}: ${r.error}`);
  };
  const status = async (p) => {
    if (p.connection === 'NETWORK') {
      const r = await api.post(`/printers/${p.id}/status`);
      r.status === 'ONLINE' ? toast.success(`${p.name}: ONLINE`) : toast.error(`${p.name}: OFFLINE`);
    } else {
      const s = transportStatus(p.connection);
      await api.post(`/printers/${p.id}/status`, { status: s === 'ONLINE' ? 'ONLINE' : s === 'UNSUPPORTED' ? 'OFFLINE' : 'UNKNOWN' });
      toast.info(`${p.name}: ${s}`);
    }
    setKey((k) => k + 1);
  };
  const pair = async (p) => {
    try {
      const name = await pairDevice(p.connection);
      toast.success(`${t('เชื่อมต่อแล้ว')}: ${name}`);
    } catch (e) {
      toast.error(e.message);
    }
  };
  const scan = async () => {
    setDiscover({ loading: true, subnet: discover?.subnet || '' });
    try {
      const r = await api.post('/printers/discover', { subnet: discover?.subnet || undefined });
      setDiscover({ ...r, loading: false });
    } catch (e) {
      toast.error(e);
      setDiscover({ loading: false, printers: [] });
    }
  };
  const addFound = async (p) => {
    try {
      await api.post('/printers', { name: p.name, connection: 'NETWORK', address: p.address, port: p.port, station: 'MAIN' });
      toast.success('เพิ่มเครื่องพิมพ์แล้ว');
      setKey((k) => k + 1);
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <>
      <div className="card flat mb">
        <Switch checked={qrPrint} onChange={(x) => { localStorage.setItem('bb_print_qr_orders', String(x)); setQrPrint(x); }} label={t('เครื่องนี้พิมพ์ใบสั่งครัว/บาร์ของลูกค้าที่สั่งผ่าน QR ในห้องอัตโนมัติ')} />
        <div className="xs muted">{t('ทุกเครื่องที่เปิดไว้ช่วยกันพิมพ์ได้ ระบบรับประกันว่าแต่ละใบพิมพ์เพียงครั้งเดียว')}</div>
      </div>
      <CrudPage
        key={key}
        title="เครื่องพิมพ์"
        icon={Printer}
        endpoint="/printers"
        topics={['printers']}
        createPerm="settings.manage"
        editPerm="settings.manage"
        deletePerm="settings.manage"
        extraHead={<Button icon={Search} onClick={() => setDiscover({ printers: null, subnet: '' })}>{t('ค้นหาเครื่องพิมพ์')}</Button>}
        defaults={{ connection: 'BROWSER', port: 9100, station: 'MAIN', paperWidth: 80, density: 8, speed: 3, marginMm: 2, copies: 1, autoPrint: true, autoCut: true, openDrawer: true, isDefault: false, isActive: true }}
        toForm={(r) => ({ id: r.id, name: r.name, connection: r.connection, address: r.address, port: r.port, station: r.station, paperWidth: r.paper_width, density: r.density, speed: r.speed, marginMm: r.margin_mm, copies: r.copies, autoPrint: r.auto_print, autoCut: r.auto_cut, openDrawer: r.open_drawer, isDefault: r.is_default, isActive: r.is_active })}
        columns={[
          { label: 'เครื่องพิมพ์', render: (r) => { const I = ICON[r.connection]; return <div className="row nowrap"><I size={18} /><div><b>{r.name}</b>{r.is_default && <Badge color="#8b5cf6">{t('หลัก')}</Badge>}{local === r.id && <Badge color="#2563eb">{t('เครื่องนี้')}</Badge>}<div className="xs muted">{r.connection} {r.address && `· ${r.address}:${r.port}`}</div></div></div>; } },
          { label: 'ใช้สำหรับ', render: (r) => ({ MAIN: t('ใบเสร็จ'), KITCHEN: t('ครัว'), BAR: t('บาร์'), PREP: t('จุดเตรียม') })[r.station] },
          { label: 'กระดาษ', render: (r) => `${r.paper_width}mm · ${t('เข้ม')} ${r.density} · ${t('เร็ว')} ${r.speed}` },
          { label: 'ตัวเลือก', render: (r) => <span className="small">{r.copies} {t('ใบ')} {r.auto_print && `· ${t('พิมพ์อัตโนมัติ')}`} {r.auto_cut && `· ${t('ตัดกระดาษ')}`} {r.open_drawer && `· ${t('เปิดลิ้นชัก')}`}</span> },
          { label: 'สถานะ', render: (r) => <Badge color={r.status === 'ONLINE' ? '#16a34a' : r.status === 'OFFLINE' ? '#dc2626' : '#6b7280'}>{r.status}</Badge> },
        ]}
        rowActions={(r) => (
          <>
            {['USB', 'SERIAL', 'BLUETOOTH'].includes(r.connection) && <Button size="sm" onClick={() => pair(r)}>{t('เชื่อมต่อ')}</Button>}
            <Button size="sm" variant="ghost" icon={Activity} title={t('ตรวจสอบสถานะ')} onClick={() => status(r)} />
            <Button size="sm" variant="ghost" icon={FileText} title={t('ทดสอบพิมพ์')} onClick={() => test(r)} />
            <Button size="sm" variant="ghost" icon={Wallet} title={t('เปิดลิ้นชัก')} onClick={async () => { const x = await openDrawer(r); x.ok ? toast.success('เปิดลิ้นชักแล้ว') : toast.warning(x.error); api.post('/drawer/open').catch(() => {}); }} />
            <Button size="sm" variant={local === r.id ? 'primary' : ''} onClick={() => { setLocalPrinterId(r.id); setLocal(r.id); }}>{t('ใช้กับเครื่องนี้')}</Button>
          </>
        )}
        fields={[
          { key: 'name', label: 'ชื่อเครื่องพิมพ์', required: true },
          { key: 'connection', label: 'การเชื่อมต่อ', type: 'select', options: CONN, required: true },
          { key: 'address', label: 'IP Address', hidden: (f) => f.connection !== 'NETWORK' },
          { key: 'port', label: 'Port', type: 'number', hidden: (f) => f.connection !== 'NETWORK' },
          { key: 'station', label: 'ใช้สำหรับ', type: 'select', options: [{ value: 'MAIN', label: 'ใบเสร็จ (หลัก)' }, { value: 'KITCHEN', label: 'ครัว' }, { value: 'BAR', label: 'บาร์' }, { value: 'PREP', label: 'จุดเตรียมสินค้า' }], required: true },
          { key: 'paperWidth', label: 'ขนาดกระดาษ (mm)', type: 'select', options: [{ value: 80, label: '80 มิลลิเมตร' }, { value: 58, label: '58 มิลลิเมตร' }] },
          { key: 'density', label: 'ความเข้ม (1-15)', type: 'number' },
          { key: 'speed', label: 'ความเร็ว (1-9)', type: 'number' },
          { key: 'marginMm', label: 'ระยะขอบ (mm)', type: 'number', step: '0.5' },
          { key: 'copies', label: 'จำนวนใบที่ต้องการพิมพ์', type: 'number' },
          { key: 'autoPrint', label: 'พิมพ์อัตโนมัติหลังชำระเงิน', type: 'switch', switchLabel: 'เปิด' },
          { key: 'autoCut', label: 'ตัดกระดาษอัตโนมัติ', type: 'switch', switchLabel: 'เปิด' },
          { key: 'openDrawer', label: 'เปิดลิ้นชักหลังรับเงินสด', type: 'switch', switchLabel: 'เปิด' },
          { key: 'isDefault', label: 'เครื่องพิมพ์หลัก', type: 'switch', switchLabel: 'ตั้งเป็นเครื่องหลัก' },
          { key: 'isActive', label: 'สถานะ', type: 'switch', switchLabel: 'เปิดใช้งาน' },
        ]}
        toPayload={(f) => ({ ...f, paperWidth: Number(f.paperWidth), address: f.address || null })}
      />
      <div className="card flat mt small muted">
        {t('USB/สายเชื่อมต่อ: ติดตั้งไดรเวอร์เครื่องพิมพ์ใน OS แล้วเลือกขนาด 80mm · USB โดยตรง/Serial/Bluetooth: ใช้ Chrome หรือ Edge กด "เชื่อมต่อ" ครั้งแรก · Network: เครื่องพิมพ์ ESC/POS พอร์ต 9100 ระบบจะส่งผ่านเซิร์ฟเวอร์ · ใบเสร็จพิมพ์เป็นภาพเพื่อให้ฟอนต์ภาษาไทยแสดงถูกต้อง')}
      </div>
      {discover && (
        <Modal title={t('ค้นหาเครื่องพิมพ์ในเครือข่าย')} onClose={() => setDiscover(null)}>
          <div className="row nowrap">
            <Input placeholder="Subnet เช่น 192.168.1 (เว้นว่าง = อัตโนมัติ)" value={discover.subnet || ''} onChange={(e) => setDiscover({ ...discover, subnet: e.target.value })} />
            <Button variant="primary" icon={Search} loading={discover.loading} onClick={scan}>{t('ค้นหา')}</Button>
          </div>
          {discover.loading && <Loading text="กำลังค้นหาเครื่องพิมพ์ (port 9100)..." />}
          {discover.printers && (
            <div className="col mt">
              {!discover.printers.length && <div className="muted">{t('ไม่พบเครื่องพิมพ์')}</div>}
              {discover.printers.map((p) => (
                <div key={p.address} className="row between card flat" style={{ padding: 10 }}>
                  <span><Network size={14} /> {p.address}:{p.port}</span>
                  <Button size="sm" onClick={() => addFound(p)}>{t('เพิ่ม')}</Button>
                </div>
              ))}
            </div>
          )}
          <div className="mt row">
            <Button icon={Bluetooth} onClick={() => pairDevice('BLUETOOTH').then((n) => toast.success(n)).catch((e) => toast.error(e.message))}>{t('ค้นหา Bluetooth')}</Button>
            <Button icon={Usb} onClick={() => pairDevice('USB').then((n) => toast.success(n)).catch((e) => toast.error(e.message))}>{t('ค้นหา USB')}</Button>
          </div>
        </Modal>
      )}
    </>
  );
}

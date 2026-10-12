import { useEffect, useState } from 'react';
import { Printer, Search, Bluetooth, Usb, Network, Cable, Activity, FileText, Wallet, RotateCcw, Copy, Route, ListOrdered, Info } from 'lucide-react';
import { CrudPage } from '../../components/Crud.jsx';
import { Button, Modal, Badge, Input, Field, Loading, Switch, Select, Tabs, useToast } from '../../components/ui.jsx';
import { usePrint, docLabel } from '../../components/PrintPreview.jsx';
import { useT } from '../../lib/i18n.jsx';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/store.jsx';
import { useLive } from '../../lib/socket.js';
import { pairDevice, transportStatus, openDrawer, getLocalPrinterId, setLocalPrinterId, paperGeometry, routeProblem } from '../../lib/print.jsx';
import { DOC_TYPES, DEFAULT_ROUTING } from '@beatbox/shared/documents.js';
import { fmtDateTime } from '@beatbox/shared/format.js';

const CONN = [
  { value: 'BROWSER', label: 'ไดรเวอร์ระบบ (OS) — USB / LAN / Bluetooth ที่ติดตั้งไดรเวอร์แล้ว · พิมพ์ฟอนต์ที่ตั้งไว้ได้' },
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
  const [tab, setTab] = useState('printers');
  const test = (p) => preview({ docType: 'TEST', data: { store: settings.store, timezone: settings.store.timezone, printer: p } }, { reference: `TEST-${p.name}`, title: 'ทดสอบพิมพ์' });
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
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'printers', label: 'เครื่องพิมพ์' }, { value: 'routing', label: 'เอกสาร → เครื่องพิมพ์' }, { value: 'jobs', label: 'คิวและสถานะงานพิมพ์' }, { value: 'guide', label: 'รุ่นที่รองรับ / วิธีตั้งค่า' }]} />
      <div className="mt" />
      {tab === 'routing' && <RoutingTab />}
      {tab === 'jobs' && <JobsTab />}
      {tab === 'guide' && <GuideTab />}
      {tab === 'printers' && <>
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
        defaults={{ connection: 'BROWSER', port: 9100, station: 'MAIN', paperWidth: 80, paperPreset: '80', printableWidthMm: '', marginLeftMm: 0, marginRightMm: 0, marginTopMm: 0, marginBottomMm: 3, fontScale: 1, renderMode: 'DRIVER', allowPrinterFont: false, escposCodepage: '', charsPerLine: '', model: '', density: 8, speed: 3, marginMm: 2, copies: 1, autoPrint: true, autoCut: true, openDrawer: true, isDefault: false, isActive: true }}
        toForm={(r) => ({ id: r.id, name: r.name, connection: r.connection, address: r.address, port: r.port, station: r.station, paperWidth: r.paper_width, paperPreset: [58, 80].includes(r.paper_width) ? String(r.paper_width) : 'CUSTOM', printableWidthMm: r.printable_width_mm ?? '', marginLeftMm: r.margin_left_mm, marginRightMm: r.margin_right_mm, marginTopMm: r.margin_top_mm, marginBottomMm: r.margin_bottom_mm, fontScale: r.font_scale, renderMode: r.render_mode, allowPrinterFont: r.allow_printer_font, escposCodepage: r.escpos_codepage ?? '', charsPerLine: r.chars_per_line ?? '', model: r.model || '', density: r.density, speed: r.speed, marginMm: r.margin_mm, copies: r.copies, autoPrint: r.auto_print, autoCut: r.auto_cut, openDrawer: r.open_drawer, isDefault: r.is_default, isActive: r.is_active })}
        columns={[
          { label: 'เครื่องพิมพ์', render: (r) => { const I = ICON[r.connection]; return <div className="row nowrap"><I size={18} /><div><b>{r.name}</b>{r.is_default && <Badge color="#8b5cf6">{t('หลัก')}</Badge>}{local === r.id && <Badge color="#2563eb">{t('เครื่องนี้')}</Badge>}<div className="xs muted">{r.connection} {r.address && `· ${r.address}:${r.port}`}</div></div></div>; } },
          { label: 'ใช้สำหรับ', render: (r) => ({ MAIN: t('ใบเสร็จ'), KITCHEN: t('ครัว'), BAR: t('บาร์'), PREP: t('จุดเตรียม') })[r.station] },
          { label: 'กระดาษ / พื้นที่พิมพ์', render: (r) => { const g = paperGeometry(r); return <span className="small">{r.paper_width}mm · {t('พิมพ์ได้')} {g.printableMm}mm · {t('ฟอนต์')} ×{Number(r.font_scale || 1)}</span>; } },
          { label: 'โหมดการพิมพ์', render: (r) => { const pr = routeProblem(r); return <div className="small">{r.render_mode === 'ESCPOS_TEXT' ? <Badge color="#f97316">{t('ฟอนต์ของเครื่องพิมพ์ (ESC/POS)')}</Badge> : <Badge color="#16a34a">{t('ไดรเวอร์ระบบ · ฟอนต์ที่ตั้งไว้')}</Badge>}{pr && <div className="xs" style={{ color: 'var(--danger)' }}>{pr.message}</div>}</div>; } },
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
          { key: 'model', label: 'รุ่นเครื่องพิมพ์ (ไม่บังคับ)', placeholder: 'เช่น Epson TM-T82III, Xprinter XP-Q80' },
          { key: 'renderMode', label: 'วิธีพิมพ์', type: 'select', options: [{ value: 'DRIVER', label: 'ไดรเวอร์ระบบ — ข้อความจริง + ฟอนต์ที่ตั้งไว้ (แนะนำ)' }, { value: 'ESCPOS_TEXT', label: 'ESC/POS ข้อความ — ใช้ฟอนต์ในเครื่องพิมพ์เท่านั้น' }], hint: 'ระบบไม่แปลงข้อความหรือใบเสร็จเป็นภาพ (Bitmap/Raster) ทุกโหมด' },
          { key: 'allowPrinterFont', label: 'ยอมรับการใช้ฟอนต์ของเครื่องพิมพ์', type: 'switch', switchLabel: 'ยอมรับว่าเอกสารจะไม่ใช้ฟอนต์ที่ตั้งไว้', hidden: (f) => f.renderMode !== 'ESCPOS_TEXT', full: true },
          { key: 'escposCodepage', label: 'Code page ภาษาไทย (ESC t n)', type: 'number', hidden: (f) => f.renderMode !== 'ESCPOS_TEXT', hint: 'ดูคู่มือเครื่องพิมพ์ เช่น Epson รุ่นไทยมักใช้ 21 หรือ 26 · ทดสอบด้วยปุ่มทดสอบพิมพ์' },
          { key: 'charsPerLine', label: 'จำนวนตัวอักษรต่อบรรทัด', type: 'number', hidden: (f) => f.renderMode !== 'ESCPOS_TEXT', hint: 'ว่าง = 48 (80mm) / 32 (58mm)' },
          { key: 'paperPreset', label: 'ขนาดกระดาษ', type: 'select', options: [{ value: '80', label: '80 มิลลิเมตร' }, { value: '58', label: '58 มิลลิเมตร' }, { value: 'CUSTOM', label: 'กำหนดเอง' }] },
          { key: 'paperWidth', label: 'ความกว้างกระดาษ (mm)', type: 'number', hidden: (f) => f.paperPreset !== 'CUSTOM' },
          { key: 'printableWidthMm', label: 'พื้นที่พิมพ์ได้จริง (mm)', type: 'number', step: '0.5', hint: 'ว่าง = อัตโนมัติ (80→72, 58→48) · ดูค่า "Printable width" ในคู่มือ/ไดรเวอร์' },
          { key: 'fontScale', label: 'ขยายขนาดตัวอักษรทั้งเอกสาร (เท่า)', type: 'number', step: '0.05', hint: '1 = ตามที่ออกแบบ · ถ้าตัวหนังสือเล็กเกินไปให้เพิ่มเป็น 1.1–1.3' },
          { key: 'marginLeftMm', label: 'ขอบซ้าย (mm)', type: 'number', step: '0.5' },
          { key: 'marginRightMm', label: 'ขอบขวา (mm)', type: 'number', step: '0.5' },
          { key: 'marginTopMm', label: 'ขอบบน (mm)', type: 'number', step: '0.5' },
          { key: 'marginBottomMm', label: 'ขอบล่าง / เผื่อตัดกระดาษ (mm)', type: 'number', step: '0.5' },
          { key: 'copies', label: 'จำนวนใบที่ต้องการพิมพ์', type: 'number' },
          { key: 'autoPrint', label: 'พิมพ์ใบเสร็จอัตโนมัติหลังชำระเงิน', type: 'switch', switchLabel: 'เปิด' },
          { key: 'autoCut', label: 'ตัดกระดาษอัตโนมัติ', type: 'switch', switchLabel: 'เปิด' },
          { key: 'openDrawer', label: 'เปิดลิ้นชักหลังรับเงินสด', type: 'switch', switchLabel: 'เปิด' },
          { key: 'isDefault', label: 'เครื่องพิมพ์หลัก', type: 'switch', switchLabel: 'ตั้งเป็นเครื่องหลัก' },
          { key: 'isActive', label: 'สถานะ', type: 'switch', switchLabel: 'เปิดใช้งาน' },
        ]}
        toPayload={(f) => ({
          ...f,
          paperWidth: f.paperPreset === 'CUSTOM' ? Number(f.paperWidth) : Number(f.paperPreset || f.paperWidth || 80),
          printableWidthMm: f.printableWidthMm === '' || f.printableWidthMm == null ? null : Number(f.printableWidthMm),
          escposCodepage: f.escposCodepage === '' || f.escposCodepage == null ? null : Number(f.escposCodepage),
          charsPerLine: f.charsPerLine === '' || f.charsPerLine == null ? null : Number(f.charsPerLine),
          address: f.address || null,
        })}
      />
      <div className="card flat mt small muted">
        <Info size={14} /> {t('แนะนำ: ติดตั้งไดรเวอร์เครื่องพิมพ์ในระบบปฏิบัติการ แล้วเลือก "ไดรเวอร์ระบบ" — เอกสารจะพิมพ์เป็นข้อความจริงด้วยฟอนต์ที่ตั้งไว้ เต็มความกว้างกระดาษ และยาวตามเนื้อหา · การเชื่อมต่อ USB/Serial/Bluetooth/Network ตรง ใช้ได้เฉพาะโหมด ESC/POS ข้อความ (ฟอนต์ในเครื่องพิมพ์) · ดูรุ่นที่รองรับในแท็บ "รุ่นที่รองรับ / วิธีตั้งค่า"')}
      </div>
      </>}
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

/** Every document type → printer, copies, cut, auto print. Default: everything on one printer, in order. */
function RoutingTab() {
  const { t } = useT();
  const toast = useToast();
  const { settings, loadSettings, can } = useAuth();
  const { printers } = usePrint();
  const [r, setR] = useState(null);
  const [auto, setAuto] = useState(true);
  useEffect(() => {
    setR({ ...DEFAULT_ROUTING, ...(settings?.documents?.routing || {}) });
    setAuto(settings?.documents?.autoPrintReceipt !== false);
  }, [settings?.documents]);
  if (!r) return <Loading />;
  const set = (doc, k, v) => setR((x) => ({ ...x, [doc]: { ...x[doc], [k]: v } }));
  const save = async () => {
    try {
      await api.put('/documents/settings', { routing: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, { printerId: v.printerId ? Number(v.printerId) : null, copies: Number(v.copies) || 1, cut: !!v.cut, auto: !!v.auto }])), autoPrintReceipt: auto });
      await loadSettings();
      toast.success('บันทึกเรียบร้อย');
    } catch (e) {
      toast.error(e);
    }
  };
  const allSame = (pid) => setR((x) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, { ...v, printerId: pid }])));
  return (
    <div className="col">
      <div className="card flat small"><Route size={14} /> {t('ทุกเอกสารพิมพ์ผ่านคิวเดียวกันตามลำดับ ไม่ปะปนกัน · ค่าเริ่มต้นใช้เครื่องพิมพ์หลักของเครื่องนี้สำหรับทุกเอกสาร (เครื่องเดียวพิมพ์ได้ทุกใบ)')}</div>
      <div className="row">
        <span className="small">{t('ใช้เครื่องเดียวกันทุกเอกสาร')}:</span>
        <Select value="" onChange={(e) => allSame(e.target.value || null)} options={[{ value: '', label: t('เครื่องหลักของเครื่องนี้') }, ...printers.map((p) => ({ value: p.id, label: p.name }))]} style={{ width: 260 }} />
      </div>
      <Switch checked={auto} onChange={setAuto} label="พิมพ์ใบเสร็จฉบับเต็มอัตโนมัติหลังชำระเงินครบ" />
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>{t('เอกสาร')}</th><th>{t('เครื่องพิมพ์')}</th><th>{t('จำนวนสำเนา')}</th><th>{t('ตัดกระดาษ')}</th><th>{t('พิมพ์อัตโนมัติ')}</th></tr></thead>
          <tbody>
            {DOC_TYPES.map((d) => (
              <tr key={d.key}>
                <td>{t(d.label)}</td>
                <td><Select value={r[d.key]?.printerId || ''} onChange={(e) => set(d.key, 'printerId', e.target.value || null)} options={[{ value: '', label: t('เครื่องหลักของเครื่องนี้') }, ...printers.map((p) => ({ value: p.id, label: p.name }))]} /></td>
                <td><Input type="number" min={1} max={5} style={{ width: 70 }} value={r[d.key]?.copies ?? 1} onChange={(e) => set(d.key, 'copies', e.target.value)} /></td>
                <td><Switch checked={r[d.key]?.cut !== false} onChange={(v) => set(d.key, 'cut', v)} /></td>
                <td><Switch checked={!!r[d.key]?.auto} onChange={(v) => set(d.key, 'auto', v)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="xs muted">{t('การตัดกระดาษในโหมดไดรเวอร์ระบบ ให้ตั้งในไดรเวอร์ว่า "ตัดกระดาษทุกหน้า" (แต่ละสำเนาคือ 1 หน้า) · โหมด ESC/POS ระบบส่งคำสั่งตัดให้เอง')}</div>
      {can('settings.manage') && <Button variant="primary" onClick={save}>{t('บันทึก')}</Button>}
    </div>
  );
}

const JOB_COLOR = { PRINTED: '#16a34a', FAILED: '#dc2626', PRINTING: '#2563eb', QUEUED: '#f97316', CANCELLED: '#6b7280' };

/** Print queue status: errors, retry (not a copy), reprint (marked "สำเนา"). */
function JobsTab() {
  const { t } = useT();
  const { reprint, print } = usePrint();
  const [status, setStatus] = useState('');
  const { data, reload } = useLive(() => api.get(`/print-jobs?payload=1${status ? `&status=${status}` : ''}`), ['print-jobs'], [status]);
  const retry = async (j) => {
    const pl = j.payload || {};
    const docs = pl.docs || [{ docType: pl.docType || j.doc_type || j.job_type, data: pl.data !== undefined ? pl.data : pl }];
    await print(docs, { reference: j.reference, jobId: j.id, force: true });
    reload();
  };
  return (
    <div className="col">
      <div className="row">
        <ListOrdered size={16} />
        <Select value={status} onChange={(e) => setStatus(e.target.value)} options={[{ value: '', label: t('ทั้งหมด') }, { value: 'FAILED', label: t('พิมพ์ไม่สำเร็จ') }, { value: 'PRINTING,QUEUED', label: t('กำลังพิมพ์ / รอคิว') }, { value: 'PRINTED', label: t('พิมพ์แล้ว') }]} style={{ width: 220 }} />
        <Button icon={RotateCcw} onClick={reload}>{t('รีเฟรช')}</Button>
      </div>
      {!data ? <Loading /> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>{t('เวลา')}</th><th>{t('เอกสาร')}</th><th>{t('อ้างอิง')}</th><th>{t('เครื่องพิมพ์')}</th><th>{t('สถานะ')}</th><th /></tr></thead>
            <tbody>
              {data.map((j) => (
                <tr key={j.id}>
                  <td className="small num">{fmtDateTime(j.created_at)}</td>
                  <td>{t(docLabel(j.doc_type || j.job_type))}{j.is_copy && <Badge color="#6b7280">{t('สำเนา')}</Badge>}{j.copies > 1 && <span className="xs muted"> ×{j.copies}</span>}</td>
                  <td className="small">{j.reference || '-'}</td>
                  <td className="small">{j.printer_name || t('เครื่องหลัก')}</td>
                  <td><Badge color={JOB_COLOR[j.status]}>{j.status}</Badge>{j.error && <div className="xs" style={{ color: 'var(--danger)', maxWidth: 320 }}>{j.error}</div>}{j.attempts > 1 && <div className="xs muted">{t('พยายาม')} {j.attempts} {t('ครั้ง')}</div>}</td>
                  <td>
                    <div className="row nowrap">
                      {j.status === 'FAILED' && j.payload && <Button size="sm" variant="primary" icon={RotateCcw} onClick={() => retry(j)}>{t('พิมพ์ใหม่')}</Button>}
                      {j.status === 'PRINTED' && j.payload && <Button size="sm" icon={Copy} onClick={() => reprint(j.id)}>{t('พิมพ์สำเนา')}</Button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Which printers print the store's font for real, and how to set them up. */
function GuideTab() {
  const { t } = useT();
  return (
    <div className="col small" style={{ maxWidth: 900 }}>
      <div className="card flat">
        <b>{t('1) พิมพ์ด้วยฟอนต์ที่ตั้งไว้ (เช่น Kanit) — ผ่านไดรเวอร์ระบบ (แนะนำ)')}</b>
        <ul>
          <li>{t('ข้อความถูกส่งเป็นข้อความจริงพร้อมฟอนต์ที่ฝังจากเบราว์เซอร์ (Chrome / Edge) ไปยังไดรเวอร์ของระบบปฏิบัติการ ไม่มีการแปลงเป็นภาพในระบบนี้')}</li>
          <li>{t('ต้องติดตั้งไดรเวอร์ Windows / macOS ของเครื่องพิมพ์ และตั้งขนาดกระดาษในไดรเวอร์เป็นม้วน 80 มม. (หรือ 58 มม.) แบบความยาวต่อเนื่อง / "Receipt" เพื่อให้ความยาวกระดาษเป็นไปตามเนื้อหา')}</li>
          <li>{t('ตั้งไดรเวอร์ให้ตัดกระดาษ "ทุกหน้า/ทุกเอกสาร" และปิด "Fit to page / Scale" (ระบบส่งหน้ากระดาษขนาดเท่ากระดาษจริงอยู่แล้ว)')}</li>
          <li>{t('พิมพ์อัตโนมัติโดยไม่ต้องกดยืนยัน: เปิด Chrome/Edge ด้วยตัวเลือก --kiosk-printing และตั้งเครื่องพิมพ์ใบเสร็จเป็นเครื่องเริ่มต้นของระบบ')}</li>
          <li>{t('ต้องการไฟล์ PDF: ในหน้าต่างพิมพ์เลือก "บันทึกเป็น PDF" — PDF จะฝังฟอนต์และเป็นข้อความที่ค้นหา/คัดลอกได้')}</li>
        </ul>
        <b>{t('รุ่นที่มีไดรเวอร์ Windows/macOS และพิมพ์ฟอนต์ของระบบได้ (ตัวอย่าง):')}</b>
        <ul>
          <li>Epson TM-T82III / TM-T82X / TM-T88VI / TM-T88VII / TM-m30II / TM-m30III (Advanced Printer Driver / TM Virtual Port)</li>
          <li>Star Micronics TSP143IIIU / TSP143IV / mC-Print3 / TSP654II (Star Windows/macOS driver)</li>
          <li>Bixolon SRP-330II / SRP-350III / SRP-E300 (Windows driver)</li>
          <li>Xprinter XP-Q80 / XP-N160II / XP-58IIH (POS-80 / POS-58 Windows driver)</li>
          <li>Sunmi / iMin รุ่น Android ที่ติดตั้ง Chrome และบริการพิมพ์ของระบบ (Android print service) — ขึ้นกับรุ่น ควรทดสอบด้วยปุ่ม "ทดสอบพิมพ์"</li>
        </ul>
        <div className="muted">{t('ก่อนใช้งานจริงให้กด "ทดสอบพิมพ์" ทุกเครื่อง: หน้าทดสอบมีข้อความไทย/อังกฤษ เส้นขอบซ้าย-ขวา และแสดงพื้นที่พิมพ์ เพื่อยืนยันว่าเต็มความกว้างและใช้ฟอนต์ที่ตั้งไว้จริง')}</div>
      </div>
      <div className="card flat">
        <b>{t('2) ESC/POS ข้อความ (USB / Serial / Bluetooth / Network ตรง)')}</b>
        <ul>
          <li>{t('พิมพ์ด้วยฟอนต์ที่อยู่ในเครื่องพิมพ์เท่านั้น ไม่สามารถใช้ Google Fonts หรือฟอนต์ที่นำเข้าได้ ระบบจะไม่อ้างว่ารองรับ และจะไม่แปลงเป็นภาพแทน')}</li>
          <li>{t('ภาษาไทยต้องเป็นรุ่นที่มีชุดอักษรไทยในเครื่อง (Thai code page) และตั้ง Code page ให้ตรงคู่มือ เช่น Epson TM รุ่นไทย, Xprinter รุ่นที่ระบุว่ารองรับภาษาไทย')}</li>
          <li>{t('QR Code ใช้คำสั่ง QR ของเครื่องพิมพ์เอง (GS ( k) — ต้องเป็นรุ่นที่รองรับคำสั่งนี้')}</li>
          <li>{t('โลโก้เป็นรูปภาพ จึงไม่พิมพ์ในโหมดนี้')}</li>
        </ul>
      </div>
    </div>
  );
}

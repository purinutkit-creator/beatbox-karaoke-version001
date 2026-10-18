import { useEffect, useRef, useState } from 'react';
import { Printer, Search, Bluetooth, Usb, Network, Cable, Activity, FileText, Wallet, RotateCcw, Copy, Route, ListOrdered, Info, CheckCheck, Play, Upload, Mic, Square, Bell } from 'lucide-react';
import { CrudPage } from '../../components/Crud.jsx';
import { Button, Modal, Badge, Input, Field, Loading, Switch, Select, Tabs, useToast } from '../../components/ui.jsx';
import { usePrint, docLabel } from '../../components/PrintPreview.jsx';
import { useT } from '../../lib/i18n.jsx';
import { api, upload } from '../../lib/api.js';
import { useAuth } from '../../lib/store.jsx';
import { useLive } from '../../lib/socket.js';
import { pairDevice, transportStatus, openDrawer, getLocalPrinterId, setLocalPrinterId, paperGeometry, routeProblem, printMode, searchUsbPrinter, usbLabel, printJob } from '../../lib/print.jsx';
import { ALERT_SOUNDS, isSoundFile, playAlert } from '../../lib/sounds.js';
import { isEpson } from '../../lib/escpos.js';
import { sampleData } from './Documents.jsx';
import { DOC_TYPES, DEFAULT_ROUTING } from '@beatbox/shared/documents.js';
import { fmtDateTime } from '@beatbox/shared/format.js';

const CONN = [
  { value: 'USB', label: 'สาย USB (แนะนำ) — พิมพ์ฟอนต์ที่ตั้งไว้ ไม่ต้องเปิดหน้าต่างพิมพ์' },
  { value: 'BROWSER', label: 'ไดรเวอร์ระบบ (OS) — ผ่านหน้าต่างพิมพ์ของ Windows / macOS' },
  { value: 'SERIAL', label: 'สาย Serial/USB-Serial (Web Serial)' },
  { value: 'BLUETOOTH', label: 'Bluetooth' },
  { value: 'NETWORK', label: 'Network Printer / IP Address' },
];
const ICON = { BROWSER: Cable, USB: Usb, SERIAL: Cable, BLUETOOTH: Bluetooth, NETWORK: Network };
const MODES = (f) =>
  f.connection === 'BROWSER'
    ? [{ value: 'DRIVER', label: 'ไดรเวอร์ระบบ — ฟอนต์ที่ตั้งไว้' }]
    : [
        { value: 'RASTER', label: 'ฟอนต์ที่ตั้งไว้ (แบบเดิม) — วาดเอกสารแล้วส่งตรงไปเครื่องพิมพ์ (แนะนำ)' },
        { value: 'ESCPOS_TEXT', label: 'ESC/POS ข้อความ — ใช้ฟอนต์ในเครื่องพิมพ์เท่านั้น' },
      ];
const MODE_BADGE = { RASTER: ['#16a34a', 'ฟอนต์ที่ตั้งไว้ · ส่งตรง'], DRIVER: ['#2563eb', 'ไดรเวอร์ระบบ · ฟอนต์ที่ตั้งไว้'], ESCPOS_TEXT: ['#f97316', 'ฟอนต์ของเครื่องพิมพ์ (ESC/POS)'] };

// print speed levels of the Epson speed command (GS ( K fn 50, see lib/escpos.js)
const SPEEDS = [
  { value: 0, label: 'ตามที่ตั้งไว้ในเครื่องพิมพ์ (ไม่ส่งคำสั่ง)' },
  { value: 1, label: '1 — ช้าที่สุด · คมชัดที่สุด' },
  { value: 2, label: '2 — ช้า' },
  { value: 3, label: '3 — ช้า' },
  { value: 4, label: '4 — ค่อนข้างช้า' },
  { value: 5, label: '5 — ปานกลาง' },
  { value: 6, label: '6 — ค่อนข้างเร็ว' },
  { value: 7, label: '7 — เร็ว' },
  { value: 8, label: '8 — เร็ว' },
  { value: 9, label: '9 — เร็วที่สุด' },
];
const ALERT_KINDS = [
  { value: 'PRINTER', label: 'ลำโพงในเครื่องพิมพ์ (ปิ๊บๆ)' },
  { value: 'DEVICE', label: 'ลำโพงของเครื่อง POS / แท็บเล็ตที่สั่งพิมพ์ (เลือกเสียงได้)' },
  { value: 'BOTH', label: 'ทั้งสองอย่าง' },
  { value: 'OFF', label: 'ปิดเสียง' },
];
const hasDeviceSound = (f) => ['DEVICE', 'BOTH'].includes(f.kitchenAlert);
const hasAlert = (f) => f.kitchenAlert && f.kitchenAlert !== 'OFF';

/** Kitchen alert sound: built-in sounds, sounds already added to other printers, upload a file or record one. */
function SoundPicker({ form, set }) {
  const { t } = useT();
  const toast = useToast();
  const { data: printers } = useLive(() => api.get('/printers'), ['printers'], []);
  const fileRef = useRef(null);
  const recRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [rec, setRec] = useState(null); // null | { state: 'REC', secs } | { state: 'DONE', blob, url, ext }
  const custom = [];
  for (const p of printers || []) if (isSoundFile(p.alert_sound) && !custom.some((c) => c.value === p.alert_sound)) custom.push({ value: p.alert_sound, label: `🎵 ${p.alert_sound_name || t('เสียงที่เพิ่มเอง')}` });
  if (isSoundFile(form.alertSound) && !custom.some((c) => c.value === form.alertSound)) custom.push({ value: form.alertSound, label: `🎵 ${form.alertSoundName || t('เสียงที่เพิ่มเอง')}` });
  const options = [...ALERT_SOUNDS.map((x) => ({ value: x.value, label: t(x.label) })), ...custom];
  const preview = () => playAlert(form.alertSound, { times: 1, volume: form.alertVolume ?? 80, text: t('มีออเดอร์ใหม่ ห้อง VIP 1') });
  const choose = (v) => {
    set('alertSound', v);
    set('alertSoundName', custom.find((c) => c.value === v)?.label.replace(/^🎵 /, '') || null);
  };
  const send = async (blob, fileName, name) => {
    setBusy(true);
    try {
      const fd = new FormData();
      if (name) fd.append('name', name); // before the file, so the server reads it with the upload
      fd.append('file', blob, fileName);
      const r = await upload('/printers/sounds', fd);
      set('alertSound', r.url);
      set('alertSoundName', r.name);
      setRec(null);
      toast.success('เพิ่มเสียงแล้ว กด "บันทึก" เพื่อใช้กับเครื่องพิมพ์นี้');
      playAlert(r.url, { volume: form.alertVolume ?? 80 });
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const record = async () => {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return toast.error('อุปกรณ์นี้อัดเสียงไม่ได้ — ใช้ปุ่มอัปโหลดไฟล์เสียงแทน');
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return toast.error('ไม่ได้รับอนุญาตให้ใช้ไมโครโฟน — อนุญาตไมโครโฟนในเบราว์เซอร์แล้วลองใหม่');
    }
    const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((x) => MediaRecorder.isTypeSupported?.(x)) || '';
    const mr = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const parts = [];
    mr.ondataavailable = (e) => e.data.size && parts.push(e.data);
    mr.onstop = () => {
      stream.getTracks().forEach((x) => x.stop());
      clearInterval(recRef.current?.timer);
      const mime = mr.mimeType || type || 'audio/webm';
      const blob = new Blob(parts, { type: mime });
      const ext = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm';
      setRec({ state: 'DONE', blob, url: URL.createObjectURL(blob), ext });
    };
    mr.start();
    const started = Date.now();
    const timer = setInterval(() => {
      const secs = Math.floor((Date.now() - started) / 1000);
      setRec({ state: 'REC', secs });
      if (secs >= 15) mr.state === 'recording' && mr.stop(); // at most 15 seconds
    }, 250);
    recRef.current = { mr, timer };
    setRec({ state: 'REC', secs: 0 });
  };
  const stop = () => recRef.current?.mr.state === 'recording' && recRef.current.mr.stop();
  useEffect(() => () => { clearInterval(recRef.current?.timer); stop(); }, []);
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="row nowrap">
        <Select value={form.alertSound || 'beep'} onChange={(e) => choose(e.target.value)} options={options} />
        <Button icon={Play} onClick={preview}>{t('ฟัง')}</Button>
      </div>
      <input ref={fileRef} type="file" hidden accept="audio/*,.mp3,.wav,.ogg,.m4a,.aac,.webm" onChange={(e) => { const f = e.target.files?.[0]; if (f) send(f, f.name); e.target.value = ''; }} />
      {!rec && (
        <div className="row">
          <Button size="sm" icon={Upload} loading={busy} onClick={() => fileRef.current?.click()}>{t('อัปโหลดไฟล์เสียง')}</Button>
          <Button size="sm" icon={Mic} onClick={record}>{t('อัดเสียงเอง')}</Button>
        </div>
      )}
      {rec?.state === 'REC' && (
        <div className="row nowrap rec-box">
          <span className="rec-dot" /> <b>{t('กำลังอัดเสียง')} 0:{String(rec.secs).padStart(2, '0')}</b> <span className="xs muted">/ 0:15</span>
          <Button size="sm" variant="danger" icon={Square} onClick={stop}>{t('หยุด')}</Button>
        </div>
      )}
      {rec?.state === 'DONE' && (
        <div className="col rec-box" style={{ gap: 6 }}>
          <audio src={rec.url} controls style={{ width: '100%' }} />
          <div className="row">
            <Button size="sm" variant="primary" loading={busy} onClick={() => send(rec.blob, `recording.${rec.ext}`, `${t('เสียงที่อัดเอง')} ${new Date().toLocaleString('th-TH', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`)}>{t('ใช้เสียงนี้')}</Button>
            <Button size="sm" icon={Mic} onClick={record}>{t('อัดใหม่')}</Button>
            <Button size="sm" variant="ghost" onClick={() => setRec(null)}>{t('ยกเลิก')}</Button>
          </div>
        </div>
      )}
      <div className="xs muted">{t('ไฟล์ .mp3 .wav .ogg .m4a ไม่เกิน 3 MB · อัดเสียงได้ไม่เกิน 15 วินาที เช่น "ออเดอร์มาแล้วจ้า"')}</div>
    </div>
  );
}

export default function Printers() {
  const { t } = useT();
  const toast = useToast();
  const { settings, loadSettings } = useAuth();
  const { preview, layouts } = usePrint();
  const [discover, setDiscover] = useState(null);
  const [usbAdded, setUsbAdded] = useState(null);
  const [searching, setSearching] = useState(false);
  const [local, setLocal] = useState(getLocalPrinterId());
  const [key, setKey] = useState(0);
  const [qrPrint, setQrPrint] = useState(localStorage.getItem('bb_print_qr_orders') !== 'false');
  const [tab, setTab] = useState('printers');
  const testKitchen = async (p) => {
    const r = await printJob({ printer: p, docs: [{ docType: 'KITCHEN', data: sampleData('KITCHEN', settings.store) }], layouts, record: { clientJobId: `test-kitchen-${p.id}-${Date.now()}`, reference: `TEST-${p.name}` } });
    r.ok ? toast.success(t('พิมพ์ใบครัวทดสอบแล้ว')) : toast.error(r.suggestion ? `${r.error} — ${r.suggestion}` : r.error);
  };
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
  // "ค้นหาเครื่องพิมพ์ USB": the browser lists the printers plugged in by cable; the chosen one is added (or found again)
  const searchUsb = async () => {
    setSearching(true);
    try {
      const dev = await searchUsbPrinter();
      if (!dev) return;
      const list = await api.get('/printers');
      const same = list.find((p) => p.connection === 'USB' && Number(p.usb_vendor_id) === dev.vendorId && Number(p.usb_product_id) === dev.productId && (!p.usb_serial || !dev.serialNumber || p.usb_serial === dev.serialNumber));
      const printer = same || (await api.post('/printers', { name: usbLabel(dev), connection: 'USB', renderMode: 'RASTER', station: 'MAIN', paperWidth: 80, paperPreset: '80', copies: 1, autoPrint: true, autoCut: true, openDrawer: true, isActive: true, isDefault: !list.length, usbVendorId: dev.vendorId, usbProductId: dev.productId, usbSerial: dev.serialNumber || null }));
      setLocalPrinterId(printer.id);
      setLocal(printer.id);
      setUsbAdded({ printer, existed: !!same, label: usbLabel(dev) });
      setKey((k) => k + 1);
    } catch (e) {
      toast.error(e.message || e);
    } finally {
      setSearching(false);
    }
  };
  const useForAll = async (p) => {
    try {
      await api.post(`/printers/${p.id}/use-for-all`);
      setLocalPrinterId(p.id);
      setLocal(p.id);
      await loadSettings();
      toast.success(`${t('ใช้เครื่องนี้กับทุกเอกสารแล้ว')}: ${p.name}`);
      setKey((k) => k + 1);
      setUsbAdded(null);
    } catch (e) {
      toast.error(e);
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
        <Switch checked={qrPrint} onChange={(x) => { localStorage.setItem('bb_print_qr_orders', String(x)); setQrPrint(x); }} label={t('เครื่องนี้พิมพ์ใบครัว/บาร์อัตโนมัติ (ทุกออเดอร์: หน้าขาย POS, เพิ่มสินค้าเข้าห้อง, ลูกค้าสั่งผ่าน QR)')} />
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
        extraHead={<>
          <Button variant="primary" icon={Usb} loading={searching} onClick={searchUsb}>{t('ค้นหาเครื่องพิมพ์ USB')}</Button>
          <Button icon={Search} onClick={() => setDiscover({ printers: null, subnet: '' })}>{t('ค้นหาเครื่องพิมพ์ในเครือข่าย')}</Button>
        </>}
        defaults={{ connection: 'USB', port: 9100, station: 'MAIN', paperWidth: 80, paperPreset: '80', printableWidthMm: '', marginLeftMm: 0, marginRightMm: 0, marginTopMm: 0, marginBottomMm: 3, fontScale: 1, renderMode: 'RASTER', allowPrinterFont: false, escposCodepage: '', charsPerLine: '', model: '', density: 8, speed: 0, marginMm: 2, copies: 1, autoPrint: true, autoCut: true, openDrawer: true, isDefault: false, isActive: true, beepKitchen: true, beepTimes: 3, kitchenAlert: 'PRINTER', alertSound: 'beep', alertSoundName: null, alertVolume: 80, alertOrder: 'BEFORE' }}
        toForm={(r) => ({ id: r.id, name: r.name, connection: r.connection, address: r.address, port: r.port, station: r.station, paperWidth: r.paper_width, paperPreset: [58, 80].includes(r.paper_width) ? String(r.paper_width) : 'CUSTOM', printableWidthMm: r.printable_width_mm ?? '', marginLeftMm: r.margin_left_mm, marginRightMm: r.margin_right_mm, marginTopMm: r.margin_top_mm, marginBottomMm: r.margin_bottom_mm, fontScale: r.font_scale, renderMode: r.render_mode, allowPrinterFont: r.allow_printer_font, escposCodepage: r.escpos_codepage ?? '', charsPerLine: r.chars_per_line ?? '', model: r.model || '', density: r.density, speed: r.speed, marginMm: r.margin_mm, copies: r.copies, autoPrint: r.auto_print, autoCut: r.auto_cut, openDrawer: r.open_drawer, isDefault: r.is_default, isActive: r.is_active, beepKitchen: r.beep_kitchen !== false, beepTimes: r.beep_times || 3, kitchenAlert: r.kitchen_alert || (r.beep_kitchen === false ? 'OFF' : 'PRINTER'), alertSound: r.alert_sound || 'beep', alertSoundName: r.alert_sound_name, alertVolume: r.alert_volume ?? 80, alertOrder: r.alert_order || 'BEFORE' })}
        columns={[
          { label: 'เครื่องพิมพ์', render: (r) => { const I = ICON[r.connection]; return <div className="row nowrap"><I size={18} /><div><b>{r.name}</b>{r.is_default && <Badge color="#8b5cf6">{t('หลัก')}</Badge>}{local === r.id && <Badge color="#2563eb">{t('เครื่องนี้')}</Badge>}<div className="xs muted">{r.connection} {r.address && `· ${r.address}:${r.port}`}</div></div></div>; } },
          { label: 'ใช้สำหรับ', render: (r) => ({ MAIN: t('ใบเสร็จ'), KITCHEN: t('ครัว'), BAR: t('บาร์'), PREP: t('จุดเตรียม') })[r.station] },
          { label: 'กระดาษ / พื้นที่พิมพ์', render: (r) => { const g = paperGeometry(r); return <span className="small">{r.paper_width}mm · {t('พิมพ์ได้')} {g.printableMm}mm · {t('ฟอนต์')} ×{Number(r.font_scale || 1)}</span>; } },
          { label: 'โหมดการพิมพ์', render: (r) => { const pr = routeProblem(r); const [c, l] = MODE_BADGE[printMode(r)]; return <div className="small"><Badge color={c}>{t(l)}</Badge>{pr && <div className="xs" style={{ color: 'var(--danger)' }}>{pr.message}</div>}</div>; } },
          { label: 'ตัวเลือก', render: (r) => <span className="small">{r.copies} {t('ใบ')} {r.auto_print && `· ${t('พิมพ์อัตโนมัติ')}`} {r.auto_cut && `· ${t('ตัดกระดาษ')}`} {r.open_drawer && `· ${t('เปิดลิ้นชัก')}`}</span> },
          { label: 'สถานะ', render: (r) => <Badge color={r.status === 'ONLINE' ? '#16a34a' : r.status === 'OFFLINE' ? '#dc2626' : '#6b7280'}>{r.status}</Badge> },
        ]}
        rowActions={(r) => (
          <>
            {['SERIAL', 'BLUETOOTH'].includes(r.connection) && <Button size="sm" onClick={() => pair(r)}>{t('เชื่อมต่อ')}</Button>}
            <Button size="sm" variant="ghost" icon={Activity} title={t('ตรวจสอบสถานะ')} onClick={() => status(r)} />
            <Button size="sm" variant="ghost" icon={FileText} title={t('ทดสอบพิมพ์')} onClick={() => test(r)} />
            <Button size="sm" variant="ghost" icon={Bell} title={t('ทดสอบใบครัว + เสียงเตือน')} onClick={() => testKitchen(r)} />
            <Button size="sm" variant="ghost" icon={Wallet} title={t('เปิดลิ้นชัก')} onClick={async () => { const x = await openDrawer(r); x.ok ? toast.success('เปิดลิ้นชักแล้ว') : toast.warning(x.error); api.post('/drawer/open').catch(() => {}); }} />
            <Button size="sm" variant={local === r.id ? 'primary' : ''} onClick={() => { setLocalPrinterId(r.id); setLocal(r.id); }}>{t('ใช้กับเครื่องนี้')}</Button>
            <Button size="sm" icon={CheckCheck} onClick={() => useForAll(r)}>{t('ใช้กับทุกเอกสาร')}</Button>
          </>
        )}
        fields={[
          { key: 'name', label: 'ชื่อเครื่องพิมพ์', required: true },
          { key: 'connection', label: 'การเชื่อมต่อ', type: 'select', options: CONN, required: true },
          { key: 'address', label: 'IP Address', hidden: (f) => f.connection !== 'NETWORK' },
          { key: 'port', label: 'Port', type: 'number', hidden: (f) => f.connection !== 'NETWORK' },
          { key: 'station', label: 'ใช้สำหรับ', type: 'select', options: [{ value: 'MAIN', label: 'ใบเสร็จ (หลัก)' }, { value: 'KITCHEN', label: 'ครัว' }, { value: 'BAR', label: 'บาร์' }, { value: 'PREP', label: 'จุดเตรียมสินค้า' }], required: true },
          { key: 'model', label: 'รุ่นเครื่องพิมพ์ (ไม่บังคับ)', placeholder: 'เช่น Epson TM-T82III, Xprinter XP-Q80' },
          { key: 'renderMode', label: 'วิธีพิมพ์', type: 'select', options: MODES, hidden: (f) => f.connection === 'BROWSER', hint: 'ฟอนต์ที่ตั้งไว้ (แบบเดิม): ระบบวาดเอกสารด้วยฟอนต์ของร้านแล้วส่งไปเครื่องพิมพ์ทางสายโดยตรง เหมือนระบบเดิม' },
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
          { key: 'speed', label: 'ความเร็วการพิมพ์', type: 'select', options: SPEEDS, hidden: (f) => f.connection === 'BROWSER' || !isEpson(f), hint: 'ส่งคำสั่งตั้งความเร็วของ Epson ให้เครื่องเดินกระดาษช้า/เร็วต่อเนื่องจริง · ช้าลง = ตัวหนังสือคมและเข้มขึ้น' },
          { key: 'speedInfo', label: 'ความเร็วการพิมพ์', type: 'custom', full: true, hidden: (f) => f.connection === 'BROWSER' || isEpson(f), render: () => <div className="small muted">{t('เครื่องพิมพ์รุ่นทั่วไป (เช่น POS-80, Xprinter) เก็บความเร็วไว้ในตัวเครื่อง และไม่รับคำสั่งปรับความเร็วจากโปรแกรม — ตั้งได้ที่ตัวเครื่องครั้งเดียวแล้วมีผลถาวร: ใช้โปรแกรมตั้งค่าของผู้ผลิต (เช่น "Printer Tool" / "POS Printer Setting" เมนู Print Speed หรือ Density) หรือ DIP switch ใต้เครื่อง (ดูคู่มือรุ่นนั้น) · ถ้าเป็นเครื่อง Epson ให้ใส่ชื่อรุ่นในช่อง "รุ่นเครื่องพิมพ์" แล้วจะเลือกระดับความเร็วได้')}</div> },
          { key: 'copies', label: 'จำนวนใบที่ต้องการพิมพ์', type: 'number' },
          { key: 'autoPrint', label: 'พิมพ์ใบเสร็จอัตโนมัติหลังชำระเงิน', type: 'switch', switchLabel: 'เปิด' },
          { key: 'autoCut', label: 'ตัดกระดาษอัตโนมัติ', type: 'switch', switchLabel: 'เปิด' },
          { key: 'openDrawer', label: 'เปิดลิ้นชักหลังรับเงินสด', type: 'switch', switchLabel: 'เปิด' },
          { key: 'kitchenAlert', label: 'เสียงเตือนเมื่อพิมพ์ใบครัว/บาร์', type: 'select', options: (f) => (f.connection === 'BROWSER' ? ALERT_KINDS.filter((x) => ['DEVICE', 'OFF'].includes(x.value)) : ALERT_KINDS), full: true, hint: 'ลำโพงในเครื่องพิมพ์ดังได้แค่ปิ๊บๆ (Xprinter / Gprinter / Rongta) · ถ้าต้องการเลือกเสียง อัปโหลด หรืออัดเสียงเอง ให้เลือก "ลำโพงของเครื่อง POS / แท็บเล็ต" — เสียงจะดังที่เครื่องที่สั่งพิมพ์ใบครัว' },
          { key: 'alertSound', label: 'เสียงที่ใช้', type: 'custom', full: true, hidden: (f) => !hasDeviceSound(f), render: (form, set) => <SoundPicker form={form} set={set} /> },
          { key: 'alertOrder', label: 'ลำดับเสียงกับการพิมพ์', type: 'select', hidden: (f) => !hasAlert(f), options: [{ value: 'BEFORE', label: 'มีเสียงก่อน แล้วค่อยพิมพ์ใบ' }, { value: 'AFTER', label: 'พิมพ์ใบก่อน แล้วค่อยมีเสียง' }] },
          { key: 'beepTimes', label: 'จำนวนครั้งที่ดัง', type: 'number', hidden: (f) => !hasAlert(f) },
          { key: 'alertVolume', label: 'ความดัง (0–100)', type: 'number', hidden: (f) => !hasDeviceSound(f), hint: 'ความดังของเสียงที่เครื่อง POS / แท็บเล็ต (ลำโพงเครื่องพิมพ์ปรับไม่ได้)' },
          { key: 'isDefault', label: 'เครื่องพิมพ์หลัก', type: 'switch', switchLabel: 'ตั้งเป็นเครื่องหลัก' },
          { key: 'isActive', label: 'สถานะ', type: 'switch', switchLabel: 'เปิดใช้งาน' },
        ]}
        toPayload={(f) => ({
          ...f,
          speedInfo: undefined, // display-only field
          speed: isEpson(f) ? Number(f.speed) || 0 : 0,
          renderMode: f.connection === 'BROWSER' ? 'DRIVER' : f.renderMode === 'ESCPOS_TEXT' ? 'ESCPOS_TEXT' : 'RASTER',
          paperWidth: f.paperPreset === 'CUSTOM' ? Number(f.paperWidth) : Number(f.paperPreset || f.paperWidth || 80),
          printableWidthMm: f.printableWidthMm === '' || f.printableWidthMm == null ? null : Number(f.printableWidthMm),
          escposCodepage: f.escposCodepage === '' || f.escposCodepage == null ? null : Number(f.escposCodepage),
          charsPerLine: f.charsPerLine === '' || f.charsPerLine == null ? null : Number(f.charsPerLine),
          address: f.address || null,
        })}
      />
      <div className="card flat mt small muted">
        <Info size={14} /> {t('เสียบสาย USB ของเครื่องพิมพ์ แล้วกด "ค้นหาเครื่องพิมพ์ USB" → เลือกเครื่องพิมพ์ในรายการ → กด "ใช้กับทุกเอกสาร" เอกสารทุกชนิดจะพิมพ์ด้วยฟอนต์ที่ตั้งไว้ทางสาย USB เหมือนระบบเดิม (ใช้ Google Chrome หรือ Microsoft Edge) · ลบเครื่องพิมพ์ที่ไม่ใช้แล้วได้ด้วยปุ่มถังขยะ')}
      </div>
      </>}
      {usbAdded && (
        <Modal title={usbAdded.existed ? t('พบเครื่องพิมพ์นี้ในระบบแล้ว') : t('เพิ่มเครื่องพิมพ์ USB แล้ว')} onClose={() => setUsbAdded(null)}>
          <div className="col">
            <div className="row nowrap"><Usb size={18} /> <b>{usbAdded.printer.name}</b></div>
            <div className="small muted">{t('เครื่องนี้ (คอมพิวเตอร์นี้) จะพิมพ์ไปที่เครื่องพิมพ์นี้ ด้วยฟอนต์ที่ตั้งไว้ทางสาย USB')}</div>
            <div className="row">
              <Button variant="primary" icon={CheckCheck} onClick={() => useForAll(usbAdded.printer)}>{t('ใช้เครื่องนี้กับทุกเอกสาร')}</Button>
              <Button icon={FileText} onClick={() => test(usbAdded.printer)}>{t('ทดสอบพิมพ์')}</Button>
            </div>
          </div>
        </Modal>
      )}
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
            <Button icon={Usb} onClick={() => { setDiscover(null); searchUsb(); }}>{t('ค้นหา USB')}</Button>
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
  const [kitchenAuto, setKitchenAuto] = useState(true);
  const [batch, setBatch] = useState(5);
  useEffect(() => {
    setR({ ...DEFAULT_ROUTING, ...(settings?.documents?.routing || {}) });
    setAuto(settings?.documents?.autoPrintReceipt !== false);
    setKitchenAuto(settings?.documents?.kitchenAuto !== false);
    setBatch(settings?.documents?.kitchenBatchSeconds ?? 5);
  }, [settings?.documents]);
  if (!r) return <Loading />;
  const set = (doc, k, v) => setR((x) => ({ ...x, [doc]: { ...x[doc], [k]: v } }));
  const save = async () => {
    try {
      await api.put('/documents/settings', { routing: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, { printerId: v.printerId ? Number(v.printerId) : null, copies: Number(v.copies) || 1, cut: !!v.cut, auto: !!v.auto }])), autoPrintReceipt: auto, kitchenAuto, kitchenBatchSeconds: Number(batch) || 0 });
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
      <Switch checked={kitchenAuto} onChange={setKitchenAuto} label="พิมพ์ใบครัว/บาร์อัตโนมัติทุกครั้งที่มีการสั่งสินค้า (POS, เพิ่มเข้าห้อง, QR)" />
      {kitchenAuto && (
        <div className="row small">
          {t('รวมรายการที่สั่งติดกันภายใน')}
          <Input type="number" min={0} max={120} style={{ width: 80 }} value={batch} onChange={(e) => setBatch(e.target.value)} />
          {t('วินาที เป็นใบเดียว')}
        </div>
      )}
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
      <div className="xs muted">{t('การตัดกระดาษในโหมดไดรเวอร์ระบบ ให้ตั้งในไดรเวอร์ว่า "ตัดกระดาษทุกหน้า" (แต่ละสำเนาคือ 1 หน้า) · สาย USB / ESC/POS ระบบส่งคำสั่งตัดให้เอง')}</div>
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
        <b>{t('1) สาย USB — ฟอนต์ที่ตั้งไว้ แบบเดิม (แนะนำ)')}</b>
        <ul>
          <li>{t('เสียบสาย USB → กด "ค้นหาเครื่องพิมพ์ USB" → เลือกเครื่องพิมพ์ → กด "ใช้เครื่องนี้กับทุกเอกสาร" (ใบเสร็จ ใบเปิดห้อง ใบสั่งครัว/บาร์ ปิดกะ ทุกชนิด)')}</li>
          <li>{t('ระบบวาดเอกสารด้วยฟอนต์ของร้าน (เช่น Kanit) ตามที่ออกแบบไว้ แล้วส่งเป็นภาพขาวดำ (ESC/POS) ไปที่เครื่องพิมพ์ทางสายโดยตรง ไม่ต้องเปิดหน้าต่างพิมพ์ ใช้ได้กับเครื่องพิมพ์ใบเสร็จ ESC/POS ทั่วไป (Xprinter, Epson TM, Gprinter, Rongta ฯลฯ)')}</li>
          <li>{t('ต้องใช้ Google Chrome หรือ Microsoft Edge บนคอมพิวเตอร์ ครั้งแรกเบราว์เซอร์จะถามสิทธิ์ใช้เครื่องพิมพ์ หลังจากนั้นจำไว้ให้')}</li>
          <li>{t('Windows: ถ้าขึ้นว่า "เครื่องพิมพ์ถูกไดรเวอร์ของ Windows ใช้งานอยู่" ให้เปลี่ยนไดรเวอร์ของเครื่องพิมพ์เป็น WinUSB ด้วยโปรแกรม Zadig (ครั้งเดียว) หรือใช้การเชื่อมต่อ "ไดรเวอร์ระบบ" แทน')}</li>
          <li>{t('ลบเครื่องพิมพ์ที่ไม่ใช้แล้วด้วยปุ่มถังขยะ — เครื่องที่ลบจะหายจากรายการและจากการตั้งค่าเอกสาร (ประวัติงานพิมพ์เดิมยังอยู่)')}</li>
        </ul>
      </div>
      <div className="card flat">
        <b>{t('2) ไดรเวอร์ระบบ (Windows / macOS) — ฟอนต์ที่ตั้งไว้')}</b>
        <ul>
          <li>{t('ข้อความถูกส่งเป็นข้อความจริงพร้อมฟอนต์ที่ฝังจากเบราว์เซอร์ (Chrome / Edge) ไปยังไดรเวอร์ของระบบปฏิบัติการ')}</li>
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
        <b>{t('3) ESC/POS ข้อความ — ฟอนต์ของเครื่องพิมพ์ (เลือกเองเท่านั้น)')}</b>
        <ul>
          <li>{t('พิมพ์ด้วยฟอนต์ที่อยู่ในเครื่องพิมพ์เท่านั้น (เร็วที่สุด แต่ไม่ใช่ฟอนต์ของร้าน) — ต้องเลือกโหมดนี้เองในการแก้ไขเครื่องพิมพ์')}</li>
          <li>{t('ภาษาไทยต้องเป็นรุ่นที่มีชุดอักษรไทยในเครื่อง (Thai code page) และตั้ง Code page ให้ตรงคู่มือ เช่น Epson TM รุ่นไทย, Xprinter รุ่นที่ระบุว่ารองรับภาษาไทย')}</li>
          <li>{t('QR Code ใช้คำสั่ง QR ของเครื่องพิมพ์เอง (GS ( k) — ต้องเป็นรุ่นที่รองรับคำสั่งนี้')}</li>
          <li>{t('โลโก้เป็นรูปภาพ จึงไม่พิมพ์ในโหมดนี้')}</li>
        </ul>
      </div>
    </div>
  );
}

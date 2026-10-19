// Printing engine.
//
// Three routes:
//  1. RASTER (default for USB / Serial / Bluetooth / Network) — like the previous system: the document is drawn in the
//     store's receipt font exactly as on screen and sent to the printer as ESC/POS image rows over the cable. No driver
//     and no print dialog; the font is always the store font.
//  2. DRIVER (for "BROWSER" printers) — the operating-system printer driver. The document is real HTML text in the
//     store's receipt font, laid out on a page exactly as wide as the paper and exactly as long as the content
//     (CSS @page per document). For printing without a dialog run Chrome/Edge with --kiosk-printing.
//  3. ESCPOS_TEXT — raw ESC/POS text; the printer prints with its OWN fonts. Only when the admin chose it explicitly.
// When the chosen font or route can't be honoured, printing stops with a clear message — the font is never switched.
//
// All documents go through one queue, so they print one after another in order and never interleave.
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { api, LS } from './api.js';
import { translate, getLang } from './i18n.jsx';
import { buildDoc } from './docs.js';
import { textLines, encodeLineUnits, DRAWER_KICK, speedCommand, FEED_MM } from './escpos.js';
import { playAlert } from './sounds.js';
import { DocView } from '../components/DocView.jsx';
import { loadFont } from './fonts.js';

const t = (s, v) => translate(s, v);

export class PrintError extends Error {
  constructor(message, code, suggestion) {
    super(message);
    this.code = code;
    this.suggestion = suggestion;
  }
}

// ── paper geometry ──
/** Usable width of a printer: paper width − non-printable sides − the store's margins (mm). */
export function paperGeometry(printer = {}) {
  const paper = Number(printer.paper_width || 80);
  const printable = Math.min(paper, Number(printer.printable_width_mm) || (paper <= 60 ? 48 : paper === 80 ? 72 : Math.max(20, paper - 8)));
  const side = (paper - printable) / 2;
  const ml = side + Number(printer.margin_left_mm || 0);
  const mr = side + Number(printer.margin_right_mm || 0);
  return {
    paperMm: paper,
    printableMm: printable,
    contentMm: Math.max(20, paper - ml - mr),
    ml,
    mr,
    mt: Number(printer.margin_top_mm || 0),
    mb: printer.margin_bottom_mm == null ? 3 : Number(printer.margin_bottom_mm),
    scale: Number(printer.font_scale || 1),
  };
}

/** Virtual printer used when no printer is set up: the OS default printer through its driver, 80 mm roll. */
export const DRIVER_FALLBACK = { id: null, name: 'เครื่องพิมพ์หลักของระบบ (ไดรเวอร์)', connection: 'BROWSER', render_mode: 'DRIVER', paper_width: 80, copies: 1, auto_cut: true };

/** Can this printer print documents at all, and how? → null when fine, else a PrintError (never a silent fallback). */
export function routeProblem(printer) {
  const p = printer || DRIVER_FALLBACK;
  const raw = p.connection && p.connection !== 'BROWSER';
  if (p.render_mode === 'ESCPOS_TEXT') {
    if (!raw) return new PrintError(t('โหมดฟอนต์ของเครื่องพิมพ์ (ESC/POS) ต้องเชื่อมต่อแบบ USB / Serial / Bluetooth / Network'), 'PRINT_ROUTE_UNSUPPORTED', t('เปลี่ยนการเชื่อมต่อ หรือใช้โหมดไดรเวอร์ระบบ'));
    if (!p.allow_printer_font) return new PrintError(t('เครื่องพิมพ์นี้ยังไม่ได้ยืนยันการใช้ฟอนต์ของเครื่องพิมพ์'), 'PRINTER_FONT_NOT_ACCEPTED', t('เปิด "ยอมรับการใช้ฟอนต์ของเครื่องพิมพ์" ในหน้าเครื่องพิมพ์ หรือใช้โหมดไดรเวอร์ระบบ'));
  }
  return null;
}

/** How a printer prints: OS driver (real text), direct connection with the store font (image), or printer fonts. */
export function printMode(printer) {
  const p = printer || DRIVER_FALLBACK;
  if (!p.connection || p.connection === 'BROWSER') return 'DRIVER';
  return p.render_mode === 'ESCPOS_TEXT' ? 'ESCPOS_TEXT' : 'RASTER';
}

// ── fonts ──
const fontOk = new Map();
/** Make sure every font of the document is really loaded — otherwise stop (the browser would silently substitute it). */
export async function ensureFonts(families) {
  const missing = [];
  for (const f of [...new Set(families.filter(Boolean))]) {
    if (fontOk.get(f)) continue;
    loadFont(f); // imported fonts used only inside a document layout are registered here
    try {
      const faces = await Promise.race([document.fonts.load(`16px "${f}"`, 'กขคABC123'), new Promise((r) => setTimeout(() => r(null), 8000))]);
      const ok = Array.isArray(faces) && faces.some((x) => x.status === 'loaded');
      fontOk.set(f, ok);
      if (!ok) missing.push(f);
    } catch {
      missing.push(f);
    }
  }
  return missing;
}

/** The receipt font currently applied (Admin → appearance; default Kanit). */
export function receiptFontFamily() {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--font-receipt') || "'Kanit'";
  return v.split(',')[0].trim().replace(/^['"]|['"]$/g, '') || 'Kanit';
}

// ── driver route ──
function printRoot() {
  let el = document.getElementById('print-root');
  if (!el) {
    el = document.createElement('div');
    el.id = 'print-root';
    document.body.appendChild(el);
  }
  return el;
}

const PX_TO_MM = 25.4 / 96;

/**
 * Print documents through the OS driver: every copy is its own page, as wide as the paper and as long as its content.
 * pages: [{ sections, isCopy }]
 */
async function driverPrint(pages, printer) {
  const g = paperGeometry(printer);
  const host = printRoot();
  host.className = 'doc-print';
  const root = createRoot(host);
  flushSync(() =>
    root.render(
      <>
        {pages.map((p, i) => (
          <div key={i} className="print-page" data-page={i}>
            <DocView sections={p.sections} geometry={g} />
          </div>
        ))}
      </>,
    ),
  );
  try {
    const families = [receiptFontFamily(), ...pages.flatMap((p) => p.sections.map((s) => s.style.font))];
    const missing = await ensureFonts(families);
    if (missing.length) {
      throw new PrintError(t('โหลดฟอนต์ {f} ไม่สำเร็จ — ระบบจะไม่เปลี่ยนไปใช้ฟอนต์อื่นเอง', { f: missing.join(', ') }), 'FONT_UNAVAILABLE', t('ตรวจสอบอินเทอร์เน็ต / ไฟล์ฟอนต์ที่นำเข้า แล้วลองใหม่ หรือเลือกฟอนต์อื่นในหน้าออกแบบเอกสาร'));
    }
    await Promise.all([...host.querySelectorAll('img')].map((img) => (img.complete ? null : new Promise((r) => ((img.onload = r), (img.onerror = r))))));
    // exact page length for every document: no A4, no cut-off, no long blank tail
    const rules = [...host.querySelectorAll('.print-page')].map((el, i) => {
      const h = Math.ceil(el.getBoundingClientRect().height * PX_TO_MM * 10) / 10 + 1;
      return `@page bbp${i} { size: ${g.paperMm}mm ${h}mm; margin: 0; }\n#print-root .print-page[data-page="${i}"] { page: bbp${i}; }`;
    });
    let style = document.getElementById('bb-page-rules');
    if (!style) {
      style = document.createElement('style');
      style.id = 'bb-page-rules';
      document.head.appendChild(style);
    }
    style.textContent = rules.join('\n');
    document.body.classList.add('printing-docs');
    await new Promise((r) => setTimeout(r, 60));
    window.print(); // blocks until the dialog closes (or returns at once with --kiosk-printing)
  } finally {
    document.body.classList.remove('printing-docs');
    setTimeout(() => root.unmount(), 300);
  }
}

// ── direct connection with the store font: the document is drawn exactly as on screen and sent as ESC/POS image rows ──
const DOTS_PER_MM = 8; // 203 dpi thermal printers

async function rasterBytes(pages, printer, { drawer = false } = {}) {
  const { default: html2canvas } = await import('html2canvas');
  const g0 = paperGeometry(printer);
  // the printer's own left/right edge is already outside the image: draw only the printable width
  const g = { ...g0, paperMm: g0.printableMm, ml: Number(printer.margin_left_mm || 0) + 1, mr: Number(printer.margin_right_mm || 0) + 1 };
  const widthDots = Math.floor((g.printableMm * DOTS_PER_MM) / 8) * 8;
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-20000px;top:0;background:#fff;';
  document.body.appendChild(host);
  const root = createRoot(host);
  flushSync(() =>
    root.render(
      <>
        {pages.map((p, i) => (
          <div key={i} className="raster-page" style={{ width: `${g.paperMm}mm` }}>
            <DocView sections={p.sections} geometry={g} qrAsImage />
          </div>
        ))}
      </>,
    ),
  );
  try {
    const missing = await ensureFonts([receiptFontFamily(), ...pages.flatMap((p) => p.sections.map((s) => s.style.font))]);
    if (missing.length) throw new PrintError(t('โหลดฟอนต์ {f} ไม่สำเร็จ', { f: missing.join(', ') }), 'FONT_UNAVAILABLE', t('ตรวจสอบอินเทอร์เน็ต / ไฟล์ฟอนต์ที่นำเข้า แล้วลองใหม่'));
    await Promise.all([...host.querySelectorAll('img')].map((img) => (img.complete ? null : new Promise((r) => ((img.onload = r), (img.onerror = r))))));
    await new Promise((r) => setTimeout(r, 60));
    const units = [];
    const nodes = [...host.querySelectorAll('.raster-page')];
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const scale = widthDots / node.getBoundingClientRect().width;
      const canvas = await html2canvas(node, { backgroundColor: '#ffffff', scale, useCORS: true, logging: false });
      units.push(...canvasToEscPos(canvas, widthDots, { density: Number(printer.density || 8), speedCmd: speedCommand(printer), cut: pages[i].cut, drawer: drawer && i === nodes.length - 1 }));
    }
    return units;
  } finally {
    root.unmount();
    host.remove();
  }
}

/** Canvas → ESC/POS units { bytes, mm }: init, then image bands of up to 255 rows (GS v 0), then feed / cut. */
function canvasToEscPos(canvas, widthDots, { density = 8, speedCmd = [], cut = true, drawer = false } = {}) {
  const ESC = 0x1b;
  const GS = 0x1d;
  const w = Math.min(widthDots, canvas.width);
  const h = canvas.height;
  const data = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  const bytesPerRow = Math.ceil(w / 8);
  const raster = new Uint8Array(bytesPerRow * h);
  const threshold = 200 - (density - 8) * 6;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] < threshold) raster[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  const units = [{ bytes: new Uint8Array([ESC, 0x40, ...speedCmd]), mm: 0 }];
  for (let y = 0; y < h; y += 255) {
    const rows = Math.min(255, h - y);
    const band = new Uint8Array(8 + rows * bytesPerRow);
    band.set([GS, 0x76, 0x30, 0x00, bytesPerRow & 0xff, (bytesPerRow >> 8) & 0xff, rows & 0xff, (rows >> 8) & 0xff]);
    band.set(raster.subarray(y * bytesPerRow, (y + rows) * bytesPerRow), 8);
    units.push({ bytes: band, mm: rows / DOTS_PER_MM });
  }
  const tail = [ESC, 0x64, 4];
  if (cut) tail.push(GS, 0x56, 0x42, 0x00);
  if (drawer) tail.push(ESC, 0x70, 0x00, 0x19, 0xfa);
  units.push({ bytes: new Uint8Array(tail), mm: FEED_MM });
  return units;
}


/**
 * Kitchen / bar ticket alert of a printer: its buzzer, a sound on this device, both or none,
 * and whether the sound comes before or after the ticket prints.
 */
export function kitchenAlert(printer, mode = printMode(printer)) {
  const kind = printer.kitchen_alert || (printer.beep_kitchen === false ? 'OFF' : 'PRINTER');
  return {
    buzzer: ['PRINTER', 'BOTH'].includes(kind) && mode !== 'DRIVER',
    device: ['DEVICE', 'BOTH'].includes(kind),
    after: printer.alert_order === 'AFTER',
    sound: printer.alert_sound || 'beep',
    times: printer.beep_times || 3,
    volume: printer.alert_volume ?? 80,
  };
}

/** The sound of a kitchen alert on this device (resolves when it has finished). */
export function playKitchenAlert(al, data = {}) {
  const lang = getLang();
  const where = data.room || data.queueNo;
  const text = lang === 'en' ? `New order${where ? `, ${where}` : ''}` : `มีออเดอร์ใหม่${where ? ` ${where}` : ''}`;
  return playAlert(al.sound, { times: al.times, volume: al.volume, text, lang });
}

/** Buzzer: ESC B n t — n beeps of t × 50 ms. */
export function beepBytes(times = 3) {
  const n = Math.min(9, Math.max(1, Number(times) || 3));
  return new Uint8Array([0x1b, 0x42, n, 3]);
}

function concatBytes(parts) {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ── raw transports ──
const handles = {};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Write bytes in writes of at most maxStep (the most a connection takes at once). */
async function writeAll(bytes, maxStep, write) {
  for (let i = 0; i < bytes.length; i += maxStep) await write(bytes.subarray(i, i + maxStep));
}

const usbMatches = (dev, p) =>
  (!p?.usb_vendor_id || dev.vendorId === Number(p.usb_vendor_id)) && (!p?.usb_product_id || dev.productId === Number(p.usb_product_id)) && (!p?.usb_serial || !dev.serialNumber || dev.serialNumber === p.usb_serial);

/** USB printers this browser may already use (no dialog). */
export async function knownUsbPrinters() {
  if (!navigator.usb) return [];
  return navigator.usb.getDevices();
}

/** "ค้นหาเครื่องพิมพ์": the browser lists the USB printers that are plugged in; the chosen one is remembered. */
export async function searchUsbPrinter({ all = false } = {}) {
  if (!navigator.usb) throw new PrintError(t('เบราว์เซอร์นี้ค้นหาเครื่องพิมพ์ USB ไม่ได้ กรุณาใช้ Google Chrome หรือ Microsoft Edge บนคอมพิวเตอร์'), 'TRANSPORT');
  try {
    return await navigator.usb.requestDevice({ filters: all ? [] : [{ classCode: 7 }] });
  } catch (e) {
    if (e?.name === 'NotFoundError') return null; // closed the list without choosing
    throw e;
  }
}

export function usbLabel(dev) {
  return [dev.manufacturerName, dev.productName].filter(Boolean).join(' ') || `USB ${dev.vendorId.toString(16).padStart(4, '0')}:${dev.productId.toString(16).padStart(4, '0')}`;
}

async function sendUsb(bytes, printer) {
  if (!navigator.usb) throw new PrintError(t('เบราว์เซอร์นี้ไม่รองรับการพิมพ์ผ่าน USB (ใช้ Google Chrome หรือ Microsoft Edge)'), 'TRANSPORT');
  const devices = await navigator.usb.getDevices();
  let dev = devices.find((d) => usbMatches(d, printer)) || (!printer?.usb_vendor_id ? devices[0] : null);
  if (!dev) {
    // first use on this computer: ask once (afterwards the browser remembers the printer)
    dev = await navigator.usb
      .requestDevice({ filters: printer?.usb_vendor_id ? [{ vendorId: Number(printer.usb_vendor_id), productId: Number(printer.usb_product_id) || undefined }] : [{ classCode: 7 }] })
      .catch(() => null);
    if (!dev) throw new PrintError(t('ไม่พบเครื่องพิมพ์ USB ที่เสียบอยู่ — ตรวจสายและไฟเครื่องพิมพ์ แล้วกด "ค้นหาเครื่องพิมพ์ USB"'), 'USB_NOT_FOUND');
  }
  try {
    if (!dev.opened) await dev.open();
    if (dev.configuration === null) await dev.selectConfiguration(1);
    const iface = dev.configuration.interfaces.find((i) => i.alternate.endpoints.some((e) => e.direction === 'out' && e.type === 'bulk')) || dev.configuration.interfaces.find((i) => i.alternate.endpoints.some((e) => e.direction === 'out'));
    if (!iface) throw new PrintError(t('อุปกรณ์นี้ไม่ใช่เครื่องพิมพ์ (ไม่มีช่องส่งข้อมูล)'), 'USB_NOT_PRINTER');
    if (!iface.claimed) await dev.claimInterface(iface.interfaceNumber);
    const ep = iface.alternate.endpoints.find((e) => e.direction === 'out');
    await writeAll(bytes, 16384, (chunk) => dev.transferOut(ep.endpointNumber, chunk));
    handles.usb = dev;
  } catch (e) {
    if (e instanceof PrintError) throw e;
    if (/claim|access denied|SecurityError|Unable to claim/i.test(`${e?.name} ${e?.message}`)) {
      throw new PrintError(
        t('เครื่องพิมพ์ USB ถูกไดรเวอร์ของ Windows ใช้งานอยู่ เบราว์เซอร์จึงส่งงานพิมพ์ตรงไม่ได้'),
        'USB_BUSY',
        t('ทางเลือก: (1) ติดตั้งไดรเวอร์ WinUSB ให้เครื่องพิมพ์ด้วยโปรแกรม Zadig แล้วลองใหม่ หรือ (2) แก้ไขเครื่องพิมพ์นี้ เปลี่ยนการเชื่อมต่อเป็น "ไดรเวอร์ระบบ" (ใช้ไดรเวอร์ Windows ที่ติดตั้งไว้)'),
      );
    }
    throw new PrintError(`${t('ส่งงานไปเครื่องพิมพ์ USB ไม่สำเร็จ')}: ${e?.message || e}`, 'USB_FAILED', t('ถอดสาย USB แล้วเสียบใหม่ จากนั้นกดพิมพ์ใหม่'));
  }
}

async function sendSerial(bytes) {
  if (!navigator.serial) throw new PrintError(t('เบราว์เซอร์นี้ไม่รองรับ Web Serial (ใช้ Chrome/Edge)'), 'TRANSPORT');
  let port = handles.serial || (await navigator.serial.getPorts())[0];
  if (!port) port = await navigator.serial.requestPort();
  if (!port.writable) await port.open({ baudRate: 9600 });
  const w = port.writable.getWriter();
  try {
    await writeAll(bytes, 4096, (chunk) => w.write(chunk));
  } finally {
    w.releaseLock();
  }
  handles.serial = port;
}

const BLE_SERVICES = ['000018f0-0000-1000-8000-00805f9b34fb', '0000ff00-0000-1000-8000-00805f9b34fb', 'e7810a71-73ae-499d-8c15-faa9aef0c3f2', '49535343-fe7d-4ae5-8fa9-9fafd205e455'];

export async function connectBluetooth() {
  if (!navigator.bluetooth) throw new PrintError(t('เบราว์เซอร์นี้ไม่รองรับ Web Bluetooth (ใช้ Chrome บน Android/Windows/Mac)'), 'TRANSPORT');
  const device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BLE_SERVICES });
  const server = await device.gatt.connect();
  let ch = null;
  for (const s of await server.getPrimaryServices()) {
    for (const c of await s.getCharacteristics()) {
      if (c.properties.write || c.properties.writeWithoutResponse) {
        ch = c;
        break;
      }
    }
    if (ch) break;
  }
  if (!ch) throw new PrintError(t('ไม่พบช่องทางส่งข้อมูลของเครื่องพิมพ์ Bluetooth'), 'TRANSPORT');
  handles.ble = { device, ch };
  return device.name;
}

async function sendBluetooth(bytes) {
  if (!handles.ble?.device?.gatt?.connected) await connectBluetooth();
  const { ch } = handles.ble;
  await writeAll(bytes, 180, (chunk) => (ch.properties.writeWithoutResponse ? ch.writeValueWithoutResponse(chunk) : ch.writeValue(chunk)));
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function sendRaw(printer, bytes, jobId) {
  if (printer.connection === 'NETWORK') return api.post(`/printers/${printer.id}/raw`, { data: toBase64(bytes), jobId });
  if (printer.connection === 'USB') return sendUsb(bytes, printer);
  if (printer.connection === 'SERIAL') return sendSerial(bytes);
  if (printer.connection === 'BLUETOOTH') return sendBluetooth(bytes);
  throw new PrintError(t('ไม่รู้จักการเชื่อมต่อเครื่องพิมพ์'), 'TRANSPORT');
}

// ── one queue for every document ──
const queue = [];
let running = false;
const listeners = new Set();
export const printQueue = {
  size: () => queue.length + (running ? 1 : 0),
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
const notify = () => listeners.forEach((f) => f(printQueue.size()));

function enqueue(task) {
  return new Promise((resolve) => {
    queue.push({ task, resolve });
    notify();
    pump();
  });
}
async function pump() {
  if (running) return;
  running = true;
  while (queue.length) {
    const { task, resolve } = queue.shift();
    notify();
    try {
      resolve(await task());
    } catch (e) {
      resolve({ ok: false, error: e.message, code: e.code, suggestion: e.suggestion });
    }
  }
  running = false;
  notify();
}

/**
 * Print one job: documents of the same job print together, in order, on one printer.
 * job: { printer, docs: [{ docType, data, isCopy, copies, cut }], layouts, drawer, record: { clientJobId, reference, jobId } }
 * Returns { ok, error, code, suggestion, jobId }.
 */
export function printJob(job) {
  return enqueue(async () => {
    const printer = job.printer || DRIVER_FALLBACK;
    const docType = job.docs[0]?.docType;
    const payload = job.docs.length === 1 ? { docType, data: job.docs[0].data } : { docs: job.docs.map((d) => ({ docType: d.docType, data: d.data })) };
    // server record first (status + reprint); the same clientJobId never creates a second record
    let jobId = job.record?.jobId || null;
    if (!jobId) {
      try {
        const rec = await api.post('/print-jobs', { clientJobId: job.record?.clientJobId || null, printerId: printer.id, docType, jobType: docType, reference: job.record?.reference || null, isCopy: job.docs.some((d) => d.isCopy), copies: job.docs[0]?.copies || 1, payload, status: 'PRINTING', reprintOf: job.record?.reprintOf || null });
        jobId = rec.id;
        if (rec.duplicate && rec.status === 'PRINTED' && !job.record?.force) return { ok: true, jobId, duplicate: true };
      } catch {
        /* offline: still print */
      }
    } else api.patch(`/print-jobs/${jobId}`, { status: 'PRINTING', printerId: printer.id }).catch(() => {});
    try {
      const problem = routeProblem(printer);
      if (problem) throw problem;
      const pages = [];
      for (const d of job.docs) {
        const sections = buildDoc(d.docType, d.data, { isCopy: d.isCopy, layouts: job.layouts, geometry: paperGeometry(printer), fontLabel: receiptFontFamily() });
        for (let c = 0; c < (d.copies || 1); c++) pages.push({ sections, cut: d.cut !== false });
      }
      const mode = printMode(printer);
      // kitchen / bar ticket: the printer's buzzer (ESC B n t — Xprinter, Gprinter, Rongta …) and / or a sound on this device,
      // before or after the ticket prints
      const kitchenDoc = job.docs.find((d) => d.docType === 'KITCHEN');
      const al = kitchenDoc ? kitchenAlert(printer, mode) : null;
      const beep = al?.buzzer ? { bytes: beepBytes(al.times), mm: 0 } : null;
      // the buzzer goes right after the printer is initialised (before) or after the cut (after)
      const withBeep = (units) => (!beep ? units : al.after ? [...units, beep] : [units[0], beep, ...units.slice(1)]);
      if (al?.device && !al.after) await playKitchenAlert(al, kitchenDoc.data);
      const t0 = Date.now();
      let lengthMm = 0;
      if (mode === 'RASTER' || mode === 'ESCPOS_TEXT') {
        const units =
          mode === 'RASTER'
            ? await rasterBytes(pages, printer, { drawer: job.drawer })
            : pages.flatMap((p, i) => encodeLineUnits(textLines(p.sections, printer).lines, printer, { copies: 1, cut: p.cut, drawer: job.drawer && i === pages.length - 1 }));
        const all = withBeep(units);
        lengthMm = all.reduce((a, u) => a + u.mm, 0);
        await sendRaw(printer, concatBytes(all.map((u) => u.bytes)), jobId);
      } else {
        await driverPrint(pages, printer);
      }
      if (al?.device && al.after) {
        // the data is sent before the paper has come out: wait for the printer to finish, then the sound
        const printMs = lengthMm ? (lengthMm / 150) * 1000 : 1500; // ~150 mm/s, a typical receipt printer
        await wait(Math.min(8000, Math.max(0, printMs - (Date.now() - t0))));
        await playKitchenAlert(al, kitchenDoc.data);
      }
      if (jobId) api.patch(`/print-jobs/${jobId}`, { status: 'PRINTED' }).catch(() => {});
      return { ok: true, jobId };
    } catch (e) {
      const msg = e.message || t('เครื่องพิมพ์ไม่ได้เชื่อมต่อ');
      if (jobId) api.patch(`/print-jobs/${jobId}`, { status: 'FAILED', error: e.suggestion ? `${msg} — ${e.suggestion}` : msg }).catch(() => {});
      return { ok: false, error: msg, code: e.code, suggestion: e.suggestion, jobId };
    }
  });
}

/** A4 report through the OS dialog (not a receipt). */
export async function browserPrint(elements) {
  const host = printRoot();
  host.className = 'report';
  document.body.classList.add('print-a4');
  const root = createRoot(host);
  flushSync(() => root.render(<>{elements}</>));
  await document.fonts?.ready;
  // pictures (logo, card backgrounds) must be loaded or they print blank; one that never loads is not waited for long
  const imgs = [...host.querySelectorAll('img')].filter((i) => !i.complete);
  await Promise.race([Promise.all(imgs.map((i) => new Promise((r) => { i.onload = i.onerror = r; }))), new Promise((r) => setTimeout(r, 5000))]);
  await new Promise((r) => setTimeout(r, 150));
  window.print();
  setTimeout(() => {
    root.unmount();
    document.body.classList.remove('print-a4');
  }, 500);
}

export function getLocalPrinterId() {
  return LS.get('bb_printer_id');
}
export function setLocalPrinterId(id) {
  LS.set('bb_printer_id', id);
}

export async function openDrawer(printer) {
  if (!printer || printer.connection === 'BROWSER') return { ok: false, error: t('ลิ้นชักเปิดผ่านไดรเวอร์เครื่องพิมพ์ (ตั้งค่า "เปิดลิ้นชักเมื่อพิมพ์" ในไดรเวอร์)') };
  try {
    await sendRaw(printer, DRAWER_KICK);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function pairDevice(connection) {
  if (connection === 'USB') {
    if (!navigator.usb) throw new PrintError(t('เบราว์เซอร์นี้ไม่รองรับ WebUSB (ใช้ Chrome/Edge)'), 'TRANSPORT');
    handles.usb = await navigator.usb.requestDevice({ filters: [] });
    return handles.usb.productName || 'USB Printer';
  }
  if (connection === 'SERIAL') {
    if (!navigator.serial) throw new PrintError(t('เบราว์เซอร์นี้ไม่รองรับ Web Serial (ใช้ Chrome/Edge)'), 'TRANSPORT');
    handles.serial = await navigator.serial.requestPort();
    return 'Serial Printer';
  }
  if (connection === 'BLUETOOTH') return connectBluetooth();
  return 'Driver';
}

export function transportStatus(connection) {
  if (connection === 'USB') return handles.usb?.opened ? 'ONLINE' : navigator.usb ? 'READY' : 'UNSUPPORTED';
  if (connection === 'SERIAL') return handles.serial?.writable ? 'ONLINE' : navigator.serial ? 'READY' : 'UNSUPPORTED';
  if (connection === 'BLUETOOTH') return handles.ble?.device?.gatt?.connected ? 'ONLINE' : navigator.bluetooth ? 'READY' : 'UNSUPPORTED';
  return 'ONLINE';
}

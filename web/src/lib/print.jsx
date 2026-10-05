// Printing engine for 80mm thermal printers.
// - BROWSER: OS print dialog / driver (USB printers installed in the OS), CSS @page 80mm
// - USB (WebUSB), SERIAL (Web Serial: USB-serial cable), BLUETOOTH (Web Bluetooth BLE), NETWORK (server → IP:9100)
//   send ESC/POS raster images rendered from the same receipt HTML (keeps the chosen Thai font perfectly).
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import html2canvas from 'html2canvas';
import { api, LS } from './api.js';
import { translate } from './i18n.jsx';

const ESC = 0x1b;
const GS = 0x1d;

async function renderOffscreen(element, widthPx = 576) {
  const host = document.createElement('div');
  host.style.cssText = `position:fixed;left:-10000px;top:0;width:${widthPx}px;background:#fff;`;
  document.body.appendChild(host);
  const root = createRoot(host);
  flushSync(() => root.render(element));
  await document.fonts?.ready;
  await Promise.all([...host.querySelectorAll('img')].map((img) => (img.complete ? null : new Promise((r) => ((img.onload = r), (img.onerror = r))))));
  await new Promise((r) => setTimeout(r, 120));
  return { host, root };
}

/** HTML receipt → 1-bit raster → ESC/POS bytes. */
export async function receiptToEscPos(element, { widthDots = 576, density = 8, cut = true, drawer = false, copies = 1 } = {}) {
  const { host, root } = await renderOffscreen(element, widthDots);
  const node = host.querySelector('.receipt') || host;
  node.style.width = `${widthDots}px`;
  node.style.padding = '8px';
  node.style.fontSize = '22px';
  const canvas = await html2canvas(node, { backgroundColor: '#ffffff', scale: 1, useCORS: true, width: widthDots });
  root.unmount();
  host.remove();
  const ctx = canvas.getContext('2d');
  const w = Math.min(widthDots, canvas.width);
  const h = canvas.height;
  const data = ctx.getImageData(0, 0, w, h).data;
  const bytesPerRow = Math.ceil(w / 8);
  const raster = new Uint8Array(bytesPerRow * h);
  const threshold = 200 - (density - 8) * 6;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (lum < threshold) raster[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  const parts = [];
  for (let c = 0; c < copies; c++) {
    parts.push([ESC, 0x40]); // init
    // print raster in bands of 255 rows (printer buffer friendly)
    for (let y = 0; y < h; y += 255) {
      const rows = Math.min(255, h - y);
      parts.push([GS, 0x76, 0x30, 0x00, bytesPerRow & 0xff, (bytesPerRow >> 8) & 0xff, rows & 0xff, (rows >> 8) & 0xff]);
      parts.push(raster.slice(y * bytesPerRow, (y + rows) * bytesPerRow));
    }
    parts.push([ESC, 0x64, 4]); // feed 4 lines
    if (cut) parts.push([GS, 0x56, 0x42, 0x00]); // partial cut
  }
  if (drawer) parts.push([ESC, 0x70, 0x00, 0x19, 0xfa]); // kick drawer pin 2
  const len = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export const DRAWER_KICK = new Uint8Array([ESC, 0x40, ESC, 0x70, 0x00, 0x19, 0xfa]);

// ── transports ──
const handles = {};

async function sendUsb(bytes) {
  if (!navigator.usb) throw new Error(translate('เบราว์เซอร์นี้ไม่รองรับ WebUSB (ใช้ Chrome/Edge)'));
  let dev = handles.usb || (await navigator.usb.getDevices())[0];
  if (!dev) dev = await navigator.usb.requestDevice({ filters: [{ classCode: 7 }] }).catch(() => navigator.usb.requestDevice({ filters: [] }));
  if (!dev.opened) await dev.open();
  if (dev.configuration === null) await dev.selectConfiguration(1);
  const iface = dev.configuration.interfaces.find((i) => i.alternate.endpoints.some((e) => e.direction === 'out'));
  if (!iface.claimed) await dev.claimInterface(iface.interfaceNumber);
  const ep = iface.alternate.endpoints.find((e) => e.direction === 'out');
  for (let i = 0; i < bytes.length; i += 16384) await dev.transferOut(ep.endpointNumber, bytes.slice(i, i + 16384));
  handles.usb = dev;
}

async function sendSerial(bytes) {
  if (!navigator.serial) throw new Error(translate('เบราว์เซอร์นี้ไม่รองรับ Web Serial (ใช้ Chrome/Edge)'));
  let port = handles.serial || (await navigator.serial.getPorts())[0];
  if (!port) port = await navigator.serial.requestPort();
  if (!port.writable) await port.open({ baudRate: 9600 });
  const w = port.writable.getWriter();
  await w.write(bytes);
  w.releaseLock();
  handles.serial = port;
}

const BLE_SERVICES = ['000018f0-0000-1000-8000-00805f9b34fb', '0000ff00-0000-1000-8000-00805f9b34fb', 'e7810a71-73ae-499d-8c15-faa9aef0c3f2', '49535343-fe7d-4ae5-8fa9-9fafd205e455'];

export async function connectBluetooth() {
  if (!navigator.bluetooth) throw new Error(translate('เบราว์เซอร์นี้ไม่รองรับ Web Bluetooth (ใช้ Chrome บน Android/Windows/Mac)'));
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
  if (!ch) throw new Error(translate('ไม่พบช่องทางส่งข้อมูลของเครื่องพิมพ์ Bluetooth'));
  handles.ble = { device, ch };
  return device.name;
}

async function sendBluetooth(bytes) {
  if (!handles.ble?.device?.gatt?.connected) await connectBluetooth();
  const { ch } = handles.ble;
  for (let i = 0; i < bytes.length; i += 180) {
    const chunk = bytes.slice(i, i + 180);
    if (ch.properties.writeWithoutResponse) await ch.writeValueWithoutResponse(chunk);
    else await ch.writeValue(chunk);
  }
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Print via the OS dialog (BROWSER mode). */
export async function browserPrint(elements, { a4 = false } = {}) {
  let rootEl = document.getElementById('print-root');
  if (!rootEl) {
    rootEl = document.createElement('div');
    rootEl.id = 'print-root';
    document.body.appendChild(rootEl);
  }
  rootEl.className = a4 ? 'report' : '';
  document.body.classList.toggle('print-a4', a4);
  const root = createRoot(rootEl);
  flushSync(() => root.render(<>{elements}</>));
  await document.fonts?.ready;
  await Promise.all([...rootEl.querySelectorAll('img')].map((img) => (img.complete ? null : new Promise((r) => ((img.onload = r), (img.onerror = r))))));
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

/**
 * Print a receipt element on the chosen printer.
 * printer: row from /api/printers. Returns { ok, error }.
 */
export async function printElement(element, printer, { jobType = 'RECEIPT', reference = null, isCopy = false, drawer = null, copies = null } = {}) {
  const p = printer || { connection: 'BROWSER', copies: 1, auto_cut: true };
  const n = copies ?? p.copies ?? 1;
  try {
    if (p.connection === 'BROWSER' || !p.connection) {
      await browserPrint(Array.from({ length: n }, (_, i) => <div key={i}>{element}</div>));
    } else {
      const bytes = await receiptToEscPos(element, { density: p.density, cut: p.auto_cut, drawer: drawer ?? false, copies: n });
      if (p.connection === 'NETWORK') await api.post(`/printers/${p.id}/raw`, { data: toBase64(bytes), jobType, reference, isCopy });
      else if (p.connection === 'USB') await sendUsb(bytes);
      else if (p.connection === 'SERIAL') await sendSerial(bytes);
      else if (p.connection === 'BLUETOOTH') await sendBluetooth(bytes);
    }
    if (p.id && p.connection !== 'NETWORK') api.post('/print-jobs', { printerId: p.id, jobType, reference, isCopy, status: 'PRINTED' }).catch(() => {});
    return { ok: true };
  } catch (e) {
    if (p.id) api.post('/print-jobs', { printerId: p.id, jobType, reference, isCopy, status: 'FAILED', error: e.message }).catch(() => {});
    return { ok: false, error: e.message || translate('เครื่องพิมพ์ไม่ได้เชื่อมต่อ') };
  }
}

export async function openDrawer(printer) {
  if (!printer || printer.connection === 'BROWSER') return { ok: false, error: translate('การเปิดลิ้นชักผ่านเบราว์เซอร์ทำงานผ่านไดรเวอร์เครื่องพิมพ์') };
  try {
    if (printer.connection === 'NETWORK') await api.post(`/printers/${printer.id}/raw`, { data: toBase64(DRAWER_KICK), jobType: 'DRAWER' });
    else if (printer.connection === 'USB') await sendUsb(DRAWER_KICK);
    else if (printer.connection === 'SERIAL') await sendSerial(DRAWER_KICK);
    else if (printer.connection === 'BLUETOOTH') await sendBluetooth(DRAWER_KICK);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function pairDevice(connection) {
  if (connection === 'USB') {
    if (!navigator.usb) throw new Error(translate('เบราว์เซอร์นี้ไม่รองรับ WebUSB (ใช้ Chrome/Edge)'));
    handles.usb = await navigator.usb.requestDevice({ filters: [] });
    return handles.usb.productName || 'USB Printer';
  }
  if (connection === 'SERIAL') {
    if (!navigator.serial) throw new Error(translate('เบราว์เซอร์นี้ไม่รองรับ Web Serial (ใช้ Chrome/Edge)'));
    handles.serial = await navigator.serial.requestPort();
    return 'Serial Printer';
  }
  if (connection === 'BLUETOOTH') return connectBluetooth();
  return 'Browser';
}

export function transportStatus(connection) {
  if (connection === 'USB') return handles.usb?.opened ? 'ONLINE' : navigator.usb ? 'READY' : 'UNSUPPORTED';
  if (connection === 'SERIAL') return handles.serial?.writable ? 'ONLINE' : navigator.serial ? 'READY' : 'UNSUPPORTED';
  if (connection === 'BLUETOOTH') return handles.ble?.device?.gatt?.connected ? 'ONLINE' : navigator.bluetooth ? 'READY' : 'UNSUPPORTED';
  return 'ONLINE';
}

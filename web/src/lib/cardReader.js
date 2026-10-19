// Card readers on this device. Most USB RFID readers and barcode scanners type the number like a keyboard and press
// Enter (KEYBOARD, nothing to set up). Readers on a USB-serial port send a line per card (SERIAL, Chrome / Edge, paired
// once). Android phones / tablets with NFC read the card's serial number (NFC, Chrome on Android). The choice is kept
// on this device.
import { useEffect, useRef } from 'react';
import { useScannerWedge } from './scanner.js';

const KEY = 'bb_card_reader';
export const READER_DEFAULT = { mode: 'KEYBOARD', baud: 9600, strip: '' };

export function readerConfig() {
  try {
    return { ...READER_DEFAULT, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...READER_DEFAULT };
  }
}
export function setReaderConfig(v) {
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    /* private mode: the default (keyboard) still works */
  }
}

export const serialSupported = () => typeof navigator !== 'undefined' && !!navigator.serial;
export const nfcSupported = () => typeof window !== 'undefined' && 'NDEFReader' in window;

/** What a reader gives → the card number: the store's prefix removed, "MEMBER:" (member QR) removed, no spaces. */
export function cleanCardNo(raw, cfg = readerConfig()) {
  let v = String(raw || '').trim();
  if (cfg.strip && v.startsWith(cfg.strip)) v = v.slice(cfg.strip.length);
  return v.replace(/^MEMBER:/i, '').replace(/[\s:]+/g, '').toUpperCase();
}

/** Pair a USB-serial card reader (needs a click). */
export async function pairSerialReader() {
  if (!serialSupported()) throw new Error('เบราว์เซอร์นี้ไม่รองรับ Web Serial (ใช้ Chrome/Edge บนคอมพิวเตอร์)');
  await navigator.serial.requestPort();
}

/** Read lines from the paired serial reader until stop() — calls onLine(text). */
async function readSerial(baud, onLine, stopped) {
  const [port] = await navigator.serial.getPorts();
  if (!port) return null;
  if (!port.readable) await port.open({ baudRate: Number(baud) || 9600 });
  const reader = port.readable.getReader();
  const dec = new TextDecoder();
  let buf = '';
  (async () => {
    try {
      while (!stopped()) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split(/[\r\n\x02\x03]+/);
        buf = parts.pop();
        parts.filter(Boolean).forEach(onLine);
      }
    } catch {
      /* unplugged */
    }
  })();
  return async () => {
    try {
      await reader.cancel();
      reader.releaseLock();
      await port.close();
    } catch {
      /* already closed */
    }
  };
}

/** Start reading NFC cards (must come from a tap / click). Returns stop(). */
export async function startNfc(onRead) {
  if (!nfcSupported()) throw new Error('อุปกรณ์นี้ไม่รองรับ NFC ผ่านเว็บ (ใช้ Chrome บน Android)');
  const ctl = new AbortController();
  const nfc = new window.NDEFReader();
  await nfc.scan({ signal: ctl.signal });
  nfc.onreading = (e) => e.serialNumber && onRead(e.serialNumber);
  return () => ctl.abort();
}

/**
 * Cards read by this device's reader → onRead(cardNo). The keyboard kind is caught anywhere on the page except inside a
 * text box (a text box gets the number itself); a serial reader is read in the background while `enabled`.
 */
export function useCardReader(onRead, enabled = true) {
  const cb = useRef(onRead);
  cb.current = onRead;
  useScannerWedge((code) => cb.current(cleanCardNo(code)), enabled);
  useEffect(() => {
    const cfg = readerConfig();
    if (!enabled || cfg.mode !== 'SERIAL' || !serialSupported()) return;
    let stop = false;
    let close = null;
    readSerial(cfg.baud, (line) => cb.current(cleanCardNo(line, cfg)), () => stop).then((c) => {
      if (stop) c?.();
      else close = c;
    }).catch(() => {});
    return () => {
      stop = true;
      close?.();
    };
  }, [enabled]);
}

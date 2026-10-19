// Camera QR / barcode scanner: native BarcodeDetector when available (Chrome/Android), jsQR fallback (iPad, Safari, Firefox).
// USB / Bluetooth barcode scanners type like a keyboard: useScannerWedge catches them anywhere on the page.
import { useEffect, useRef } from 'react';
import jsQR from 'jsqr';

// camera streams kept open between scans (keep = true): the browser asks for the camera once, not at every scan
const kept = {};

async function cameraStream(facing, keep) {
  const k = kept[facing];
  if (k && k.getVideoTracks().some((tr) => tr.readyState === 'live')) {
    k.getVideoTracks().forEach((tr) => (tr.enabled = true));
    return k;
  }
  const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing } }, audio: false });
  if (keep) kept[facing] = s;
  return s;
}

/**
 * Scan with the camera while active. options.facing: 'environment' (back) | 'user' (front, e.g. a tablet facing the
 * customer); options.keep: keep the camera ready between scans (paused, not closed) so permission is asked only once.
 */
export function useCameraScanner(videoRef, active, onResult, onError, { facing = 'environment', keep = false } = {}) {
  useEffect(() => {
    if (!active) return;
    let stream;
    let stop = false;
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('อุปกรณ์นี้ไม่รองรับกล้อง หรือเว็บไม่ได้เปิดผ่าน HTTPS');
        stream = await cameraStream(facing, keep);
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        video.setAttribute('playsinline', 'true');
        await video.play();
        const det = 'BarcodeDetector' in window ? new window.BarcodeDetector({ formats: ['qr_code', 'code_128'] }) : null;
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        while (!stop) {
          let value = null;
          if (video.readyState >= 2) {
            if (det) value = (await det.detect(video).catch(() => []))[0]?.rawValue || null;
            if (!value) {
              const w = Math.min(960, video.videoWidth);
              const h = Math.round((video.videoHeight / video.videoWidth) * w) || 0;
              if (w && h) {
                canvas.width = w;
                canvas.height = h;
                ctx.drawImage(video, 0, 0, w, h);
                value = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' })?.data || null;
              }
            }
          }
          if (value) {
            onResult(value);
            break;
          }
          await new Promise((r) => setTimeout(r, 250));
        }
      } catch (e) {
        onError?.(e);
      }
    })();
    return () => {
      stop = true;
      if (keep && stream === kept[facing]) stream.getTracks().forEach((t) => (t.enabled = false));
      else stream?.getTracks().forEach((t) => t.stop());
    };
  }, [active, facing]);
}

/**
 * A barcode scanner typing on the keyboard: characters arriving very fast and ending with Enter, while the cursor
 * is not in a text box (a text box handles its own Enter). Calls onScan(code).
 */
export function useScannerWedge(onScan, enabled = true) {
  const buf = useRef({ text: '', last: 0 });
  const cb = useRef(onScan);
  cb.current = onScan;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e) => {
      const el = document.activeElement;
      if (el && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable)) return;
      const now = Date.now();
      const b = buf.current;
      if (now - b.last > 60) b.text = ''; // people type slower than scanners
      b.last = now;
      if (e.key === 'Enter') {
        if (b.text.length >= 6) {
          e.preventDefault();
          cb.current(b.text);
        }
        b.text = '';
      } else if (e.key.length === 1) b.text += e.key;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}

/** Looks like a booking code (QR "CHECKIN:…" or a booking number such as BK20261005001). */
export const isBookingCode = (v) => /^CHECKIN:/i.test(v || '') || /^BK\d{6,}/i.test((v || '').trim());

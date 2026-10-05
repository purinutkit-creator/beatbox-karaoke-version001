// Camera QR / barcode scanner: native BarcodeDetector when available (Chrome/Android), jsQR fallback (iPad, Safari, Firefox).
import { useEffect } from 'react';
import jsQR from 'jsqr';

export function useCameraScanner(videoRef, active, onResult, onError) {
  useEffect(() => {
    if (!active) return;
    let stream;
    let stop = false;
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('อุปกรณ์นี้ไม่รองรับกล้อง หรือเว็บไม่ได้เปิดผ่าน HTTPS');
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
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
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [active]);
}

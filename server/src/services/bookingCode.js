// The booking pass as a picture (PNG) for LINE: the check-in QR on top, the barcode of the booking number below it and
// the number in big digits — what the customer shows at the counter. Drawn here pixel by pixel (no image library).
import QRCode from 'qrcode';
import JsBarcode from 'jsbarcode';
import { PNG } from 'pngjs';

// 5 × 7 letters for the booking number under the barcode
const FONT = {
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11100', '10010', '10001', '10001', '10001', '10010', '11100'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '10001', '11001', '10101', '10011', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '10001', '01010', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
};

function canvas(w, h) {
  const png = new PNG({ width: w, height: h });
  png.data.fill(255);
  const rect = (x, y, rw, rh, [r, g, b] = [0, 0, 0]) => {
    for (let yy = Math.max(0, y); yy < Math.min(h, y + rh); yy++)
      for (let xx = Math.max(0, x); xx < Math.min(w, x + rw); xx++) {
        const i = (yy * w + xx) * 4;
        png.data[i] = r;
        png.data[i + 1] = g;
        png.data[i + 2] = b;
        png.data[i + 3] = 255;
      }
  };
  return { png, rect };
}

/** PNG (Buffer) of the booking pass: QR of `qrText`, barcode + digits of `barcodeText`. */
export function bookingCodePng(qrText, barcodeText, { accent = [139, 92, 246] } = {}) {
  const W = 720;
  const qr = QRCode.create(String(qrText), { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const scale = Math.floor(480 / (n + 2));
  const qrPx = (n + 2) * scale;
  const enc = {};
  JsBarcode(enc, String(barcodeText), { format: 'CODE128', margin: 0 });
  const bits = (enc.encodings || []).map((e) => e.data).join('');
  const bar = Math.max(2, Math.floor(620 / bits.length));
  const barW = bits.length * bar;
  const text = String(barcodeText).toUpperCase();
  const px = 6; // font pixel size
  const textW = text.length * 6 * px - px;
  const H = 30 + 14 + 40 + qrPx + 40 + 150 + 26 + 7 * px + 50;
  const { png, rect } = canvas(W, H);
  rect(0, 0, W, 14, accent); // coloured band on top
  // QR
  let y = 14 + 50;
  const qx = Math.floor((W - qrPx) / 2);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.modules.get(r, c)) rect(qx + (c + 1) * scale, y + (r + 1) * scale, scale, scale);
  y += qrPx + 40;
  // barcode (with quiet zones)
  const bx = Math.floor((W - barW) / 2);
  for (let i = 0; i < bits.length; i++) if (bits[i] === '1') rect(bx + i * bar, y, bar, 150);
  y += 150 + 26;
  // the number
  let tx = Math.floor((W - textW) / 2);
  for (const ch of text) {
    const g = FONT[ch];
    if (g) for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) if (g[r][c] === '1') rect(tx + c * px, y + r * px, px, px);
    tx += 6 * px;
  }
  rect(0, H - 14, W, 14, accent);
  return PNG.sync.write(png);
}

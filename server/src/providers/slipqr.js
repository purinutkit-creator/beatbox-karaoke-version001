// Thai bank transfer slips carry a "mini QR" (Bank of Thailand slip verification payload):
//   00 (nested) → 00 API id "000001", 01 sending bank code, 02 transaction reference
//   51 country "TH", 91 CRC16
// Decoding it gives the real transaction reference without any third party, which lets us detect re-used slips
// even when the same slip is photographed again, and is what bank / provider verification APIs take as input.
import jsQR from 'jsqr';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { crc16 } from '@beatbox/shared/promptpay.js';

export const BANK_CODES = {
  '002': 'ธนาคารกรุงเทพ', '004': 'ธนาคารกสิกรไทย', '006': 'ธนาคารกรุงไทย', '011': 'ธนาคารทหารไทยธนชาต', '014': 'ธนาคารไทยพาณิชย์',
  '022': 'ธนาคารซีไอเอ็มบี', '024': 'ธนาคารยูโอบี', '025': 'ธนาคารกรุงศรีอยุธยา', '030': 'ธนาคารออมสิน', '033': 'ธนาคารอาคารสงเคราะห์',
  '034': 'ธ.ก.ส.', '066': 'ธนาคารอิสลาม', '067': 'ธนาคารทิสโก้', '069': 'ธนาคารเกียรตินาคินภัทร', '070': 'ธนาคารไอซีบีซี', '073': 'ธนาคารแลนด์ แอนด์ เฮ้าส์',
};

function tlv(str) {
  const out = {};
  let i = 0;
  while (i + 4 <= str.length) {
    const tag = str.slice(i, i + 2);
    const len = Number(str.slice(i + 2, i + 4));
    if (!Number.isFinite(len)) break;
    out[tag] = str.slice(i + 4, i + 4 + len);
    i += 4 + len;
  }
  return out;
}

/** Parse a slip QR payload. Returns null when it is not a bank slip QR. */
export function parseSlipQr(payload) {
  const s = String(payload || '').trim();
  if (!/^00\d{2}/.test(s)) return null;
  const top = tlv(s);
  const inner = tlv(top['00'] || '');
  if (!inner['02']) return null;
  let crcOk = null;
  const crcPos = s.lastIndexOf('9104');
  if (crcPos > 0 && crcPos + 8 === s.length) crcOk = crc16(s.slice(0, crcPos + 4)).toUpperCase() === s.slice(crcPos + 4).toUpperCase();
  return {
    payload: s,
    apiId: inner['00'] || null,
    sendingBank: inner['01'] || null,
    sendingBankName: BANK_CODES[inner['01']] || null,
    transRef: inner['02'],
    country: top['51'] || null,
    crcOk,
  };
}

function decodePixels(buffer, mime) {
  const isPng = mime === 'image/png' || buffer.slice(1, 4).toString() === 'PNG';
  if (isPng) {
    const png = PNG.sync.read(buffer);
    return { data: new Uint8ClampedArray(png.data), width: png.width, height: png.height };
  }
  const img = jpeg.decode(buffer, { useTArray: true, maxMemoryUsageInMB: 512, formatAsRGBA: true });
  return { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height };
}

function downscale({ data, width, height }, f) {
  const w = Math.floor(width / f);
  const h = Math.floor(height / f);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const si = (y * f * width + x * f) * 4;
      const di = (y * w + x) * 4;
      out[di] = data[si];
      out[di + 1] = data[si + 1];
      out[di + 2] = data[si + 2];
      out[di + 3] = 255;
    }
  return { data: out, width: w, height: h };
}

/** Read the QR code from a slip image (JPG/PNG). Returns the parsed slip QR or { raw } for other QR codes. */
export function readSlipQr(buffer, mime) {
  let img;
  try {
    img = decodePixels(buffer, mime);
  } catch {
    return null;
  }
  const attempts = [img];
  if (img.width * img.height > 2_500_000) attempts.push(downscale(img, 2));
  if (img.width * img.height > 8_000_000) attempts.push(downscale(img, 3));
  for (const a of attempts) {
    const r = jsQR(a.data, a.width, a.height, { inversionAttempts: 'attemptBoth' });
    if (r?.data) return parseSlipQr(r.data) || { raw: r.data };
  }
  return null;
}

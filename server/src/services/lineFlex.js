// LINE messages (Flex cards) for the customer: the booking found by phone, the booking pass (QR + barcode), reminders,
// the room card when the room opens, "time almost up" and the online receipt. LINE refuses a whole message for one bad
// part (an http picture, an empty text), so every value here is checked.
import { config } from '../config.js';
import { fmtDate, fmtTime } from '@beatbox/shared/format.js';
import { RESERVATION_STATUS_LABEL } from '@beatbox/shared/constants.js';

const PURPLE = '#7c3aed';
const MUTED = '#8c8c8c';

/** An https address LINE accepts (relative paths get the server address), or null. */
export function httpsUrl(u) {
  if (!u) return null;
  const abs = /^https?:\/\//i.test(u) ? u : `${config.publicUrl}${u.startsWith('/') ? '' : '/'}${u}`;
  return abs.startsWith('https://') ? abs : null;
}
/** A link that opens on the phone (http allowed while testing locally). */
const link = (path) => (/^https?:\/\//i.test(path) ? path : `${config.publicUrl}${path}`);

export function mapsUrl(settings) {
  if (settings.booking?.mapUrl) return settings.booking.mapUrl;
  const q = [settings.store?.name, settings.store?.address].filter(Boolean).join(' ');
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q || 'karaoke')}`;
}
const telUrl = (phone) => {
  const d = String(phone || '').replace(/[^0-9+]/g, '');
  return d.length >= 6 ? `tel:${d}` : null;
};

const txt = (text, o = {}) => ({ type: 'text', text: String(text ?? '').trim() || '-', wrap: true, ...o });
const row = (label, value, o = {}) => ({
  type: 'box',
  layout: 'baseline',
  spacing: 'sm',
  contents: [txt(label, { size: 'sm', color: MUTED, flex: 3, wrap: false }), txt(value, { size: 'sm', color: '#222222', flex: 7, weight: 'bold', ...o })],
});
const sep = () => ({ type: 'separator', margin: 'lg' });
const uriBtn = (label, uri, style = 'secondary', color) => (uri ? { type: 'button', style, height: 'sm', ...(color ? { color } : {}), action: { type: 'uri', label, uri } } : null);
const postBtn = (label, data, displayText, style = 'secondary', color) => ({ type: 'button', style, height: 'sm', ...(color ? { color } : {}), action: { type: 'postback', label, data, displayText } });
const footer = (buttons) => ({ type: 'box', layout: 'vertical', spacing: 'sm', contents: buttons.filter(Boolean) });
// LINE takes whole numbers only in a ratio ("20:13", not "1:1.15")
const hero = (url, ratio = '20:13', mode = 'cover') => {
  const u = httpsUrl(url);
  return u ? { type: 'image', url: u, size: 'full', aspectRatio: ratio, aspectMode: mode, ...(mode === 'fit' ? { backgroundColor: '#ffffff' } : {}) } : undefined;
};
const bubble = ({ heroUrl, heroRatio, heroMode, body, buttons }) => {
  const b = { type: 'bubble', size: 'mega', body: { type: 'box', layout: 'vertical', spacing: 'md', contents: body.filter(Boolean) } };
  const h = hero(heroUrl, heroRatio, heroMode);
  if (h) b.hero = h;
  const f = buttons?.filter(Boolean);
  if (f?.length) b.footer = footer(f);
  return b;
};
export const flex = (altText, contents) => ({ type: 'flex', altText: String(altText).slice(0, 380), contents });

const minutesText = (m) => {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h ? `${h} ชม.` : ''}${h && mm ? ' ' : ''}${mm ? `${mm} นาที` : ''}` || '0 นาที';
};
const longDate = (d) => fmtDate(d, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const timeRange = (rv) => `${fmtTime(rv.start_at)} – ${fmtTime(rv.end_at)} น.`;

/** Waiting for the customer's answer (or already confirmed) and still ahead. */
export const ACTIVE_BOOKING = ['PENDING', 'CONFIRMED', 'DEPOSIT_PAID', 'WAITING'];

/**
 * The booking found by phone. rv: reservation row + room_name, room_image, type_name, floor_name.
 * Buttons: confirm / cancel (postbacks with the booking id), Google Maps, call the store.
 */
export function bookingBubble(rv, settings) {
  const minutes = Math.round((new Date(rv.end_at) - new Date(rv.start_at)) / 60000);
  const confirmed = !!rv.customer_confirmed_at;
  const open = ACTIVE_BOOKING.includes(rv.status);
  const status = confirmed && open ? 'ยืนยันแล้ว' : RESERVATION_STATUS_LABEL[rv.status] || rv.status;
  return bubble({
    heroUrl: rv.room_image,
    body: [
      { type: 'box', layout: 'horizontal', contents: [txt(settings.store?.name || 'BEATBOX', { size: 'xs', color: PURPLE, weight: 'bold', flex: 6 }), txt(status, { size: 'xs', color: confirmed ? '#16a34a' : '#f97316', weight: 'bold', align: 'end', flex: 4 })] },
      txt(rv.room_name, { size: 'xxl', weight: 'bold', color: '#111111' }),
      txt([rv.type_name, rv.floor_name].filter(Boolean).join(' · ') || 'ห้องคาราโอเกะ', { size: 'sm', color: MUTED }),
      sep(),
      txt(longDate(rv.start_at), { size: 'sm', color: '#444444', margin: 'lg' }),
      txt(timeRange(rv), { size: 'xl', weight: 'bold', color: PURPLE }),
      txt(`⏳ ${timeUntil(rv.start_at)}`, { size: 'sm', color: '#ea580c', weight: 'bold' }),
      { type: 'box', layout: 'vertical', spacing: 'sm', margin: 'md', contents: [row('ระยะเวลา', minutesText(minutes)), row('จำนวน', `${rv.guest_count || 1} คน`), row('ชื่อผู้จอง', rv.customer_name), row('เบอร์โทร', rv.phone), row('เลขที่จอง', rv.booking_no)] },
    ],
    buttons: [
      open && !confirmed ? postBtn('✅ ยืนยันการจอง', `a=confirm&r=${rv.id}`, 'ยืนยันการจอง', 'primary', '#16a34a') : null,
      open && confirmed ? postBtn('🎫 แสดง QR การจอง', `a=pass&r=${rv.id}`, 'ขอ QR การจอง', 'primary', PURPLE) : null,
      uriBtn('🗺️ นำทาง Google Maps', mapsUrl(settings)),
      uriBtn(`📞 โทรหาร้าน ${settings.store?.phone || ''}`.trim(), telUrl(settings.store?.phone)),
      open && ['PENDING', 'CONFIRMED', 'DEPOSIT_PAID'].includes(rv.status) ? postBtn('ยกเลิกการจอง', `a=cancel&r=${rv.id}`, 'ยกเลิกการจอง', 'link', '#dc2626') : null,
    ],
  });
}

export function bookingsMessage(rows, settings) {
  const bubbles = rows.slice(0, 10).map((rv) => bookingBubble(rv, settings));
  const first = rows[0];
  return flex(`การจอง ${first.room_name} ${fmtDate(first.start_at)} ${timeRange(first)}`, bubbles.length === 1 ? bubbles[0] : { type: 'carousel', contents: bubbles });
}

/** The booking pass after confirming: the picture to save and a card with the details. */
/** "อีก 2 วัน 3 ชม. 15 นาที" until the booking starts, as it is when the message is sent. */
export function timeUntil(at, now = Date.now()) {
  let m = Math.max(0, Math.ceil((new Date(at) - now) / 60000));
  if (m <= 0) return 'ถึงเวลาแล้ว';
  const d = Math.floor(m / 1440);
  m -= d * 1440;
  const h = Math.floor(m / 60);
  m -= h * 60;
  return `อีก ${[d && `${d} วัน`, h && `${h} ชม.`, m && `${m} นาที`].filter(Boolean).join(' ')}`;
}
/** The live countdown page (days, hours, minutes, seconds) with the booking QR / barcode. */
export const passPage = (rv) => link(`/pass/${rv.check_in_token}`);

const countdownBox = (rv) => ({
  type: 'box',
  layout: 'vertical',
  backgroundColor: '#f5f3ff',
  cornerRadius: 'lg',
  paddingAll: 'md',
  contents: [txt('⏳ นับถอยหลังถึงเวลาของคุณ', { size: 'xs', color: MUTED, align: 'center' }), txt(timeUntil(rv.start_at), { size: 'xl', weight: 'bold', color: PURPLE, align: 'center' })],
});

/** The booking pass after confirming: one card — the QR + barcode picture, the time left and the live countdown. */
export function passMessages(rv, settings, codeUrl, { justConfirmed = false } = {}) {
  const img = httpsUrl(codeUrl);
  const card = bubble({
    heroUrl: img,
    heroRatio: '4:5',
    heroMode: 'fit', // the whole QR and barcode, never cropped
    body: [
      justConfirmed ? txt('✅ ยืนยันการจองเรียบร้อย แล้วพบกันนะคะ', { size: 'sm', color: '#16a34a', weight: 'bold' }) : null,
      txt('บัตรเข้าใช้ห้อง', { size: 'xs', color: PURPLE, weight: 'bold' }),
      txt(`${rv.room_name} · ${timeRange(rv)}`, { size: 'lg', weight: 'bold' }),
      txt(longDate(rv.start_at), { size: 'sm', color: '#444444' }),
      countdownBox(rv),
      txt(`แสดง QR หรือบาร์โค้ดนี้ที่เคาน์เตอร์ · ${rv.booking_no}`, { size: 'sm', color: MUTED }),
    ],
    buttons: [
      uriBtn('⏱️ นับถอยหลังแบบสด + QR', passPage(rv), 'primary', PURPLE),
      img ? uriBtn('🔍 เปิดรูป QR เต็ม (บันทึกรูป)', img) : null,
      uriBtn('🗺️ นำทาง Google Maps', mapsUrl(settings)),
      uriBtn('📞 โทรหาร้าน', telUrl(settings.store?.phone)),
    ],
  });
  return [flex(`บัตรเข้าใช้ห้อง ${rv.booking_no} ${timeUntil(rv.start_at)}`, card)];
}

export function reminderMessage(rv, minutes, settings, codeUrl) {
  return flex(
    `อีก ${minutes} นาที ถึงเวลาเข้าห้อง ${rv.room_name}`,
    bubble({
      heroUrl: rv.room_image,
      body: [
        txt(`⏰ อีก ${minutes} นาที ถึงเวลาของคุณ`, { size: 'lg', weight: 'bold', color: '#ea580c' }),
        txt(rv.room_name, { size: 'xxl', weight: 'bold' }),
        txt(timeRange(rv), { size: 'xl', weight: 'bold', color: PURPLE }),
        txt(`${rv.customer_name} · ${rv.guest_count || 1} คน · ${rv.booking_no}`, { size: 'sm', color: MUTED }),
        txt('แสดง QR การจองที่เคาน์เตอร์เมื่อมาถึง', { size: 'sm', color: '#444444' }),
      ],
      buttons: [uriBtn('⏱️ นับถอยหลัง + QR การจอง', passPage(rv), 'primary', PURPLE), uriBtn('🗺️ นำทาง Google Maps', mapsUrl(settings)), uriBtn('📞 โทรหาร้าน', telUrl(settings.store?.phone))],
    }),
  );
}

/** The room is open: when it ends (big), and the live page (countdown, order food, report a problem), the way. */
export function roomOpenMessage(s, settings) {
  const left = Math.max(0, Math.round((new Date(s.scheduled_end_at) - Date.now()) / 60000));
  const page = link(`/order/${s.order_token}`);
  return flex(
    `ห้อง ${s.room_name} เปิดแล้ว หมดเวลา ${fmtTime(s.scheduled_end_at)} น.`,
    bubble({
      heroUrl: s.room_image,
      body: [
        txt(`🎤 ห้อง ${s.room_name} พร้อมแล้ว`, { size: 'lg', weight: 'bold', color: PURPLE }),
        { type: 'box', layout: 'vertical', backgroundColor: '#f5f3ff', cornerRadius: 'lg', paddingAll: 'lg', contents: [txt('เวลาคงเหลือ', { size: 'sm', color: MUTED, align: 'center' }), txt(minutesText(left), { size: '3xl', weight: 'bold', color: '#111111', align: 'center' }), txt(`หมดเวลา ${fmtTime(s.scheduled_end_at)} น.`, { size: 'md', weight: 'bold', color: '#dc2626', align: 'center' })] },
        { type: 'box', layout: 'vertical', spacing: 'sm', contents: [row('เริ่ม', `${fmtTime(s.started_at)} น.`), row('จำนวน', `${s.guest_count || 1} คน`), row('แพ็กเกจ', s.package_name || 'รายชั่วโมง'), row('ชื่อ', s.customer_name)] },
        txt('กด "ดูเวลานับถอยหลัง" เพื่อดูเวลาแบบสด', { size: 'xs', color: MUTED }),
      ],
      buttons: [
        uriBtn('⏱️ ดูเวลานับถอยหลัง', page, 'primary', PURPLE),
        uriBtn('🍔 สั่งอาหาร / เครื่องดื่ม', `${page}?tab=menu`, 'primary', '#ea580c'),
        uriBtn('🛠️ แจ้งปัญหา / เรียกพนักงาน', `${page}?issue=1`),
        s.guide_token ? uriBtn('🧭 ทางไปห้อง', link(`/guide/${s.guide_token}`)) : null,
      ],
    }),
  );
}

export function timeLeftMessage(s, minutes) {
  const page = link(`/order/${s.order_token}`);
  return flex(
    `ห้อง ${s.room_name} เหลือเวลา ${minutes} นาที`,
    bubble({
      body: [txt(`⏳ เหลือเวลา ${minutes} นาที`, { size: 'xl', weight: 'bold', color: '#dc2626' }), txt(`ห้อง ${s.room_name} หมดเวลา ${fmtTime(s.scheduled_end_at)} น.`, { size: 'md', weight: 'bold' }), txt('ต้องการเพิ่มเวลา แจ้งพนักงานได้เลย', { size: 'sm', color: MUTED })],
      buttons: [uriBtn('⏱️ ดูเวลานับถอยหลัง', page, 'primary', PURPLE), uriBtn('🙋 ขอเพิ่มเวลา / เรียกพนักงาน', `${page}?issue=1`)],
    }),
  );
}

const money = (n) => Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const PAY = { CASH: 'เงินสด', QR: 'QR พร้อมเพย์', TRANSFER: 'โอนเงิน', CARD: 'บัตร', CREDIT: 'เครดิต', OTHER: 'อื่นๆ' };

/** The online receipt: the bill at a glance, the full receipt page and "collect points" for this bill. */
export function receiptMessage(rc, settings, { receiptUrl, pointsUrl, pointsLabel, pointsText }) {
  const s = rc.snapshot || {};
  const lines = (s.lines || []).filter((l) => Number(l.net) !== 0 || l.type !== 'DISCOUNT');
  const shown = lines.slice(0, 8).map((l) => ({
    type: 'box',
    layout: 'horizontal',
    contents: [txt(`${l.name}${Number(l.qty) > 1 ? ` ×${l.qty}` : ''}`, { size: 'sm', color: '#444444', flex: 7 }), txt(money(l.net), { size: 'sm', align: 'end', flex: 3 })],
  }));
  if (lines.length > 8) shown.push(txt(`… และอีก ${lines.length - 8} รายการ`, { size: 'xs', color: MUTED }));
  const t = s.totals || {};
  return flex(
    `ใบเสร็จ ${rc.receipt_no} ยอดชำระ ${money(t.grandTotal)} บาท`,
    bubble({
      body: [
        txt('🧾 ใบเสร็จรับเงิน', { size: 'sm', color: PURPLE, weight: 'bold' }),
        txt(settings.store?.name || s.store?.name, { size: 'lg', weight: 'bold' }),
        txt(`${rc.receipt_no} · ${fmtDate(rc.issued_at)} ${fmtTime(rc.issued_at)} น.`, { size: 'xs', color: MUTED }),
        s.room ? txt(`ห้อง ${s.room.name} · ${fmtTime(s.room.startedAt)} – ${fmtTime(s.room.endedAt)} น.`, { size: 'sm', color: '#444444' }) : null,
        sep(),
        { type: 'box', layout: 'vertical', spacing: 'xs', margin: 'lg', contents: shown.length ? shown : [txt('-', { size: 'sm' })] },
        sep(),
        { type: 'box', layout: 'horizontal', margin: 'lg', contents: [txt('ยอดชำระ', { size: 'md', weight: 'bold', flex: 5 }), txt(`฿${money(t.grandTotal)}`, { size: 'xl', weight: 'bold', color: PURPLE, align: 'end', flex: 5 })] },
        txt((s.payments || []).map((p) => PAY[p.method] || p.method).join(', ') || '-', { size: 'xs', color: MUTED, align: 'end' }),
        pointsText ? txt(pointsText, { size: 'sm', color: '#16a34a', weight: 'bold', margin: 'md' }) : null,
      ].filter(Boolean),
      buttons: [uriBtn('🧾 ดูใบเสร็จออนไลน์', receiptUrl), pointsUrl ? uriBtn(pointsLabel || '⭐ สะสมแต้ม', pointsUrl, 'primary', '#16a34a') : null],
    }),
  );
}

export function helpMessage(settings, text) {
  return {
    type: 'text',
    text: text || `สวัสดีค่ะ ${settings.store?.name || ''} ยินดีให้บริการ 🎤\nพิมพ์เบอร์มือถือที่ใช้จอง (เช่น 0812345678) เพื่อดูการจองของคุณ`,
    quickReply: { items: [{ type: 'action', action: { type: 'uri', label: 'จองห้อง', uri: link(`/book?store=${encodeURIComponent(settings.store?.slug || '')}`) } }, ...(telUrl(settings.store?.phone) ? [{ type: 'action', action: { type: 'uri', label: 'โทรหาร้าน', uri: telUrl(settings.store?.phone) } }] : [])] },
  };
}

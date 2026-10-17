// Document builders: data + the store's layout → sections of text blocks.
// The same sections are rendered as real HTML text for the OS printer driver / preview, or as ESC/POS text.
// Nothing here ever turns text into an image.
import { resolveLayout } from '@beatbox/shared/documents.js';
import { formatMinutesShort } from '@beatbox/shared/roomPricing.js';
import { PAYMENT_METHODS } from '@beatbox/shared/constants.js';
import { formatMoney } from '@beatbox/shared/money.js';
import { translate, translatePhrase } from './i18n.jsx';

const t = (s, v) => translate(s, v);
const tp = (s) => translatePhrase(s);
const money = (n) => formatMoney(Number(n || 0), { decimals: 2 });

function fmt(d, tz, opts) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'Asia/Bangkok', ...opts }).format(new Date(d));
}
/** 12/10/2026 */
export const dmy = (d, tz) => (d ? fmt(d, tz, { day: '2-digit', month: '2-digit', year: 'numeric' }) : '-');
/** 23:00 */
export const hm = (d, tz) => (d ? fmt(d, tz, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '-');
const dmyhm = (d, tz) => `${dmy(d, tz)} ${hm(d, tz)}`;
const method = (m) => t(PAYMENT_METHODS[m] || m || '-');

// ── blocks ──
const text = (s, o = {}) => ({ t: 'text', text: String(s ?? ''), ...o });
const kv = (k, v, o = {}) => ({ t: 'kv', k: String(k ?? ''), v: String(v ?? ''), ...o });
const hr = (double = false) => ({ t: 'hr', double });
const qr = (value) => ({ t: 'qr', value: String(value) });

/** Start / end lines: same day → date once; across midnight → the date on both sides. */
function timeLines(start, end, minutes, tz, durationLabel = 'ระยะเวลา') {
  if (!start) return [];
  const cross = end && dmy(start, tz) !== dmy(end, tz);
  const out = cross
    ? [kv(t('เริ่ม'), `${dmy(start, tz)} ${t('เวลา')} ${hm(start, tz)}`, { strong: true }), kv(t('สิ้นสุด'), `${dmy(end, tz)} ${t('เวลา')} ${hm(end, tz)}`, { strong: true })]
    : [kv(t('วันที่'), dmy(start, tz)), kv(t('เวลาเริ่ม'), hm(start, tz), { strong: true, rel: 1.15 }), kv(t('เวลาสิ้นสุด'), end ? hm(end, tz) : '-', { strong: true, rel: 1.15 })];
  if (minutes != null) out.push(kv(t(durationLabel), tp(formatMinutesShort(minutes)), { strong: true }));
  return out;
}

const roomBlocks = (name, type, number) => [text(name || '-', { strong: true }), text([type && `${t('ประเภท')} ${type}`, number && `${t('ห้องหมายเลข')} ${number}`].filter(Boolean).join(' · '), { rel: 0.55 })];

function storeInfo(store = {}) {
  return [store.branchName && text(store.branchName), store.address && text(store.address), store.phone && text(`${t('โทร')} ${store.phone}`), store.taxId && text(`${t('เลขประจำตัวผู้เสียภาษี')} ${store.taxId}`)].filter(Boolean);
}

const withText = (el, lines) => [...lines, ...(el.text ? String(el.text).split('\n').map((l) => text(l)) : [])];

// ── per document ──
const BUILDERS = {
  ROOM_TICKET_CUSTOMER: (d, el, ctx) => roomTicket(d, el, ctx, true),
  ROOM_TICKET_STAFF: (d, el, ctx) => roomTicket(d, el, ctx, false),
  TIME_ADJUST: timeAdjust,
  RECEIPT: receipt,
  ORDER_LIST: orderList,
  KITCHEN: kitchen,
  MEMBER_SIGNUP: memberSignup,
  DEPOSIT: deposit,
  VOID: voidSlip,
  SHIFT_REPORT: shiftReport,
  REPORT: report,
  TEST: testPage,
};

function common(key, d, el, ctx) {
  const store = d.store || {};
  if (key === 'copyMark') return ctx.isCopy ? [text(`${t('สำเนา')} / COPY`, { box: true })] : [];
  if (key === 'logo') return store.logoUrl && d.showLogo !== false ? [{ t: 'img', url: store.logoUrl }] : [];
  if (key === 'storeName') return store.name ? [text(store.name)] : [];
  if (key === 'storeInfo') return storeInfo(store);
  return null;
}

function roomTicket(d, el, ctx, customer) {
  const tz = d.timezone;
  switch (el.key) {
    case 'title':
      return [text(el.text || t(customer ? 'ใบเปิดห้อง (สำหรับลูกค้า)' : 'ใบเปิดห้อง (สำหรับพนักงาน)'))];
    case 'room':
      return roomBlocks(d.room, d.type, d.roomNumber);
    case 'times':
      return timeLines(d.startAt, d.endAt, d.minutes, tz);
    case 'info': {
      const out = [kv(t('เลขที่อ้างอิง'), d.refNo || d.sessionNo), kv(t('พนักงานเปิดห้อง'), d.employee || '-')];
      if (!customer) {
        if (d.refNo && d.sessionNo && d.refNo !== d.sessionNo) out.push(kv(t('เลขที่เปิดห้อง'), d.sessionNo));
        if (d.customer) out.push(kv(t('ลูกค้า'), d.customer));
        out.push(kv(t('จำนวนลูกค้า'), `${d.guests}${d.capacity && d.guests > d.capacity ? ` (${t('เกิน')} ${d.guests - d.capacity})` : ''}`));
        if (d.extraMics > 0) out.push(kv(t('ไมค์เพิ่ม'), `${d.extraMics} ${t('ตัว')}`));
        if (d.packageName) out.push(kv(t('แพ็กเกจ'), d.packageName));
        if (d.prepaidAmount > 0) out.push(kv(t('ชำระค่าห้องแล้ว'), money(d.prepaidAmount)));
      }
      out.push(kv(t('พิมพ์เมื่อ'), dmyhm(ctx.now, tz), { rel: 0.85 }));
      return out;
    }
    case 'qr': {
      if (!customer || !d.orderToken || !d.roomServiceEnabled) return [];
      return [text(t('สั่งอาหาร · ดูเวลาคงเหลือ · เรียกพนักงาน'), { strong: true }), qr(`${ctx.origin}/order/${d.orderToken}`), d.ticket?.customerNote ? text(d.ticket.customerNote, { rel: 0.85 }) : null].filter(Boolean);
    }
    case 'footer':
      return withText(el, []);
    default:
      return [];
  }
}

function timeAdjust(d, el, ctx) {
  const tz = d.timezone;
  const a = d.adjust || {};
  switch (el.key) {
    case 'title':
      return [text(el.text || t('ใบแจ้งปรับเวลา'))];
    case 'room':
      return roomBlocks(d.room, d.type, d.roomNumber);
    case 'times': {
      const oldEnd = a.before?.scheduled_end_at;
      const newEnd = a.after?.scheduled_end_at || d.endAt;
      const out = [];
      if (a.minutes) out.push(kv(a.type === 'EXTEND' ? t('เพิ่มเวลา') : t('ปรับเวลา'), `${a.minutes > 0 ? '+' : ''}${tp(formatMinutesShort(Math.abs(a.minutes)))}${a.after?.free ? ` (${t('ไม่คิดค่าบริการ')})` : ''}`, { strong: true }));
      if (oldEnd) out.push(kv(t('เวลาสิ้นสุดเดิม'), dmy(oldEnd, tz) !== dmy(newEnd, tz) || dmy(d.startAt, tz) !== dmy(oldEnd, tz) ? `${dmy(oldEnd, tz)} ${hm(oldEnd, tz)}` : hm(oldEnd, tz)));
      out.push(hr());
      out.push(...timeLines(d.startAt, newEnd, d.minutes, tz));
      return out;
    }
    case 'info':
      return [kv(t('เลขที่อ้างอิง'), d.refNo || d.sessionNo), kv(t('ทำรายการโดย'), a.employee || '-'), a.reason ? kv(t('เหตุผล'), a.reason) : null, kv(t('เวลาทำรายการ'), dmyhm(a.at || ctx.now, tz))].filter(Boolean);
    case 'footer':
      return withText(el, []);
    default:
      return [];
  }
}

function receipt(s, el, ctx) {
  const tz = s.timezone;
  const tot = s.totals || {};
  const tax = s.tax || {};
  switch (el.key) {
    case 'title':
      return [text(el.text || t('ใบเสร็จรับเงิน / ใบกำกับภาษีอย่างย่อ'))];
    case 'room':
      return s.room ? roomBlocks(s.room.name, s.room.type, s.room.number) : [];
    case 'times':
      return s.room ? timeLines(s.room.startedAt, s.room.endedAt, s.room.billedMinutes, tz, 'ระยะเวลาที่คิดค่าบริการ') : [];
    case 'info':
      return [
        kv(t('เลขที่ใบเสร็จ'), s.receiptNo, { strong: true }),
        s.orderNo && kv(t('เลขที่บิล'), s.orderNo),
        kv(t('วันที่ออก'), dmyhm(s.issuedAt, tz)),
        kv(t('พนักงาน'), s.employee || '-'),
        s.room?.openedBy && s.room.openedBy !== s.employee && kv(t('พนักงานเปิดห้อง'), s.room.openedBy),
        s.queueNo && kv(t('คิว'), s.queueNo),
        s.customer?.name && kv(t('ลูกค้า'), s.customer.name),
      ].filter(Boolean);
    case 'items':
      return (s.lines || []).map((l) => ({
        t: 'item',
        name: l.type === 'PRODUCT' || !l.type ? l.name : tp(l.name),
        qty: l.qty,
        amount: money(l.gross),
        subs: [l.qty !== 1 ? `${l.qty} × ${money(l.unitPrice)}` : null, l.discount > 0 ? `${t('ส่วนลด')} -${money(l.discount)}` : null, l.note ? `* ${l.note}` : null].filter(Boolean),
      }));
    case 'totals':
      return [
        kv(t('รวม'), money(tot.grossTotal)),
        ...(s.discounts || []).map((x) => kv(tp(x.name), `-${money(x.amount)}`)),
        tot.lineDiscountTotal > 0 && kv(t('ส่วนลดรายการ'), `-${money(tot.lineDiscountTotal)}`),
        tax.scEnabled && kv(`${t('ค่าบริการ')} ${tax.scRate}%`, money(tot.serviceCharge)),
        tax.vatEnabled && kv(`VAT ${tax.vatRate}%${tax.vatInclusive || tax.vatMode === 'INCLUSIVE' ? ` (${t('รวมใน')})` : ''}`, money(tot.vat)),
        tot.rounding ? kv(t('ปัดเศษ'), money(tot.rounding)) : null,
        hr(true),
        kv(t('ยอดรวมทั้งสิ้น'), money(tot.grandTotal), { strong: true, rel: 1.25 }),
      ].filter(Boolean);
    case 'payments':
      return receiptPayments(s);
    case 'member': {
      const m = s.member || (s.customer?.memberCode ? { code: s.customer.memberCode, name: s.customer.name, tier: s.customer.tier } : null);
      if (!m) return [];
      const out = [kv(t('สมาชิก'), `${m.name || ''} (${m.code})`), m.tier && kv(t('ระดับ'), m.tier)];
      if (s.points && s.showPoints !== false) {
        if (s.points.used > 0) out.push(kv(t('คะแนนที่ใช้'), s.points.used));
        out.push(kv(t('คะแนนที่ได้รับ'), `+${s.points.earned}`), kv(t('คะแนนคงเหลือ'), s.points.balance));
      }
      return out.filter(Boolean);
    }
    case 'memberSignup': {
      // only when the bill has no member (decided by the server when the receipt was issued)
      if (!s.memberSignup || s.member || s.customer?.memberCode) return [];
      return [el.text && text(el.text, { strong: true }), qr(`${ctx.origin}${s.memberSignup.path}`), s.memberSignup.note && text(s.memberSignup.note, { rel: 0.85 })].filter(Boolean);
    }
    case 'qr':
      return s.showQr === false ? [] : [qr(`RECEIPT:${s.receiptNo}`)];
    case 'footer':
      return withText(el, [s.slogan && text(s.slogan, { strong: true }), s.thankYou && text(s.thankYou), s.footerNote && text(s.footerNote, { rel: 0.85 })].filter(Boolean));
    default:
      return [];
  }
}

function receiptPayments(s) {
  const tot = s.totals || {};
  const st = s.settlement;
  const out = [];
  const tender = (p) => [
    kv(`${method(p.method)}${p.reference ? ` (${p.reference})` : ''}`, money(p.amount)),
    p.method === 'CASH' && p.received != null ? kv(`  ${t('รับเงินสด')}`, money(p.received)) : null,
    p.method === 'CASH' && Number(p.change) > 0 ? kv(`  ${t('เงินทอน')}`, money(p.change)) : null,
  ];
  if (!st) {
    // receipts issued before the settlement breakdown existed
    if (tot.depositApplied > 0) out.push(kv(t('หักเงินมัดจำ'), `-${money(tot.depositApplied)}`));
    out.push(kv(t('ยอดสุทธิ'), money(tot.netTotal), { strong: true }));
    (s.payments || []).forEach((p) => out.push(kv(method(p.method), money(p.received ?? p.amount))));
    if (tot.change > 0) out.push(kv(t('เงินทอน'), money(tot.change), { strong: true }));
    return out;
  }
  if (st.prepaid > 0) {
    out.push(text(t('ชำระค่าห้องล่วงหน้า'), { strong: true }));
    (s.prepayments || []).forEach((p) => out.push(...tender(p)));
  }
  if (st.deposits > 0) out.push(kv(t('หักเงินมัดจำ'), `-${money(st.deposits)}`));
  if ((s.payments || []).length) {
    out.push(text(s.room && st.prepaid > 0 ? t('ชำระเพิ่มเมื่อปิดห้อง') : t('การชำระเงิน'), { strong: true }));
    (s.payments || []).forEach((p) => out.push(...tender(p)));
  } else if (s.room && st.prepaid > 0) out.push(kv(t('ชำระเพิ่มเมื่อปิดห้อง'), money(0)));
  if (tot.excessDeposit > 0) out.push(kv(t('มัดจำคงเหลือ (คืนลูกค้า)'), money(tot.excessDeposit)));
  out.push(hr(), text(`✔ ${t('ชำระครบแล้ว')}`, { strong: true, align: 'center' }), kv(t('ยอดค้างชำระ'), `${money(st.outstanding || 0)} ${t('บาท')}`, { strong: true }));
  return out.filter(Boolean);
}

function orderList(d, el, ctx) {
  const tz = d.timezone;
  switch (el.key) {
    case 'title':
      return [text(el.text || t('รายการอาหารและเครื่องดื่ม'))];
    case 'room':
      return d.room ? roomBlocks(d.room, d.type, d.roomNumber) : [];
    case 'info':
      return [d.orderNo && kv(t('เลขที่บิล'), d.orderNo), kv(t('เวลา'), dmyhm(d.time || ctx.now, tz)), d.employee && kv(t('พนักงาน'), d.employee)].filter(Boolean);
    case 'items':
      return (d.lines || []).map((l) => ({ t: 'item', name: l.name, qty: l.qty, amount: money(l.gross ?? l.qty * l.unitPrice), subs: [l.qty !== 1 ? `${l.qty} × ${money(l.unitPrice)}` : null, l.note ? `* ${l.note}` : null].filter(Boolean) }));
    case 'totals':
      return [hr(), kv(t('รวมค่าอาหารและเครื่องดื่ม'), money((d.lines || []).reduce((a, l) => a + Number(l.gross ?? l.qty * l.unitPrice), 0)), { strong: true })];
    case 'footer':
      return withText(el, []);
    default:
      return [];
  }
}

function kitchen(d, el, ctx) {
  const station = { KITCHEN: 'ครัว', BAR: 'บาร์', PREP: 'จุดเตรียมสินค้า' }[d.station] || d.station || 'ครัว';
  switch (el.key) {
    case 'title':
      return [text(el.text || t(station), { box: true })];
    case 'room':
      return [text(d.room || t('หน้าร้าน'), { strong: true })];
    case 'info':
      return [d.queueNo && kv(t('คิว'), d.queueNo, { strong: true }), kv(t('บิล'), d.orderNo), kv(t('เวลา'), dmyhm(d.time || ctx.now, d.timezone)), d.employee && kv(t('พนักงาน'), d.employee)].filter(Boolean);
    case 'items':
      return (d.items || []).flatMap((i) => [kv(i.name, `x${i.qty}`, { strong: true }), i.note ? text(`** ${i.note}`, { rel: 0.8 }) : null]).filter(Boolean);
    case 'footer':
      return withText(el, []);
    default:
      return [];
  }
}

function memberSignup(d, el, ctx) {
  switch (el.key) {
    case 'title':
      return [text(el.text || t('สมัครสมาชิก'))];
    case 'memberSignup':
      return [el.text && text(el.text, { strong: true }), qr(`${ctx.origin}${d.path}`), d.note && text(d.note, { rel: 0.85 })].filter(Boolean);
    case 'footer':
      return withText(el, []);
    default:
      return [];
  }
}

function deposit(d, el) {
  const dep = d.deposit || {};
  const rf = d.refund;
  const tz = d.timezone;
  switch (el.key) {
    case 'title':
      return [text(el.text || t(rf ? 'ใบคืนเงินมัดจำ' : dep.source === 'PREPAY' ? 'ใบรับชำระค่าห้องล่วงหน้า' : 'ใบรับเงินมัดจำ'))];
    case 'info':
      return [
        kv(t('เลขที่'), rf ? rf.refund_no : dep.deposit_no),
        dep.booking_no && kv(t('เลขที่การจอง'), dep.booking_no),
        kv(t('วันที่'), dmyhm(rf?.created_at || dep.received_at || Date.now(), tz)),
        kv(t('ลูกค้า'), dep.customer_name || '-'),
        dep.phone && kv(t('โทร'), dep.phone),
        dep.room_name && kv(t('ห้อง'), dep.room_name),
        dep.start_at && kv(t('วันเวลาใช้บริการ'), dmyhm(dep.start_at, tz)),
        kv(t('พนักงาน'), rf?.employee_name || dep.received_by_name || '-'),
      ].filter(Boolean);
    case 'payments':
      return rf
        ? [kv(t('ยอดมัดจำ'), money(dep.amount)), kv(t('ยอดคืน'), money(rf.amount), { strong: true }), kv(t('ช่องทางคืนเงิน'), method(rf.refund_type)), kv(t('เหตุผล'), rf.reason)]
        : [kv(t('จำนวนเงิน'), money(dep.amount), { strong: true }), kv(t('ช่องทางชำระ'), method(dep.method)), dep.reference && kv(t('อ้างอิง'), dep.reference)].filter(Boolean);
    case 'footer':
      return withText(el, []);
    default:
      return [];
  }
}

function voidSlip(d, el, ctx) {
  switch (el.key) {
    case 'title':
      return [text(el.text || t('ใบยกเลิกรายการ'))];
    case 'info':
      return [kv(t('ใบเสร็จ'), d.receipt?.receipt_no || d.receipt?.receiptNo), kv(t('ยอด'), money(d.receipt?.snapshot?.totals?.grandTotal ?? d.receipt?.grand_total), { strong: true }), kv(t('เหตุผล'), d.reason), kv(t('ผู้ยกเลิก'), d.employee), kv(t('วันที่'), dmyhm(ctx.now, d.timezone))];
    case 'footer':
      return withText(el, []);
    default:
      return [];
  }
}

function shiftReport(d, el, ctx) {
  const s = d.summary || {};
  const sh = d.shift || {};
  const tz = d.timezone;
  switch (el.key) {
    case 'title':
      return [text(el.text || t('รายงานปิดรอบการขาย'))];
    case 'info':
      return [kv(t('รอบ'), sh.shift_no), kv(t('เปิดรอบ'), `${dmyhm(sh.opened_at, tz)} (${sh.employee_name || ''})`), kv(t('ปิดรอบ'), sh.closed_at ? `${dmyhm(sh.closed_at, tz)} (${sh.closed_by_name || ''})` : '-')];
    case 'totals':
      return [
        kv(t('เงินสดตั้งต้น'), money(s.openingCash)),
        kv(t('ยอดขายเงินสด'), money(s.cashSales)),
        kv(t('ยอดขาย QR Code'), money(s.qrSales)),
        kv(t('ยอดขายโอนเงิน'), money(s.transferSales)),
        kv(t('ยอดขายบัตร'), money(s.cardSales)),
        kv(t('ยอดขายช่องทางอื่น'), money(s.otherSales)),
        s.prepaidReceived != null && kv(t('ค่าห้องที่ชำระล่วงหน้า'), money(s.prepaidReceived)),
        kv(t('ยอดมัดจำที่รับ'), money(s.depositsReceived)),
        kv(t('ยอดมัดจำที่คืน'), money(s.depositsRefunded)),
        kv(t('ยอดคืนเงิน'), money(s.refundsTotal)),
        kv(t('ส่วนลดทั้งหมด'), money(s.discountTotal)),
        kv(t('ค่าบริการ'), money(s.serviceCharge)),
        kv('VAT', money(s.vat)),
        hr(true),
        kv(t('เงินสดที่ควรมีในลิ้นชัก'), money(s.expectedCash), { strong: true }),
        s.countedCash != null && kv(t('เงินสดที่นับได้จริง'), money(s.countedCash), { strong: true }),
        s.shortage > 0 && kv(t('เงินขาด'), money(s.shortage), { strong: true }),
        s.overage > 0 && kv(t('เงินเกิน'), money(s.overage), { strong: true }),
        hr(),
        kv(t('จำนวนใบเสร็จ'), s.receipts),
        kv(t('จำนวนรายการขาย'), s.itemsSold),
        kv(t('จำนวนห้องที่ขาย'), s.roomsSold),
        kv(t('จำนวนชั่วโมงที่ขาย'), s.hoursSold),
        kv(t('จำนวนสมาชิกใหม่'), s.newMembers),
        kv(t('รายการยกเลิก'), (s.voids || []).length),
        kv(t('รายการคืนเงิน'), (s.refunds || []).length),
        ...(s.voids || []).map((v) => text(`- ${v.order_no} ${money(v.grand_total)} ${v.void_reason || ''}`, { rel: 0.85 })),
      ].filter(Boolean);
    case 'footer':
      return withText(el, []);
    default:
      return [];
  }
}

function report(d, el) {
  const rep = d.report || { rows: [], columns: [], totals: {} };
  const val = (c, v) => (c.type === 'money' ? money(v) : String(v ?? ''));
  switch (el.key) {
    case 'title':
      return [text(el.text || rep.title), text(`${rep.from || ''} – ${rep.to || ''}`, { rel: 0.85 })];
    case 'items':
      return rep.rows.slice(0, 300).flatMap((r) => [...rep.columns.map((c, j) => (j === 0 ? text(val(c, r[c.key]), { strong: true }) : kv(c.label, val(c, r[c.key])))), hr()]);
    case 'totals': {
      const cols = rep.columns.filter((c) => rep.totals?.[c.key] != null);
      return cols.length ? [text(t('รวม'), { strong: true }), ...cols.map((c) => kv(c.label, val(c, rep.totals[c.key]), { strong: true }))] : [];
    }
    default:
      return [];
  }
}

function testPage(d, el, ctx) {
  const p = d.printer || {};
  switch (el.key) {
    case 'title':
      return [text(el.text || t('ทดสอบพิมพ์'))];
    case 'info':
      return [
        kv(t('เครื่องพิมพ์'), p.name || '-'),
        kv(t('การเชื่อมต่อ'), p.connection || '-'),
        kv(t('โหมดการพิมพ์'), p.render_mode === 'ESCPOS_TEXT' ? t('ฟอนต์ของเครื่องพิมพ์ (ESC/POS)') : !p.connection || p.connection === 'BROWSER' ? t('ไดรเวอร์ระบบ (ฟอนต์ที่ตั้งไว้)') : t('ส่งตรงทางสาย (ฟอนต์ที่ตั้งไว้)')),
        kv(t('ความกว้างกระดาษ'), `${p.paper_width || 80} mm`),
        kv(t('พื้นที่พิมพ์'), `${ctx.geometry?.contentMm?.toFixed(1) || '-'} mm`),
        kv(t('ฟอนต์'), ctx.fontLabel || '-'),
        kv(t('เวลา'), dmyhm(ctx.now, d.timezone)),
        hr(),
        text('กขคงจฉชซ ฤฦ ภาษาไทย ๐๑๒๓', { strong: true, align: 'center' }),
        text('ABCDEFGHIJ abcdefghij 0123456789', { align: 'center' }),
        text('|<- ซ้ายสุด ............................ ขวาสุด ->|', { align: 'center', rel: 0.8 }),
      ];
    case 'footer':
      return withText(el, []);
    default:
      return [];
  }
}

/**
 * Build a document: [{ key, style, blocks }].
 * ctx: { isCopy, origin, now, layouts (settings.documents.layouts), geometry, fontLabel }
 */
export function buildDoc(docType, data, ctx = {}) {
  const layout = resolveLayout(docType, ctx.layouts?.[docType]);
  const fn = BUILDERS[docType];
  if (!fn) throw new Error(`Unknown document type ${docType}`);
  const full = { origin: typeof window !== 'undefined' ? window.location.origin : '', now: new Date(), ...ctx };
  const out = [];
  for (const el of layout) {
    if (el.show === false) continue;
    const blocks = (common(el.key, data, el, full) ?? fn(data, el, full)).filter(Boolean);
    if (blocks.length) out.push({ key: el.key, style: el, blocks });
  }
  return out;
}

export { money as docMoney };

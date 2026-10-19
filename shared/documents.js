// Printed documents: types, their elements and the default layout of each element.
// The store can change every element (font, size, bold, alignment, spacing, show / hide, order) per document type;
// the saved layout is merged over these defaults, so new elements appear automatically.

export const DOC_TYPES = [
  { key: 'ROOM_TICKET_CUSTOMER', label: 'ใบเปิดห้อง (ลูกค้า)' },
  { key: 'ROOM_TICKET_STAFF', label: 'ใบเปิดห้อง (พนักงาน)' },
  { key: 'TIME_ADJUST', label: 'ใบแจ้งปรับเวลา / เพิ่มเวลา' },
  { key: 'RECEIPT', label: 'ใบเสร็จชำระเงิน' },
  { key: 'ORDER_LIST', label: 'ใบรายการอาหารและเครื่องดื่ม' },
  { key: 'KITCHEN', label: 'ใบครัว' },
  { key: 'MEMBER_SIGNUP', label: 'ใบสมัครสมาชิก (QR)' },
  { key: 'DEPOSIT', label: 'ใบรับ / คืนเงินมัดจำ' },
  { key: 'PAY_QR', label: 'ใบ QR ชำระเงิน (สำหรับร้านที่ไม่มีจอลูกค้า)' },
  { key: 'VOID', label: 'ใบยกเลิกรายการ' },
  { key: 'SHIFT_REPORT', label: 'รายงานปิดรอบ' },
  { key: 'REPORT', label: 'รายงานแบบใบเสร็จ' },
  { key: 'TEST', label: 'หน้าทดสอบเครื่องพิมพ์' },
];

/** Every element that can appear on a document. */
export const DOC_ELEMENTS = {
  copyMark: { label: 'ป้าย "สำเนา" (เมื่อพิมพ์ซ้ำ)' },
  logo: { label: 'โลโก้' },
  storeName: { label: 'ชื่อร้าน' },
  storeInfo: { label: 'ที่อยู่ เบอร์โทร เลขผู้เสียภาษี' },
  title: { label: 'หัวเอกสาร', text: true },
  room: { label: 'ชื่อห้อง ประเภท และหมายเลขห้อง' },
  times: { label: 'วันที่ เวลาเริ่ม เวลาสิ้นสุด ระยะเวลา' },
  info: { label: 'เลขที่เอกสาร พนักงาน ลูกค้า' },
  items: { label: 'รายการ จำนวน ราคา และยอดรวม' },
  totals: { label: 'ส่วนลด ภาษี ค่าบริการ และยอดรวม' },
  payments: { label: 'การชำระเงิน (ชำระล่วงหน้า ชำระเพิ่ม เงินสด/เงินทอน)' },
  member: { label: 'ข้อมูลสมาชิกและคะแนน' },
  qr: { label: 'QR Code' },
  payQr: { label: 'QR ชำระเงิน ยอดเงิน และบัญชีรับเงิน' },
  memberSignup: { label: 'ส่วนสมัครสมาชิก (QR + คำเชิญ)', text: true },
  footer: { label: 'ข้อความท้ายเอกสาร', text: true },
};

/**
 * Lines inside an element that can be switched off one by one (el.hide = [keys]).
 * Used by the receipt checklist in ตั้งค่าร้าน → ใบเสร็จ and by the document builder.
 */
export const ELEMENT_LINES = {
  RECEIPT: {
    info: [
      { key: 'orderNo', label: 'เลขที่บิล' },
      { key: 'issuedAt', label: 'วันที่และเวลาออกใบเสร็จ' },
      { key: 'employee', label: 'ชื่อพนักงาน' },
      { key: 'queue', label: 'เลขคิว' },
      { key: 'customer', label: 'ชื่อลูกค้า' },
    ],
    items: [{ key: 'detail', label: 'จำนวน × ราคาต่อหน่วย และหมายเหตุของแต่ละรายการ' }],
    totals: [
      { key: 'subtotal', label: 'ยอดรวมก่อนส่วนลด' },
      { key: 'discounts', label: 'ส่วนลด' },
      { key: 'serviceCharge', label: 'ค่าบริการ (Service Charge)' },
      { key: 'vat', label: 'VAT' },
    ],
    payments: [{ key: 'cashDetail', label: 'รับเงินสด / เงินทอน' }],
    member: [{ key: 'points', label: 'คะแนนที่ใช้ / ได้รับ / คงเหลือ' }],
  },
};

const el = (show, size, extra = {}) => ({ show, size, bold: false, align: 'left', font: '', spaceBefore: 0, spaceAfter: 0, ...extra });

/** Default element settings per document type (order = array order). Sizes are in pt. */
export const DEFAULT_LAYOUTS = {
  ROOM_TICKET_CUSTOMER: {
    copyMark: el(true, 12, { bold: true, align: 'center' }),
    logo: el(false, 0, { align: 'center' }),
    storeName: el(true, 13, { bold: true, align: 'center' }),
    storeInfo: el(false, 9, { align: 'center' }),
    title: el(true, 11, { bold: true, align: 'center', text: 'ใบเปิดห้อง (สำหรับลูกค้า)' }),
    room: el(true, 20, { bold: true, align: 'center', spaceAfter: 1 }),
    times: el(true, 12, { bold: true }),
    info: el(true, 9),
    qr: el(true, 10, { align: 'center', spaceBefore: 1, qrSize: 34 }),
    footer: el(true, 8.5, { align: 'center', text: 'QR นี้ใช้ได้เฉพาะรอบนี้ และหมดอายุเมื่อปิดห้อง' }),
  },
  ROOM_TICKET_STAFF: {
    copyMark: el(true, 12, { bold: true, align: 'center' }),
    storeName: el(true, 11, { bold: true, align: 'center' }),
    title: el(true, 11, { bold: true, align: 'center', text: 'ใบเปิดห้อง (สำหรับพนักงาน)' }),
    room: el(true, 20, { bold: true, align: 'center', spaceAfter: 1 }),
    times: el(true, 12, { bold: true }),
    info: el(true, 9.5),
    footer: el(false, 8.5, { align: 'center', text: '' }),
  },
  TIME_ADJUST: {
    copyMark: el(true, 12, { bold: true, align: 'center' }),
    storeName: el(true, 11, { bold: true, align: 'center' }),
    title: el(true, 11, { bold: true, align: 'center', text: 'ใบแจ้งปรับเวลา' }),
    room: el(true, 18, { bold: true, align: 'center' }),
    times: el(true, 12, { bold: true }),
    info: el(true, 9.5),
    footer: el(false, 8.5, { align: 'center', text: '' }),
  },
  RECEIPT: {
    copyMark: el(true, 12, { bold: true, align: 'center' }),
    logo: el(true, 0, { align: 'center' }),
    storeName: el(true, 13, { bold: true, align: 'center' }),
    storeInfo: el(true, 8.5, { align: 'center' }),
    title: el(true, 10, { bold: true, align: 'center', text: 'ใบเสร็จรับเงิน / ใบกำกับภาษีอย่างย่อ' }),
    room: el(true, 16, { bold: true, align: 'center' }),
    times: el(true, 10),
    info: el(true, 9),
    items: el(true, 9.5),
    totals: el(true, 10),
    payments: el(true, 10),
    member: el(true, 9),
    qr: el(false, 9, { align: 'center', qrSize: 24 }),
    memberSignup: el(true, 9, { align: 'center', qrSize: 28, text: 'สมัครสมาชิกฟรี! สะสมคะแนนรับส่วนลดครั้งถัดไป สแกน QR นี้เพื่อสมัคร' }),
    footer: el(true, 9, { align: 'center', text: '' }),
  },
  ORDER_LIST: {
    copyMark: el(true, 12, { bold: true, align: 'center' }),
    storeName: el(true, 11, { bold: true, align: 'center' }),
    title: el(true, 11, { bold: true, align: 'center', text: 'รายการอาหารและเครื่องดื่ม' }),
    room: el(true, 16, { bold: true, align: 'center' }),
    info: el(true, 9),
    items: el(true, 10),
    totals: el(true, 10),
    footer: el(true, 8.5, { align: 'center', text: 'เอกสารนี้ไม่ใช่ใบเสร็จรับเงิน' }),
  },
  KITCHEN: {
    copyMark: el(true, 12, { bold: true, align: 'center' }),
    title: el(true, 16, { bold: true, align: 'center', text: '' }),
    room: el(true, 18, { bold: true, align: 'center' }),
    info: el(true, 9.5),
    items: el(true, 14, { bold: true }),
    footer: el(false, 8.5, { align: 'center', text: '' }),
  },
  MEMBER_SIGNUP: {
    storeName: el(true, 13, { bold: true, align: 'center' }),
    title: el(true, 12, { bold: true, align: 'center', text: 'สมัครสมาชิก' }),
    memberSignup: el(true, 10, { align: 'center', qrSize: 40, text: 'สแกน QR เพื่อสมัครสมาชิกฟรี สะสมคะแนน รับสิทธิพิเศษ' }),
    footer: el(true, 9, { align: 'center', text: '' }),
  },
  DEPOSIT: {
    copyMark: el(true, 12, { bold: true, align: 'center' }),
    logo: el(true, 0, { align: 'center' }),
    storeName: el(true, 13, { bold: true, align: 'center' }),
    storeInfo: el(true, 8.5, { align: 'center' }),
    title: el(true, 11, { bold: true, align: 'center', text: '' }),
    info: el(true, 9.5),
    payments: el(true, 10.5),
    footer: el(true, 8.5, { align: 'center', text: 'กรุณาเก็บเอกสารนี้ไว้เป็นหลักฐาน' }),
  },
  PAY_QR: {
    storeName: el(true, 12, { bold: true, align: 'center' }),
    title: el(true, 12, { bold: true, align: 'center', text: 'สแกนเพื่อชำระเงิน' }),
    room: el(true, 14, { bold: true, align: 'center' }),
    payQr: el(true, 11, { align: 'center', qrSize: 50, spaceBefore: 1, spaceAfter: 1 }),
    info: el(true, 9),
    footer: el(true, 9, { align: 'center', text: 'โอนแล้วกรุณาแสดงสลิปให้พนักงาน\nเอกสารนี้ไม่ใช่ใบเสร็จรับเงิน' }),
  },
  VOID: {
    storeName: el(true, 12, { bold: true, align: 'center' }),
    title: el(true, 11, { bold: true, align: 'center', text: 'ใบยกเลิกรายการ' }),
    info: el(true, 10),
    footer: el(false, 8.5, { align: 'center', text: '' }),
  },
  SHIFT_REPORT: {
    storeName: el(true, 12, { bold: true, align: 'center' }),
    title: el(true, 11, { bold: true, align: 'center', text: 'รายงานปิดรอบการขาย' }),
    info: el(true, 9.5),
    totals: el(true, 9.5),
    footer: el(true, 9, { align: 'center', text: 'ลงชื่อ ........................................' }),
  },
  REPORT: {
    storeName: el(true, 12, { bold: true, align: 'center' }),
    title: el(true, 11, { bold: true, align: 'center', text: '' }),
    items: el(true, 9),
    totals: el(true, 9.5),
  },
  TEST: {
    storeName: el(true, 13, { bold: true, align: 'center' }),
    title: el(true, 11, { bold: true, align: 'center', text: 'ทดสอบพิมพ์' }),
    info: el(true, 10),
    footer: el(true, 9, { align: 'center', text: 'ภาษาไทย / English ✓' }),
  },
};

/** Default routing: every document goes to the same (main) printer; copies and cut per document. */
export const DEFAULT_ROUTING = Object.fromEntries(
  DOC_TYPES.map((d) => [d.key, { printerId: null, copies: 1, cut: true, auto: ['ROOM_TICKET_CUSTOMER', 'ROOM_TICKET_STAFF', 'RECEIPT', 'KITCHEN'].includes(d.key) }]),
);

/** Saved layout merged over the defaults → [{ key, ...settings }] sorted by order. */
export function resolveLayout(docType, saved = {}) {
  const def = DEFAULT_LAYOUTS[docType] || {};
  const keys = Object.keys(def);
  const savedOrder = Array.isArray(saved.order) ? saved.order.filter((k) => keys.includes(k)) : [];
  const order = [...savedOrder, ...keys.filter((k) => !savedOrder.includes(k))];
  return order.map((key) => ({ key, ...def[key], ...(saved.elements?.[key] || {}) }));
}

export const SIZE_LIMITS = { min: 6, max: 40 };
export const QR_SIZE_LIMITS = { min: 14, max: 60 }; // mm

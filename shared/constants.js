// Shared constants used by server, POS, Customer Display and Booking website.

export const ROOM_STATUS = {
  AVAILABLE: 'AVAILABLE',
  RESERVED: 'RESERVED',
  WAITING: 'WAITING',
  IN_USE: 'IN_USE',
  NEAR_END: 'NEAR_END',
  TIME_UP: 'TIME_UP',
  CLEANING: 'CLEANING',
  MAINTENANCE: 'MAINTENANCE',
  DISABLED: 'DISABLED',
};

export const ROOM_STATUS_LABEL = {
  AVAILABLE: 'ห้องว่าง',
  RESERVED: 'จองแล้ว',
  WAITING: 'รอลูกค้า',
  IN_USE: 'กำลังใช้งาน',
  NEAR_END: 'ใกล้หมดเวลา',
  TIME_UP: 'หมดเวลาแล้ว',
  CLEANING: 'รอทำความสะอาด',
  MAINTENANCE: 'ปิดปรับปรุง',
  DISABLED: 'ปิดใช้งาน',
};

export const ROOM_STATUS_COLOR = {
  AVAILABLE: '#16a34a',
  RESERVED: '#2563eb',
  WAITING: '#7c3aed',
  IN_USE: '#db2777',
  NEAR_END: '#f97316',
  TIME_UP: '#dc2626',
  CLEANING: '#0891b2',
  MAINTENANCE: '#6b7280',
  DISABLED: '#374151',
};

export const SESSION_STATUS = {
  ACTIVE: 'ACTIVE',
  PAUSED: 'PAUSED',
  CLOSED: 'CLOSED', // time stopped, waiting for payment
  PAID: 'PAID',
  CANCELLED: 'CANCELLED',
};

// Reservation statuses that occupy the room inventory (used by DB exclusion constraint too)
export const RESERVATION_BLOCKING = ['HOLD', 'PENDING', 'CONFIRMED', 'DEPOSIT_PAID', 'WAITING', 'ARRIVED', 'IN_USE'];

export const RESERVATION_STATUS_LABEL = {
  HOLD: 'ล็อกห้องชั่วคราว',
  PENDING: 'รอยืนยัน',
  CONFIRMED: 'ยืนยันแล้ว',
  DEPOSIT_PAID: 'ชำระมัดจำแล้ว',
  WAITING: 'รอลูกค้า',
  ARRIVED: 'ลูกค้ามาถึงแล้ว',
  IN_USE: 'กำลังใช้งาน',
  COMPLETED: 'เสร็จสิ้น',
  CANCELLED: 'ยกเลิก',
  NO_SHOW: 'ไม่มาตามนัด',
  REFUNDED: 'คืนเงินมัดจำแล้ว',
  EXPIRED: 'หมดเวลาชำระ',
};

export const RESERVATION_STATUS_COLOR = {
  HOLD: '#a855f7',
  PENDING: '#eab308',
  CONFIRMED: '#2563eb',
  DEPOSIT_PAID: '#0d9488',
  WAITING: '#7c3aed',
  ARRIVED: '#16a34a',
  IN_USE: '#db2777',
  COMPLETED: '#6b7280',
  CANCELLED: '#dc2626',
  NO_SHOW: '#b91c1c',
  REFUNDED: '#9ca3af',
  EXPIRED: '#9ca3af',
};

export const BOOKING_SOURCES = ['ONLINE', 'POS', 'PHONE', 'WALK_IN', 'LINE'];

export const PAYMENT_METHODS = {
  CASH: 'เงินสด',
  QR: 'QR Code',
  TRANSFER: 'โอนเงิน',
  CARD: 'บัตร',
  CREDIT: 'เครดิตลูกค้า',
  OTHER: 'ช่องทางอื่น',
};

export const PAYMENT_TX_STATUS = ['PENDING', 'VERIFYING', 'PAID', 'FAILED', 'EXPIRED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED'];

export const POINT_TX_TYPES = ['EARN', 'REDEEM', 'ADJUST', 'EXPIRE', 'REFUND', 'REVERSE'];

export const REWARD_TYPES = {
  DISCOUNT: 'ส่วนลด',
  FREE_HOUR: 'ชั่วโมงฟรี',
  EXTRA_30: 'เพิ่มเวลา 30 นาที',
  FREE_DRINK: 'เครื่องดื่มฟรี',
  FREE_PRODUCT: 'สินค้าฟรี',
  PACKAGE: 'แพ็กเกจพิเศษ',
};

export const PROMOTION_TYPES = {
  AMOUNT: 'ลดเป็นจำนวนเงิน',
  PERCENT: 'ลดเป็นเปอร์เซ็นต์',
  MEMBER: 'ส่วนลดสมาชิก',
  BIRTHDAY: 'ส่วนลดวันเกิด',
  COUPON: 'คูปอง / Promo Code',
  FREE_HOURS: 'ชั่วโมงฟรี',
  MIN_QTY: 'ซื้อครบตามจำนวน',
  MIN_SPEND: 'ซื้อครบตามยอด',
  FREE_ITEM: 'ฟรีสินค้า',
  ROOM_TYPE: 'ส่วนลดเฉพาะ Type ห้อง',
  TIME_RANGE: 'ส่วนลดเฉพาะช่วงเวลา',
  HAPPY_HOUR: 'Happy Hour',
};

export const STOCK_MOVEMENT_TYPES = {
  IN: 'รับสินค้าเข้า',
  OUT: 'เบิกสินค้าออก',
  ADJUST: 'ปรับยอดสต็อก',
  COUNT: 'นับสต็อก',
  DAMAGED: 'สินค้าเสีย',
  EXPIRED: 'สินค้าหมดอายุ',
  RETURN: 'คืนสินค้า',
  SALE: 'ขาย',
  VOID: 'ยกเลิกรายการ',
};

export const ROLES = {
  ADMIN: 'ผู้ดูแลระบบ',
  MANAGER: 'ผู้จัดการ',
  CASHIER: 'แคชเชียร์',
  STAFF: 'พนักงาน',
};

export const PERMISSIONS = [
  { code: 'pos.access', name: 'เข้าหน้าขายได้', group: 'ขาย' },
  { code: 'discount.give', name: 'ให้ส่วนลดได้', group: 'ขาย' },
  { code: 'discount.approve', name: 'อนุมัติส่วนลดเกินวงเงิน', group: 'ขาย' },
  { code: 'order.void', name: 'ยกเลิกรายการได้', group: 'ขาย' },
  { code: 'refund.create', name: 'คืนเงินได้', group: 'ขาย' },
  { code: 'refund.approve', name: 'อนุมัติการคืนเงิน', group: 'ขาย' },
  { code: 'drawer.open', name: 'เปิดลิ้นชักเก็บเงินได้', group: 'ขาย' },
  { code: 'receipt.reprint', name: 'พิมพ์ใบเสร็จซ้ำได้', group: 'ขาย' },
  { code: 'slip.verify', name: 'ตรวจสอบสลิปได้', group: 'ขาย' },
  { code: 'shift.open', name: 'เปิดรอบการขายได้', group: 'รอบการขาย' },
  { code: 'shift.close', name: 'ปิดรอบการขายได้', group: 'รอบการขาย' },
  { code: 'product.create', name: 'เพิ่มสินค้าได้', group: 'สินค้า' },
  { code: 'product.edit', name: 'แก้ไขสินค้าได้', group: 'สินค้า' },
  { code: 'product.delete', name: 'ลบสินค้าได้', group: 'สินค้า' },
  { code: 'stock.manage', name: 'จัดการสต็อกได้', group: 'สินค้า' },
  { code: 'room.create', name: 'เพิ่มห้องได้', group: 'ห้อง' },
  { code: 'room.edit', name: 'แก้ไขข้อมูลห้องได้', group: 'ห้อง' },
  { code: 'room.operate', name: 'เปิด/ปิดห้องได้', group: 'ห้อง' },
  { code: 'room.time_edit', name: 'แก้ไขเวลาห้องได้', group: 'ห้อง' },
  { code: 'room.pause', name: 'หยุดและต่อเวลาห้องได้', group: 'ห้อง' },
  { code: 'room.move', name: 'เปลี่ยนห้องให้ลูกค้าได้', group: 'ห้อง' },
  { code: 'booking.manage', name: 'จัดการการจองได้', group: 'การจอง' },
  { code: 'member.view', name: 'ดูข้อมูลสมาชิกได้', group: 'สมาชิก' },
  { code: 'member.edit', name: 'เพิ่ม/แก้ไขสมาชิกได้', group: 'สมาชิก' },
  { code: 'member.points', name: 'เพิ่มและลดคะแนนสมาชิกได้', group: 'สมาชิก' },
  { code: 'sales.view', name: 'ดูยอดขายได้', group: 'รายงาน' },
  { code: 'cost.view', name: 'ดูต้นทุนและกำไรได้', group: 'รายงาน' },
  { code: 'reports.view', name: 'ดูรายงานทั้งหมดได้', group: 'รายงาน' },
  { code: 'settings.manage', name: 'ตั้งค่าร้านได้', group: 'ระบบ' },
  { code: 'employee.manage', name: 'จัดการพนักงานได้', group: 'ระบบ' },
  { code: 'activity.view', name: 'ดู Activity Log ได้', group: 'ระบบ' },
];

export const ALL_PERMISSION_CODES = PERMISSIONS.map((p) => p.code);

export const DEFAULT_ROLE_PERMISSIONS = {
  ADMIN: ALL_PERMISSION_CODES,
  MANAGER: ALL_PERMISSION_CODES.filter((c) => !['employee.manage', 'settings.manage'].includes(c)),
  CASHIER: [
    'pos.access', 'discount.give', 'drawer.open', 'receipt.reprint', 'slip.verify', 'shift.open', 'shift.close',
    'room.operate', 'room.pause', 'room.move', 'booking.manage', 'member.view', 'member.edit', 'sales.view',
  ],
  STAFF: ['pos.access', 'room.operate', 'booking.manage', 'member.view'],
};

export const ORDER_ITEM_TYPES = {
  ROOM: 'ค่าห้อง',
  PACKAGE: 'แพ็กเกจ',
  EXTENSION: 'เวลาเพิ่มเติม',
  OVERTIME: 'เวลาเกิน',
  EXTRA_GUEST: 'ค่าลูกค้าเกินจำนวน',
  PRODUCT: 'สินค้า',
  SERVICE: 'ค่าบริการ',
  REWARD: 'ของรางวัล',
};

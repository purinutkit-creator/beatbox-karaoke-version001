// Plan features (switched on/off per plan by the Super Owner) and how they map to staff permissions / API areas.
// The effective right of a staff member = plan feature AND the staff member's own permission (checked on the server).

export const PLAN_FEATURES = [
  { key: 'pos', label: 'POS / ขายสินค้าและชำระเงิน' },
  { key: 'rooms', label: 'จัดการห้องและเปิดห้อง' },
  { key: 'booking', label: 'จองห้อง (หลังร้าน + เว็บไซต์)' },
  { key: 'members', label: 'สมาชิก คะแนน และรางวัล' },
  { key: 'promotions', label: 'โปรโมชั่น' },
  { key: 'stock', label: 'สต็อกสินค้า' },
  { key: 'reports', label: 'รายงาน' },
  { key: 'display', label: 'หน้าจอลูกค้า' },
  { key: 'receipt_settings', label: 'ตั้งค่าใบเสร็จและเอกสาร' },
  { key: 'printing', label: 'การพิมพ์เอกสาร' },
  { key: 'staff', label: 'จัดการพนักงานและสิทธิ์' },
  { key: 'multi_branch', label: 'หลายสาขา' },
];

export const PLAN_LIMITS = [
  { key: 'branches', label: 'จำนวนสาขาสูงสุด' },
  { key: 'rooms', label: 'จำนวนห้องสูงสุด' },
  { key: 'employees', label: 'จำนวนพนักงานสูงสุด' },
  { key: 'devices', label: 'จำนวนเครื่อง POS สูงสุด' },
];

export const BILLING_CYCLES = { DAY: 'วัน', MONTH: 'เดือน', YEAR: 'ปี' };

export const SUBSCRIPTION_STATUS_LABEL = {
  TRIAL: 'ทดลองใช้',
  ACTIVE: 'ใช้งานปกติ',
  EXPIRED: 'หมดอายุ',
  SUSPENDED: 'ถูกระงับ',
};

/** Staff permission → plan feature (permissions not listed are core: always available). */
export const PERMISSION_FEATURE = {
  'pos.access': 'pos',
  'discount.give': 'pos',
  'discount.approve': 'pos',
  'order.void': 'pos',
  'refund.create': 'pos',
  'refund.approve': 'pos',
  'drawer.open': 'pos',
  'slip.verify': 'pos',
  'shift.open': 'pos',
  'shift.close': 'pos',
  'product.create': 'pos',
  'product.edit': 'pos',
  'product.delete': 'pos',
  'receipt.reprint': 'printing',
  'stock.manage': 'stock',
  'room.create': 'rooms',
  'room.edit': 'rooms',
  'room.operate': 'rooms',
  'room.time_edit': 'rooms',
  'room.pause': 'rooms',
  'room.move': 'rooms',
  'booking.manage': 'booking',
  'member.view': 'members',
  'member.edit': 'members',
  'member.points': 'members',
  'sales.view': 'reports',
  'cost.view': 'reports',
  'reports.view': 'reports',
  'employee.manage': 'staff',
};

/** API path → plan feature (checked for every request, so hiding a menu is never the only protection). */
export const API_FEATURES = [
  [/^\/(reservations|booking)(\/|$)/, 'booking'],
  [/^\/public\/(availability|holds|bookings|rooms\/\d+\/slots|checkin)(\/|$)/, 'booking'],
  [/^\/(members|member-tiers|tiers|rewards|redemptions)(\/|$)/, 'members'],
  [/^\/public\/(me|auth)(\/|$)/, 'members'],
  [/^\/promotions(\/|$)/, 'promotions'],
  [/^\/stock(\/|$)/, 'stock'],
  [/^\/(reports|dashboard)(\/|$)/, 'reports'],
  [/^\/(displays|promotion-images)(\/|$)/, 'display'],
  [/^\/public\/display(\/|$)/, 'display'],
  [/^\/(printers|print-jobs)(\/|$)/, 'printing'],
  [/^\/documents(\/|$)/, 'receipt_settings'],
  [/^\/employees(?!\/directory)(\/|$)/, 'staff'],
  [/^\/roles(\/|$)/, 'staff'],
  [/^\/(rooms|sessions|room-types|packages|room-service|room-issues)(\/|$)/, 'rooms'],
  [/^\/public\/room(\/|$)/, 'rooms'],
  [/^\/(orders|products|categories|shifts|payments|terminal|deposits|refunds|receipts)(\/|$)/, 'pos'],
];

export function featureForPath(path) {
  for (const [re, f] of API_FEATURES) if (re.test(path)) return f;
  return null;
}

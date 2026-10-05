import { pool } from '../db/index.js';
import { config } from '../config.js';
import { getIntegrations } from './integrations.js';

export const DEFAULT_SETTINGS = {
  appearance: {
    defaultLanguage: 'th', // th | en
    thFont: 'Sarabun',
    enFont: 'Poppins',
    receiptThFont: 'Kanit',
    receiptEnFont: 'Kanit',
    displayScale: 1,
    customFonts: [], // [{ family, url, format }]
  },
  general: {
    primaryColor: '#8b5cf6',
    accentColor: '#ec4899',
    backgroundUrl: '',
    defaultTheme: 'dark',
    currency: 'THB',
    currencySymbol: '฿',
  },
  tax: {
    vatEnabled: true,
    vatRate: 7,
    vatMode: 'INCLUSIVE', // INCLUSIVE | EXCLUSIVE
    scEnabled: false,
    scRate: 10,
    scBase: 'ALL', // ALL | ROOM | PRODUCT
    rounding: { mode: 'NONE', unit: 1 },
  },
  receipt: {
    numberFormat: 'RC{YYYY}{MM}{DD}-{SEQ:4}',
    slogan: 'ร้องให้สุด หยุดที่ BEATBOX',
    thankYou: 'ขอบคุณที่ใช้บริการ แล้วพบกันใหม่',
    showLogo: true,
    showQr: true,
    showPoints: true,
    footerNote: '',
  },
  queue: {
    prefix: 'BEATBOX',
    digits: 2,
    start: 1,
    resetMode: 'DAILY', // DAILY | SHIFT | NEVER
  },
  payment: {
    accountName: 'บริษัท บีทบ็อกซ์ คาราโอเกะ จำกัด',
    accountNumber: '123-4-56789-0',
    bankName: 'ธนาคารกสิกรไทย',
    promptPayId: '0812345678',
    qrImageUrl: '',
    useDynamicPromptPay: true,
    instruction: 'สแกน QR Code เพื่อชำระเงิน แล้วแจ้งพนักงานเพื่อตรวจสอบสลิป',
    slipCheckSeconds: 5,
    methods: { CASH: true, QR: true, TRANSFER: true, CARD: true, CREDIT: false, OTHER: true },
  },
  room: {
    extraGuestFee: 50,
    maxExtraGuests: 10, // how many people above the room capacity may book / open (0 = not allowed)
    includedMics: 2,
    extraMicFee: 50, // price per extra microphone (per visit)
    maxExtraMics: 4,
    partialRule: 'ROUND_UP', // NONE | ROUND_UP | PER_MINUTE | GRACE
    graceMinutes: 5,
    alertMinutes: [30, 15, 10, 5],
    nearEndMinutes: 10,
    alertSoundUrl: '',
    useSpeech: true,
    speechTemplate: 'ห้อง {room} หมดเวลาแล้ว กรุณาตรวจสอบห้อง',
    nearSpeechTemplate: 'ห้อง {room} เหลือเวลา {minutes} นาที',
    upcomingReservationMinutes: 60,
    quickExtendMinutes: [30, 60],
  },
  deposit: {
    rule: 'ROOM_TYPE', // FIXED | PERCENT | ROOM_TYPE | PACKAGE | PROMOTION | CUSTOM
    fixedAmount: 300,
    percent: 25,
  },
  points: {
    enabled: true,
    amountPerPoint: 25,
    pointsPerUnit: 1,
    base: 'AFTER_DISCOUNT', // BEFORE_DISCOUNT | AFTER_DISCOUNT
    includeRoom: true,
    includeProduct: true,
    includePackage: true,
    includeServiceCharge: false,
    includeVat: true,
    onlyFullPayment: true,
    expiryMonths: 12,
    reverseOnRefund: true,
    pointValue: 1, // baht per point when redeemed as discount
  },
  discount: {
    approvalAbovePercent: 20,
    approvalAboveAmount: 500,
  },
  booking: {
    enabled: true,
    holdMinutes: 10,
    minAdvanceMinutes: 30,
    maxAdvanceDays: 60,
    slotMinutes: 30,
    durations: [60, 90, 120, 180, 240],
    requireDeposit: true,
    gracePeriodMinutes: 15,
    autoNoShow: false,
    noShowDepositAction: 'FORFEIT', // FORFEIT | KEEP
    reminderHours: 2,
    arriveEarlyMinutes: 10,
    cancellation: {
      allowOnline: true,
      tiers: [
        { hoursBefore: 24, percent: 100 },
        { hoursBefore: 6, percent: 50 },
      ],
      defaultPercent: 0,
      refundType: 'ORIGINAL', // ORIGINAL | STORE_CREDIT
    },
    lineOaUrl: 'https://line.me/R/ti/p/@beatbox',
    facebookUrl: '',
    mapUrl: '',
    contactEmail: '',
  },
  // Tickets printed when a room is opened: one for the store, one for the customer (with the in-room ordering QR)
  roomTicket: {
    printOnOpen: true,
    storeCopy: true,
    customerCopy: true,
    customerNote: 'สแกน QR เพื่อสั่งอาหาร/เครื่องดื่ม ดูเวลาคงเหลือ และเรียกพนักงาน',
  },
  // In-room QR ordering + problem reports
  roomService: {
    enabled: true,
    allowPayNow: true,
    allowPayAtCounter: true,
    autoAcceptSeconds: 60, // if the cashier hasn't checked the slip within this time the customer sees "paid" (cashier must still verify)
    issueOptions: ['ไมค์ไม่มีเสียง / ไมค์เสีย', 'เครื่องเสียง / ลำโพงมีปัญหา', 'จอ / ระบบคาราโอเกะมีปัญหา', 'แอร์ร้อนหรือเย็นเกินไป', 'ขอแก้ว / น้ำแข็งเพิ่ม', 'ต้องการเพิ่มเวลา'],
    issueSoundUrl: '',
  },
  security: {
    sessionIdleMinutes: 30,
    maxLoginAttempts: 5,
    refundRequiresApproval: true,
  },
  backup: {
    enabled: true,
    hour: 4,
    keep: 14,
  },
  line: {
    messagingEnabled: false,
    notifyBookingConfirmed: true,
    notifyDeposit: true,
    notifyReminder: true,
    notifyRoomChange: true,
    notifyCancel: true,
    notifyRefund: true,
    notifyPoints: true,
    notifyRewards: true,
    notifyPromotions: false,
  },
};

let cache = null;
let cacheAt = 0;

function deepMerge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over || {})) {
    out[k] = typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k]) ? deepMerge(base[k], over[k]) : over[k];
  }
  return out;
}

export async function getSettings(client) {
  if (!client && cache && Date.now() - cacheAt < 5000) return cache;
  const c = client || pool;
  const rows = (await c.query('SELECT key, value FROM system_settings')).rows;
  const s = structuredClone(DEFAULT_SETTINGS);
  for (const r of rows) s[r.key] = deepMerge(DEFAULT_SETTINGS[r.key] ?? {}, r.value);
  const store = (await c.query('SELECT * FROM stores ORDER BY id LIMIT 1')).rows[0] || {};
  const branch = (await c.query('SELECT * FROM branches WHERE is_active ORDER BY sort_order, id LIMIT 1')).rows[0] || {};
  s.store = {
    name: store.name || 'BEATBOX Karaoke',
    logoUrl: store.logo_url || '',
    address: store.address || '',
    phone: store.phone || '',
    taxId: store.tax_id || '',
    slogan: store.slogan || s.receipt.slogan,
    currency: store.currency || 'THB',
    branchName: branch.name || '',
    branchId: branch.id || null,
    openTime: branch.open_time ? String(branch.open_time).slice(0, 5) : '12:00',
    closeTime: branch.close_time ? String(branch.close_time).slice(0, 5) : '02:00',
  };
  const integ = await getIntegrations();
  s.runtime = {
    paymentMode: integ.slip.mode === 'PRODUCTION' ? 'PRODUCTION' : 'DEMO',
    slipProvider: integ.slip.provider,
    lineLoginEnabled: !!(integ.line.loginEnabled !== false && integ.line.loginChannelId && integ.line.loginChannelSecret),
    terminalProvider: integ.terminal.provider,
    appEnv: config.appEnv,
  };
  if (!client) {
    cache = s;
    cacheAt = Date.now();
  }
  return s;
}

export function invalidateSettings() {
  cache = null;
}

/** Tax snapshot passed to the calculation engine and stored on every order. */
export function taxSnapshot(settings) {
  const t = settings.tax;
  return {
    vatEnabled: !!t.vatEnabled,
    vatRate: Number(t.vatRate || 0),
    vatMode: t.vatMode,
    scEnabled: !!t.scEnabled,
    scRate: Number(t.scRate || 0),
    scBase: t.scBase,
    rounding: t.rounding,
  };
}

export async function saveSettingsSection(client, key, value, employeeId) {
  await client.query(
    `INSERT INTO system_settings(key, value, updated_by) VALUES ($1,$2,$3)
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now(), updated_by = $3`,
    [key, value, employeeId || null],
  );
  invalidateSettings();
}

/** Subset safe to expose publicly (Customer Display / Booking website). */
export function publicSettings(s) {
  return {
    store: s.store,
    general: s.general,
    appearance: s.appearance,
    tax: { vatEnabled: s.tax.vatEnabled, vatRate: s.tax.vatRate, vatMode: s.tax.vatMode, scEnabled: s.tax.scEnabled, scRate: s.tax.scRate, scBase: s.tax.scBase, rounding: s.tax.rounding },
    payment: {
      accountName: s.payment.accountName,
      accountNumber: s.payment.accountNumber,
      bankName: s.payment.bankName,
      promptPayId: s.payment.promptPayId,
      qrImageUrl: s.payment.qrImageUrl,
      useDynamicPromptPay: s.payment.useDynamicPromptPay,
      instruction: s.payment.instruction,
    },
    booking: s.booking,
    deposit: s.deposit,
    points: { enabled: s.points.enabled, amountPerPoint: s.points.amountPerPoint, pointsPerUnit: s.points.pointsPerUnit },
    room: { extraGuestFee: s.room.extraGuestFee, maxExtraGuests: s.room.maxExtraGuests, includedMics: s.room.includedMics, extraMicFee: s.room.extraMicFee, maxExtraMics: s.room.maxExtraMics, partialRule: s.room.partialRule, graceMinutes: s.room.graceMinutes },
    queue: { prefix: s.queue.prefix },
    receipt: { slogan: s.receipt.slogan, thankYou: s.receipt.thankYou },
    runtime: { paymentMode: s.runtime.paymentMode, lineLoginEnabled: s.runtime.lineLoginEnabled },
  };
}

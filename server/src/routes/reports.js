import { Router } from 'express';
import ExcelJS from 'exceljs';
import { pool, many, one } from '../db/index.js';
import { requireAuth, can, hasPerm } from '../lib/auth.js';
import { badRequest, forbidden } from '../lib/errors.js';
import { getSettings } from '../services/settings.js';
import { getRoomBoard } from '../services/rooms.js';
import { bkkDateStr } from '@beatbox/shared/format.js';

const r = Router();
r.use(requireAuth);

const PAID = `o.status IN ('PAID','PARTIALLY_REFUNDED','REFUNDED')`;
const BKK = (col) => `(${col} AT TIME ZONE 'Asia/Bangkok')`;

function range(q) {
  const today = bkkDateStr();
  return { from: q.from || today, to: q.to || q.from || today };
}

r.get('/dashboard', can('sales.view'), async (req, res) => {
  const date = req.query.date || bkkDateStr();
  const settings = await getSettings();
  const d = [date];
  const kpi = await one(
    `SELECT COALESCE(SUM(o.grand_total),0) AS total_sales, COALESCE(SUM(o.room_total),0) AS room_sales, COALESCE(SUM(o.product_total),0) AS product_sales,
            COUNT(*) AS receipts, COALESCE(AVG(o.grand_total),0) AS avg_bill, COALESCE(SUM(o.billed_minutes),0) AS minutes_sold,
            COALESCE(SUM(o.refunded_total),0) AS refunded,
            COALESCE(SUM(o.grand_total) FILTER (WHERE o.member_id IS NOT NULL),0) AS member_sales,
            COALESCE(SUM(o.grand_total) FILTER (WHERE o.member_id IS NULL),0) AS non_member_sales,
            COALESCE(SUM(o.guest_count),0) AS customers
     FROM orders o WHERE ${PAID} AND ${BKK('o.paid_at')}::date = $1`,
    d,
  );
  const pay = await many(`SELECT p.method, SUM(p.amount) AS amount FROM payments p WHERE p.purpose = 'SALE' AND ${BKK('p.paid_at')}::date = $1 GROUP BY p.method`, d);
  const deposits = await one(`SELECT COALESCE(SUM(amount),0) AS amount, COALESCE(SUM(amount) FILTER (WHERE source = 'ONLINE'),0) AS online FROM deposits WHERE verification_status = 'VERIFIED' AND ${BKK('received_at')}::date = $1`, d);
  const newMembers = await one(`SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE source = 'LINE') AS line FROM members WHERE ${BKK('created_at')}::date = $1`, d);
  const lineMembers = await one(`SELECT COUNT(DISTINCT member_id) AS n FROM line_connections WHERE status = 'CONNECTED'`);
  const topRoom = await one(
    `SELECT rm.name, SUM(o.grand_total) AS amount FROM orders o JOIN room_sessions rs ON rs.id = o.session_id JOIN rooms rm ON rm.id = rs.room_id
     WHERE ${PAID} AND ${BKK('o.paid_at')}::date = $1 GROUP BY rm.name ORDER BY amount DESC LIMIT 1`,
    d,
  );
  const topProducts = await many(
    `SELECT oi.name, SUM(oi.qty) AS qty, SUM(oi.qty * oi.unit_price) AS amount FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE ${PAID} AND oi.item_type = 'PRODUCT' AND oi.voided_at IS NULL AND ${BKK('o.paid_at')}::date = $1 GROUP BY oi.name ORDER BY qty DESC LIMIT 5`,
    d,
  );
  const hourly = await many(
    `SELECT extract(hour FROM ${BKK('o.paid_at')})::int AS hour, SUM(o.grand_total) AS amount, COUNT(*) AS bills FROM orders o
     WHERE ${PAID} AND ${BKK('o.paid_at')}::date = $1 GROUP BY 1 ORDER BY 1`,
    d,
  );
  const usageHours = await many(
    `SELECT extract(hour FROM ${BKK('rs.started_at')})::int AS hour, COUNT(*) AS sessions FROM room_sessions rs
     WHERE rs.status IN ('ACTIVE','PAUSED','CLOSED','PAID') AND ${BKK('rs.started_at')}::date >= ($1::date - 30) GROUP BY 1 ORDER BY sessions DESC`,
    d,
  );
  const daily = await many(
    `SELECT ${BKK('o.paid_at')}::date AS day, SUM(o.grand_total) AS amount, SUM(o.billed_minutes) / 60.0 AS hours, COUNT(*) AS bills FROM orders o
     WHERE ${PAID} AND ${BKK('o.paid_at')}::date > ($1::date - 30) AND ${BKK('o.paid_at')}::date <= $1 GROUP BY 1 ORDER BY 1`,
    d,
  );
  const monthly = await many(
    `SELECT to_char(${BKK('o.paid_at')}, 'YYYY-MM') AS month, SUM(o.grand_total) AS amount, SUM(o.billed_minutes) / 60.0 AS hours FROM orders o
     WHERE ${PAID} AND ${BKK('o.paid_at')}::date > ($1::date - 365) GROUP BY 1 ORDER BY 1`,
    d,
  );
  const byType = await many(
    `SELECT rt.name, rt.color, SUM(o.grand_total) AS amount, SUM(o.billed_minutes) / 60.0 AS hours FROM orders o JOIN room_sessions rs ON rs.id = o.session_id JOIN room_types rt ON rt.id = rs.room_type_id
     WHERE ${PAID} AND ${BKK('o.paid_at')}::date > ($1::date - 30) AND ${BKK('o.paid_at')}::date <= $1 GROUP BY rt.name, rt.color ORDER BY amount DESC`,
    d,
  );
  const byMethod = await many(`SELECT p.method, SUM(p.amount) AS amount FROM payments p WHERE p.purpose = 'SALE' AND ${BKK('p.paid_at')}::date > ($1::date - 30) AND ${BKK('p.paid_at')}::date <= $1 GROUP BY 1 ORDER BY 2 DESC`, d);
  const byEmployee = await many(
    `SELECT e.name, SUM(o.grand_total) AS amount, COUNT(*) AS bills FROM orders o JOIN employees e ON e.id = o.paid_by WHERE ${PAID} AND ${BKK('o.paid_at')}::date > ($1::date - 30) AND ${BKK('o.paid_at')}::date <= $1 GROUP BY e.name ORDER BY amount DESC`,
    d,
  );
  const byPackage = await many(
    `SELECT COALESCE(rs.package_name, 'รายชั่วโมง') AS name, SUM(o.room_total) AS amount, COUNT(*) AS n FROM orders o JOIN room_sessions rs ON rs.id = o.session_id
     WHERE ${PAID} AND ${BKK('o.paid_at')}::date > ($1::date - 30) AND ${BKK('o.paid_at')}::date <= $1 GROUP BY 1 ORDER BY amount DESC`,
    d,
  );
  // bookings
  const bk = await one(
    `SELECT COUNT(*) FILTER (WHERE source = 'ONLINE' AND ${BKK('created_at')}::date = $1 AND status NOT IN ('EXPIRED','HOLD')) AS online_today,
            COUNT(*) FILTER (WHERE source = 'ONLINE' AND date_trunc('month', ${BKK('created_at')}) = date_trunc('month', $1::date) AND status NOT IN ('EXPIRED','HOLD')) AS online_month,
            COUNT(*) FILTER (WHERE source = 'ONLINE' AND date_trunc('month', ${BKK('created_at')}) = date_trunc('month', $1::date)) AS online_attempts_month,
            COUNT(*) FILTER (WHERE status IN ('HOLD','PENDING') AND end_at > now()) AS unpaid,
            COUNT(*) FILTER (WHERE status IN ('CONFIRMED','DEPOSIT_PAID') AND end_at > now()) AS confirmed,
            COUNT(*) FILTER (WHERE ${BKK('start_at')}::date > ($1::date - 30) AND status IN ('CANCELLED','REFUNDED')) AS cancelled_30,
            COUNT(*) FILTER (WHERE ${BKK('start_at')}::date > ($1::date - 30) AND status = 'NO_SHOW') AS noshow_30,
            COUNT(*) FILTER (WHERE ${BKK('start_at')}::date > ($1::date - 30) AND status NOT IN ('EXPIRED','HOLD')) AS total_30
     FROM reservations`,
    d,
  );
  const bookingsDaily = await many(
    `SELECT ${BKK('start_at')}::date AS day, COUNT(*) AS n, COUNT(*) FILTER (WHERE source = 'ONLINE') AS online FROM reservations
     WHERE status NOT IN ('EXPIRED','HOLD') AND ${BKK('start_at')}::date > ($1::date - 30) AND ${BKK('start_at')}::date <= ($1::date + 7) GROUP BY 1 ORDER BY 1`,
    d,
  );
  const bookingsHourly = await many(`SELECT extract(hour FROM ${BKK('start_at')})::int AS hour, COUNT(*) AS n FROM reservations WHERE status NOT IN ('EXPIRED','HOLD') AND ${BKK('start_at')}::date > ($1::date - 60) GROUP BY 1 ORDER BY 1`, d);
  const sources = await many(
    `SELECT CASE WHEN rs.reservation_id IS NULL THEN 'WALK_IN' ELSE COALESCE(rv.source, 'POS') END AS source, COUNT(*) AS n FROM room_sessions rs LEFT JOIN reservations rv ON rv.id = rs.reservation_id
     WHERE ${BKK('rs.started_at')}::date > ($1::date - 30) AND rs.status IN ('PAID','ACTIVE','PAUSED','CLOSED') GROUP BY 1`,
    d,
  );
  const depositMethods = await many(`SELECT method, SUM(amount) AS amount FROM deposits WHERE verification_status = 'VERIFIED' AND ${BKK('received_at')}::date > ($1::date - 30) GROUP BY 1`, d);
  const points = await one(
    `SELECT COALESCE(SUM(points) FILTER (WHERE type = 'EARN'),0) AS issued, COALESCE(-SUM(points) FILTER (WHERE type = 'REDEEM'),0) AS redeemed FROM point_ledgers WHERE ${BKK('created_at')}::date = $1`,
    d,
  );
  // utilization (today): sold room minutes / (active rooms × opening minutes)
  const roomsCount = await one(`SELECT COUNT(*) AS n FROM rooms WHERE deleted_at IS NULL AND is_active`);
  const [oh, om] = settings.store.openTime.split(':').map(Number);
  const [ch, cm] = settings.store.closeTime.split(':').map(Number);
  let openMinutes = ch * 60 + cm - (oh * 60 + om);
  if (openMinutes <= 0) openMinutes += 1440;
  const availHours = (Number(roomsCount.n) * openMinutes) / 60;
  const usedMin = await one(`SELECT COALESCE(SUM(billed_minutes),0) AS m FROM orders o WHERE ${PAID} AND ${BKK('o.paid_at')}::date = $1 AND session_id IS NOT NULL`, d);
  const utilDaily = await many(
    `SELECT ${BKK('o.paid_at')}::date AS day, SUM(o.billed_minutes) / 60.0 AS hours FROM orders o WHERE ${PAID} AND o.session_id IS NOT NULL AND ${BKK('o.paid_at')}::date > ($1::date - 30) GROUP BY 1 ORDER BY 1`,
    d,
  );

  const board = await getRoomBoard(settings);
  const count = (s) => board.filter((x) => x.status === s).length;
  const canCost = hasPerm(req, 'cost.view');
  res.json({
    date,
    kpi: {
      totalSales: Number(kpi.total_sales),
      roomSales: Number(kpi.room_sales),
      productSales: Number(kpi.product_sales),
      cash: Number(pay.find((p) => p.method === 'CASH')?.amount || 0),
      qr: Number(pay.find((p) => p.method === 'QR')?.amount || 0),
      transfer: Number(pay.find((p) => p.method === 'TRANSFER')?.amount || 0),
      card: Number(pay.find((p) => p.method === 'CARD')?.amount || 0),
      deposits: Number(deposits.amount),
      onlineDeposits: Number(deposits.online),
      receipts: Number(kpi.receipts),
      roomsInUse: board.filter((x) => ['IN_USE', 'NEAR_END', 'TIME_UP'].includes(x.status)).length,
      roomsAvailable: count('AVAILABLE'),
      roomsReserved: count('RESERVED') + count('WAITING'),
      roomsNearEnd: count('NEAR_END'),
      roomsTimeUp: count('TIME_UP'),
      roomsCleaning: count('CLEANING'),
      customers: Number(kpi.customers),
      newMembers: Number(newMembers.n),
      hoursSold: Math.round((Number(kpi.minutes_sold) / 60) * 100) / 100,
      halfHourBlocks: Math.ceil(Number(kpi.minutes_sold) / 30),
      avgBill: Math.round(Number(kpi.avg_bill) * 100) / 100,
      topRoom: topRoom || null,
      peakHour: usageHours[0]?.hour ?? null,
      onlineToday: Number(bk.online_today),
      onlineMonth: Number(bk.online_month),
      conversionRate: Number(bk.online_attempts_month) ? Math.round((Number(bk.online_month) / Number(bk.online_attempts_month)) * 1000) / 10 : 0,
      unpaidBookings: Number(bk.unpaid),
      confirmedBookings: Number(bk.confirmed),
      cancellationRate: Number(bk.total_30) ? Math.round((Number(bk.cancelled_30) / Number(bk.total_30)) * 1000) / 10 : 0,
      noShowRate: Number(bk.total_30) ? Math.round((Number(bk.noshow_30) / Number(bk.total_30)) * 1000) / 10 : 0,
      lineMembers: Number(lineMembers.n),
      pointsIssued: Number(points.issued),
      pointsRedeemed: Number(points.redeemed),
      memberSales: Number(kpi.member_sales),
      nonMemberSales: Number(kpi.non_member_sales),
      utilization: availHours ? Math.round((Number(usedMin.m) / 60 / availHours) * 1000) / 10 : 0,
      revPARH: availHours ? Math.round((Number(kpi.room_sales) / availHours) * 100) / 100 : 0,
    },
    topProducts,
    charts: {
      hourly,
      daily,
      monthly,
      byType,
      byMethod,
      byEmployee,
      byPackage,
      bookingsDaily,
      bookingsHourly,
      sources,
      depositMethods,
      memberSplit: [
        { name: 'สมาชิก', amount: Number(kpi.member_sales) },
        { name: 'ไม่ใช่สมาชิก', amount: Number(kpi.non_member_sales) },
      ],
      utilization: utilDaily.map((u) => ({ day: u.day, percent: availHours ? Math.round((Number(u.hours) / availHours) * 1000) / 10 : 0 })),
    },
    canCost,
  });
});

// ───────────── Reports ─────────────
const money = 'money';
const REPORTS = {
  sales: {
    title: 'รายงานยอดขาย',
    columns: [['receipt_no', 'เลขที่ใบเสร็จ'], ['queue_no', 'คิว'], ['paid_at', 'วันเวลา', 'datetime'], ['room_name', 'ห้อง'], ['customer', 'ลูกค้า'], ['employee', 'พนักงาน'], ['subtotal', 'ยอดก่อนส่วนลด', money], ['discount_total', 'ส่วนลด', money], ['service_charge', 'Service Charge', money], ['vat', 'VAT', money], ['grand_total', 'ยอดรวม', money], ['deposit_applied', 'มัดจำ', money], ['net_total', 'สุทธิ', money], ['status', 'สถานะ']],
    sql: (w) => `SELECT rc.receipt_no, o.queue_no, o.paid_at, rm.name AS room_name, COALESCE(m.first_name, o.customer_name) AS customer, e.name AS employee,
       o.subtotal, o.discount_total, o.service_charge, o.vat, o.grand_total, o.deposit_applied, o.net_total, o.status
       FROM orders o LEFT JOIN receipts rc ON rc.order_id = o.id LEFT JOIN room_sessions rs ON rs.id = o.session_id LEFT JOIN rooms rm ON rm.id = rs.room_id
       LEFT JOIN members m ON m.id = o.member_id LEFT JOIN employees e ON e.id = o.paid_by WHERE ${w} ORDER BY o.paid_at`,
    totals: ['subtotal', 'discount_total', 'service_charge', 'vat', 'grand_total', 'deposit_applied', 'net_total'],
  },
  'room-sales': {
    title: 'รายงานค่าห้อง',
    columns: [['room_name', 'ห้อง'], ['type_name', 'Type'], ['sessions', 'จำนวนครั้ง'], ['hours', 'ชั่วโมงที่ขาย'], ['room_total', 'ค่าห้อง', money], ['product_total', 'ค่าสินค้า', money], ['grand_total', 'ยอดรวม', money]],
    sql: (w) => `SELECT rm.name AS room_name, rt.name AS type_name, COUNT(*) AS sessions, ROUND(SUM(o.billed_minutes)/60.0, 2) AS hours, SUM(o.room_total) AS room_total, SUM(o.product_total) AS product_total, SUM(o.grand_total) AS grand_total
       FROM orders o JOIN room_sessions rs ON rs.id = o.session_id JOIN rooms rm ON rm.id = rs.room_id JOIN room_types rt ON rt.id = rs.room_type_id WHERE ${w} GROUP BY rm.name, rt.name, rm.sort_order ORDER BY rm.sort_order`,
    totals: ['sessions', 'hours', 'room_total', 'product_total', 'grand_total'],
  },
  products: {
    title: 'รายงานสินค้า',
    columns: [['name', 'สินค้า'], ['category', 'หมวดหมู่'], ['qty', 'จำนวน'], ['amount', 'ยอดขาย', money], ['cost', 'ต้นทุน', money, 'cost'], ['profit', 'กำไร', money, 'cost']],
    sql: (w) => `SELECT oi.name, c.name AS category, SUM(oi.qty - oi.refunded_qty) AS qty, SUM((oi.qty - oi.refunded_qty) * oi.unit_price) AS amount, SUM((oi.qty - oi.refunded_qty) * oi.unit_cost) AS cost,
       SUM((oi.qty - oi.refunded_qty) * (oi.unit_price - oi.unit_cost)) AS profit
       FROM order_items oi JOIN orders o ON o.id = oi.order_id LEFT JOIN categories c ON c.id = oi.category_id LEFT JOIN room_sessions rs ON rs.id = o.session_id
       WHERE ${w} AND oi.item_type = 'PRODUCT' AND oi.voided_at IS NULL GROUP BY oi.name, c.name ORDER BY amount DESC`,
    totals: ['qty', 'amount', 'cost', 'profit'],
  },
  hours: {
    title: 'รายงานจำนวนชั่วโมงที่ขาย',
    columns: [['day', 'วันที่', 'date'], ['sessions', 'จำนวนห้องที่ขาย'], ['minutes', 'นาที'], ['hours', 'ชั่วโมง'], ['room_total', 'ค่าห้อง', money]],
    sql: (w) => `SELECT ${BKK('o.paid_at')}::date AS day, COUNT(*) AS sessions, SUM(o.billed_minutes) AS minutes, ROUND(SUM(o.billed_minutes)/60.0, 2) AS hours, SUM(o.room_total) AS room_total
       FROM orders o LEFT JOIN room_sessions rs ON rs.id = o.session_id WHERE ${w} AND o.session_id IS NOT NULL GROUP BY 1 ORDER BY 1`,
    totals: ['sessions', 'minutes', 'hours', 'room_total'],
  },
  'half-hours': {
    title: 'รายงานเวลา 30 นาทีที่ขาย',
    columns: [['day', 'วันที่', 'date'], ['blocks', 'จำนวนช่วง 30 นาที'], ['full_hours', 'ชั่วโมงเต็ม'], ['half_blocks', 'เศษ 30 นาที'], ['hours', 'รวมชั่วโมง']],
    sql: (w) => `SELECT ${BKK('o.paid_at')}::date AS day, SUM(CEIL(o.billed_minutes/30.0)) AS blocks, SUM(FLOOR(o.billed_minutes/60)) AS full_hours,
       SUM(CASE WHEN o.billed_minutes % 60 > 0 THEN 1 ELSE 0 END) AS half_blocks, ROUND(SUM(o.billed_minutes)/60.0, 2) AS hours
       FROM orders o LEFT JOIN room_sessions rs ON rs.id = o.session_id WHERE ${w} AND o.session_id IS NOT NULL GROUP BY 1 ORDER BY 1`,
    totals: ['blocks', 'full_hours', 'half_blocks', 'hours'],
  },
  'room-usage': {
    title: 'รายงานการใช้ห้อง',
    columns: [['session_no', 'เลขที่'], ['room_name', 'ห้อง'], ['customer_name', 'ลูกค้า'], ['guest_count', 'จำนวนคน'], ['started_at', 'เริ่ม', 'datetime'], ['ended_at', 'สิ้นสุด', 'datetime'], ['used_minutes', 'นาทีที่ใช้'], ['package_name', 'แพ็กเกจ'], ['status', 'สถานะ'], ['opened_by', 'พนักงานเปิดห้อง']],
    sql: (w) => `SELECT rs.session_no, rm.name AS room_name, rs.customer_name, rs.guest_count, rs.started_at, rs.ended_at,
       ROUND(EXTRACT(epoch FROM (COALESCE(rs.ended_at, now()) - rs.started_at))/60 - rs.total_paused_seconds/60.0) AS used_minutes, rs.package_name, rs.status, e.name AS opened_by
       FROM room_sessions rs JOIN rooms rm ON rm.id = rs.room_id LEFT JOIN employees e ON e.id = rs.opened_by LEFT JOIN orders o ON o.id = rs.order_id
       WHERE ${w.replaceAll('o.paid_at', 'rs.started_at').replace(PAID, 'true')} ORDER BY rs.started_at`,
  },
  'room-types': {
    title: 'รายงานยอดขายแยก Type ห้อง',
    columns: [['type_name', 'Type ห้อง'], ['sessions', 'จำนวนครั้ง'], ['hours', 'ชั่วโมง'], ['room_total', 'ค่าห้อง', money], ['grand_total', 'ยอดรวม', money]],
    sql: (w) => `SELECT rt.name AS type_name, COUNT(*) AS sessions, ROUND(SUM(o.billed_minutes)/60.0,2) AS hours, SUM(o.room_total) AS room_total, SUM(o.grand_total) AS grand_total
       FROM orders o JOIN room_sessions rs ON rs.id = o.session_id JOIN room_types rt ON rt.id = rs.room_type_id WHERE ${w} GROUP BY rt.name ORDER BY grand_total DESC`,
    totals: ['sessions', 'hours', 'room_total', 'grand_total'],
  },
  customers: {
    title: 'รายงานจำนวนลูกค้า',
    columns: [['day', 'วันที่', 'date'], ['bills', 'จำนวนบิล'], ['guests', 'จำนวนลูกค้า'], ['members', 'บิลสมาชิก'], ['avg_guests', 'เฉลี่ยคน/ห้อง']],
    sql: (w) => `SELECT ${BKK('o.paid_at')}::date AS day, COUNT(*) AS bills, COALESCE(SUM(o.guest_count),0) AS guests, COUNT(o.member_id) AS members, ROUND(AVG(o.guest_count), 1) AS avg_guests
       FROM orders o LEFT JOIN room_sessions rs ON rs.id = o.session_id WHERE ${w} GROUP BY 1 ORDER BY 1`,
    totals: ['bills', 'guests', 'members'],
  },
  'extra-guests': {
    title: 'รายงานลูกค้าเกินจำนวน',
    columns: [['receipt_no', 'ใบเสร็จ'], ['paid_at', 'วันเวลา', 'datetime'], ['room_name', 'ห้อง'], ['capacity', 'รองรับ'], ['guest_count', 'ลูกค้า'], ['extra_guests', 'เกิน (คน)'], ['amount', 'ค่าบริการ', money]],
    sql: (w) => `SELECT rc.receipt_no, o.paid_at, rm.name AS room_name, rs.room_capacity AS capacity, o.guest_count, o.extra_guests,
       (SELECT SUM(qty * unit_price) FROM order_items WHERE order_id = o.id AND item_type = 'EXTRA_GUEST') AS amount
       FROM orders o JOIN room_sessions rs ON rs.id = o.session_id JOIN rooms rm ON rm.id = rs.room_id LEFT JOIN receipts rc ON rc.order_id = o.id WHERE ${w} AND o.extra_guests > 0 ORDER BY o.paid_at`,
    totals: ['extra_guests', 'amount'],
  },
  members: {
    title: 'รายงานสมาชิก',
    columns: [['member_code', 'รหัส'], ['name', 'ชื่อ'], ['phone', 'เบอร์โทร'], ['tier', 'ระดับ'], ['points_balance', 'คะแนน'], ['total_spending', 'ยอดสะสม', money], ['visit_count', 'ครั้ง'], ['hours', 'ชั่วโมงสะสม'], ['period_spending', 'ยอดในช่วง', money], ['source', 'ช่องทางสมัคร'], ['created_at', 'วันที่สมัคร', 'datetime']],
    sql: () => `SELECT m.member_code, m.first_name || ' ' || COALESCE(m.last_name,'') AS name, m.phone, t.name AS tier, m.points_balance, m.total_spending, m.visit_count, ROUND(m.total_minutes/60.0,1) AS hours,
       (SELECT COALESCE(SUM(o.grand_total),0) FROM orders o WHERE o.member_id = m.id AND ${PAID} AND ${BKK('o.paid_at')}::date BETWEEN $1 AND $2) AS period_spending, m.source, m.created_at
       FROM members m LEFT JOIN member_tiers t ON t.id = m.tier_id WHERE m.deleted_at IS NULL ORDER BY period_spending DESC, m.total_spending DESC`,
    totals: ['period_spending'],
  },
  points: {
    title: 'รายงานคะแนน',
    columns: [['created_at', 'วันเวลา', 'datetime'], ['member_code', 'สมาชิก'], ['name', 'ชื่อ'], ['type', 'ประเภท'], ['points', 'คะแนน'], ['balance_after', 'คงเหลือ'], ['reason', 'รายละเอียด'], ['employee', 'พนักงาน']],
    sql: () => `SELECT pl.created_at, m.member_code, m.first_name AS name, pl.type, pl.points, pl.balance_after, pl.reason, e.name AS employee
       FROM point_ledgers pl JOIN members m ON m.id = pl.member_id LEFT JOIN employees e ON e.id = pl.employee_id WHERE ${BKK('pl.created_at')}::date BETWEEN $1 AND $2 ORDER BY pl.id`,
    totals: ['points'],
  },
  deposits: {
    title: 'รายงานมัดจำ',
    columns: [['deposit_no', 'เลขที่มัดจำ'], ['booking_no', 'เลขที่จอง'], ['customer_name', 'ลูกค้า'], ['phone', 'เบอร์โทร'], ['amount', 'จำนวน', money], ['method', 'ช่องทาง'], ['source', 'ที่มา'], ['verification_status', 'การตรวจสอบ'], ['status', 'สถานะ'], ['received_at', 'วันเวลา', 'datetime'], ['employee', 'ผู้รับเงิน']],
    sql: () => `SELECT d.deposit_no, rv.booking_no, d.customer_name, d.phone, d.amount, d.method, d.source, d.verification_status, d.status, d.received_at, e.name AS employee
       FROM deposits d LEFT JOIN reservations rv ON rv.id = d.reservation_id LEFT JOIN employees e ON e.id = d.received_by WHERE ${BKK('d.received_at')}::date BETWEEN $1 AND $2 ORDER BY d.id`,
    totals: ['amount'],
  },
  'deposit-refunds': {
    title: 'รายงานคืนมัดจำ',
    columns: [['refund_no', 'เลขที่'], ['deposit_no', 'มัดจำ'], ['booking_no', 'การจอง'], ['amount', 'จำนวน', money], ['refund_type', 'ช่องทาง'], ['reason', 'เหตุผล'], ['employee', 'พนักงาน'], ['created_at', 'วันเวลา', 'datetime']],
    sql: () => `SELECT dr.refund_no, d.deposit_no, rv.booking_no, dr.amount, dr.refund_type, dr.reason, e.name AS employee, dr.created_at FROM deposit_refunds dr JOIN deposits d ON d.id = dr.deposit_id
       LEFT JOIN reservations rv ON rv.id = d.reservation_id LEFT JOIN employees e ON e.id = dr.employee_id WHERE ${BKK('dr.created_at')}::date BETWEEN $1 AND $2 ORDER BY dr.id`,
    totals: ['amount'],
  },
  discounts: {
    title: 'รายงานส่วนลด',
    columns: [['receipt_no', 'ใบเสร็จ'], ['paid_at', 'วันเวลา', 'datetime'], ['discount_name', 'ส่วนลด'], ['source', 'ประเภท'], ['amount', 'จำนวน', money], ['employee', 'พนักงาน'], ['approver', 'ผู้อนุมัติ']],
    sql: (w) => `SELECT rc.receipt_no, o.paid_at, d->>'name' AS discount_name, d->>'source' AS source, (d->>'amount')::numeric AS amount, e.name AS employee, a.name AS approver
       FROM orders o JOIN receipts rc ON rc.order_id = o.id LEFT JOIN room_sessions rs ON rs.id = o.session_id LEFT JOIN employees e ON e.id = o.paid_by LEFT JOIN employees a ON a.id = o.discount_approved_by
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(o.calc_snapshot->'discounts','[]'::jsonb)) d WHERE ${w}
       UNION ALL
       SELECT rc.receipt_no, o.paid_at, 'ส่วนลดรายการ: ' || (l->>'name'), 'ITEM', (l->>'discount')::numeric, e.name, a.name
       FROM orders o JOIN receipts rc ON rc.order_id = o.id LEFT JOIN room_sessions rs ON rs.id = o.session_id LEFT JOIN employees e ON e.id = o.paid_by LEFT JOIN employees a ON a.id = o.discount_approved_by
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(o.calc_snapshot->'lines','[]'::jsonb)) l WHERE ${w} AND (l->>'discount')::numeric > 0
       ORDER BY 2`,
    totals: ['amount'],
  },
  vat: {
    title: 'รายงาน VAT',
    columns: [['receipt_no', 'ใบเสร็จ'], ['paid_at', 'วันเวลา', 'datetime'], ['vat_mode', 'รูปแบบ'], ['vat_rate', 'อัตรา %'], ['before_vat', 'มูลค่าก่อน VAT', money], ['vat', 'VAT', money], ['grand_total', 'ยอดรวม', money]],
    sql: (w) => `SELECT rc.receipt_no, o.paid_at, o.settings_snapshot->'tax'->>'vatMode' AS vat_mode, o.settings_snapshot->'tax'->>'vatRate' AS vat_rate,
       COALESCE((o.calc_snapshot->>'beforeVat')::numeric, o.grand_total - o.vat) AS before_vat, o.vat, o.grand_total
       FROM orders o JOIN receipts rc ON rc.order_id = o.id LEFT JOIN room_sessions rs ON rs.id = o.session_id WHERE ${w} ORDER BY o.paid_at`,
    totals: ['before_vat', 'vat', 'grand_total'],
  },
  'service-charge': {
    title: 'รายงาน Service Charge',
    columns: [['receipt_no', 'ใบเสร็จ'], ['paid_at', 'วันเวลา', 'datetime'], ['sc_rate', 'อัตรา %'], ['sc_base', 'ฐานคำนวณ', money], ['service_charge', 'Service Charge', money]],
    sql: (w) => `SELECT rc.receipt_no, o.paid_at, o.settings_snapshot->'tax'->>'scRate' AS sc_rate, (o.calc_snapshot->>'scBase')::numeric AS sc_base, o.service_charge
       FROM orders o JOIN receipts rc ON rc.order_id = o.id LEFT JOIN room_sessions rs ON rs.id = o.session_id WHERE ${w} AND o.service_charge > 0 ORDER BY o.paid_at`,
    totals: ['sc_base', 'service_charge'],
  },
  'payment-methods': {
    title: 'รายงานช่องทางชำระเงิน',
    columns: [['method', 'ช่องทาง'], ['transactions', 'จำนวนรายการ'], ['amount', 'ยอดเงิน', money]],
    sql: () => `SELECT p.method, COUNT(*) AS transactions, SUM(p.amount) AS amount FROM payments p WHERE p.purpose = 'SALE' AND ${BKK('p.paid_at')}::date BETWEEN $1 AND $2 GROUP BY p.method ORDER BY amount DESC`,
    totals: ['transactions', 'amount'],
  },
  employees: {
    title: 'รายงานพนักงาน',
    columns: [['employee', 'พนักงาน'], ['bills', 'จำนวนบิล'], ['amount', 'ยอดขาย', money], ['discount', 'ส่วนลด', money], ['rooms_opened', 'เปิดห้อง'], ['voids', 'ยกเลิก'], ['refunds', 'คืนเงิน']],
    sql: () => `SELECT e.name AS employee,
       (SELECT COUNT(*) FROM orders o WHERE o.paid_by = e.id AND ${PAID} AND ${BKK('o.paid_at')}::date BETWEEN $1 AND $2) AS bills,
       (SELECT COALESCE(SUM(o.grand_total),0) FROM orders o WHERE o.paid_by = e.id AND ${PAID} AND ${BKK('o.paid_at')}::date BETWEEN $1 AND $2) AS amount,
       (SELECT COALESCE(SUM(o.discount_total),0) FROM orders o WHERE o.paid_by = e.id AND ${PAID} AND ${BKK('o.paid_at')}::date BETWEEN $1 AND $2) AS discount,
       (SELECT COUNT(*) FROM room_sessions rs WHERE rs.opened_by = e.id AND ${BKK('rs.started_at')}::date BETWEEN $1 AND $2) AS rooms_opened,
       (SELECT COUNT(*) FROM orders o WHERE o.voided_by = e.id AND ${BKK('o.voided_at')}::date BETWEEN $1 AND $2) AS voids,
       (SELECT COUNT(*) FROM refunds rf WHERE rf.requested_by = e.id AND ${BKK('rf.created_at')}::date BETWEEN $1 AND $2) AS refunds
       FROM employees e WHERE e.deleted_at IS NULL ORDER BY amount DESC`,
    totals: ['bills', 'amount', 'discount', 'rooms_opened'],
  },
  shifts: {
    title: 'รายงานเปิดและปิดรอบ',
    columns: [['shift_no', 'รอบ'], ['employee', 'เปิดโดย'], ['opened_at', 'เปิด', 'datetime'], ['closed_at', 'ปิด', 'datetime'], ['closed_by', 'ปิดโดย'], ['opening_cash', 'เงินตั้งต้น', money], ['expected_cash', 'เงินที่ควรมี', money], ['counted_cash', 'นับได้', money], ['difference', 'ขาด/เกิน', money], ['status', 'สถานะ']],
    sql: () => `SELECT s.shift_no, e.name AS employee, s.opened_at, s.closed_at, c.name AS closed_by, s.opening_cash, s.expected_cash, s.counted_cash, s.difference, s.status
       FROM shifts s JOIN employees e ON e.id = s.employee_id LEFT JOIN employees c ON c.id = s.closed_by WHERE ${BKK('s.opened_at')}::date BETWEEN $1 AND $2 ORDER BY s.id`,
    totals: ['difference'],
  },
  'cash-diff': {
    title: 'รายงานเงินขาดหรือเกิน',
    columns: [['shift_no', 'รอบ'], ['closed_at', 'ปิดรอบ', 'datetime'], ['closed_by', 'พนักงาน'], ['expected_cash', 'ควรมี', money], ['counted_cash', 'นับได้', money], ['shortage', 'เงินขาด', money], ['overage', 'เงินเกิน', money], ['close_note', 'หมายเหตุ']],
    sql: () => `SELECT s.shift_no, s.closed_at, c.name AS closed_by, s.expected_cash, s.counted_cash, GREATEST(0, -s.difference) AS shortage, GREATEST(0, s.difference) AS overage, s.close_note
       FROM shifts s LEFT JOIN employees c ON c.id = s.closed_by WHERE s.status = 'CLOSED' AND ${BKK('s.closed_at')}::date BETWEEN $1 AND $2 ORDER BY s.id`,
    totals: ['shortage', 'overage'],
  },
  voids: {
    title: 'รายงานยกเลิก',
    columns: [['order_no', 'บิล'], ['voided_at', 'วันเวลา', 'datetime'], ['amount', 'ยอด', money], ['reason', 'เหตุผล'], ['employee', 'ผู้ยกเลิก'], ['kind', 'ประเภท']],
    sql: () => `SELECT o.order_no, o.voided_at, o.grand_total AS amount, o.void_reason AS reason, e.name AS employee, 'บิล' AS kind FROM orders o LEFT JOIN employees e ON e.id = o.voided_by
       WHERE o.status = 'VOID' AND ${BKK('o.voided_at')}::date BETWEEN $1 AND $2
       UNION ALL
       SELECT o.order_no, oi.voided_at, oi.qty * oi.unit_price, oi.name || ': ' || COALESCE(oi.void_reason,''), e.name, 'รายการสินค้า' FROM order_items oi JOIN orders o ON o.id = oi.order_id LEFT JOIN employees e ON e.id = oi.voided_by
       WHERE oi.voided_at IS NOT NULL AND ${BKK('oi.voided_at')}::date BETWEEN $1 AND $2
       UNION ALL
       SELECT rs.session_no, rs.ended_at, 0, 'ยกเลิกห้อง: ' || COALESCE(rs.cancel_reason,''), NULL, 'ห้อง' FROM room_sessions rs WHERE rs.status = 'CANCELLED' AND ${BKK('rs.ended_at')}::date BETWEEN $1 AND $2
       ORDER BY 2`,
    totals: ['amount'],
  },
  refunds: {
    title: 'รายงานคืนเงิน',
    columns: [['refund_no', 'เลขที่'], ['order_no', 'บิล'], ['created_at', 'วันเวลา', 'datetime'], ['amount', 'จำนวน', money], ['method', 'ช่องทาง'], ['reason', 'เหตุผล'], ['status', 'สถานะ'], ['requested_by', 'ผู้ขอ'], ['approved_by', 'ผู้อนุมัติ'], ['points_reversed', 'คะแนนที่ย้อน']],
    sql: () => `SELECT rf.refund_no, o.order_no, rf.created_at, rf.amount, rf.method, rf.reason, rf.status, e.name AS requested_by, a.name AS approved_by, rf.points_reversed
       FROM refunds rf JOIN orders o ON o.id = rf.order_id LEFT JOIN employees e ON e.id = rf.requested_by LEFT JOIN employees a ON a.id = rf.approved_by WHERE ${BKK('rf.created_at')}::date BETWEEN $1 AND $2 ORDER BY rf.id`,
    totals: ['amount'],
  },
  stock: {
    title: 'รายงานสต็อก',
    columns: [['sku', 'รหัส'], ['name', 'สินค้า'], ['category', 'หมวด'], ['quantity', 'คงเหลือ'], ['min_stock', 'ขั้นต่ำ'], ['in_qty', 'รับเข้า'], ['out_qty', 'ออก/ขาย'], ['value', 'มูลค่าคงเหลือ', money, 'cost']],
    sql: () => `SELECT p.sku, p.name, c.name AS category, COALESCE(sb.quantity,0) AS quantity, p.min_stock,
       (SELECT COALESCE(SUM(quantity),0) FROM stock_movements sm WHERE sm.product_id = p.id AND sm.quantity > 0 AND ${BKK('sm.created_at')}::date BETWEEN $1 AND $2) AS in_qty,
       (SELECT COALESCE(-SUM(quantity),0) FROM stock_movements sm WHERE sm.product_id = p.id AND sm.quantity < 0 AND ${BKK('sm.created_at')}::date BETWEEN $1 AND $2) AS out_qty,
       COALESCE(sb.quantity,0) * p.cost AS value
       FROM products p LEFT JOIN stock_balances sb ON sb.product_id = p.id LEFT JOIN categories c ON c.id = p.category_id WHERE p.deleted_at IS NULL AND p.track_stock ORDER BY p.name`,
    totals: ['in_qty', 'out_qty', 'value'],
  },
  'top-products': {
    title: 'รายงานสินค้าขายดี',
    columns: [['rank', 'อันดับ'], ['name', 'สินค้า'], ['qty', 'จำนวน'], ['amount', 'ยอดขาย', money]],
    sql: (w) => `SELECT ROW_NUMBER() OVER (ORDER BY SUM(oi.qty) DESC) AS rank, oi.name, SUM(oi.qty) AS qty, SUM(oi.qty * oi.unit_price) AS amount
       FROM order_items oi JOIN orders o ON o.id = oi.order_id LEFT JOIN room_sessions rs ON rs.id = o.session_id WHERE ${w} AND oi.item_type = 'PRODUCT' AND oi.voided_at IS NULL GROUP BY oi.name ORDER BY qty DESC LIMIT 50`,
  },
  'top-rooms': {
    title: 'รายงานห้องยอดนิยม',
    columns: [['rank', 'อันดับ'], ['room_name', 'ห้อง'], ['sessions', 'จำนวนครั้ง'], ['hours', 'ชั่วโมง'], ['amount', 'รายได้', money]],
    sql: (w) => `SELECT ROW_NUMBER() OVER (ORDER BY COUNT(*) DESC) AS rank, rm.name AS room_name, COUNT(*) AS sessions, ROUND(SUM(o.billed_minutes)/60.0,2) AS hours, SUM(o.grand_total) AS amount
       FROM orders o JOIN room_sessions rs ON rs.id = o.session_id JOIN rooms rm ON rm.id = rs.room_id WHERE ${w} GROUP BY rm.name ORDER BY sessions DESC`,
  },
  'peak-hours': {
    title: 'รายงานช่วงเวลายอดนิยม',
    columns: [['hour', 'ช่วงเวลา'], ['sessions', 'จำนวนห้องที่เปิด'], ['guests', 'จำนวนลูกค้า'], ['amount', 'ยอดขาย', money]],
    sql: (w) => `SELECT lpad(extract(hour FROM ${BKK('rs.started_at')})::text, 2, '0') || ':00' AS hour, COUNT(*) AS sessions, SUM(rs.guest_count) AS guests, SUM(o.grand_total) AS amount
       FROM orders o JOIN room_sessions rs ON rs.id = o.session_id WHERE ${w} GROUP BY 1 ORDER BY 1`,
    totals: ['sessions', 'guests', 'amount'],
  },
};

export const REPORT_LIST = Object.entries(REPORTS).map(([key, v]) => ({ key, title: v.title }));

async function runReport(type, q, req) {
  const def = REPORTS[type];
  if (!def) throw badRequest('ไม่พบประเภทรายงาน');
  const { from, to } = range(q);
  const params = [from, to];
  const conds = [PAID, `${BKK('o.paid_at')}::date BETWEEN $1 AND $2`];
  if (q.employeeId) {
    params.push(Number(q.employeeId));
    conds.push(`o.paid_by = $${params.length}`);
  }
  if (q.roomId) {
    params.push(Number(q.roomId));
    conds.push(`rs.room_id = $${params.length}`);
  }
  if (q.roomTypeId) {
    params.push(Number(q.roomTypeId));
    conds.push(`rs.room_type_id = $${params.length}`);
  }
  if (q.timeFrom && q.timeTo) {
    params.push(q.timeFrom, q.timeTo);
    conds.push(`${BKK('o.paid_at')}::time BETWEEN $${params.length - 1}::time AND $${params.length}::time`);
  }
  const sql = def.sql(conds.join(' AND '));
  const usedParams = sql.includes('$3') || sql.includes('$4') || sql.includes('$5') ? params : params.slice(0, 2);
  const rows = (await pool.query(sql, usedParams.length && sql.includes('$1') ? usedParams : [])).rows;
  const showCost = hasPerm(req, 'cost.view');
  const columns = def.columns.filter((c) => c[3] !== 'cost' || showCost).map(([key, label, type]) => ({ key, label, type: type || 'text' }));
  const totals = {};
  for (const k of def.totals || []) if (columns.find((c) => c.key === k)) totals[k] = Math.round(rows.reduce((s, x) => s + Number(x[k] || 0), 0) * 100) / 100;
  return { type, title: def.title, from, to, columns, rows, totals };
}

r.get('/reports', can('reports.view'), (_req, res) => res.json(REPORT_LIST));

r.get('/reports/:type', can('reports.view'), async (req, res) => {
  const rep = await runReport(req.params.type, req.query, req);
  const fmt = req.query.format;
  if (fmt === 'csv') {
    const esc = (v) => {
      if (v == null) return '';
      const s = v instanceof Date ? v.toISOString() : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [rep.columns.map((c) => esc(c.label)).join(',')];
    for (const row of rep.rows) lines.push(rep.columns.map((c) => esc(row[c.key])).join(','));
    if (Object.keys(rep.totals).length) lines.push(rep.columns.map((c, i) => (i === 0 ? 'รวม' : esc(rep.totals[c.key] ?? ''))).join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.type}-${rep.from}-${rep.to}.csv"`);
    return res.send('﻿' + lines.join('\n'));
  }
  if (fmt === 'xlsx') {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(rep.title.slice(0, 30));
    ws.addRow([rep.title]).font = { bold: true, size: 14 };
    ws.addRow([`ช่วงวันที่ ${rep.from} ถึง ${rep.to}`]);
    ws.addRow([]);
    const header = ws.addRow(rep.columns.map((c) => c.label));
    header.font = { bold: true };
    header.eachCell((cell) => (cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDE9FE' } }));
    for (const row of rep.rows) {
      ws.addRow(rep.columns.map((c) => (c.type === 'money' ? Number(row[c.key] || 0) : row[c.key] instanceof Date ? row[c.key] : row[c.key] ?? '')));
    }
    if (Object.keys(rep.totals).length) ws.addRow(rep.columns.map((c, i) => (i === 0 ? 'รวม' : rep.totals[c.key] ?? ''))).font = { bold: true };
    rep.columns.forEach((c, i) => {
      const col = ws.getColumn(i + 1);
      col.width = Math.max(12, c.label.length + 6);
      if (c.type === 'money') col.numFmt = '#,##0.00';
      if (c.type === 'datetime') col.numFmt = 'dd/mm/yyyy hh:mm';
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.type}-${rep.from}-${rep.to}.xlsx"`);
    await wb.xlsx.write(res);
    return res.end();
  }
  res.json(rep);
});

export default r;

// Initial data for a fresh database (only runs when there is no store yet).
import { pool, tx } from './index.js';
import { migrate } from './migrate.js';
import { hashPin, pinLookup } from '../lib/auth.js';
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, ROLES } from '@beatbox/shared/constants.js';
import { halfHourPrice } from '@beatbox/shared/roomPricing.js';

const img = (id) => `https://images.unsplash.com/${id}?auto=format&fit=crop&w=800&q=70`;

export async function seedIfEmpty({ demo = process.env.SEED_DEMO !== 'false' } = {}) {
  const has = await pool.query('SELECT 1 FROM stores LIMIT 1');
  // permissions are always synced (new permissions added in updates)
  for (const p of PERMISSIONS) {
    await pool.query('INSERT INTO permissions(code, name, group_name) VALUES ($1,$2,$3) ON CONFLICT (code) DO UPDATE SET name = $2, group_name = $3', [p.code, p.name, p.group]);
  }
  if (has.rows[0]) return false;
  await tx(async (c) => {
    const store = (
      await c.query(
        `INSERT INTO stores(name, logo_url, address, phone, tax_id, slogan) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        ['BEATBOX Karaoke', '', '99/9 ถนนสุขุมวิท แขวงคลองตันเหนือ เขตวัฒนา กรุงเทพฯ 10110', '02-123-4567', '0105566012345', 'ร้องให้สุด หยุดที่ BEATBOX'],
      )
    ).rows[0];
    const branch = (await c.query(`INSERT INTO branches(store_id, code, name, address, phone, open_time, close_time) VALUES ($1,'HQ','สาขาสุขุมวิท',$2,'02-123-4567','12:00','02:00') RETURNING id`, [store.id, '99/9 ถนนสุขุมวิท กรุงเทพฯ'])).rows[0];

    const roleIds = {};
    for (const [code, name] of Object.entries(ROLES)) {
      const r = (await c.query('INSERT INTO roles(code, name) VALUES ($1,$2) RETURNING id', [code, name])).rows[0];
      roleIds[code] = r.id;
      for (const p of DEFAULT_ROLE_PERMISSIONS[code]) await c.query('INSERT INTO role_permissions(role_id, permission_code) VALUES ($1,$2)', [r.id, p]);
    }
    const adminPin = process.env.ADMIN_PIN || '1234';
    const emps = [['ผู้ดูแลระบบ', adminPin, 'ADMIN', 'เจ้าของร้าน', 100]];
    if (demo) emps.push(['สมชาย ผู้จัดการ', '2222', 'MANAGER', 'ผู้จัดการร้าน', 50], ['มานี แคชเชียร์', '3333', 'CASHIER', 'แคชเชียร์', 10], ['ปิติ พนักงาน', '4444', 'STAFF', 'พนักงานบริการ', 0]);
    for (const [name, pin, role, position, limit] of emps) {
      await c.query(`INSERT INTO employees(name, pin_hash, pin_lookup, role_id, position, discount_limit_percent) VALUES ($1,$2,$3,$4,$5,$6)`, [name, await hashPin(pin), pinLookup(pin), roleIds[role], position, limit]);
    }

    const tiers = [
      ['MEMBER', 'Member', '#9ca3af', 0, null, null, 1, 0, 0],
      ['SILVER', 'Silver', '#94a3b8', 1, null, 5000, 1.2, 0, 0],
      ['GOLD', 'Gold', '#eab308', 2, null, 15000, 1.5, 5, 0],
      ['PLATINUM', 'Platinum', '#a78bfa', 3, null, 40000, 2, 10, 5],
      ['VIP', 'VIP', '#ec4899', 4, null, 100000, 3, 15, 10],
    ];
    for (const [code, name, color, sort, pts, spend, mult, rd, pd] of tiers) {
      await c.query(
        `INSERT INTO member_tiers(code, name, color, sort_order, min_points, min_spending, point_multiplier, room_discount_percent, product_discount_percent, benefits) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [code, name, color, sort, pts, spend, mult, rd, pd, { birthdayReward: sort >= 2, priorityBooking: sort >= 3 }],
      );
    }
    await c.query(`INSERT INTO printers(name, connection, station, is_default) VALUES ('เครื่องพิมพ์ใบเสร็จหลัก (Browser/USB)','BROWSER','MAIN',true)`);
    if (!demo) return;

    const types = [
      ['STD', 'Standard', 6, 299, 300, '#22c55e', ['จอ 55 นิ้ว', 'ไมค์ไร้สาย 2 ตัว', 'แอร์'], img('photo-1516280440614-37939bbacd81')],
      ['DLX', 'Deluxe', 10, 399, 500, '#3b82f6', ['จอ 65 นิ้ว', 'ไมค์ไร้สาย 4 ตัว', 'ไฟดิสโก้', 'โซฟาใหญ่'], img('photo-1493225457124-a3eb161ffa5f')],
      ['VIP', 'VIP', 15, 599, 800, '#a855f7', ['จอ 85 นิ้ว', 'เครื่องเสียง Hi-End', 'ห้องน้ำในตัว', 'ไฟ LED'], img('photo-1514525253161-7a46d19cd819')],
      ['PARTY', 'Party Room', 25, 899, 1500, '#ec4899', ['เวทีเล็ก', 'จอโปรเจกเตอร์', 'ไมค์ 6 ตัว', 'ระบบไฟปาร์ตี้'], img('photo-1470225620780-dba8ba36b745')],
    ];
    const typeIds = {};
    for (const [i, [code, name, cap, price, dep, color, amen, image]] of types.entries()) {
      const r = (
        await c.query(
          `INSERT INTO room_types(code, name, capacity, price_hour, price_half, default_deposit, color, amenities, image_url, description, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
          [code, name, cap, price, halfHourPrice(price), dep, color, amen, image, `ห้อง ${name} รองรับ ${cap} ท่าน`, i],
        )
      ).rows[0];
      typeIds[code] = { id: r.id, cap, price, dep, image };
    }
    const rooms = [['STD', 4], ['DLX', 3], ['VIP', 2], ['PARTY', 1]];
    let n = 1;
    for (const [code, count] of rooms) {
      for (let i = 0; i < count; i++) {
        const t = typeIds[code];
        const num = String(n).padStart(2, '0');
        await c.query(
          `INSERT INTO rooms(branch_id, room_type_id, name, number, image_url, zone, capacity, price_hour, price_half, deposit, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [branch.id, t.id, `BEATBOX ${num}`, num, t.image, n <= 5 ? 'ชั้น 1' : 'ชั้น 2', t.cap, t.price, halfHourPrice(t.price), t.dep, n],
        );
        n++;
      }
    }
    const pk = [
      ['30 นาที', [], 0, 30, null],
      ['1 ชั่วโมง', [], 1, 0, null],
      ['1 ชั่วโมง 30 นาที', [], 1, 30, null],
      ['2 ชั่วโมง', [], 2, 0, null],
      ['3 ชั่วโมง (ประหยัด)', [typeIds.STD.id, typeIds.DLX.id], 3, 0, 990],
      ['เหมาทั้งคืน', [typeIds.VIP.id, typeIds.PARTY.id], 6, 0, 2990],
      ['แพ็กเกจวันเกิด', [typeIds.DLX.id, typeIds.VIP.id], 3, 0, 1590],
    ];
    for (const [i, [name, ids, h, m, price]] of pk.entries()) {
      const p = price ?? Math.ceil(typeIds.STD.price * h + (m ? halfHourPrice(typeIds.STD.price) : 0));
      await c.query(
        `INSERT INTO room_packages(name, room_type_ids, hours, minutes, price, image_url, description, sort_order, available_from, available_to, included_guests) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [name, ids, h, m, p, img('photo-1501386761578-eac5c94b800a'), `แพ็กเกจ ${name}`, i, name === 'เหมาทั้งคืน' ? '20:00' : null, name === 'เหมาทั้งคืน' ? '02:00' : null, name === 'แพ็กเกจวันเกิด' ? 10 : null],
      );
    }
    const cats = [
      ['น้ำอัดลม', '#ef4444', 'BAR'], ['เครื่องดื่ม', '#3b82f6', 'BAR'], ['เครื่องดื่มแอลกอฮอล์', '#f59e0b', 'BAR'],
      ['อาหารทานเล่น', '#f97316', 'KITCHEN'], ['อาหารจานหลัก', '#22c55e', 'KITCHEN'], ['ของหวาน', '#ec4899', 'KITCHEN'], ['ค่าบริการ', '#6b7280', 'NONE'],
    ];
    const catIds = {};
    for (const [i, [name, color, station]] of cats.entries()) catIds[name] = (await c.query('INSERT INTO categories(name, color, station, sort_order) VALUES ($1,$2,$3,$4) RETURNING id', [name, color, station, i])).rows[0].id;
    const products = [
      ['P001', '8850999220000', 'โค้ก', 'น้ำอัดลม', 35, 15, 'กระป๋อง', img('photo-1554866585-cd94860890b7')],
      ['P002', '8850999220017', 'สไปรท์', 'น้ำอัดลม', 35, 15, 'กระป๋อง', img('photo-1625772299848-391b6a87d7b3')],
      ['P003', '8851952350116', 'น้ำเปล่า', 'เครื่องดื่ม', 20, 6, 'ขวด', img('photo-1548839140-29a749e1cf4d')],
      ['P004', null, 'ชาเย็น', 'เครื่องดื่ม', 55, 15, 'แก้ว', img('photo-1556679343-c7306c1976bc')],
      ['P005', '8851993616035', 'เบียร์ช้าง', 'เครื่องดื่มแอลกอฮอล์', 90, 45, 'ขวด', img('photo-1608270586620-248524c67de9')],
      ['P006', null, 'ชุดเบียร์ 5 ขวด + ถังน้ำแข็ง', 'เครื่องดื่มแอลกอฮอล์', 420, 225, 'ชุด', img('photo-1535958636474-b021ee887b13')],
      ['P007', null, 'เฟรนช์ฟรายส์', 'อาหารทานเล่น', 89, 25, 'จาน', img('photo-1573080496219-bb080dd4f877')],
      ['P008', null, 'ไก่ทอด', 'อาหารทานเล่น', 149, 50, 'จาน', img('photo-1626645738196-c2a7c87a8f58')],
      ['P009', null, 'ข้าวผัดกุ้ง', 'อาหารจานหลัก', 129, 45, 'จาน', img('photo-1603133872878-684f208fb84b')],
      ['P010', null, 'บิงซูสตรอว์เบอร์รี', 'ของหวาน', 159, 50, 'ถ้วย', img('photo-1563805042-7684c019e1cb')],
      ['S001', null, 'ค่าเปิดขวด', 'ค่าบริการ', 100, 0, 'ครั้ง', ''],
    ];
    for (const [i, [sku, barcode, name, cat, price, cost, unit, image]] of products.entries()) {
      const track = cat !== 'ค่าบริการ' && !['ชาเย็น', 'เฟรนช์ฟรายส์', 'ไก่ทอด', 'ข้าวผัดกุ้ง', 'บิงซูสตรอว์เบอร์รี'].includes(name);
      const p = (await c.query(`INSERT INTO products(sku, barcode, name, category_id, price, cost, unit, image_url, track_stock, min_stock, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`, [sku, barcode, name, catIds[cat], price, cost, unit, image || null, track, track ? 10 : 0, i])).rows[0];
      await c.query('INSERT INTO stock_balances(product_id, quantity) VALUES ($1,$2)', [p.id, track ? 48 : 0]);
      if (track) await c.query(`INSERT INTO stock_movements(product_id, type, quantity, balance_after, note) VALUES ($1,'IN',48,48,'ยอดเริ่มต้น')`, [p.id]);
      if (name === 'ชาเย็น') {
        await c.query(`INSERT INTO product_options(product_id, group_name, name, price_delta) VALUES ($1,'ความหวาน','หวานน้อย',0),($1,'ความหวาน','หวานปกติ',0),($1,'เพิ่ม','ไข่มุก',15)`, [p.id]);
      }
    }
    await c.query(
      `INSERT INTO promotions(name, type, value_type, value, code, conditions, description, auto_apply, image_url) VALUES
       ('Happy Hour ลดค่าห้อง 20%', 'HAPPY_HOUR', 'PERCENT', 20, NULL, '{"time_from":"12:00","time_to":"17:00","apply_to":"ROOM","days":[1,2,3,4,5]}', 'จันทร์–ศุกร์ 12:00–17:00 ลดค่าห้อง 20%', false, $1),
       ('Promo Code SING50', 'COUPON', 'AMOUNT', 50, 'SING50', '{"min_spend":500}', 'ใช้โค้ด SING50 ลด 50 บาท เมื่อยอดครบ 500', false, NULL),
       ('ส่วนลดวันเกิด 15%', 'BIRTHDAY', 'PERCENT', 15, NULL, '{}', 'สมาชิกรับส่วนลด 15% ตลอดเดือนเกิด', false, NULL),
       ('ร้อง 3 ชม. ฟรี 1 ชม.', 'FREE_HOURS', 'AMOUNT', 1, NULL, '{"room_type_ids":[]}', 'ใช้ได้เมื่อจองตั้งแต่ 3 ชั่วโมงขึ้นไป', false, NULL)`,
      [img('photo-1429962714451-bb934ecdc4ec')],
    );
    const rewards = [
      ['น้ำอัดลมฟรี', 50, 'FREE_DRINK', 35],
      ['เพิ่มเวลา 30 นาที', 100, 'EXTRA_30', 0],
      ['ส่วนลด 100 บาท', 200, 'DISCOUNT', 100],
      ['ห้องฟรี 1 ชั่วโมง', 300, 'FREE_HOUR', 1],
      ['แพ็กเกจพิเศษ', 500, 'PACKAGE', 500],
    ];
    const coke = (await c.query(`SELECT id FROM products WHERE sku = 'P001'`)).rows[0];
    for (const [name, pts, type, value] of rewards) {
      await c.query(`INSERT INTO rewards(name, points_cost, reward_type, value, product_id, image_url) VALUES ($1,$2,$3,$4,$5,$6)`, [name, pts, type, value, type === 'FREE_DRINK' ? coke.id : null, img('photo-1513151233558-d860c5398176')]);
    }
    const banners = [
      ['Happy Hour ลด 20%', img('photo-1516450360452-9312f5e86fc7')],
      ['ปาร์ตี้วันเกิดสุดมันส์', img('photo-1530103862676-de8c9debad1d')],
      ['สมาชิกสะสมคะแนน แลกห้องฟรี', img('photo-1501612780327-45045538702b')],
    ];
    for (const [i, [title, url]] of banners.entries()) await c.query('INSERT INTO promotion_images(title, image_url, sort_order) VALUES ($1,$2,$3)', [title, url, i]);
  });
  console.log('[seed] initial data created');
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(() => seedIfEmpty())
    .then(() => pool.end())
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

// Promotion evaluation engine (pure). Server re-evaluates every promotion before saving an order.
import { round2 } from './money.js';

function bkkParts(date) {
  const d = new Date(new Date(date).getTime() + 7 * 3600 * 1000);
  return {
    dateStr: d.toISOString().slice(0, 10),
    day: d.getUTCDay(),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    month: d.getUTCMonth() + 1,
    dom: d.getUTCDate(),
  };
}

function toMin(t) {
  if (!t) return null;
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + (m || 0);
}

export function isWithinTime(now, from, to) {
  const f = toMin(from);
  const t = toMin(to);
  if (f == null || t == null) return true;
  const n = bkkParts(now).minutes;
  return f <= t ? n >= f && n < t : n >= f || n < t; // supports ranges across midnight
}

const ROOM_LINE = new Set(['ROOM', 'PACKAGE', 'EXTENSION', 'OVERTIME']);

/**
 * ctx: { lines:[{type, productId, categoryId, qty, net}], subtotal, roomTypeId, member:{id,birthday,tierId}, now, code, priceHour, online }
 */
export function evaluatePromotion(promo, ctx = {}) {
  const c = promo.conditions || {};
  const now = ctx.now ? new Date(ctx.now) : new Date();
  const p = bkkParts(now);
  const no = (reason) => ({ eligible: false, reason, amount: 0, promotion: promo });

  if (promo.is_active === false) return no('ปิดใช้งาน');
  if (promo.start_date && p.dateStr < String(promo.start_date).slice(0, 10)) return no('ยังไม่ถึงวันเริ่มโปรโมชั่น');
  if (promo.end_date && p.dateStr > String(promo.end_date).slice(0, 10)) return no('โปรโมชั่นหมดอายุ');
  if (promo.usage_limit && Number(promo.used_count || 0) >= Number(promo.usage_limit)) return no('สิทธิ์เต็มแล้ว');
  if (promo.code && String(ctx.code || '').trim().toUpperCase() !== String(promo.code).trim().toUpperCase()) return no('ต้องใช้ Promo Code');
  if (Array.isArray(c.days) && c.days.length && !c.days.map(Number).includes(p.day)) return no('ไม่สามารถใช้ในวันนี้');
  if ((c.time_from || c.time_to) && !isWithinTime(now, c.time_from, c.time_to)) return no('อยู่นอกช่วงเวลาโปรโมชั่น');
  if ((c.member_only || ['MEMBER', 'BIRTHDAY'].includes(promo.type)) && !ctx.member) return no('เฉพาะสมาชิก');
  if (Array.isArray(c.tier_ids) && c.tier_ids.length && !c.tier_ids.map(Number).includes(Number(ctx.member?.tierId))) return no('ระดับสมาชิกไม่ตรงเงื่อนไข');
  if (Array.isArray(c.room_type_ids) && c.room_type_ids.length && !c.room_type_ids.map(Number).includes(Number(ctx.roomTypeId))) return no('ใช้ได้เฉพาะ Type ห้องที่กำหนด');
  if (promo.type === 'BIRTHDAY') {
    const b = ctx.member?.birthday ? new Date(ctx.member.birthday) : null;
    if (!b || b.getMonth() + 1 !== p.month) return no('ใช้ได้เฉพาะเดือนเกิด');
  }

  const lines = ctx.lines || [];
  const matches = (l) => {
    if (Array.isArray(c.product_ids) && c.product_ids.length) return c.product_ids.map(Number).includes(Number(l.productId));
    if (Array.isArray(c.category_ids) && c.category_ids.length) return c.category_ids.map(Number).includes(Number(l.categoryId));
    if (promo.type === 'ROOM_TYPE' || promo.type === 'FREE_HOURS' || c.apply_to === 'ROOM') return ROOM_LINE.has(l.type);
    if (c.apply_to === 'PRODUCT') return l.type === 'PRODUCT';
    return true;
  };
  const target = lines.filter(matches);
  const base = round2(target.reduce((s, l) => s + Number(l.net ?? l.qty * l.unitPrice ?? 0), 0));
  const qty = target.reduce((s, l) => s + Number(l.qty || 0), 0);
  const subtotal = Number(ctx.subtotal ?? lines.reduce((s, l) => s + Number(l.net || 0), 0));

  if (c.min_spend && subtotal < Number(c.min_spend)) return no(`ยอดซื้อขั้นต่ำ ${c.min_spend} บาท`);
  if (promo.type === 'MIN_QTY' && qty < Number(c.min_qty || 0)) return no(`ต้องซื้ออย่างน้อย ${c.min_qty} ชิ้น`);

  const byValue = (b) => (promo.value_type === 'PERCENT' ? round2((b * Math.min(Number(promo.value), 100)) / 100) : round2(promo.value));
  let amount = 0;
  switch (promo.type) {
    case 'FREE_HOURS': {
      const hours = Number(promo.value || 0);
      amount = Math.min(base, round2(Number(ctx.priceHour || 0) * hours));
      break;
    }
    case 'FREE_ITEM': {
      const fid = Number(c.free_product_id);
      const line = lines.find((l) => Number(l.productId) === fid);
      if (!line) return no('ยังไม่มีสินค้าที่แถมฟรีในบิล');
      const unit = Number(line.unitPrice ?? line.net / (line.qty || 1));
      amount = round2(unit * Math.min(Number(c.free_qty || 1), Number(line.qty || 1)));
      break;
    }
    default:
      amount = byValue(base);
  }
  if (c.max_discount) amount = Math.min(amount, Number(c.max_discount));
  amount = Math.min(round2(amount), base || subtotal);
  if (amount <= 0) return no('ไม่มีรายการที่เข้าเงื่อนไข');
  return { eligible: true, amount, promotion: promo, name: promo.name };
}

export function evaluatePromotions(promos, ctx) {
  return (promos || []).map((pr) => evaluatePromotion(pr, ctx));
}

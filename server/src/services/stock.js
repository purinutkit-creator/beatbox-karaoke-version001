import { notify } from './notifications.js';

const SIGN = { IN: 1, RETURN: 1, VOID: 1, OUT: -1, DAMAGED: -1, EXPIRED: -1, SALE: -1 };

/**
 * Apply a stock movement atomically. ADJUST = signed delta, COUNT = absolute counted quantity.
 */
export async function moveStock(client, { productId, type, quantity, reference = null, orderId = null, employeeId = null, note = null, unitCost = null }) {
  const p = (await client.query('SELECT id, name, track_stock, min_stock FROM products WHERE id = $1', [productId])).rows[0];
  if (!p || !p.track_stock) return null;
  await client.query('INSERT INTO stock_balances(product_id, quantity) VALUES ($1, 0) ON CONFLICT DO NOTHING', [productId]);
  const bal = (await client.query('SELECT quantity FROM stock_balances WHERE product_id = $1 FOR UPDATE', [productId])).rows[0];
  const before = Number(bal.quantity);
  let delta;
  if (type === 'COUNT') delta = Number(quantity) - before;
  else if (type === 'ADJUST') delta = Number(quantity);
  else delta = (SIGN[type] ?? 1) * Math.abs(Number(quantity));
  const after = Math.round((before + delta) * 100) / 100;
  await client.query('UPDATE stock_balances SET quantity = $2, updated_at = now() WHERE product_id = $1', [productId, after]);
  await client.query(
    `INSERT INTO stock_movements(product_id, type, quantity, balance_after, unit_cost, reference, order_id, employee_id, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [productId, type, delta, after, unitCost, reference, orderId, employeeId, note],
  );
  if (after <= 0) await client.query('UPDATE products SET is_sold_out = true WHERE id = $1', [productId]);
  else if (before <= 0 && after > 0) await client.query('UPDATE products SET is_sold_out = false WHERE id = $1', [productId]);
  if (Number(p.min_stock) > 0 && after <= Number(p.min_stock) && before > Number(p.min_stock)) {
    await notify({ type: 'LOW_STOCK', level: 'warning', title: 'สินค้าใกล้หมด', message: `${p.name} เหลือ ${after} (ขั้นต่ำ ${p.min_stock})`, data: { productId }, dedupeKey: `lowstock:${productId}:${Date.now()}` }, client);
  }
  return { before, after, delta };
}

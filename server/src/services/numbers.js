import crypto from 'node:crypto';
import { nextCounter } from '../db/index.js';
import { renderNumber, periodKey, renderQueue, toBangkok } from '@beatbox/shared/numbering.js';

async function templated(client, name, template, date = new Date()) {
  const seq = await nextCounter(client, name, periodKey(template, date));
  return renderNumber(template, seq, { date });
}

export const nextReceiptNo = (client, settings) => templated(client, 'receipt', settings.receipt.numberFormat || 'RC{YYYY}{MM}{DD}-{SEQ:4}');
export const nextBookingNo = (client) => templated(client, 'booking', 'BK{YYYY}{MM}{DD}{SEQ:3}');
export const nextOrderNo = (client) => templated(client, 'order', 'OD{YY}{MM}{DD}{SEQ:4}');
export const nextSessionNo = (client) => templated(client, 'session', 'RS{YY}{MM}{DD}{SEQ:4}');
export const nextDepositNo = (client) => templated(client, 'deposit', 'DP{YY}{MM}{DD}{SEQ:4}');
export const nextDepositRefundNo = (client) => templated(client, 'deposit_refund', 'DR{YY}{MM}{DD}{SEQ:3}');
export const nextRefundNo = (client) => templated(client, 'refund', 'RF{YY}{MM}{DD}{SEQ:3}');
export const nextPaymentNo = (client) => templated(client, 'payment', 'PM{YY}{MM}{DD}{SEQ:5}');
export const nextShiftNo = (client) => templated(client, 'shift', 'SH{YY}{MM}{DD}{SEQ:2}');

export async function nextMemberCode(client) {
  const seq = await nextCounter(client, 'member', 'ALL');
  return 'M' + String(seq).padStart(6, '0');
}

/** Queue number according to settings: DAILY / SHIFT / NEVER reset; manual "set last number" supported. */
export async function nextQueueNo(client, settings, shiftId) {
  const q = settings.queue || {};
  let period = 'ALL';
  if (q.resetMode === 'DAILY') {
    const d = toBangkok(new Date());
    period = `${d.y}-${d.m}-${d.d}`;
  } else if (q.resetMode === 'SHIFT') period = `shift-${shiftId || 0}`;
  const start = Number(q.start ?? 1);
  const r = await client.query(
    `INSERT INTO counters(name, period, value) VALUES ('queue', $1, $2)
     ON CONFLICT (name, period) DO UPDATE SET value = counters.value + 1, updated_at = now() RETURNING value`,
    [period, start],
  );
  return renderQueue(q, r.rows[0].value);
}

export function randomToken(bytes = 16) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function randomCode(len = 8) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const buf = crypto.randomBytes(len);
  return [...buf].map((b) => alphabet[b % alphabet.length]).join('');
}

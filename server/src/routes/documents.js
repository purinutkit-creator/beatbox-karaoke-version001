// Document designer (layout of every printed document) and printer routing. Plan feature: receipt_settings (/documents).
import { Router } from 'express';
import { tx } from '../db/index.js';
import { requireAuth, can } from '../lib/auth.js';
import { logActivity } from '../lib/activity.js';
import { z, parse } from '../lib/validate.js';
import { emitSync } from '../lib/realtime.js';
import { getSettings, saveSettingsSection } from '../services/settings.js';
import { DOC_TYPES, DEFAULT_LAYOUTS, DOC_ELEMENTS, DEFAULT_ROUTING, SIZE_LIMITS, QR_SIZE_LIMITS } from '@beatbox/shared/documents.js';

const r = Router();
r.use(requireAuth);

const docKeys = DOC_TYPES.map((d) => d.key);
const elementSchema = z.object({
  show: z.boolean().optional(),
  size: z.coerce.number().min(0).max(SIZE_LIMITS.max).optional(),
  bold: z.boolean().optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
  font: z.string().max(80).optional(),
  spaceBefore: z.coerce.number().min(0).max(20).optional(),
  spaceAfter: z.coerce.number().min(0).max(20).optional(),
  text: z.string().max(500).optional(),
  qrSize: z.coerce.number().min(QR_SIZE_LIMITS.min).max(QR_SIZE_LIMITS.max).optional(),
  logoWidth: z.coerce.number().min(10).max(80).optional(),
});
const layoutSchema = z.object({ order: z.array(z.string()).max(30).optional(), elements: z.record(z.string(), elementSchema).optional() });
const routeSchema = z.object({ printerId: z.coerce.number().int().nullable().optional(), copies: z.coerce.number().int().min(1).max(5), cut: z.boolean(), auto: z.boolean() });

r.get('/documents/settings', async (_req, res) => {
  const s = await getSettings();
  res.json({ ...s.documents, types: DOC_TYPES, elements: DOC_ELEMENTS, defaults: DEFAULT_LAYOUTS, defaultRouting: DEFAULT_ROUTING });
});

r.put('/documents/settings', can('settings.manage'), async (req, res) => {
  const b = parse(
    z.object({
      layouts: z.record(z.string(), layoutSchema).optional(),
      routing: z.record(z.string(), routeSchema).optional(),
      autoPrintReceipt: z.boolean().optional(),
      kitchenAuto: z.boolean().optional(),
      kitchenBatchSeconds: z.coerce.number().int().min(0).max(120).optional(),
    }),
    req.body,
  );
  const cur = (await getSettings()).documents;
  const layouts = { ...cur.layouts };
  for (const [doc, l] of Object.entries(b.layouts || {})) {
    if (!docKeys.includes(doc)) continue;
    const allowed = Object.keys(DEFAULT_LAYOUTS[doc] || {});
    layouts[doc] = {
      order: (l.order || []).filter((k) => allowed.includes(k)),
      elements: Object.fromEntries(Object.entries(l.elements || {}).filter(([k]) => allowed.includes(k))),
    };
  }
  const routing = { ...cur.routing };
  for (const [doc, v] of Object.entries(b.routing || {})) if (docKeys.includes(doc)) routing[doc] = v;
  const value = { ...cur, layouts, routing, autoPrintReceipt: b.autoPrintReceipt ?? cur.autoPrintReceipt, kitchenAuto: b.kitchenAuto ?? cur.kitchenAuto ?? true, kitchenBatchSeconds: b.kitchenBatchSeconds ?? cur.kitchenBatchSeconds ?? 5 };
  await tx(async (c) => {
    await saveSettingsSection(c, 'documents', value, req.employee.id);
    await logActivity(c, req, 'DOCUMENTS_UPDATE', 'settings', 'documents', { docs: Object.keys(b.layouts || {}), routing: Object.keys(b.routing || {}) });
  });
  emitSync('settings');
  res.json(value);
});

export default r;

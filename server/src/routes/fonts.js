// Custom font import (upload a font file or register a font/CSS URL). Fonts are public assets served from /uploads/fonts
// (uploaded files are stored in the database, see services/files.js).
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { tx } from '../db/index.js';
import { requireAuth, can } from '../lib/auth.js';
import { logActivity } from '../lib/activity.js';
import { z, parse } from '../lib/validate.js';
import { badRequest } from '../lib/errors.js';
import { config } from '../config.js';
import { getSettings, saveSettingsSection } from '../services/settings.js';
import { emitSync } from '../lib/realtime.js';
import { saveFile, deleteFile, getFile } from '../services/files.js';

/** Public font file handler, mounted at /uploads/fonts (fonts are public assets, used by every site and receipt). */
export async function serveFont(req, res, next) {
  const f = await getFile(path.basename(req.params.name, path.extname(req.params.name))).catch(() => null);
  if (!f || f.kind !== 'FONT') return next(); // fall back to legacy on-disk fonts
  res.set({ 'Content-Type': f.mime, 'Cache-Control': 'public, max-age=31536000, immutable', 'Access-Control-Allow-Origin': '*' });
  res.send(f.data);
}

const r = Router();
r.use(requireAuth);

const FORMATS = { '.woff2': 'woff2', '.woff': 'woff', '.ttf': 'truetype', '.otf': 'opentype' };
const fontDir = path.join(config.uploadDir, 'fonts');

const MIME = { '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf' };

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, f, cb) => (FORMATS[path.extname(f.originalname).toLowerCase()] ? cb(null, true) : cb(Object.assign(new Error('รองรับเฉพาะไฟล์ .woff2 .woff .ttf .otf'), { status: 400 }))),
});

async function addFont(req, font) {
  const settings = await getSettings();
  const list = (settings.appearance.customFonts || []).filter((f) => !(f.family === font.family && f.weight === font.weight && f.style === font.style));
  list.push(font);
  await tx(async (c) => {
    await saveSettingsSection(c, 'appearance', { ...settings.appearance, customFonts: list }, req.employee.id);
    await logActivity(c, req, 'FONT_IMPORT', 'font', font.family, font);
  });
  emitSync('settings');
  return list;
}

r.post('/fonts/upload', can('settings.manage'), (req, res, next) => upload.single('file')(req, res, (e) => (e ? res.status(400).json({ error: e.message }) : next())), async (req, res) => {
  if (!req.file) throw badRequest('กรุณาเลือกไฟล์ฟอนต์');
  const b = parse(z.object({ family: z.string().trim().min(1).max(80), weight: z.string().default('400'), style: z.enum(['normal', 'italic']).default('normal') }), req.body);
  const ext = path.extname(req.file.originalname).toLowerCase();
  const file = await saveFile(null, { kind: 'FONT', name: req.file.originalname, mime: MIME[ext], buffer: req.file.buffer });
  const font = { id: crypto.randomUUID(), fileId: file.id, family: b.family, url: `/uploads/fonts/${file.id}${ext}`, format: FORMATS[ext], weight: b.weight, style: b.style, source: 'UPLOAD' };
  res.json(await addFont(req, font));
});

/** Register a font by URL: either a font file (.woff2/.ttf…) or a stylesheet (e.g. a CSS from a font CDN). */
r.post('/fonts/url', can('settings.manage'), async (req, res) => {
  const b = parse(z.object({ family: z.string().trim().min(1).max(80), url: z.string().url(), weight: z.string().default('400'), style: z.enum(['normal', 'italic']).default('normal') }), req.body);
  const ext = path.extname(new URL(b.url).pathname).toLowerCase();
  const font = { id: crypto.randomUUID(), family: b.family, url: b.url, format: FORMATS[ext] || 'css', weight: b.weight, style: b.style, source: 'URL' };
  res.json(await addFont(req, font));
});

r.delete('/fonts/:id', can('settings.manage'), async (req, res) => {
  const settings = await getSettings();
  const font = (settings.appearance.customFonts || []).find((f) => f.id === req.params.id);
  const list = (settings.appearance.customFonts || []).filter((f) => f.id !== req.params.id);
  await tx(async (c) => {
    await saveSettingsSection(c, 'appearance', { ...settings.appearance, customFonts: list }, req.employee.id);
    await logActivity(c, req, 'FONT_DELETE', 'font', font?.family, font || {});
  });
  if (font?.fileId) await deleteFile(font.fileId);
  else if (font?.source === 'UPLOAD') fs.rmSync(path.join(fontDir, path.basename(font.url)), { force: true });
  emitSync('settings');
  res.json(list);
});

export default r;

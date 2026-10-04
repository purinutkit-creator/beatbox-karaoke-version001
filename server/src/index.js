import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { seedIfEmpty } from './db/seed.js';
import { errorHandler } from './lib/errors.js';
import { initRealtime } from './lib/realtime.js';
import { startScheduler } from './services/scheduler.js';
import { pool } from './db/index.js';

import authRoutes from './routes/auth.js';
import settingsRoutes from './routes/settings.js';
import employeeRoutes from './routes/employees.js';
import shiftRoutes from './routes/shifts.js';
import catalogRoutes from './routes/catalog.js';
import sessionRoutes from './routes/sessions.js';
import orderRoutes from './routes/orders.js';
import reservationRoutes from './routes/reservations.js';
import memberRoutes from './routes/members.js';
import printerRoutes from './routes/printers.js';
import notificationRoutes from './routes/notifications.js';
import reportRoutes from './routes/reports.js';
import publicRoutes from './routes/public.js';
import fontRoutes from './routes/fonts.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({ origin: config.corsOrigins.length ? config.corsOrigins : true, credentials: true }));
  app.use(compression());
  app.use(express.json({ limit: '2mb' }));

  // rate limiting
  app.use('/api/', rateLimit({ windowMs: 60000, limit: 600, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'มีการเรียกใช้งานถี่เกินไป กรุณาลองใหม่ภายหลัง' } }));
  app.use('/api/auth/login', rateLimit({ windowMs: 5 * 60000, limit: 20, message: { error: 'พยายามเข้าสู่ระบบบ่อยเกินไป กรุณารอ 5 นาที' } }));
  app.use('/api/public/auth', rateLimit({ windowMs: 10 * 60000, limit: 30, message: { error: 'มีการขอรหัสบ่อยเกินไป กรุณาลองใหม่ภายหลัง' } }));
  app.use('/api/public/holds', rateLimit({ windowMs: 60000, limit: 20, message: { error: 'มีการจองถี่เกินไป กรุณาลองใหม่ภายหลัง' } }));

  app.get('/api/health', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true, env: config.appEnv, time: new Date().toISOString() });
  });
  app.get('/api/time', (_req, res) => res.json({ now: Date.now(), iso: new Date().toISOString() }));

  app.use('/api/public', publicRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api', settingsRoutes);
  app.use('/api', employeeRoutes);
  app.use('/api', shiftRoutes);
  app.use('/api', catalogRoutes);
  app.use('/api', sessionRoutes);
  app.use('/api', orderRoutes);
  app.use('/api', reservationRoutes);
  app.use('/api', memberRoutes);
  app.use('/api', printerRoutes);
  app.use('/api', notificationRoutes);
  app.use('/api', reportRoutes);
  app.use('/api', fontRoutes);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'ไม่พบ API' }));

  // Only fonts are public uploads — payment slips stay private (served through an authenticated endpoint)
  app.use('/uploads/fonts', express.static(path.join(config.uploadDir, 'fonts'), { maxAge: '30d', setHeaders: (res) => res.setHeader('Access-Control-Allow-Origin', '*') }));

  // Frontend (POS, Customer Display, Booking website) — single build
  if (fs.existsSync(config.webDist)) {
    app.use(express.static(config.webDist, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api|socket\.io).*/, (_req, res) => res.sendFile(path.join(config.webDist, 'index.html')));
  }
  app.use(errorHandler);
  return app;
}

export async function start() {
  await migrate();
  await seedIfEmpty();
  const app = createApp();
  const server = http.createServer(app);
  initRealtime(server, config.corsOrigins);
  startScheduler();
  server.listen(config.port, () => console.log(`[server] BEATBOX POS running on :${config.port} (${config.appEnv}, payment=${config.paymentMode})`));
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

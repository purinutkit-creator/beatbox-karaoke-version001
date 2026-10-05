import 'dotenv/config';
import crypto from 'node:crypto';

const env = process.env;
const appEnv = env.APP_ENV || (env.NODE_ENV === 'production' ? 'production' : 'development');

function secret(name, fallbackLabel) {
  if (env[name]) return env[name];
  if (appEnv === 'production') throw new Error(`Missing required secret ${name}`);
  // deterministic dev secret so tokens survive restarts in development
  return crypto.createHash('sha256').update(`beatbox-dev-${fallbackLabel}`).digest('hex');
}

// RENDER_EXTERNAL_URL is set automatically on Render
const publicUrl = (env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${env.PORT || 4000}`).replace(/\/$/, '');

export const config = {
  appEnv,
  isProd: appEnv === 'production',
  port: Number(env.PORT || 4000),
  databaseUrl: env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/beatbox',
  publicUrl,
  corsOrigins: (env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  jwtSecret: secret('JWT_SECRET', 'jwt'),
  pinPepper: secret('PIN_PEPPER', 'pin'),
  uploadDir: env.UPLOAD_DIR || new URL('../uploads', import.meta.url).pathname,
  backupDir: env.BACKUP_DIR || new URL('../backups', import.meta.url).pathname,
  // payments
  paymentMode: env.PAYMENT_MODE || 'DEMO', // DEMO | PRODUCTION
  slipProvider: env.SLIP_PROVIDER || 'demo', // demo | slipok | easyslip | manual
  slipApiUrl: env.SLIP_API_URL || '',
  slipApiKey: env.SLIP_API_KEY || '',
  slipBranchId: env.SLIP_BRANCH_ID || '',
  // LINE
  lineLoginChannelId: env.LINE_LOGIN_CHANNEL_ID || '',
  lineLoginChannelSecret: env.LINE_LOGIN_CHANNEL_SECRET || '',
  lineLoginCallbackUrl: env.LINE_LOGIN_CALLBACK_URL || `${publicUrl}/api/public/auth/line/callback`,
  lineMessagingToken: env.LINE_MESSAGING_ACCESS_TOKEN || '',
  // SMS (OTP) — when not configured OTP is returned in dev/demo responses only
  smsProvider: env.SMS_PROVIDER || '',
  smsApiKey: env.SMS_API_KEY || '',
  smsSender: env.SMS_SENDER || 'BEATBOX',
  otpDebug: env.OTP_DEBUG ? env.OTP_DEBUG === 'true' : appEnv !== 'production',
  webDist: env.WEB_DIST || new URL('../../web/dist', import.meta.url).pathname,
};

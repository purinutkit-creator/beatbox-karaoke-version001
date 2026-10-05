// LINE Login (OAuth 2.1 / OpenID) + Messaging API adapters.
// Credentials come from Admin → ตั้งค่าร้าน → การเชื่อมต่อ (encrypted in the DB), falling back to env variables.
import { getIntegrations } from '../services/integrations.js';

async function cfg() {
  return (await getIntegrations()).line;
}

export const lineLogin = {
  async enabled() {
    const c = await cfg();
    return !!(c.loginEnabled !== false && c.loginChannelId && c.loginChannelSecret && c.callbackUrl);
  },
  async authorizeUrl(state, nonce) {
    const c = await cfg();
    const p = new URLSearchParams({ response_type: 'code', client_id: c.loginChannelId, redirect_uri: c.callbackUrl, state, scope: 'profile openid', nonce, bot_prompt: 'aggressive' });
    return `https://access.line.me/oauth2/v2.1/authorize?${p}`;
  },
  async exchangeCode(code) {
    const c = await cfg();
    const r = await fetch('https://api.line.me/oauth2/v2.1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: c.callbackUrl, client_id: c.loginChannelId, client_secret: c.loginChannelSecret }),
    });
    if (!r.ok) throw new Error(`LINE token exchange failed (${r.status})`);
    return r.json();
  },
  async verifyIdToken(idToken, nonce) {
    const c = await cfg();
    const r = await fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token: idToken, client_id: c.loginChannelId, nonce }),
    });
    if (!r.ok) throw new Error('LINE id_token verification failed');
    return r.json(); // { sub, name, picture, ... }
  },
  /** Admin "test" button: checks that the channel ID / secret pair is accepted by LINE. */
  async test() {
    const c = await cfg();
    if (!c.loginChannelId || !c.loginChannelSecret) return { ok: false, message: 'กรุณากรอก Channel ID และ Channel Secret' };
    const r = await fetch('https://api.line.me/v2/oauth/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: c.loginChannelId, client_secret: c.loginChannelSecret }),
    });
    if (r.ok) return { ok: true, message: 'LINE Login: Channel ID / Secret ถูกต้อง' };
    return { ok: false, message: `LINE Login ตอบกลับ ${r.status}: ${(await r.text()).slice(0, 200)}` };
  },
};

export const lineMessaging = {
  async enabled() {
    return !!(await cfg()).messagingAccessToken;
  },
  async push(to, text) {
    const token = (await cfg()).messagingAccessToken;
    if (!token) throw new Error('LINE Messaging API ยังไม่ได้ตั้งค่า Channel Access Token');
    const r = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to, messages: [{ type: 'text', text: String(text).slice(0, 4900) }] }),
    });
    if (!r.ok) throw new Error(`LINE push failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
    return true;
  },
  async test() {
    const token = (await cfg()).messagingAccessToken;
    if (!token) return { ok: false, message: 'กรุณากรอก Channel Access Token' };
    const r = await fetch('https://api.line.me/v2/bot/info', { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return { ok: false, message: `LINE Messaging API ตอบกลับ ${r.status}: ${(await r.text()).slice(0, 200)}` };
    const j = await r.json();
    return { ok: true, message: `เชื่อมต่อ LINE OA สำเร็จ: ${j.displayName || ''} ${j.basicId || ''}`.trim() };
  },
};

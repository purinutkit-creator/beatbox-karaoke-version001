// LINE Login (OAuth 2.1 / OpenID) + Messaging API adapters.
// Credentials come from Admin → ตั้งค่าร้าน → การเชื่อมต่อ (encrypted in the DB), falling back to env variables.
import crypto from 'node:crypto';
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
    if (!r.ok) return { ok: false, message: `LINE Login ตอบกลับ ${r.status}: ${(await r.text()).slice(0, 200)}` };
    // the ID / secret pair is also accepted for a Messaging API channel: open the real login page the way a customer
    // does — LINE answers 400 when the channel is not a LINE Login channel or the callback URL is not registered
    const page = await fetch(await this.authorizeUrl('test', 'test'), { redirect: 'manual' }).catch(() => null);
    if (page && page.status === 400) {
      const body = (await page.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      const why = /redirect_uri/i.test(body) ? `Callback URL ยังไม่ได้ลงทะเบียนใน Channel นี้ — ใส่ ${c.callbackUrl} ที่แท็บ LINE Login → Callback URL` : /client_id/i.test(body) ? `Channel ID ${c.loginChannelId} ไม่ใช่ Channel แบบ LINE Login (อาจเป็น Channel ของ Messaging API)` : body.slice(0, 160);
      return { ok: false, message: `LINE Login หน้าเข้าสู่ระบบตอบ 400: ${why}` };
    }
    if (r.ok) return { ok: true, message: 'LINE Login: Channel ID / Secret และ Callback URL ถูกต้อง' };
    return { ok: false, message: `LINE Login ตอบกลับ ${r.status}: ${(await r.text()).slice(0, 200)}` };
  },
};

export const lineMessaging = {
  async enabled() {
    return !!(await cfg()).messagingAccessToken;
  },
  async push(to, text) {
    return this.send('push', { to, messages: [{ type: 'text', text: String(text).slice(0, 4900) }] });
  },
  /** Push any messages (text, image, Flex) to one LINE user. */
  async pushMessages(to, messages) {
    return this.send('push', { to, messages: messages.slice(0, 5) });
  },
  /** Answer a message the customer just sent (free, but only once and within a minute). */
  async reply(replyToken, messages) {
    return this.send('reply', { replyToken, messages: messages.slice(0, 5) });
  },
  async send(kind, body) {
    const token = (await cfg()).messagingAccessToken;
    if (!token) throw new Error('LINE Messaging API ยังไม่ได้ตั้งค่า Channel Access Token');
    const r = await fetch(`https://api.line.me/v2/bot/message/${kind}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`LINE ${kind} failed (${r.status}): ${(await r.text()).slice(0, 300)}`);
    return true;
  },
  /**
   * Rich menu (the menu under the chat): create it, upload its picture, make it everyone's menu, and drop the one it
   * replaces. Returns the new rich menu id.
   */
  async publishRichMenu({ menu, image, contentType, replaces = null }) {
    const token = (await cfg()).messagingAccessToken;
    if (!token) throw new Error('LINE Messaging API ยังไม่ได้ตั้งค่า Channel Access Token');
    const auth = { Authorization: `Bearer ${token}` };
    const call = async (url, opts, what) => {
      const r = await fetch(url, { ...opts, headers: { ...auth, ...(opts.headers || {}) } });
      if (!r.ok) throw new Error(`LINE ${what} (${r.status}): ${(await r.text()).slice(0, 300)}`);
      return r.json().catch(() => ({}));
    };
    const { richMenuId } = await call('https://api.line.me/v2/bot/richmenu', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(menu) }, 'สร้างริชเมนูไม่สำเร็จ');
    try {
      await call(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, { method: 'POST', headers: { 'Content-Type': contentType }, body: image }, 'อัปโหลดรูปริชเมนูไม่สำเร็จ');
      await call(`https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`, { method: 'POST' }, 'ตั้งเป็นเมนูหลักไม่สำเร็จ');
    } catch (e) {
      await fetch(`https://api.line.me/v2/bot/richmenu/${richMenuId}`, { method: 'DELETE', headers: auth }).catch(() => {});
      throw e;
    }
    if (replaces && replaces !== richMenuId) await fetch(`https://api.line.me/v2/bot/richmenu/${replaces}`, { method: 'DELETE', headers: auth }).catch(() => {});
    return richMenuId;
  },
  async removeRichMenu(id) {
    const token = (await cfg()).messagingAccessToken;
    if (!token || !id) return;
    const auth = { Authorization: `Bearer ${token}` };
    await fetch('https://api.line.me/v2/bot/user/all/richmenu', { method: 'DELETE', headers: auth }).catch(() => {});
    await fetch(`https://api.line.me/v2/bot/richmenu/${id}`, { method: 'DELETE', headers: auth }).catch(() => {});
  },
  /** Name and picture of a LINE user who talks with the OA (null when LINE does not say). */
  async profile(userId) {
    const token = (await cfg()).messagingAccessToken;
    if (!token) return null;
    const r = await fetch(`https://api.line.me/v2/bot/profile/${encodeURIComponent(userId)}`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
    return r?.ok ? r.json() : null;
  },
  /** The webhook really comes from LINE: HMAC-SHA256 of the raw body with the channel secret. */
  async verifySignature(rawBody, signature) {
    const secret = (await cfg()).messagingChannelSecret;
    if (!secret || !rawBody || !signature) return false;
    const mac = crypto.createHmac('sha256', secret).update(rawBody).digest();
    const got = Buffer.from(String(signature), 'base64');
    return got.length === mac.length && crypto.timingSafeEqual(got, mac);
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

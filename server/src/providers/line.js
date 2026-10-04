// LINE Login (OAuth 2.1 / OpenID) + Messaging API adapters. Secrets are only read server-side from env.
import { config } from '../config.js';

export const lineLogin = {
  enabled() {
    return !!(config.lineLoginChannelId && config.lineLoginChannelSecret && config.lineLoginCallbackUrl);
  },
  authorizeUrl(state, nonce) {
    const p = new URLSearchParams({
      response_type: 'code',
      client_id: config.lineLoginChannelId,
      redirect_uri: config.lineLoginCallbackUrl,
      state,
      scope: 'profile openid',
      nonce,
      bot_prompt: 'aggressive',
    });
    return `https://access.line.me/oauth2/v2.1/authorize?${p}`;
  },
  async exchangeCode(code) {
    const r = await fetch('https://api.line.me/oauth2/v2.1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.lineLoginCallbackUrl,
        client_id: config.lineLoginChannelId,
        client_secret: config.lineLoginChannelSecret,
      }),
    });
    if (!r.ok) throw new Error(`LINE token exchange failed (${r.status})`);
    return r.json();
  },
  async verifyIdToken(idToken, nonce) {
    const r = await fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token: idToken, client_id: config.lineLoginChannelId, nonce }),
    });
    if (!r.ok) throw new Error('LINE id_token verification failed');
    return r.json(); // { sub, name, picture, ... }
  },
};

export const lineMessaging = {
  enabled() {
    return !!config.lineMessagingToken;
  },
  async push(to, text) {
    if (!config.lineMessagingToken) throw new Error('LINE Messaging API ยังไม่ได้ตั้งค่า (LINE_MESSAGING_ACCESS_TOKEN)');
    const r = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.lineMessagingToken}` },
      body: JSON.stringify({ to, messages: [{ type: 'text', text: String(text).slice(0, 4900) }] }),
    });
    if (!r.ok) throw new Error(`LINE push failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
    return true;
  },
};

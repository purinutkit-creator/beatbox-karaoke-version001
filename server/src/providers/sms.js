// OTP SMS provider adapter. Without a configured provider the OTP is only exposed when OTP_DEBUG=true (dev / demo).
import { config } from '../config.js';

export async function sendSms(phone, text) {
  if (!config.smsProvider) return { delivered: false, reason: 'SMS provider not configured' };
  if (config.smsProvider === 'thsms') {
    const r = await fetch('https://thsms.com/api/send-sms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.smsApiKey}` },
      body: JSON.stringify({ sender: config.smsSender, msisdn: [phone], message: text }),
    });
    if (!r.ok) throw new Error(`SMS failed (${r.status})`);
    return { delivered: true };
  }
  throw new Error(`Unknown SMS provider ${config.smsProvider}`);
}

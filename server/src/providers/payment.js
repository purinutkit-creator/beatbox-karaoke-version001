// Payment provider abstraction (business logic never talks to a gateway directly).
import { promptPayPayload } from '@beatbox/shared/promptpay.js';

const promptPayStatic = {
  name: 'promptpay',
  async createQr({ amount, reference, settings }) {
    const p = settings.payment;
    const qrData = p.useDynamicPromptPay && p.promptPayId ? promptPayPayload(p.promptPayId, amount) : null;
    return { qrData, qrImageUrl: !qrData ? p.qrImageUrl || null : p.qrImageUrl || null, reference };
  },
};

// Placeholder for a future gateway (e.g. Omise / 2C2P / GB Prime Pay) — implement createQr + webhook verification.
export function getPaymentProvider(name = 'promptpay') {
  return promptPayStatic;
}

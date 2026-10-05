// PromptPay (Thai QR / EMVCo) payload generator — used to create a dynamic QR with amount.
function f(id, value) {
  const v = String(value);
  return id + String(v.length).padStart(2, '0') + v;
}

export function crc16(str) {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
    crc &= 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function formatTarget(id) {
  const digits = String(id || '').replace(/[^0-9]/g, '');
  if (digits.length >= 15) return { tag: '03', value: digits }; // e-wallet
  if (digits.length >= 13) return { tag: '02', value: digits }; // national id / tax id
  // mobile: 0812345678 -> 0066812345678
  const mobile = ('0000000000000' + digits.replace(/^0/, '66')).slice(-13);
  return { tag: '01', value: mobile };
}

export function promptPayPayload(promptPayId, amount) {
  if (!promptPayId) return '';
  const target = formatTarget(promptPayId);
  const amt = Number(amount || 0);
  const parts = [
    f('00', '01'),
    f('01', amt > 0 ? '12' : '11'),
    f('29', f('00', 'A000000677010111') + f(target.tag, target.value)),
    f('53', '764'),
    amt > 0 ? f('54', amt.toFixed(2)) : '',
    f('58', 'TH'),
  ].join('');
  const withCrcTag = parts + '6304';
  return withCrcTag + crc16(withCrcTag);
}

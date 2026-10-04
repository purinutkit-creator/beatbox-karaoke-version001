export class AppError extends Error {
  constructor(status, message, code, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const badRequest = (msg, code = 'BAD_REQUEST', extra) => new AppError(400, msg, code, extra);
export const unauthorized = (msg = 'กรุณาเข้าสู่ระบบ') => new AppError(401, msg, 'UNAUTHORIZED');
export const forbidden = (msg = 'คุณไม่มีสิทธิ์ทำรายการนี้') => new AppError(403, msg, 'FORBIDDEN');
export const notFound = (msg = 'ไม่พบข้อมูล') => new AppError(404, msg, 'NOT_FOUND');
export const conflict = (msg, code = 'CONFLICT', extra) => new AppError(409, msg, code, extra);

export function errorHandler(err, req, res, _next) {
  if (err?.name === 'ZodError' || Array.isArray(err?.issues)) {
    const first = err.issues?.[0];
    return res.status(400).json({ error: `ข้อมูลไม่ถูกต้อง: ${first?.path?.join('.') || ''} ${first?.message || ''}`.trim(), code: 'VALIDATION', issues: err.issues });
  }
  if (err instanceof AppError) return res.status(err.status).json({ error: err.message, code: err.code, ...(err.extra || {}) });
  if (err?.code === '23P01') {
    return res.status(409).json({ error: 'ขออภัย ห้องนี้เพิ่งถูกจอง กรุณาเลือกห้องหรือช่วงเวลาอื่น', code: 'ROOM_TAKEN' });
  }
  if (err?.code === '23505') {
    const c = err.constraint || '';
    let msg = 'ข้อมูลซ้ำกับรายการที่มีอยู่แล้ว';
    if (c.includes('room_sessions_one_active')) msg = 'ห้องนี้ถูกเปิดใช้งานแล้วจากเครื่องอื่น';
    if (c.includes('payment_verifications')) msg = 'พบรายการนี้ถูกใช้แล้ว (สลิปซ้ำ)';
    if (c.includes('pin_lookup')) msg = 'รหัสพนักงานนี้ถูกใช้แล้ว';
    if (c.includes('members_phone')) msg = 'เบอร์โทรศัพท์นี้เป็นสมาชิกอยู่แล้ว';
    if (c.includes('shifts_one_open')) msg = 'เครื่องนี้มีรอบการขายที่เปิดอยู่แล้ว';
    if (c.includes('sku')) msg = 'รหัสสินค้านี้ถูกใช้แล้ว';
    return res.status(409).json({ error: msg, code: 'DUPLICATE', constraint: c });
  }
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'ข้อมูลมีขนาดใหญ่เกินไป' });
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'ไฟล์มีขนาดใหญ่เกินไป' });
  console.error('[error]', req.method, req.originalUrl, err);
  res.status(500).json({ error: 'เกิดข้อผิดพลาดในระบบ กรุณาลองใหม่อีกครั้ง', code: 'INTERNAL' });
}

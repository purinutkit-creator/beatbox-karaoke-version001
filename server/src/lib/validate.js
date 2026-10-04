import { z } from 'zod';
export { z };

export const parse = (schema, data) => schema.parse(data ?? {});

export const zUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => v === '' || /^https?:\/\//i.test(v) || v.startsWith('/'), { message: 'ต้องเป็น URL รูปภาพ (http/https)' })
  .optional()
  .nullable()
  .transform((v) => (v ? v : null));

export const zMoney = z.coerce.number().min(0).max(100000000);
export const zInt = z.coerce.number().int();
export const zPhone = z.string().trim().transform((v) => v.replace(/[^0-9]/g, '')).refine((v) => v.length >= 9 && v.length <= 10, { message: 'เบอร์โทรศัพท์ไม่ถูกต้อง' });
export const zIdArr = z.array(z.coerce.number().int()).default([]);

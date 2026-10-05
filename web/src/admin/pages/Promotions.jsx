import { BadgePercent } from 'lucide-react';
import { CrudPage, DaysInput, MultiCheck } from '../../components/Crud.jsx';
import { Badge, Field, Input, Switch, money } from '../../components/ui.jsx';
import { useT } from '../../lib/i18n.jsx';
import { useLive } from '../../lib/socket.js';
import { api } from '../../lib/api.js';
import { PROMOTION_TYPES } from '@beatbox/shared/constants.js';

function Conditions({ value = {}, onChange, types, products, cats, tiers }) {
  const { t } = useT();
  const set = (k, v) => onChange({ ...value, [k]: v === '' ? undefined : v });
  return (
    <div className="grid grid-2 card flat" style={{ background: 'var(--surface-2)' }}>
      <Field label="ยอดซื้อขั้นต่ำ"><Input type="number" value={value.min_spend ?? ''} onChange={(e) => set('min_spend', e.target.value && Number(e.target.value))} /></Field>
      <Field label="จำนวนขั้นต่ำ (ซื้อครบตามจำนวน)"><Input type="number" value={value.min_qty ?? ''} onChange={(e) => set('min_qty', e.target.value && Number(e.target.value))} /></Field>
      <Field label="ส่วนลดสูงสุด"><Input type="number" value={value.max_discount ?? ''} onChange={(e) => set('max_discount', e.target.value && Number(e.target.value))} /></Field>
      <Field label="ใช้กับ">
        <select className="input" value={value.apply_to || ''} onChange={(e) => set('apply_to', e.target.value)}>
          <option value="">{t('ทั้งบิล')}</option>
          <option value="ROOM">{t('เฉพาะค่าห้อง')}</option>
          <option value="PRODUCT">{t('เฉพาะสินค้า')}</option>
        </select>
      </Field>
      <Field label="เวลาเริ่ม (Happy Hour / ช่วงเวลา)"><Input type="time" value={value.time_from || ''} onChange={(e) => set('time_from', e.target.value)} /></Field>
      <Field label="เวลาสิ้นสุด"><Input type="time" value={value.time_to || ''} onChange={(e) => set('time_to', e.target.value)} /></Field>
      <Field label="วันที่ใช้ได้ (ไม่เลือก = ทุกวัน)" style={{ gridColumn: '1/-1' }}><DaysInput value={value.days || []} onChange={(v) => set('days', v)} /></Field>
      <Field label="เฉพาะ Type ห้อง" style={{ gridColumn: '1/-1' }}><MultiCheck value={value.room_type_ids || []} onChange={(v) => set('room_type_ids', v)} options={types} /></Field>
      <Field label="เฉพาะหมวดหมู่สินค้า" style={{ gridColumn: '1/-1' }}><MultiCheck value={value.category_ids || []} onChange={(v) => set('category_ids', v)} options={cats} /></Field>
      <Field label="เฉพาะระดับสมาชิก" style={{ gridColumn: '1/-1' }}><MultiCheck value={value.tier_ids || []} onChange={(v) => set('tier_ids', v)} options={tiers} /></Field>
      <Field label="สินค้าที่แถมฟรี (ฟรีสินค้า)">
        <select className="input" value={value.free_product_id || ''} onChange={(e) => set('free_product_id', e.target.value && Number(e.target.value))}>
          <option value="">-</option>
          {products.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
      </Field>
      <Field label="จำนวนที่แถม"><Input type="number" value={value.free_qty ?? ''} onChange={(e) => set('free_qty', e.target.value && Number(e.target.value))} /></Field>
      <div style={{ gridColumn: '1/-1' }}><Switch checked={!!value.member_only} onChange={(v) => set('member_only', v)} label="เฉพาะสมาชิก" /></div>
    </div>
  );
}

export default function Promotions() {
  const { t } = useT();
  const { data: types } = useLive(() => api.get('/room-types'), [], []);
  const { data: products } = useLive(() => api.get('/products'), [], []);
  const { data: cats } = useLive(() => api.get('/categories'), [], []);
  const { data: tiers } = useLive(() => api.get('/member-tiers'), [], []);
  const opts = (l) => (l || []).map((x) => ({ value: x.id, label: x.name }));
  return (
    <CrudPage
      title="โปรโมชั่น"
      icon={BadgePercent}
      endpoint="/promotions"
      topics={['promotions']}
      createPerm="settings.manage"
      editPerm="settings.manage"
      deletePerm="settings.manage"
      searchKeys={['name', 'code', 'type']}
      defaults={{ type: 'PERCENT', valueType: 'PERCENT', value: 10, conditions: {}, isActive: true, isOnline: true, autoApply: false }}
      toForm={(r) => ({ id: r.id, name: r.name, type: r.type, valueType: r.value_type, value: r.value, code: r.code, conditions: r.conditions, imageUrl: r.image_url, description: r.description, startDate: r.start_date, endDate: r.end_date, usageLimit: r.usage_limit, autoApply: r.auto_apply, isOnline: r.is_online, depositAmount: r.deposit_amount, isActive: r.is_active })}
      columns={[
        { key: 'image_url', label: 'รูป', type: 'image' },
        { label: 'โปรโมชั่น', render: (r) => <div><b>{r.name}</b><div className="xs muted">{r.description}</div></div> },
        { label: 'ประเภท', render: (r) => t(PROMOTION_TYPES[r.type]) },
        { label: 'มูลค่า', right: true, render: (r) => (r.type === 'FREE_HOURS' ? `${r.value} ${t('ชม.')}` : r.value_type === 'PERCENT' ? `${r.value}%` : `฿${money(r.value, 0)}`) },
        { label: 'Code', render: (r) => (r.code ? <Badge color="#8b5cf6">{r.code}</Badge> : '—') },
        { label: 'ช่วงเวลา', render: (r) => `${r.start_date || '…'} → ${r.end_date || '…'}` },
        { label: 'ใช้แล้ว', right: true, render: (r) => `${r.used_count}${r.usage_limit ? ` / ${r.usage_limit}` : ''}` },
        { label: 'สถานะ', render: (r) => (r.is_active ? <Badge color="#16a34a">{t('เปิด')}</Badge> : <Badge color="#6b7280">{t('ปิด')}</Badge>) },
      ]}
      fields={[
        { key: 'name', label: 'ชื่อโปรโมชั่น', required: true, full: true },
        { key: 'type', label: 'ประเภท', type: 'select', options: Object.entries(PROMOTION_TYPES).map(([value, label]) => ({ value, label })), required: true },
        { key: 'valueType', label: 'รูปแบบส่วนลด', type: 'select', options: [{ value: 'PERCENT', label: 'เปอร์เซ็นต์ (%)' }, { value: 'AMOUNT', label: 'จำนวนเงิน (บาท)' }], hidden: (f) => ['FREE_HOURS', 'FREE_ITEM'].includes(f.type), required: true },
        { key: 'value', label: 'มูลค่า (ชั่วโมงฟรี = จำนวนชั่วโมง)', type: 'number' },
        { key: 'code', label: 'Promo Code / คูปอง (ไม่บังคับ)' },
        { key: 'startDate', label: 'วันเริ่ม', type: 'date' },
        { key: 'endDate', label: 'วันสิ้นสุด', type: 'date' },
        { key: 'usageLimit', label: 'จำกัดจำนวนครั้ง', type: 'number' },
        { key: 'depositAmount', label: 'มัดจำเมื่อใช้โปรนี้ (จองออนไลน์)', type: 'money' },
        { key: 'conditions', label: 'เงื่อนไข', type: 'custom', full: true, render: (f, set) => <Conditions value={f.conditions} onChange={(v) => set('conditions', v)} types={opts(types)} products={opts(products)} cats={opts(cats)} tiers={opts(tiers)} /> },
        { key: 'imageUrl', label: 'รูปโปรโมชั่น (URL)', type: 'image', full: true },
        { key: 'description', label: 'รายละเอียด', type: 'textarea', full: true },
        { key: 'autoApply', label: 'ใช้อัตโนมัติ', type: 'switch', switchLabel: 'ใช้อัตโนมัติเมื่อเข้าเงื่อนไข' },
        { key: 'isOnline', label: 'เว็บไซต์จอง', type: 'switch', switchLabel: 'แสดงบนเว็บไซต์' },
        { key: 'isActive', label: 'สถานะ', type: 'switch', switchLabel: 'เปิดใช้งาน' },
      ]}
    />
  );
}

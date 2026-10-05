import { useState } from 'react';
import { Gift, Crown } from 'lucide-react';
import { CrudPage } from '../../components/Crud.jsx';
import { Tabs, Badge, money } from '../../components/ui.jsx';
import { useT } from '../../lib/i18n.jsx';
import { useLive } from '../../lib/socket.js';
import { api } from '../../lib/api.js';
import { REWARD_TYPES } from '@beatbox/shared/constants.js';

export default function Rewards() {
  const { t } = useT();
  const [tab, setTab] = useState('rewards');
  const { data: types } = useLive(() => api.get('/room-types'), [], []);
  const { data: products } = useLive(() => api.get('/products'), [], []);
  return (
    <div>
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'rewards', label: 'Rewards ของรางวัล' }, { value: 'tiers', label: 'ระดับสมาชิก (Tier)' }]} />
      {tab === 'rewards' ? (
        <CrudPage
          title="Rewards"
          icon={Gift}
          endpoint="/rewards"
          createPerm="settings.manage"
          editPerm="settings.manage"
          deletePerm="settings.manage"
          defaults={{ pointsCost: 100, rewardType: 'DISCOUNT', value: 0, roomTypeIds: [], availableDays: [0, 1, 2, 3, 4, 5, 6], validDays: 30, isActive: true }}
          toForm={(r) => ({ id: r.id, name: r.name, imageUrl: r.image_url, description: r.description, pointsCost: r.points_cost, rewardType: r.reward_type, value: r.value, productId: r.product_id, roomTypeIds: r.room_type_ids, availableDays: r.available_days, availableFrom: r.available_from?.slice(0, 5), availableTo: r.available_to?.slice(0, 5), expiresAt: r.expires_at, validDays: r.valid_days, quantityTotal: r.quantity_total, limitPerMember: r.limit_per_member, isActive: r.is_active })}
          toPayload={(f) => ({ ...f, productId: f.productId ? Number(f.productId) : null })}
          columns={[
            { key: 'image_url', label: 'รูป', type: 'image' },
            { key: 'name', label: 'ชื่อ' },
            { label: 'คะแนนที่ใช้', right: true, render: (r) => <b>{r.points_cost}</b> },
            { label: 'ประเภท', render: (r) => t(REWARD_TYPES[r.reward_type]) },
            { key: 'value', label: 'มูลค่า', type: 'money', right: true },
            { label: 'สิทธิ์', right: true, render: (r) => `${r.quantity_used}${r.quantity_total ? ` / ${r.quantity_total}` : ''}` },
            { label: 'หมดอายุ', render: (r) => r.expires_at || '—' },
            { key: 'is_active', label: 'เปิด', type: 'bool' },
          ]}
          fields={[
            { key: 'name', label: 'ชื่อ', required: true },
            { key: 'pointsCost', label: 'คะแนนที่ใช้', type: 'number', required: true },
            { key: 'rewardType', label: 'ประเภท Reward', type: 'select', options: Object.entries(REWARD_TYPES).map(([value, label]) => ({ value, label })), required: true },
            { key: 'value', label: 'มูลค่า (บาท / ชั่วโมง)', type: 'money' },
            { key: 'productId', label: 'สินค้าที่ได้ฟรี', type: 'select', options: (products || []).map((p) => ({ value: p.id, label: p.name })), hidden: (f) => !['FREE_DRINK', 'FREE_PRODUCT'].includes(f.rewardType) },
            { key: 'validDays', label: 'ใช้ได้ภายใน (วัน) หลังแลก', type: 'number' },
            { key: 'roomTypeIds', label: 'Type ห้องที่ใช้ได้', type: 'multi', options: (types || []).map((x) => ({ value: x.id, label: x.name })), full: true },
            { key: 'availableDays', label: 'วันใช้งาน', type: 'days', full: true },
            { key: 'availableFrom', label: 'เวลาใช้งานตั้งแต่', type: 'time' },
            { key: 'availableTo', label: 'ถึง', type: 'time' },
            { key: 'expiresAt', label: 'วันหมดอายุ', type: 'date' },
            { key: 'quantityTotal', label: 'จำนวนสิทธิ์ทั้งหมด', type: 'number' },
            { key: 'limitPerMember', label: 'จำกัดต่อสมาชิก', type: 'number' },
            { key: 'isActive', label: 'สถานะ', type: 'switch', switchLabel: 'เปิดใช้งาน' },
            { key: 'imageUrl', label: 'รูป (URL)', type: 'image', full: true },
            { key: 'description', label: 'รายละเอียด', type: 'textarea', full: true },
          ]}
        />
      ) : (
        <CrudPage
          title="ระดับสมาชิก"
          icon={Crown}
          endpoint="/member-tiers"
          createPerm="settings.manage"
          editPerm="settings.manage"
          canDelete={false}
          defaults={{ pointMultiplier: 1, roomDiscountPercent: 0, productDiscountPercent: 0, conditionMode: 'ANY', isActive: true, sortOrder: 0, color: '#9ca3af', benefits: {} }}
          toForm={(r) => ({ id: r.id, code: r.code, name: r.name, color: r.color, sortOrder: r.sort_order, minPoints: r.min_points, minSpending: r.min_spending, minVisits: r.min_visits, minHours: r.min_hours, conditionMode: r.condition_mode, pointMultiplier: r.point_multiplier, roomDiscountPercent: r.room_discount_percent, productDiscountPercent: r.product_discount_percent, benefits: r.benefits || {}, isActive: r.is_active })}
          columns={[
            { label: 'Tier', render: (r) => <Badge color={r.color}>{r.name}</Badge> },
            { label: 'เงื่อนไข', render: (r) => [r.min_points != null && `${t('คะแนน')} ≥ ${r.min_points}`, r.min_spending != null && `${t('ยอดสะสม')} ≥ ${money(r.min_spending, 0)}`, r.min_visits != null && `${t('ครั้ง')} ≥ ${r.min_visits}`, r.min_hours != null && `${t('ชั่วโมง')} ≥ ${r.min_hours}`].filter(Boolean).join(r.condition_mode === 'ALL' ? ' และ ' : ' หรือ ') || t('เริ่มต้น') },
            { label: 'Point Multiplier', right: true, render: (r) => `×${r.point_multiplier}` },
            { label: 'ลดค่าห้อง', right: true, render: (r) => `${r.room_discount_percent}%` },
            { label: 'ลดสินค้า', right: true, render: (r) => `${r.product_discount_percent}%` },
            { key: 'member_count', label: 'สมาชิก', right: true },
          ]}
          fields={[
            { key: 'name', label: 'ชื่อ Tier', required: true },
            { key: 'code', label: 'รหัส', required: true },
            { key: 'color', label: 'สี', type: 'color' },
            { key: 'sortOrder', label: 'ลำดับ (สูง = ระดับสูงกว่า)', type: 'number' },
            { key: 'minPoints', label: 'คะแนนขั้นต่ำ', type: 'number' },
            { key: 'minSpending', label: 'ยอดใช้จ่ายสะสมขั้นต่ำ', type: 'money' },
            { key: 'minVisits', label: 'จำนวนครั้งขั้นต่ำ', type: 'number' },
            { key: 'minHours', label: 'จำนวนชั่วโมงขั้นต่ำ', type: 'number' },
            { key: 'conditionMode', label: 'รูปแบบเงื่อนไข', type: 'select', options: [{ value: 'ANY', label: 'ผ่านเงื่อนไขใดเงื่อนไขหนึ่ง' }, { value: 'ALL', label: 'ต้องผ่านทุกเงื่อนไข' }] },
            { key: 'pointMultiplier', label: 'Point Multiplier', type: 'number', step: '0.1' },
            { key: 'roomDiscountPercent', label: 'ส่วนลดค่าห้อง %', type: 'number' },
            { key: 'productDiscountPercent', label: 'ส่วนลดสินค้า %', type: 'number' },
            { key: 'benefits', label: 'สิทธิพิเศษ', type: 'custom', full: true, render: (f, set) => (
              <div className="row">
                {[['birthdayReward', 'Birthday Reward'], ['freeTime', 'Free Time'], ['specialPackage', 'Special Package'], ['priorityBooking', 'Priority Booking']].map(([k, l]) => (
                  <label key={k} className="check badge" style={{ padding: '6px 10px' }}>
                    <input type="checkbox" checked={!!f.benefits?.[k]} onChange={(e) => set('benefits', { ...f.benefits, [k]: e.target.checked })} /> {l}
                  </label>
                ))}
              </div>
            ) },
            { key: 'isActive', label: 'สถานะ', type: 'switch', switchLabel: 'เปิดใช้งาน' },
          ]}
        />
      )}
    </div>
  );
}

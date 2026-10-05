import { LayoutGrid, Users } from 'lucide-react';
import { CrudPage } from '../../components/Crud.jsx';
import { Img, Badge, money, Switch } from '../../components/ui.jsx';
import { useT } from '../../lib/i18n.jsx';
import { halfHourPrice } from '@beatbox/shared/roomPricing.js';

export default function RoomTypes() {
  const { t } = useT();
  return (
    <CrudPage
      title="Type ห้อง"
      icon={LayoutGrid}
      endpoint="/room-types"
      topics={['room-types']}
      createPerm="room.create"
      editPerm="room.edit"
      deletePerm="room.edit"
      searchKeys={['name', 'code']}
      defaults={{ capacity: 6, priceHour: 0, halfPriceManual: false, defaultDeposit: 0, color: '#8b5cf6', amenities: [], isActive: true, sortOrder: 0, applyToRooms: true }}
      toForm={(r) => ({ id: r.id, code: r.code, name: r.name, imageUrl: r.image_url, description: r.description, capacity: r.capacity, priceHour: r.price_hour, priceHalf: r.price_half, halfPriceManual: r.half_price_manual, defaultDeposit: r.default_deposit, color: r.color, amenities: r.amenities, isActive: r.is_active, sortOrder: r.sort_order, applyToRooms: false })}
      cards={(r) => (
        <>
          <Img src={r.image_url} style={{ width: '100%', height: 140, objectFit: 'cover' }} />
          <div style={{ padding: 12 }}>
            <div className="row between">
              <h3 style={{ margin: 0 }}>{r.name}</h3>
              <Badge color={r.color}>{r.code}</Badge>
            </div>
            <div className="muted small"><Users size={14} /> {r.capacity} {t('คน')}</div>
            <div className="row between mt">
              <span>{t('1 ชั่วโมง')} <b>{money(r.price_hour, 0)}</b></span>
              <span>{t('30 นาที')} <b>{money(r.price_half, 0)}</b></span>
            </div>
            <div className="small muted">{t('มัดจำเริ่มต้น')} {money(r.default_deposit, 0)} · {(r.amenities || []).join(', ')}</div>
            {!r.is_active && <Badge color="#dc2626">{t('ปิดใช้งาน')}</Badge>}
          </div>
        </>
      )}
      fields={[
        { key: 'name', label: 'ชื่อ Type ห้อง', required: true },
        { key: 'code', label: 'รหัส Type ห้อง', required: true },
        { key: 'imageUrl', label: 'รูปภาพ (URL)', type: 'image', full: true },
        { key: 'description', label: 'รายละเอียด', type: 'textarea', full: true },
        { key: 'capacity', label: 'จำนวนคนที่รองรับ', type: 'number', required: true },
        { key: 'defaultDeposit', label: 'เงินมัดจำเริ่มต้น', type: 'money' },
        { key: 'priceHour', label: 'ราคาต่อ 1 ชั่วโมง', type: 'money', required: true },
        {
          key: 'priceHalf',
          label: 'ราคาต่อ 30 นาที',
          type: 'custom',
          render: (f, set) => (
            <div className="col">
              <Switch checked={f.halfPriceManual} onChange={(v) => set('halfPriceManual', v)} label="กำหนดราคาเอง" />
              {f.halfPriceManual ? (
                <input className="input" type="number" value={f.priceHalf ?? ''} onChange={(e) => set('priceHalf', e.target.value)} />
              ) : (
                <div className="input" style={{ opacity: 0.8 }}>{halfHourPrice(f.priceHour)} <span className="xs muted">({t('คำนวณอัตโนมัติ ปัดขึ้น')})</span></div>
              )}
            </div>
          ),
        },
        { key: 'color', label: 'สีประจำประเภทห้อง', type: 'color' },
        { key: 'sortOrder', label: 'ลำดับการแสดงผล', type: 'number' },
        { key: 'amenities', label: 'สิ่งอำนวยความสะดวก', type: 'tags', full: true },
        { key: 'isActive', label: 'สถานะ', type: 'switch', switchLabel: 'เปิดใช้งาน' },
        { key: 'applyToRooms', label: 'อัปเดตราคาไปยังห้องทั้งหมดใน Type นี้', type: 'switch', switchLabel: 'ใช่', hidden: (f) => !f.id },
      ]}
    />
  );
}

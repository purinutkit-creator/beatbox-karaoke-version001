import { DoorOpen } from 'lucide-react';
import { CrudPage } from '../../components/Crud.jsx';
import { Badge, Switch, money } from '../../components/ui.jsx';
import { useT } from '../../lib/i18n.jsx';
import { useLive } from '../../lib/socket.js';
import { api } from '../../lib/api.js';
import { halfHourPrice } from '@beatbox/shared/roomPricing.js';
import { ROOM_STATUS_LABEL, ROOM_STATUS_COLOR } from '@beatbox/shared/constants.js';

export default function RoomsManage() {
  const { t } = useT();
  const { data: types } = useLive(() => api.get('/room-types'), ['room-types'], []);
  const typeOpts = (types || []).map((x) => ({ value: x.id, label: x.name }));
  return (
    <CrudPage
      title="จัดการห้อง"
      icon={DoorOpen}
      endpoint="/rooms"
      topics={['rooms']}
      createPerm="room.create"
      editPerm="room.edit"
      deletePerm="room.edit"
      searchKeys={['name', 'number', 'type_name', 'zone']}
      defaults={{ capacity: 6, priceHour: 0, halfPriceManual: false, deposit: 0, sortOrder: 0, isActive: true }}
      toForm={(r) => ({ id: r.id, name: r.name, number: r.number, roomTypeId: r.room_type_id, imageUrl: r.image_url, zone: r.zone, capacity: r.capacity, priceHour: r.price_hour, priceHalf: r.price_half, halfPriceManual: r.half_price_manual, deposit: r.deposit, note: r.note, sortOrder: r.sort_order, isActive: r.is_active })}
      columns={[
        { key: 'image_url', label: 'รูป', type: 'image' },
        { key: 'number', label: 'หมายเลข' },
        { key: 'name', label: 'ชื่อห้อง' },
        { label: 'Type', render: (r) => <Badge color={r.type_color}>{r.type_name}</Badge> },
        { key: 'zone', label: 'ชั้น/โซน' },
        { key: 'capacity', label: 'รองรับ', right: true },
        { key: 'price_hour', label: 'ราคา/ชม.', type: 'money', right: true },
        { key: 'price_half', label: '30 นาที', type: 'money', right: true },
        { key: 'deposit', label: 'มัดจำ', type: 'money', right: true },
        { label: 'สถานะ', render: (r) => <Badge color={ROOM_STATUS_COLOR[r.status]}>{t(ROOM_STATUS_LABEL[r.status])}</Badge> },
        { key: 'sort_order', label: 'ลำดับ', right: true },
      ]}
      fields={[
        { key: 'name', label: 'ชื่อห้อง', required: true },
        { key: 'number', label: 'หมายเลขห้อง', required: true },
        {
          key: 'roomTypeId',
          label: 'Type ห้อง',
          type: 'custom',
          render: (f, set) => (
            <select
              className="input"
              value={f.roomTypeId || ''}
              onChange={(e) => {
                const ty = types.find((x) => x.id === Number(e.target.value));
                set('roomTypeId', e.target.value);
                if (ty && !f.id) {
                  set('capacity', ty.capacity);
                  set('priceHour', ty.price_hour);
                  set('deposit', ty.default_deposit);
                  set('imageUrl', f.imageUrl || ty.image_url);
                }
              }}
            >
              <option value="">-</option>
              {typeOpts.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          ),
        },
        { key: 'zone', label: 'ชั้นหรือโซน' },
        { key: 'imageUrl', label: 'รูปภาพห้อง (URL)', type: 'image', full: true },
        { key: 'capacity', label: 'จำนวนคนที่รองรับ', type: 'number', required: true },
        { key: 'deposit', label: 'เงินมัดจำ', type: 'money' },
        { key: 'priceHour', label: 'ราคาต่อชั่วโมง', type: 'money', required: true },
        {
          key: 'priceHalf',
          label: 'ราคา 30 นาที',
          type: 'custom',
          render: (f, set) => (
            <div className="col">
              <Switch checked={f.halfPriceManual} onChange={(v) => set('halfPriceManual', v)} label="กำหนดราคาเอง" />
              {f.halfPriceManual ? <input className="input" type="number" value={f.priceHalf ?? ''} onChange={(e) => set('priceHalf', e.target.value)} /> : <div className="input">{money(halfHourPrice(f.priceHour), 0)}</div>}
            </div>
          ),
        },
        { key: 'sortOrder', label: 'ลำดับการแสดงผล', type: 'number' },
        { key: 'isActive', label: 'สถานะ', type: 'switch', switchLabel: 'เปิดใช้งาน' },
        { key: 'note', label: 'หมายเหตุ', type: 'textarea', full: true },
      ]}
      toPayload={(f) => ({ ...f, roomTypeId: Number(f.roomTypeId) })}
    />
  );
}

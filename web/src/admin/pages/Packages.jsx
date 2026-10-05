import { Timer } from 'lucide-react';
import { CrudPage, DAYS } from '../../components/Crud.jsx';
import { Img, Badge, money } from '../../components/ui.jsx';
import { useT } from '../../lib/i18n.jsx';
import { useLive } from '../../lib/socket.js';
import { api } from '../../lib/api.js';

export default function Packages() {
  const { t } = useT();
  const { data: types } = useLive(() => api.get('/room-types'), ['room-types'], []);
  const typeOpts = (types || []).map((x) => ({ value: x.id, label: x.name }));
  return (
    <CrudPage
      title="แพ็กเกจเวลา"
      icon={Timer}
      endpoint="/packages"
      topics={['packages']}
      createPerm="room.edit"
      editPerm="room.edit"
      deletePerm="room.edit"
      defaults={{ hours: 1, minutes: 0, price: 0, roomTypeIds: [], availableDays: [0, 1, 2, 3, 4, 5, 6], blackoutDates: [], isActive: true, isOnline: true, memberOnly: false, sortOrder: 0 }}
      toForm={(r) => ({ id: r.id, name: r.name, roomTypeIds: r.room_type_ids, hours: r.hours, minutes: r.minutes, price: r.price, includedGuests: r.included_guests, imageUrl: r.image_url, description: r.description, availableDays: r.available_days, availableFrom: r.available_from?.slice(0, 5), availableTo: r.available_to?.slice(0, 5), blackoutDates: r.blackout_dates, deposit: r.deposit, memberOnly: r.member_only, isOnline: r.is_online, isActive: r.is_active, sortOrder: r.sort_order })}
      cards={(r) => (
        <>
          <Img src={r.image_url} style={{ width: '100%', height: 120, objectFit: 'cover' }} />
          <div style={{ padding: 12 }}>
            <h3 style={{ margin: 0 }}>{r.name}</h3>
            <div className="row between">
              <span className="muted">{r.hours} {t('ชม.')} {r.minutes ? `${r.minutes} ${t('นาที')}` : ''}</span>
              <b style={{ fontSize: '1.2rem' }}>฿{money(r.price, 0)}</b>
            </div>
            <div className="small muted">
              {r.room_type_ids?.length ? r.room_type_ids.map((id) => types?.find((x) => x.id === id)?.name).join(', ') : t('ทุก Type ห้อง')}
              {' · '}
              {r.available_days.length === 7 ? t('ทุกวัน') : r.available_days.map((d) => t(DAYS[d])).join(' ')}
              {r.available_from && ` ${r.available_from.slice(0, 5)}–${r.available_to?.slice(0, 5)}`}
            </div>
            <div className="row" style={{ gap: 4, marginTop: 6 }}>
              {!r.is_active && <Badge color="#dc2626">{t('ปิดใช้งาน')}</Badge>}
              {r.member_only && <Badge color="#eab308">{t('เฉพาะสมาชิก')}</Badge>}
              {r.is_online && <Badge color="#2563eb">{t('จองออนไลน์ได้')}</Badge>}
            </div>
          </div>
        </>
      )}
      fields={[
        { key: 'name', label: 'ชื่อแพ็กเกจ', required: true, full: true },
        { key: 'hours', label: 'จำนวนชั่วโมง', type: 'number', required: true },
        { key: 'minutes', label: 'จำนวนนาที', type: 'number' },
        { key: 'price', label: 'ราคา', type: 'money', required: true },
        { key: 'includedGuests', label: 'จำนวนคนที่รวมในแพ็กเกจ', type: 'number' },
        { key: 'deposit', label: 'มัดจำของแพ็กเกจ', type: 'money', hint: 'เว้นว่าง = ใช้มัดจำตาม Type ห้อง' },
        { key: 'sortOrder', label: 'ลำดับ', type: 'number' },
        { key: 'roomTypeIds', label: 'Type ห้องที่ใช้ได้ (ไม่เลือก = ทุก Type)', type: 'multi', options: typeOpts, full: true },
        { key: 'availableDays', label: 'วันที่สามารถใช้ได้', type: 'days', full: true },
        { key: 'availableFrom', label: 'ใช้ได้ตั้งแต่เวลา', type: 'time' },
        { key: 'availableTo', label: 'ถึงเวลา', type: 'time' },
        { key: 'blackoutDates', label: 'วันหยุดที่ไม่สามารถใช้ได้ (YYYY-MM-DD)', type: 'tags', full: true },
        { key: 'imageUrl', label: 'รูปภาพ (URL)', type: 'image', full: true },
        { key: 'description', label: 'รายละเอียด', type: 'textarea', full: true },
        { key: 'isActive', label: 'สถานะ', type: 'switch', switchLabel: 'เปิดใช้งาน' },
        { key: 'isOnline', label: 'จองออนไลน์', type: 'switch', switchLabel: 'แสดงบนเว็บไซต์จอง' },
        { key: 'memberOnly', label: 'แพ็กเกจสมาชิก', type: 'switch', switchLabel: 'เฉพาะสมาชิก' },
      ]}
    />
  );
}

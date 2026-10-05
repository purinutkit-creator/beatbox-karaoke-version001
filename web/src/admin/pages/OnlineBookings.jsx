import { useState } from 'react';
import { Globe, QrCode } from 'lucide-react';
import Reservations from './Reservations.jsx';
import { Tabs, Badge, Button, Empty, money, useToast, useDialog } from '../../components/ui.jsx';
import { useT } from '../../lib/i18n.jsx';
import { api } from '../../lib/api.js';
import { useLive } from '../../lib/socket.js';
import { fmtDateTime } from '@beatbox/shared/format.js';
import { ReservationDrawer } from '../../components/ReservationParts.jsx';

export default function OnlineBookings() {
  const { t } = useT();
  const [tab, setTab] = useState('list');
  const [open, setOpen] = useState(null);
  const { data: review, reload } = useLive(() => api.get('/payment-verifications?result=MANUAL_REVIEW'), ['reservations', 'notifications'], []);
  return (
    <div>
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'list', label: 'รายการจองออนไลน์' }, { value: 'review', label: 'สลิปรอตรวจสอบ', count: review?.length }]} />
      {tab === 'list' ? (
        <Reservations source="ONLINE" title="Online Booking" icon={Globe} />
      ) : (
        <div className="col">
          {!review?.length && <Empty icon={QrCode} text="ไม่มีสลิปรอตรวจสอบ" />}
          {review?.map((v) => (
            <div key={v.id} className="card row between">
              <div>
                <b>{v.booking_no}</b> · {v.customer_name} ({v.phone})
                <div className="small muted">{t('ยอดที่ต้องชำระ')} ฿{money(v.expected_amount)} · {v.failure_reason} · {fmtDateTime(v.created_at)}</div>
              </div>
              <Button onClick={() => setOpen(v.reservation_id)}>{t('ตรวจสอบ')}</Button>
            </div>
          ))}
        </div>
      )}
      {open && <ReservationDrawer id={open} onClose={() => setOpen(null)} onChanged={reload} />}
    </div>
  );
}

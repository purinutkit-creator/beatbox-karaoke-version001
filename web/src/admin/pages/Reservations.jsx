import { useState } from 'react';
import { ClipboardList, CalendarPlus } from 'lucide-react';
import { PageHead, Button, Input, Select, Loading } from '../../components/ui.jsx';
import { ReservationForm, ReservationDrawer, ReservationTable } from '../../components/ReservationParts.jsx';
import { useT } from '../../lib/i18n.jsx';
import { api } from '../../lib/api.js';
import { useLive } from '../../lib/socket.js';
import { RESERVATION_STATUS_LABEL } from '@beatbox/shared/constants.js';
import { bkkDateStr, bkkDateTime } from '@beatbox/shared/format.js';

export default function Reservations({ source, title = 'รายการจอง', icon = ClipboardList }) {
  const { t } = useT();
  const [from, setFrom] = useState(bkkDateStr());
  const [to, setTo] = useState(bkkDateStr(Date.now() + 30 * 86400000));
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [src, setSrc] = useState(source || '');
  const [open, setOpen] = useState(null);
  const [creating, setCreating] = useState(false);
  const qs = new URLSearchParams({ from: bkkDateTime(from).toISOString(), to: bkkDateTime(to, '23:59').toISOString(), ...(status ? { status } : {}), ...(q ? { q } : {}), ...(src ? { source: src } : {}) });
  const { data, loading, reload } = useLive(() => api.get(`/reservations?${qs}`), ['reservations'], [qs.toString()]);
  return (
    <div>
      <PageHead icon={icon} title={title}>
        <Button variant="primary" icon={CalendarPlus} onClick={() => setCreating(true)}>{t('สร้างการจอง')}</Button>
      </PageHead>
      <div className="row mb">
        <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 160 }} />
        <span>–</span>
        <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 160 }} />
        <Select value={status} onChange={(e) => setStatus(e.target.value)} options={Object.entries(RESERVATION_STATUS_LABEL).map(([value, label]) => ({ value, label }))} placeholder="ทุกสถานะ" style={{ width: 170 }} />
        {!source && <Select value={src} onChange={(e) => setSrc(e.target.value)} options={['ONLINE', 'POS', 'PHONE', 'WALK_IN', 'LINE']} placeholder="ทุกช่องทาง" style={{ width: 150 }} />}
        <Input placeholder={t('ค้นหาเลขที่จอง / ชื่อ / เบอร์โทร')} value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 280 }} />
      </div>
      {loading ? <Loading /> : <ReservationTable rows={data} onOpen={setOpen} />}
      {open && <ReservationDrawer id={open} onClose={() => setOpen(null)} onChanged={reload} />}
      {creating && <ReservationForm onClose={() => setCreating(false)} onSaved={() => { setCreating(false); reload(); }} />}
    </div>
  );
}

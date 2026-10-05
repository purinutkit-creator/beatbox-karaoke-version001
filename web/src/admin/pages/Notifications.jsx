import { useState } from 'react';
import { Bell, CheckCheck, RefreshCw } from 'lucide-react';
import { PageHead, Button, Tabs, Badge, Empty, Loading } from '../../components/ui.jsx';
import { useT } from '../../lib/i18n.jsx';
import { api } from '../../lib/api.js';
import { useLive, useSocketEvent } from '../../lib/socket.js';
import { fmtDateTime } from '@beatbox/shared/format.js';

const LEVEL = { error: '#dc2626', warning: '#f97316', success: '#16a34a', info: '#2563eb' };

export default function Notifications() {
  const { t, tp } = useT();
  const [tab, setTab] = useState('POS');
  const { data, loading, reload } = useLive(() => api.get(`/notifications?channel=${tab}&limit=200`), ['notifications'], [tab]);
  useSocketEvent('notification:new', reload);
  useSocketEvent('notification:read', reload);
  return (
    <div>
      <PageHead icon={Bell} title="Notification Center">
        {tab === 'POS' && <Button icon={CheckCheck} onClick={() => api.post('/notifications/read-all').then(reload)}>{t('อ่านทั้งหมด')}</Button>}
      </PageHead>
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'POS', label: 'แจ้งเตือนในร้าน', count: data?.unread }, { value: 'LINE', label: 'ข้อความ LINE' }, { value: 'SMS', label: 'SMS' }]} />
      {loading ? <Loading /> : !data?.items?.length ? <Empty icon={Bell} /> : (
        <div className="col">
          {data.items.map((n) => (
            <div key={n.id} className="card flat row between" style={{ borderLeft: `4px solid ${LEVEL[n.level] || '#2563eb'}`, opacity: n.read_at && tab === 'POS' ? 0.6 : 1 }}>
              <div className="grow">
                <div className="row"><b>{tp(n.title)}</b><Badge>{n.type}</Badge>{tab !== 'POS' && <Badge color={n.status === 'SENT' ? '#16a34a' : n.status === 'FAILED' ? '#dc2626' : '#f97316'}>{n.status}</Badge>}</div>
                <div className="small" style={{ whiteSpace: 'pre-line' }}>{tp(n.message)}</div>
                <div className="xs muted">{fmtDateTime(n.created_at)} {n.read_by_name && `· ${t('อ่านโดย')} ${n.read_by_name}`} {n.error && `· ${n.error}`}</div>
              </div>
              {tab === 'POS' && !n.read_at && <Button size="sm" onClick={() => api.post(`/notifications/${n.id}/read`).then(reload)}>{t('อ่านแล้ว')}</Button>}
              {tab !== 'POS' && n.status === 'FAILED' && <Button size="sm" icon={RefreshCw} onClick={() => api.post(`/notifications/${n.id}/retry`).then(reload)}>{t('ส่งใหม่')}</Button>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

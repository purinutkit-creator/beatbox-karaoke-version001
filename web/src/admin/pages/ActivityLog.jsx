import { useState } from 'react';
import { History } from 'lucide-react';
import { PageHead, Input, Select, Loading, Empty, Badge } from '../../components/ui.jsx';
import { useT } from '../../lib/i18n.jsx';
import { api } from '../../lib/api.js';
import { useLive } from '../../lib/socket.js';
import { fmtDateTime, bkkDateStr } from '@beatbox/shared/format.js';

export default function ActivityLog() {
  const { t } = useT();
  const [f, setF] = useState({ from: bkkDateStr(Date.now() - 7 * 86400000), to: bkkDateStr(), action: '', entity: '', employeeId: '' });
  const qs = new URLSearchParams(Object.fromEntries(Object.entries(f).filter(([, v]) => v)));
  const { data, loading } = useLive(() => api.get(`/activity-logs?${qs}`), [], [qs.toString()]);
  const { data: emps } = useLive(() => api.get('/employees/directory'), [], []);
  return (
    <div>
      <PageHead icon={History} title="Activity Log" />
      <div className="row mb">
        <Input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} style={{ width: 160 }} />
        <Input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} style={{ width: 160 }} />
        <Select value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: e.target.value })} options={(emps || []).map((x) => ({ value: x.id, label: x.name }))} placeholder="ทุกพนักงาน" style={{ width: 180 }} />
        <Select value={f.entity} onChange={(e) => setF({ ...f, entity: e.target.value })} options={['order', 'room_session', 'reservation', 'member', 'product', 'shift', 'settings', 'employee', 'room', 'printer']} placeholder="ทุกประเภท" style={{ width: 170 }} />
        <Input placeholder={t('ค้นหา action')} value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })} style={{ width: 180 }} />
      </div>
      {loading ? <Loading /> : !data?.length ? <Empty /> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>{t('วันเวลา')}</th><th>{t('พนักงาน')}</th><th>Action</th><th>{t('ประเภท')}</th><th>ID</th><th>{t('รายละเอียด')}</th><th>IP</th></tr></thead>
            <tbody>
              {data.map((l) => (
                <tr key={l.id}>
                  <td className="small nowrap">{fmtDateTime(l.created_at)}</td>
                  <td>{l.employee_name || 'SYSTEM'}</td>
                  <td><Badge>{l.action}</Badge></td>
                  <td>{l.entity}</td>
                  <td>{l.entity_id}</td>
                  <td className="xs" style={{ maxWidth: 480, wordBreak: 'break-word' }}>{JSON.stringify(l.details)}</td>
                  <td className="xs muted">{l.ip}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

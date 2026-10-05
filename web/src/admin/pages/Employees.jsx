import { useState } from 'react';
import { UserCog, ShieldCheck, History } from 'lucide-react';
import { CrudPage } from '../../components/Crud.jsx';
import { Button, Modal, Badge, Img, Tabs, Loading, Empty, money, useToast } from '../../components/ui.jsx';
import { useT } from '../../lib/i18n.jsx';
import { api } from '../../lib/api.js';
import { useLive } from '../../lib/socket.js';
import { fmtDateTime } from '@beatbox/shared/format.js';

function PermissionEditor({ emp, roles, perms, onClose }) {
  const { t } = useT();
  const toast = useToast();
  const role = roles.find((r) => r.id === emp.role_id);
  const base = new Set(role?.permissions || []);
  const [ov, setOv] = useState(Object.fromEntries((emp.overrides || []).map((o) => [o.permission_code, o.granted])));
  const effective = (code) => (code in ov ? ov[code] : base.has(code));
  const toggle = (code) => {
    const next = !effective(code);
    const n = { ...ov };
    if (next === base.has(code)) delete n[code];
    else n[code] = next;
    setOv(n);
  };
  const save = async () => {
    try {
      await api.put(`/employees/${emp.id}/permissions`, { overrides: Object.entries(ov).map(([code, granted]) => ({ code, granted })) });
      toast.success('บันทึกสิทธิ์เรียบร้อย');
      onClose(true);
    } catch (e) {
      toast.error(e);
    }
  };
  const groups = perms.reduce((g, p) => ((g[p.group] ||= []).push(p), g), {});
  return (
    <Modal title={`${t('กำหนดสิทธิ์')} · ${emp.name} (${role?.name})`} size="wide" onClose={() => onClose(false)} footer={<Button variant="primary" onClick={save}>{t('บันทึก')}</Button>}>
      {emp.role === 'ADMIN' && <div className="card flat mb">{t('ผู้ดูแลระบบมีสิทธิ์ทั้งหมดเสมอ')}</div>}
      <div className="grid grid-2">
        {Object.entries(groups).map(([g, list]) => (
          <div key={g} className="card flat">
            <b>{t(g)}</b>
            {list.map((p) => (
              <label key={p.code} className="check" style={{ display: 'flex', padding: '4px 0' }}>
                <input type="checkbox" checked={effective(p.code)} onChange={() => toggle(p.code)} />
                <span>{t(p.name)}</span>
                {p.code in ov && <Badge color="#f97316">{t('กำหนดเฉพาะ')}</Badge>}
              </label>
            ))}
          </div>
        ))}
      </div>
    </Modal>
  );
}

function HistoryModal({ emp, onClose }) {
  const { t } = useT();
  const [type, setType] = useState('login');
  const { data, loading } = useLive(() => api.get(`/employees/${emp.id}/history?type=${type}`), [], [type]);
  return (
    <Modal title={`${t('ประวัติ')} · ${emp.name}`} size="wide" onClose={onClose}>
      <Tabs value={type} onChange={setType} tabs={[{ value: 'login', label: 'การเข้าสู่ระบบ' }, { value: 'sales', label: 'รายการขาย' }, { value: 'edits', label: 'การแก้ไขรายการ' }, { value: 'voids', label: 'การยกเลิก' }, { value: 'refunds', label: 'การคืนเงิน' }, { value: 'shifts', label: 'เปิด/ปิดรอบ' }]} />
      {loading ? <Loading /> : !data?.length ? <Empty /> : (
        <div className="col">
          {data.map((r, i) => (
            <div key={i} className="card flat small" style={{ padding: 10 }}>
              {type === 'login' && <>{r.action} · {r.success ? '✓' : '✗'} · {fmtDateTime(r.created_at)} · {r.ip}</>}
              {type === 'sales' && <>{r.receipt_no || r.order_no} · {r.queue_no} · ฿{money(r.grand_total)} · {fmtDateTime(r.paid_at)} · {r.status}</>}
              {['edits', 'voids'].includes(type) && <>{r.action} · {r.entity} #{r.entity_id} · {fmtDateTime(r.created_at)}<div className="xs muted">{JSON.stringify(r.details).slice(0, 200)}</div></>}
              {type === 'refunds' && <>{r.refund_no} · {r.order_no} · ฿{money(r.amount)} · {r.status} · {r.reason}</>}
              {type === 'shifts' && <>{r.shift_no} · {fmtDateTime(r.opened_at)} → {r.closed_at ? fmtDateTime(r.closed_at) : '-'} · {t('ขาด/เกิน')} {money(r.difference)}</>}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

export default function Employees() {
  const { t } = useT();
  const { data: roles, reload: reloadRoles } = useLive(() => api.get('/roles'), [], []);
  const { data: perms } = useLive(() => api.get('/permissions'), [], []);
  const [permFor, setPermFor] = useState(null);
  const [histFor, setHistFor] = useState(null);
  const [key, setKey] = useState(0);
  return (
    <>
      <CrudPage
        key={key}
        title="พนักงาน"
        icon={UserCog}
        endpoint="/employees"
        createPerm="employee.manage"
        editPerm="employee.manage"
        deletePerm="employee.manage"
        searchKeys={['name', 'position', 'phone', 'role']}
        defaults={{ roleId: roles?.find((r) => r.code === 'CASHIER')?.id, isActive: true, discountLimitPercent: 10 }}
        toForm={(r) => ({ id: r.id, name: r.name, photoUrl: r.photo_url, position: r.position, phone: r.phone, roleId: r.role_id, isActive: r.is_active, discountLimitPercent: r.discount_limit_percent, pin: '' })}
        toPayload={(f) => ({ ...f, roleId: Number(f.roleId), pin: f.pin || undefined })}
        columns={[
          { key: 'photo_url', label: 'รูป', type: 'image' },
          { label: 'ชื่อพนักงาน', render: (r) => <div><b>{r.name}</b><div className="xs muted">{r.position}</div></div> },
          { label: 'ตำแหน่ง/สิทธิ์', render: (r) => <Badge color="#8b5cf6">{t(r.role_name)}</Badge> },
          { key: 'phone', label: 'เบอร์โทรศัพท์' },
          { label: 'ส่วนลดสูงสุด', right: true, render: (r) => `${Number(r.discount_limit_percent)}%` },
          { label: 'สร้างเมื่อ', render: (r) => <span className="small">{fmtDateTime(r.created_at)}</span> },
          { label: 'เข้าระบบล่าสุด', render: (r) => <span className="small">{r.last_login_at ? fmtDateTime(r.last_login_at) : '-'}</span> },
          { label: 'สถานะ', render: (r) => (r.is_active ? <Badge color="#16a34a">{t('เปิดใช้งาน')}</Badge> : <Badge color="#dc2626">{t('ปิดใช้งาน')}</Badge>) },
        ]}
        rowActions={(r) => (
          <>
            <Button size="sm" variant="ghost" icon={ShieldCheck} title={t('กำหนดสิทธิ์')} onClick={() => setPermFor(r)} />
            <Button size="sm" variant="ghost" icon={History} title={t('ประวัติ')} onClick={() => setHistFor(r)} />
          </>
        )}
        fields={[
          { key: 'name', label: 'ชื่อพนักงาน', required: true },
          { key: 'pin', label: 'รหัสพนักงาน 4 หลัก', inputType: 'password', maxLength: 4, hint: 'เว้นว่างเมื่อแก้ไข = ใช้รหัสเดิม (เก็บแบบเข้ารหัส)' },
          { key: 'roleId', label: 'ระดับสิทธิ์', type: 'select', options: (roles || []).map((r) => ({ value: r.id, label: r.name })), required: true },
          { key: 'position', label: 'ตำแหน่ง' },
          { key: 'phone', label: 'เบอร์โทรศัพท์' },
          { key: 'discountLimitPercent', label: 'ให้ส่วนลดได้สูงสุด (%)', type: 'number' },
          { key: 'photoUrl', label: 'รูปพนักงาน (URL)', type: 'image', full: true },
          { key: 'isActive', label: 'สถานะ', type: 'switch', switchLabel: 'เปิดใช้งาน' },
        ]}
      />
      {permFor && <PermissionEditor emp={permFor} roles={roles || []} perms={perms || []} onClose={(changed) => { setPermFor(null); if (changed) { setKey((k) => k + 1); reloadRoles(); } }} />}
      {histFor && <HistoryModal emp={histFor} onClose={() => setHistFor(null)} />}
    </>
  );
}

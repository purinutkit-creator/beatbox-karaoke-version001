import { useState } from 'react';
import { Search, UserPlus, Crown } from 'lucide-react';
import { Input, Button, Badge, Modal, Field, useToast } from './ui.jsx';
import { useT } from '../lib/i18n.jsx';
import { api } from '../lib/api.js';

/** Find a member by phone / name / member code, or register a new one. */
export function MemberPicker({ onPick, initialPhone = '' }) {
  const { t } = useT();
  const toast = useToast();
  const [q, setQ] = useState(initialPhone);
  const [rows, setRows] = useState(null);
  const [creating, setCreating] = useState(null);
  const search = async () => {
    if (!q.trim()) return;
    try {
      setRows(await api.get(`/members?q=${encodeURIComponent(q.trim())}&limit=20`));
    } catch (e) {
      toast.error(e);
    }
  };
  const create = async () => {
    try {
      const m = await api.post('/members', creating);
      toast.success('สมัครสมาชิกเรียบร้อย');
      setCreating(null);
      onPick(m);
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <div className="col">
      <div className="row nowrap">
        <Input placeholder={t('เบอร์โทร / ชื่อ / รหัสสมาชิก')} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} />
        <Button icon={Search} onClick={search}>{t('ค้นหา')}</Button>
        <Button icon={UserPlus} onClick={() => setCreating({ firstName: '', phone: /^\d+$/.test(q) ? q : '' })}>{t('สมัคร')}</Button>
      </div>
      {rows && !rows.length && <div className="muted small">{t('ไม่พบสมาชิก')}</div>}
      {rows?.map((m) => (
        <button key={m.id} className="card flat row between" style={{ cursor: 'pointer', textAlign: 'left', padding: 10 }} onClick={() => onPick(m)}>
          <div>
            <b>{m.first_name} {m.last_name || ''}</b> {m.nickname && <span className="muted">({m.nickname})</span>}
            <div className="small muted">{m.phone} · {m.member_code}</div>
          </div>
          <div className="right">
            <Badge color={m.tier_color}><Crown size={12} /> {m.tier_name}</Badge>
            <div className="small">{Number(m.points_balance)} {t('คะแนน')}</div>
          </div>
        </button>
      ))}
      {creating && (
        <Modal title={t('สมัครสมาชิกใหม่')} onClose={() => setCreating(null)} footer={<Button variant="primary" onClick={create}>{t('บันทึก')}</Button>}>
          <div className="grid grid-2">
            <Field label="ชื่อ *"><Input value={creating.firstName} onChange={(e) => setCreating({ ...creating, firstName: e.target.value })} /></Field>
            <Field label="นามสกุล"><Input value={creating.lastName || ''} onChange={(e) => setCreating({ ...creating, lastName: e.target.value })} /></Field>
            <Field label="เบอร์โทรศัพท์ *"><Input value={creating.phone} onChange={(e) => setCreating({ ...creating, phone: e.target.value })} /></Field>
            <Field label="วันเกิด"><Input type="date" value={creating.birthday || ''} onChange={(e) => setCreating({ ...creating, birthday: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
    </div>
  );
}

import { useState } from 'react';
import { Users, Plus, Pencil, Crown, Coins, Gift, Search } from 'lucide-react';
import { PageHead, Button, Input, Modal, Field, Select, Switch, Textarea, Badge, Tabs, Loading, Empty, Drawer, Img, ImageUrlInput, money, useToast, useDialog, QRCode } from '../../components/ui.jsx';
import { StatusBadge } from '../../components/ReservationParts.jsx';
import { useT } from '../../lib/i18n.jsx';
import { api, uid } from '../../lib/api.js';
import { useAuth } from '../../lib/store.jsx';
import { useLive } from '../../lib/socket.js';
import { fmtDate, fmtDateTime } from '@beatbox/shared/format.js';

function MemberForm({ initial, tiers, onClose, onSaved }) {
  const { t } = useT();
  const toast = useToast();
  const [f, setF] = useState(
    initial?.id
      ? { firstName: initial.first_name, lastName: initial.last_name, nickname: initial.nickname, phone: initial.phone, birthday: initial.birthday, gender: initial.gender, email: initial.email, photoUrl: initial.photo_url, tierId: initial.tier_id, favoriteItems: initial.favorite_items, note: initial.note, status: initial.status, marketingConsent: initial.marketing_consent }
      : { firstName: '', phone: '', status: 'ACTIVE', marketingConsent: false },
  );
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => {
    try {
      if (initial?.id) await api.put(`/members/${initial.id}`, f);
      else await api.post('/members', f);
      toast.success('บันทึกเรียบร้อย');
      onSaved();
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <Modal title={initial?.id ? t('แก้ไขสมาชิก') : t('เพิ่มสมาชิก')} size="wide" onClose={onClose} footer={<Button variant="primary" onClick={save}>{t('บันทึก')}</Button>}>
      <div className="grid grid-2">
        <Field label="ชื่อ *"><Input value={f.firstName || ''} onChange={(e) => set('firstName', e.target.value)} /></Field>
        <Field label="นามสกุล"><Input value={f.lastName || ''} onChange={(e) => set('lastName', e.target.value)} /></Field>
        <Field label="ชื่อเล่น"><Input value={f.nickname || ''} onChange={(e) => set('nickname', e.target.value)} /></Field>
        <Field label="เบอร์โทรศัพท์ *"><Input value={f.phone || ''} onChange={(e) => set('phone', e.target.value)} /></Field>
        <Field label="วันเกิด"><Input type="date" value={f.birthday || ''} onChange={(e) => set('birthday', e.target.value)} /></Field>
        <Field label="เพศ"><Select value={f.gender || ''} onChange={(e) => set('gender', e.target.value)} options={['ชาย', 'หญิง', 'อื่นๆ']} placeholder="-" /></Field>
        <Field label="อีเมล"><Input value={f.email || ''} onChange={(e) => set('email', e.target.value)} /></Field>
        <Field label="ระดับสมาชิก"><Select value={f.tierId || ''} onChange={(e) => set('tierId', e.target.value ? Number(e.target.value) : null)} options={(tiers || []).map((x) => ({ value: x.id, label: x.name }))} placeholder="อัตโนมัติ" /></Field>
        <Field label="รูปภาพ (URL)" style={{ gridColumn: '1/-1' }}><ImageUrlInput value={f.photoUrl} onChange={(v) => set('photoUrl', v)} /></Field>
        <Field label="รายการโปรด"><Input value={f.favoriteItems || ''} onChange={(e) => set('favoriteItems', e.target.value)} /></Field>
        <Field label="สถานะสมาชิก"><Select value={f.status} onChange={(e) => set('status', e.target.value)} options={[{ value: 'ACTIVE', label: 'ใช้งาน' }, { value: 'INACTIVE', label: 'ไม่ใช้งาน' }, { value: 'BANNED', label: 'ระงับ' }]} /></Field>
        <Field label="หมายเหตุ" style={{ gridColumn: '1/-1' }}><Textarea value={f.note || ''} onChange={(e) => set('note', e.target.value)} /></Field>
        <Switch checked={f.marketingConsent} onChange={(v) => set('marketingConsent', v)} label="ยินยอมรับข่าวสารโปรโมชั่น" />
      </div>
    </Modal>
  );
}

function MemberDrawer({ id, tiers, onClose, onEdit }) {
  const { t } = useT();
  const toast = useToast();
  const { confirm } = useDialog();
  const { can } = useAuth();
  const { data: m, reload } = useLive(() => api.get(`/members/${id}`), ['members'], [id]);
  const { data: rewards } = useLive(() => api.get('/rewards'), [], []);
  const [tab, setTab] = useState('points');
  const [adj, setAdj] = useState(null);
  if (!m) return <Drawer title="..." onClose={onClose}><Loading /></Drawer>;
  const redeem = async (r) => {
    if (!(await confirm({ message: `${t('แลก')} ${r.name} (${r.points_cost} ${t('คะแนน')})?` }))) return;
    try {
      const rd = await api.post(`/members/${m.id}/redeem`, { rewardId: r.id }, { idempotencyKey: uid() });
      toast.success(`${t('รหัสแลกรางวัล')} ${rd.code}`);
      reload();
    } catch (e) {
      toast.error(e);
    }
  };
  const saveAdj = async () => {
    try {
      await api.post(`/members/${m.id}/points`, { points: Number(adj.points), reason: adj.reason }, { idempotencyKey: uid() });
      toast.success('บันทึกเรียบร้อย');
      setAdj(null);
      reload();
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <Drawer title={`${m.first_name} ${m.last_name || ''}`} onClose={onClose} actions={<Button size="sm" icon={Pencil} onClick={() => onEdit(m)}>{t('แก้ไข')}</Button>}>
      <div className="col">
        <div className="row nowrap card flat">
          <Img src={m.photo_url} style={{ width: 80, height: 80, borderRadius: 16, objectFit: 'cover' }} />
          <div className="grow">
            <div className="row"><b style={{ fontSize: '1.2rem' }}>{m.first_name} {m.last_name || ''}</b>{m.nickname && <span className="muted">({m.nickname})</span>}<Badge color={m.tier_color}><Crown size={12} /> {m.tier_name}</Badge>{m.line_connected && <Badge color="#06c755">LINE</Badge>}</div>
            <div className="muted">{m.member_code} · {m.phone} · {m.email || ''}</div>
            <div className="small muted">{t('วันเกิด')} {m.birthday ? fmtDate(m.birthday) : '-'} · {t('สมัคร')} {fmtDate(m.created_at)} ({m.source})</div>
          </div>
          <QRCode value={`MEMBER:${m.member_code}`} size={80} />
        </div>
        <div className="grid grid-4">
          <div className="card flat kpi"><div className="label">{t('คะแนนสะสม')}</div><div className="value" style={{ color: 'var(--primary)' }}>{Number(m.points_balance)}</div></div>
          <div className="card flat kpi"><div className="label">{t('ยอดใช้จ่ายสะสม')}</div><div className="value">฿{money(m.total_spending, 0)}</div></div>
          <div className="card flat kpi"><div className="label">{t('จำนวนครั้ง')}</div><div className="value">{m.visit_count}</div></div>
          <div className="card flat kpi"><div className="label">{t('ชั่วโมงสะสม')}</div><div className="value">{(m.total_minutes / 60).toFixed(1)}</div></div>
        </div>
        <div className="small muted">{t('ห้องที่ใช้บ่อย')}: {m.favorite_room || '-'} · {t('รายการโปรด')}: {m.favorite_items || m.topItems.map((x) => x.name).join(', ') || '-'}</div>
        {m.note && <div className="small">📝 {m.note}</div>}
        {can('member.points') && <div className="row"><Button icon={Coins} onClick={() => setAdj({ points: '', reason: '' })}>{t('เพิ่ม/ลดคะแนน')}</Button></div>}
        <Tabs value={tab} onChange={setTab} tabs={[{ value: 'points', label: 'ประวัติคะแนน' }, { value: 'rewards', label: 'แลกรางวัล' }, { value: 'orders', label: 'ประวัติการใช้บริการ' }, { value: 'bookings', label: 'ประวัติการจอง' }, { value: 'login', label: 'การเชื่อมบัญชี' }]} />
        {tab === 'points' && (
          <div className="table-wrap"><table className="table"><thead><tr><th>{t('วันเวลา')}</th><th>{t('ประเภท')}</th><th className="right">{t('คะแนน')}</th><th className="right">{t('คงเหลือ')}</th><th>{t('รายละเอียด')}</th></tr></thead>
            <tbody>{m.ledger.map((l) => <tr key={l.id}><td className="nowrap small">{fmtDateTime(l.created_at)}</td><td><Badge>{l.type}</Badge></td><td className="right num" style={{ color: l.points > 0 ? 'var(--ok)' : 'var(--danger)' }}>{l.points > 0 ? '+' : ''}{Number(l.points)}</td><td className="right num">{Number(l.balance_after)}</td><td className="small">{l.reason} {l.employee_name && `· ${l.employee_name}`}</td></tr>)}</tbody></table></div>
        )}
        {tab === 'rewards' && (
          <div className="col">
            {(rewards || []).filter((r) => r.is_active).map((r) => (
              <div key={r.id} className="row between card flat" style={{ padding: 10 }}>
                <span><Gift size={14} /> {r.name} <span className="muted">({r.points_cost} {t('คะแนน')})</span></span>
                <Button size="sm" disabled={!can('member.points') || Number(m.points_balance) < r.points_cost} onClick={() => redeem(r)}>{t('แลก')}</Button>
              </div>
            ))}
            <h3 className="mt">{t('รหัสที่แลกแล้ว')}</h3>
            {m.redemptions.map((rd) => <div key={rd.id} className="row between card flat small" style={{ padding: 10 }}><span><b>{rd.code}</b> · {rd.reward_name}</span><span><Badge>{rd.status}</Badge> {rd.expires_at && fmtDate(rd.expires_at)}</span></div>)}
          </div>
        )}
        {tab === 'orders' && m.orders.map((o) => <div key={o.id} className="row between card flat small" style={{ padding: 10 }}><span>{o.receipt_no} · {o.room_name || t('หน้าร้าน')} · {fmtDateTime(o.paid_at)}</span><span>฿{money(o.grand_total)} · +{o.points_earned}</span></div>)}
        {tab === 'bookings' && m.reservations.map((r) => <div key={r.id} className="row between card flat small" style={{ padding: 10 }}><span>{r.booking_no} · {r.room_name} · {fmtDateTime(r.start_at)}</span><StatusBadge status={r.status} /></div>)}
        {tab === 'login' && m.identities.map((i, k) => <div key={k} className="row between card flat small" style={{ padding: 10 }}><span><b>{i.provider}</b> {i.display_name || ''}</span><span>{i.status} · {fmtDateTime(i.linked_at)}</span></div>)}
      </div>
      {adj && (
        <Modal title={t('เพิ่ม/ลดคะแนน')} onClose={() => setAdj(null)} footer={<Button variant="primary" disabled={!Number(adj.points) || !adj.reason} onClick={saveAdj}>{t('บันทึก')}</Button>}>
          <div className="grid grid-2">
            <Field label="คะแนน (ติดลบ = ลด)"><Input type="number" value={adj.points} onChange={(e) => setAdj({ ...adj, points: e.target.value })} /></Field>
            <Field label="เหตุผล *"><Input value={adj.reason} onChange={(e) => setAdj({ ...adj, reason: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
    </Drawer>
  );
}

export default function Members() {
  const { t } = useT();
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(null);
  const [edit, setEdit] = useState(null);
  const { data, loading, reload } = useLive(() => api.get(`/members?q=${encodeURIComponent(query)}`), ['members'], [query]);
  const { data: tiers } = useLive(() => api.get('/member-tiers'), [], []);
  return (
    <div>
      <PageHead icon={Users} title="สมาชิก">
        <div className="row nowrap">
          <Input placeholder={t('เบอร์โทร / ชื่อ / รหัสสมาชิก')} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && setQuery(q)} />
          <Button icon={Search} onClick={() => setQuery(q)} />
        </div>
        {can('member.edit') && <Button variant="primary" icon={Plus} onClick={() => setEdit({})}>{t('เพิ่มสมาชิก')}</Button>}
      </PageHead>
      {loading ? <Loading /> : !data?.length ? <Empty /> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th /><th>{t('รหัสสมาชิก')}</th><th>{t('ชื่อ')}</th><th>{t('เบอร์โทรศัพท์')}</th><th>{t('ระดับ')}</th><th className="right">{t('คะแนน')}</th><th className="right">{t('ยอดสะสม')}</th><th className="right">{t('ครั้ง')}</th><th>{t('วันที่สมัคร')}</th><th>{t('สถานะ')}</th></tr></thead>
            <tbody>
              {data.map((m) => (
                <tr key={m.id} className="clickable" onClick={() => setOpen(m.id)}>
                  <td><Img src={m.photo_url} style={{ width: 36, height: 36, borderRadius: 99, objectFit: 'cover' }} /></td>
                  <td className="bold">{m.member_code}</td>
                  <td>{m.first_name} {m.last_name || ''} {m.nickname && <span className="muted">({m.nickname})</span>} {m.line_connected && <Badge color="#06c755">LINE</Badge>}</td>
                  <td>{m.phone}</td>
                  <td><Badge color={m.tier_color}>{m.tier_name}</Badge></td>
                  <td className="right num">{Number(m.points_balance)}</td>
                  <td className="right num">{money(m.total_spending, 0)}</td>
                  <td className="right">{m.visit_count}</td>
                  <td className="small">{fmtDate(m.created_at)}</td>
                  <td>{m.status === 'ACTIVE' ? <Badge color="#16a34a">{t('ใช้งาน')}</Badge> : <Badge color="#dc2626">{m.status}</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <MemberDrawer id={open} tiers={tiers} onClose={() => setOpen(null)} onEdit={(m) => setEdit(m)} />}
      {edit && <MemberForm initial={edit} tiers={tiers} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
    </div>
  );
}

// Super Owner console: all stores, the 4 packages (fully editable), trials / renewals / suspension with history,
// "เข้าจัดการร้าน" and the Super Owner's own password. The rights belong to the account (username + password), not a device.
import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Shield, Package, LogOut, Plus, Pencil, History, LogIn, KeyRound, RefreshCw, Globe, Search, Hash, Save } from 'lucide-react';
import { api, LS } from '../lib/api.js';
import { useAuth } from '../lib/store.jsx';
import { useT } from '../lib/i18n.jsx';
import { useServerNow } from '../lib/socket.js';
import { remainingParts, formatRemaining } from '@beatbox/shared/time.js';
import { BILLING_CYCLES } from '@beatbox/shared/plans.js';
import { Button, Modal, Field, Input, Textarea, Select, Switch, Tabs, Loading, Badge, useToast, useDialog, baht } from '../components/ui.jsx';
import { StatusBadge, fmtStoreDateTime, EVENT_LABEL, licenseLevel } from '../components/License.jsx';
import { CopyValue } from '../admin/pages/StoreAccount.jsx';

const papi = {
  get: (u) => api.get(`/platform${u}`, { platform: true }),
  post: (u, b) => api.post(`/platform${u}`, b, { platform: true }),
  put: (u, b) => api.put(`/platform${u}`, b, { platform: true }),
};

function PlatformLogin({ onDone }) {
  const { t, lang, setLang } = useT();
  const [f, setF] = useState({ username: '', password: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      const r = await api.post('/platform/login', f, { auth: false });
      LS.set('bb_platform_token', r.token);
      LS.set('bb_platform_user', r.user);
      onDone(r.user);
    } catch (er) {
      setErr(er.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login-wrap">
      <form className="card login-card col" onSubmit={submit} style={{ textAlign: 'left' }}>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button type="button" size="sm" variant="ghost" icon={Globe} onClick={() => setLang(lang === 'th' ? 'en' : 'th')}>{lang === 'th' ? 'EN' : 'TH'}</Button>
        </div>
        <div className="center"><Shield size={48} color="var(--accent)" /></div>
        <h2 className="center" style={{ margin: 0 }}>Super Owner</h2>
        <p className="muted center small">{t('ศูนย์จัดการร้านค้าทั้งหมด')}</p>
        {/* the login name is free text (no e-mail format check) */}
        <Field label="อีเมลหรือชื่อเข้าสู่ระบบ"><Input autoComplete="username" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} required /></Field>
        <Field label="รหัสผ่าน"><Input type="password" autoComplete="current-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required /></Field>
        {err && <div style={{ color: 'var(--danger)' }}>{t(err)}</div>}
        <Button type="submit" variant="primary" loading={busy} icon={LogIn}>{t('เข้าสู่ระบบ')}</Button>
        <a href="/login" className="small center">{t('กลับหน้าเข้าสู่ระบบร้าน')}</a>
      </form>
    </div>
  );
}

function Remaining({ sub }) {
  const { lang } = useT();
  const now = useServerNow(30000);
  if (!sub) return '-';
  const p = remainingParts(now, sub.expiresAt ? new Date(sub.expiresAt).getTime() : null, sub.timezone || 'Asia/Bangkok');
  const lv = licenseLevel(sub, now);
  return <span className="num" style={{ color: lv === 'expired' || lv === 'danger' ? 'var(--danger)' : lv === 'warn' ? 'var(--warn)' : undefined }}>{formatRemaining(p, lang)}</span>;
}

// ───── stores ─────
function StoreForm({ plans, onClose, onSaved }) {
  const { t } = useT();
  const toast = useToast();
  const [f, setF] = useState({ storeName: '', ownerFirstName: '', ownerLastName: '', email: '', phone: '', password: '', planId: plans[0]?.id || '', status: 'TRIAL', trialDays: plans[0]?.trialDays ?? 14, expiresAt: '', address: '' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target ? e.target.value : e });
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await papi.post('/stores', { ...f, planId: Number(f.planId), trialDays: Number(f.trialDays), expiresAt: f.expiresAt ? new Date(f.expiresAt).toISOString() : null });
      toast.success(t('เพิ่มร้านแล้ว'));
      onSaved();
      onClose({ kind: 'account', store: { id: r.storeId, name: f.storeName }, created: true });
    } catch (er) {
      toast.error(er);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} title={t('เพิ่มร้านค้า')} size="wide">
      <form className="col" onSubmit={save}>
        <div className="grid grid-2">
          <Field label="ชื่อร้าน *"><Input value={f.storeName} onChange={set('storeName')} required /></Field>
          <Field label="เบอร์โทร *"><Input value={f.phone} onChange={set('phone')} required /></Field>
          <Field label="ชื่อเจ้าของ *"><Input value={f.ownerFirstName} onChange={set('ownerFirstName')} required /></Field>
          <Field label="นามสกุลเจ้าของ *"><Input value={f.ownerLastName} onChange={set('ownerLastName')} required /></Field>
          <Field label="อีเมลเจ้าของ (ใช้เข้าสู่ระบบ) *"><Input type="email" value={f.email} onChange={set('email')} required /></Field>
          <Field label="รหัสผ่านเริ่มต้นของร้าน" hint="เว้นว่าง = ระบบสุ่มให้ · ดูได้ภายหลังที่ปุ่ม 'บัญชีร้าน' จนกว่าเจ้าของร้านจะเปลี่ยน"><Input autoComplete="new-password" minLength={8} value={f.password} onChange={set('password')} /></Field>
          <Field label="แพ็กเกจ"><Select value={f.planId} onChange={set('planId')} options={plans.map((p) => ({ value: p.id, label: p.name }))} /></Field>
          <Field label="สถานะเริ่มต้น"><Select value={f.status} onChange={set('status')} options={[{ value: 'TRIAL', label: 'ทดลองใช้' }, { value: 'ACTIVE', label: 'ใช้งานปกติ (1 รอบบิล)' }]} /></Field>
          {f.status === 'TRIAL' && <Field label="จำนวนวันทดลองใช้"><Input type="number" min={0} value={f.trialDays} onChange={set('trialDays')} /></Field>}
          <Field label="หรือกำหนดวันเวลาหมดอายุ" hint="ถ้ากรอก จะใช้ค่านี้แทนจำนวนวัน"><Input type="datetime-local" value={f.expiresAt} onChange={set('expiresAt')} /></Field>
          <Field label="ที่อยู่" style={{ gridColumn: '1 / -1' }}><Textarea rows={2} value={f.address} onChange={set('address')} /></Field>
        </div>
        <Button type="submit" variant="primary" loading={busy} icon={Plus}>{t('เพิ่มร้าน')}</Button>
      </form>
    </Modal>
  );
}

/** Store sign-in: store code, username / e-mail, starting password, owner PIN — view, reset and edit. */
function StoreAccount({ store, created, onClose, onSaved }) {
  const { t } = useT();
  const toast = useToast();
  const { confirm } = useDialog();
  const [acc, setAcc] = useState(null);
  const [f, setF] = useState(null);
  const [busy, setBusy] = useState(null);
  const apply = (a) => {
    setAcc(a);
    setF({ storeCode: a.storeCode || '', username: a.owner?.username || '', email: a.owner?.email || '' });
  };
  useEffect(() => {
    papi.get(`/stores/${store.id}/account`).then(apply).catch((e) => toast.error(e));
  }, [store.id]);
  const act = async (key, fn, msg) => {
    setBusy(key);
    try {
      const r = await fn();
      if (r?.storeCode) apply(r);
      toast.success(msg);
      onSaved?.();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };
  const resetPassword = async () => {
    if (!(await confirm({ title: 'รีเซ็ตรหัสผ่านของร้าน', message: 'ระบบจะสร้างรหัสผ่านเริ่มต้นใหม่ รหัสผ่านเดิมจะใช้ไม่ได้ (เครื่องที่เข้าร้านไว้แล้วยังใช้ PIN ได้ตามปกติ)', okText: 'รีเซ็ต' }))) return;
    act('pw', () => papi.post(`/stores/${store.id}/reset-password`, {}), 'สร้างรหัสผ่านเริ่มต้นใหม่แล้ว');
  };
  const resetPin = async () => {
    if (!(await confirm({ title: 'รีเซ็ต PIN เจ้าของร้าน', message: 'PIN เจ้าของร้านจะกลับเป็น 1234', okText: 'รีเซ็ต' }))) return;
    act('pin', () => papi.post(`/stores/${store.id}/reset-owner-pin`, {}), 'รีเซ็ต PIN แล้ว');
  };
  const signOut = async () => {
    if (!(await confirm({ title: 'ออกจากระบบทุกเครื่อง', message: 'ทุกเครื่องของร้านนี้ต้องกรอกรหัสร้านค้าและบัญชีร้านใหม่', danger: true, okText: 'ออกจากระบบทุกเครื่อง' }))) return;
    act('out', () => papi.post(`/stores/${store.id}/sign-out-devices`, {}), 'ออกจากระบบทุกเครื่องแล้ว');
  };
  const o = acc?.owner || {};
  return (
    <Modal onClose={onClose} title={`${t('บัญชีร้าน')} · ${store.name}`} size="wide">
      {!acc || !f ? <Loading /> : (
        <div className="col">
          {created && <div className="card flat small" style={{ borderColor: 'var(--ok)' }}>{t('สร้างร้านแล้ว — ส่งข้อมูลด้านล่างให้เจ้าของร้านเพื่อเข้าใช้งาน')}</div>}
          <div className="small muted">{t('ขั้นตอนเข้าใช้งาน: รหัสร้านค้า → ชื่อผู้ใช้ / อีเมล + รหัสผ่าน → PIN พนักงาน (เจ้าของร้านเริ่มต้น 1234)')}</div>
          <div className="grid grid-2">
            <Field label="รหัสร้านค้า"><CopyValue value={acc.storeCode} /></Field>
            <Field label="ชื่อผู้ใช้"><CopyValue value={o.username || '-'} /></Field>
            <Field label="อีเมล"><CopyValue value={o.email || '-'} mono={false} /></Field>
            <Field label="รหัสผ่านเริ่มต้น">
              {o.startingPassword ? <CopyValue value={o.startingPassword} /> : <div className="small muted">{t('เจ้าของร้านตั้งรหัสผ่านเองแล้ว (ไม่แสดง) — กดรีเซ็ตเพื่อสร้างรหัสเริ่มต้นใหม่')}</div>}
            </Field>
            <Field label="PIN เจ้าของร้าน">{o.pin ? <CopyValue value={o.pin} /> : <div className="small muted">{t('เจ้าของร้านตั้ง PIN เองแล้ว (ไม่แสดง)')}</div>}</Field>
          </div>
          <div className="row">
            <Button icon={KeyRound} loading={busy === 'pw'} onClick={resetPassword}>{t('รีเซ็ตรหัสผ่าน')}</Button>
            <Button icon={Hash} loading={busy === 'pin'} onClick={resetPin}>{t('รีเซ็ต PIN เจ้าของเป็น 1234')}</Button>
            <Button variant="danger" icon={LogOut} loading={busy === 'out'} onClick={signOut}>{t('ออกจากระบบทุกเครื่อง')}</Button>
          </div>
          <h4>{t('แก้ไข')}</h4>
          <div className="grid grid-3">
            <Field label="รหัสร้านค้า (a-z 0-9 รวม 8 ตัว)"><Input value={f.storeCode} onChange={(e) => setF({ ...f, storeCode: e.target.value.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) })} style={{ fontFamily: 'ui-monospace, monospace', letterSpacing: 2 }} /></Field>
            <Field label="ชื่อผู้ใช้"><Input value={f.username} autoCapitalize="off" onChange={(e) => setF({ ...f, username: e.target.value })} /></Field>
            <Field label="อีเมล"><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          </div>
          <div className="row end"><Button variant="primary" icon={Save} loading={busy === 'save'} onClick={() => act('save', () => papi.put(`/stores/${store.id}/account`, f), 'บันทึกเรียบร้อย')}>{t('บันทึก')}</Button></div>
        </div>
      )}
    </Modal>
  );
}

function StoreEdit({ store, onClose, onSaved }) {
  const { t } = useT();
  const toast = useToast();
  const [f, setF] = useState({ name: store.name, slug: store.slug, phone: store.phone || '', address: store.address || '', ownerName: store.owner_name || '' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await papi.put(`/stores/${store.id}`, f);
      toast.success(t('บันทึกแล้ว'));
      onSaved();
      onClose();
    } catch (er) {
      toast.error(er);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} title={`${t('แก้ไขร้าน')}: ${store.name}`}>
      <form className="col" onSubmit={save}>
        <Field label="ชื่อร้าน"><Input value={f.name} onChange={set('name')} required /></Field>
        <Field label="รหัสร้านในลิงก์ (slug)" hint="ใช้ในลิงก์เว็บไซต์จอง / สมัครสมาชิก เช่น /book?store=slug"><Input value={f.slug} onChange={set('slug')} /></Field>
        <Field label="ชื่อเจ้าของ"><Input value={f.ownerName} onChange={set('ownerName')} /></Field>
        <Field label="เบอร์โทร"><Input value={f.phone} onChange={set('phone')} /></Field>
        <Field label="ที่อยู่"><Textarea rows={2} value={f.address} onChange={set('address')} /></Field>
        <Button type="submit" variant="primary" loading={busy}>{t('บันทึก')}</Button>
      </form>
    </Modal>
  );
}

const ACTIONS = [
  { value: 'TRIAL', label: 'ให้ทดลองใช้แพ็กเกจ (เริ่มใหม่)' },
  { value: 'EXTEND_TRIAL', label: 'เพิ่มวันทดลองใช้' },
  { value: 'RENEW', label: 'ต่ออายุ (ชำระแล้ว)' },
  { value: 'CHANGE_PLAN', label: 'เปลี่ยนแพ็กเกจ (วันหมดอายุเดิม)' },
  { value: 'SET_EXPIRY', label: 'กำหนดวันเวลาหมดอายุเอง' },
  { value: 'SUSPEND', label: 'ระงับการใช้งาน' },
  { value: 'ACTIVATE', label: 'เปิดใช้งาน (ยกเลิกการระงับ)' },
];

function SubscriptionAction({ store, plans, onClose, onSaved }) {
  const { t, lang } = useT();
  const toast = useToast();
  const sub = store.subscription;
  const [f, setF] = useState({ action: store.is_active ? 'RENEW' : 'ACTIVATE', planId: sub?.plan?.id || plans[0]?.id, days: 7, periods: 1, expiresAt: '', mode: 'days', reason: '', note: '' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e?.target ? e.target.value : e });
  const plan = plans.find((p) => p.id === Number(f.planId));
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const body = { action: f.action, planId: Number(f.planId) || null, reason: f.reason || null, note: f.note || null };
      if (['TRIAL', 'EXTEND_TRIAL'].includes(f.action)) {
        if (f.mode === 'date') body.expiresAt = f.expiresAt ? new Date(f.expiresAt).toISOString() : null;
        else body.days = Number(f.days);
      }
      if (f.action === 'RENEW') {
        if (f.mode === 'date') body.expiresAt = f.expiresAt ? new Date(f.expiresAt).toISOString() : null;
        else body.periods = Number(f.periods);
      }
      if (f.action === 'SET_EXPIRY') body.expiresAt = f.expiresAt ? new Date(f.expiresAt).toISOString() : null;
      await papi.post(`/stores/${store.id}/subscription`, body);
      toast.success(t('บันทึกแล้ว'));
      onSaved();
      onClose();
    } catch (er) {
      toast.error(er);
    } finally {
      setBusy(false);
    }
  };
  const needsPlan = ['TRIAL', 'RENEW', 'CHANGE_PLAN'].includes(f.action);
  const dateOrDays = ['TRIAL', 'EXTEND_TRIAL', 'RENEW'].includes(f.action);
  return (
    <Modal onClose={onClose} title={`${t('แพ็กเกจและอายุการใช้งาน')}: ${store.name}`}>
      <form className="col" onSubmit={save}>
        <div className="card flat small">
          {t('ปัจจุบัน')}: <b>{sub?.plan?.name || '-'}</b> · <StatusBadge status={sub?.status} /> · {t('หมดอายุ')} {sub?.expiresAt ? fmtStoreDateTime(sub.expiresAt, sub.timezone, lang) : t('ไม่มีวันหมดอายุ')}
        </div>
        <Field label="การดำเนินการ"><Select value={f.action} onChange={set('action')} options={ACTIONS} /></Field>
        {needsPlan && <Field label="แพ็กเกจ"><Select value={f.planId} onChange={set('planId')} options={plans.map((p) => ({ value: p.id, label: `${p.name} — ${baht(p.price, 0)}/${p.billingInterval > 1 ? p.billingInterval : ''}${t(BILLING_CYCLES[p.billingCycle])}` }))} /></Field>}
        {dateOrDays && (
          <Field label="กำหนดเป็น">
            <Select value={f.mode} onChange={set('mode')} options={[{ value: 'days', label: f.action === 'RENEW' ? 'จำนวนรอบบิล' : 'จำนวนวัน' }, { value: 'date', label: 'วันและเวลาสิ้นสุด' }]} />
          </Field>
        )}
        {dateOrDays && f.mode === 'days' && f.action !== 'RENEW' && <Field label="จำนวนวัน" hint={f.action === 'EXTEND_TRIAL' ? 'นับต่อจากวันหมดอายุเดิม (หรือจากตอนนี้ถ้าหมดอายุแล้ว)' : 'นับจากตอนนี้'}><Input type="number" min={1} value={f.days} onChange={set('days')} /></Field>}
        {f.action === 'RENEW' && f.mode === 'days' && (
          <Field label="จำนวนรอบบิล" hint={plan ? `${t('1 รอบ')} = ${plan.billingInterval} ${t(BILLING_CYCLES[plan.billingCycle])} · ${t('นับต่อจากวันหมดอายุเดิม (หรือจากตอนนี้ถ้าหมดอายุแล้ว)')}` : ''}>
            <Input type="number" min={1} value={f.periods} onChange={set('periods')} />
          </Field>
        )}
        {((dateOrDays && f.mode === 'date') || f.action === 'SET_EXPIRY') && <Field label="วันและเวลาหมดอายุ" hint={f.action === 'SET_EXPIRY' ? 'เว้นว่าง = ไม่มีวันหมดอายุ' : ''}><Input type="datetime-local" value={f.expiresAt} onChange={set('expiresAt')} required={f.action !== 'SET_EXPIRY'} /></Field>}
        {f.action === 'SUSPEND' && <Field label="เหตุผลการระงับ *"><Input value={f.reason} onChange={set('reason')} required /></Field>}
        <Field label="หมายเหตุ (บันทึกในประวัติ)"><Input value={f.note} onChange={set('note')} /></Field>
        <Button type="submit" variant={f.action === 'SUSPEND' ? 'danger' : 'primary'} loading={busy}>{t('ยืนยัน')}</Button>
      </form>
    </Modal>
  );
}

function StoreEvents({ store, onClose }) {
  const { t, lang } = useT();
  const [rows, setRows] = useState(null);
  useEffect(() => {
    papi.get(`/stores/${store.id}/events`).then(setRows).catch(() => setRows([]));
  }, [store.id]);
  return (
    <Modal onClose={onClose} title={`${t('ประวัติ')}: ${store.name}`} size="wide">
      {!rows ? <Loading /> : (
        <div className="table-wrap">
          <table className="table small">
            <thead><tr><th>{t('เวลา')}</th><th>{t('รายการ')}</th><th>{t('ก่อน')}</th><th>{t('หลัง')}</th><th>{t('โดย')}</th></tr></thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id}>
                  <td className="num">{fmtStoreDateTime(e.created_at, 'Asia/Bangkok', lang)}</td>
                  <td>{t(EVENT_LABEL[e.action] || e.action)}{e.note ? <div className="xs muted">{e.note}</div> : null}</td>
                  <td className="xs">{describe(e.before, t, lang)}</td>
                  <td className="xs">{describe(e.after, t, lang)}</td>
                  <td>{e.actor_name || e.actor_type}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

function describe(v, t, lang) {
  if (!v) return '-';
  const out = [];
  if (v.planName) out.push(v.planName);
  if (v.status) out.push(t({ TRIAL: 'ทดลองใช้', ACTIVE: 'ใช้งานปกติ' }[v.status] || v.status));
  if ('expiresAt' in v) out.push(v.expiresAt ? fmtStoreDateTime(v.expiresAt, 'Asia/Bangkok', lang) : t('ไม่มีวันหมดอายุ'));
  if (v.storeActive === false) out.push(t('ถูกระงับ'));
  if (v.name) out.push(v.name);
  return out.join(' · ') || '-';
}

function StoresTab({ plans }) {
  const { t, lang } = useT();
  const toast = useToast();
  const { applyLogin } = useAuth();
  const nav = useNavigate();
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');
  const [modal, setModal] = useState(null);
  const load = useCallback(() => papi.get('/stores').then(setRows).catch((e) => toast.error(e)), []);
  useEffect(() => {
    load();
  }, [load]);
  const enter = async (s) => {
    try {
      const r = await papi.post(`/stores/${s.id}/enter`);
      await applyLogin(r);
      nav('/admin/rooms');
    } catch (e) {
      toast.error(e);
    }
  };
  if (!rows) return <Loading />;
  const list = rows.filter((s) => !q || `${s.name} ${s.slug} ${s.store_code} ${s.owner_email || ''} ${s.owner_name || ''} ${s.phone || ''}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="col">
      <div className="row">
        <div className="row grow nowrap" style={{ maxWidth: 360 }}><Search size={16} /><Input placeholder={t('ค้นหาร้าน')} value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <Button icon={RefreshCw} onClick={load}>{t('รีเฟรช')}</Button>
        <Button variant="primary" icon={Plus} onClick={() => setModal({ kind: 'create' })}>{t('เพิ่มร้านค้า')}</Button>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr><th>{t('ร้าน')}</th><th>{t('เจ้าของ')}</th><th>{t('แพ็กเกจ')}</th><th>{t('สถานะ')}</th><th>{t('หมดอายุ')}</th><th>{t('คงเหลือ')}</th><th>{t('ข้อมูล')}</th><th /></tr>
          </thead>
          <tbody>
            {list.map((s) => (
              <tr key={s.id}>
                <td><b>{s.name}</b><div className="xs muted">#{s.id} · {t('รหัสร้าน')} <code>{s.store_code}</code></div></td>
                <td className="small">{s.owner_name || '-'}<div className="xs muted">{s.owner_email || ''} {s.phone || ''}</div></td>
                <td>{s.plan_name || '-'}</td>
                <td><StatusBadge status={s.subscription?.status} />{Number(s.open_requests) > 0 && <div><Badge color="#f59e0b">{t('ขอต่ออายุ')}</Badge></div>}</td>
                <td className="small num">{s.expires_at ? fmtStoreDateTime(s.expires_at, s.subscription?.timezone, lang) : t('ไม่มีวันหมดอายุ')}</td>
                <td className="small"><Remaining sub={s.subscription} /></td>
                <td className="xs muted">{t('ห้อง')} {s.rooms} · {t('พนักงาน')} {s.employees} · {t('บิล')} {s.orders}</td>
                <td>
                  <div className="row nowrap">
                    <Button size="sm" variant="primary" icon={LogIn} onClick={() => enter(s)}>{t('เข้าจัดการร้าน')}</Button>
                    <Button size="sm" icon={KeyRound} onClick={() => setModal({ kind: 'account', store: s })}>{t('บัญชีร้าน')}</Button>
                    <Button size="sm" icon={Package} onClick={() => setModal({ kind: 'sub', store: s })}>{t('แพ็กเกจ')}</Button>
                    <Button size="sm" variant="ghost icon" icon={Pencil} title={t('แก้ไข')} onClick={() => setModal({ kind: 'edit', store: s })} />
                    <Button size="sm" variant="ghost icon" icon={History} title={t('ประวัติ')} onClick={() => setModal({ kind: 'events', store: s })} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {modal?.kind === 'create' && <StoreForm plans={plans} onClose={(next) => setModal(next || null)} onSaved={load} />}
      {modal?.kind === 'account' && <StoreAccount store={modal.store} created={modal.created} onClose={() => setModal(null)} onSaved={load} />}
      {modal?.kind === 'edit' && <StoreEdit store={modal.store} onClose={() => setModal(null)} onSaved={load} />}
      {modal?.kind === 'sub' && <SubscriptionAction store={modal.store} plans={plans} onClose={() => setModal(null)} onSaved={load} />}
      {modal?.kind === 'events' && <StoreEvents store={modal.store} onClose={() => setModal(null)} />}
    </div>
  );
}

// ───── plans ─────
function PlanEditor({ plan, features, limits, onSaved }) {
  const { t } = useT();
  const toast = useToast();
  const [f, setF] = useState(plan);
  const [busy, setBusy] = useState(false);
  useEffect(() => setF(plan), [plan]);
  const save = async () => {
    setBusy(true);
    try {
      const limitsOut = Object.fromEntries(limits.map((l) => [l.key, f.limits?.[l.key] === '' || f.limits?.[l.key] == null ? null : Number(f.limits[l.key])]));
      await papi.put(`/plans/${plan.id}`, { ...f, price: Number(f.price), billingInterval: Number(f.billingInterval), trialDays: Number(f.trialDays), limits: limitsOut });
      toast.success(t('บันทึกแพ็กเกจแล้ว — ร้านที่ใช้แพ็กเกจนี้ได้รับสิทธิ์ใหม่ทันที'));
      onSaved();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card col">
      <div className="grid grid-2">
        <Field label="ชื่อแพ็กเกจ"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="ราคา (บาท)"><Input type="number" min={0} value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} /></Field>
        <Field label="รอบบิล">
          <div className="row nowrap">
            <Input type="number" min={1} style={{ width: 90 }} value={f.billingInterval} onChange={(e) => setF({ ...f, billingInterval: e.target.value })} />
            <Select value={f.billingCycle} onChange={(e) => setF({ ...f, billingCycle: e.target.value })} options={Object.entries(BILLING_CYCLES).map(([value, label]) => ({ value, label }))} />
          </div>
        </Field>
        <Field label="จำนวนวันทดลองใช้เมื่อสมัคร" hint="0 = ไม่มีทดลองใช้"><Input type="number" min={0} value={f.trialDays} onChange={(e) => setF({ ...f, trialDays: e.target.value })} /></Field>
        <Field label="คำอธิบาย" style={{ gridColumn: '1 / -1' }}><Textarea rows={2} value={f.description || ''} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      </div>
      <Switch checked={f.isPublic} onChange={(v) => setF({ ...f, isPublic: v })} label="เปิดให้สมัครใช้งาน (แสดงในหน้าสมัคร)" />
      <h4 style={{ margin: '8px 0 0' }}>{t('สิทธิ์การใช้งานฟังก์ชัน')}</h4>
      <div className="grid grid-2">
        {features.map((x) => (
          <Switch key={x.key} checked={!!f.features?.[x.key]} onChange={(v) => setF({ ...f, features: { ...f.features, [x.key]: v } })} label={x.label} />
        ))}
      </div>
      <h4 style={{ margin: '8px 0 0' }}>{t('ข้อจำกัด (เว้นว่าง = ไม่จำกัด)')}</h4>
      <div className="grid grid-2">
        {limits.map((l) => (
          <Field key={l.key} label={l.label}>
            <Input type="number" min={0} value={f.limits?.[l.key] ?? ''} onChange={(e) => setF({ ...f, limits: { ...f.limits, [l.key]: e.target.value } })} />
          </Field>
        ))}
      </div>
      <Button variant="primary" loading={busy} onClick={save}>{t('บันทึกแพ็กเกจ')}</Button>
    </div>
  );
}

function PlansTab({ data, reload }) {
  const [sel, setSel] = useState(data.plans[0]?.id);
  const plan = data.plans.find((p) => p.id === sel) || data.plans[0];
  return (
    <div className="col">
      <Tabs value={plan?.id} onChange={setSel} tabs={data.plans.map((p) => ({ value: p.id, label: p.name }))} />
      {plan && <PlanEditor plan={plan} features={data.features} limits={data.limits} onSaved={reload} />}
    </div>
  );
}

// ───── renewal requests / settings / account ─────
function RequestsTab() {
  const { t, lang } = useT();
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const load = () => papi.get('/renewal-requests').then(setRows).catch((e) => toast.error(e));
  useEffect(() => {
    load();
  }, []);
  if (!rows) return <Loading />;
  const mark = async (id, st) => {
    await papi.post(`/renewal-requests/${id}/${st}`).catch((e) => toast.error(e));
    load();
  };
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr><th>{t('เวลา')}</th><th>{t('ร้าน')}</th><th>{t('แพ็กเกจที่ขอ')}</th><th>{t('ข้อความ')}</th><th>{t('ผู้ขอ')}</th><th>{t('สถานะ')}</th><th /></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="small num">{fmtStoreDateTime(r.created_at, 'Asia/Bangkok', lang)}</td>
              <td>{r.store_name}</td>
              <td>{r.plan_name || '-'}</td>
              <td className="small">{r.message || '-'}</td>
              <td className="small">{r.requested_by}</td>
              <td>{r.status}</td>
              <td>
                {r.status === 'OPEN' && (
                  <div className="row nowrap">
                    <Button size="sm" variant="primary" onClick={() => mark(r.id, 'DONE')}>{t('ดำเนินการแล้ว')}</Button>
                    <Button size="sm" onClick={() => mark(r.id, 'REJECTED')}>{t('ปฏิเสธ')}</Button>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SettingsTab() {
  const { t } = useT();
  const toast = useToast();
  const [s, setS] = useState(null);
  useEffect(() => {
    papi.get('/settings').then((d) => setS(d.signup)).catch((e) => toast.error(e));
  }, []);
  if (!s) return <Loading />;
  const save = async () => {
    try {
      await papi.put('/settings', { signup: { enabled: !!s.enabled, contactPhone: s.contactPhone || '', contactLine: s.contactLine || '', contactEmail: s.contactEmail || '' } });
      toast.success(t('บันทึกแล้ว'));
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <div className="card col" style={{ maxWidth: 560 }}>
      <Switch checked={s.enabled !== false} onChange={(v) => setS({ ...s, enabled: v })} label="เปิดรับสมัครร้านค้าใหม่ (หน้า /register)" />
      <h4 style={{ margin: '6px 0 0' }}>{t('ช่องทางติดต่อผู้ดูแล (แสดงในหน้าแพ็กเกจหมดอายุ)')}</h4>
      <Field label="เบอร์โทร"><Input value={s.contactPhone || ''} onChange={(e) => setS({ ...s, contactPhone: e.target.value })} /></Field>
      <Field label="LINE ID"><Input value={s.contactLine || ''} onChange={(e) => setS({ ...s, contactLine: e.target.value })} /></Field>
      <Field label="อีเมล"><Input value={s.contactEmail || ''} onChange={(e) => setS({ ...s, contactEmail: e.target.value })} /></Field>
      <Button variant="primary" onClick={save}>{t('บันทึก')}</Button>
    </div>
  );
}

function AccountTab({ user }) {
  const { t } = useT();
  const toast = useToast();
  const [f, setF] = useState({ current: '', password: '', confirm: '' });
  const save = async (e) => {
    e.preventDefault();
    if (f.password !== f.confirm) return toast.error(t('รหัสผ่านใหม่และการยืนยันไม่ตรงกัน'));
    try {
      await papi.post('/password', { current: f.current, password: f.password });
      toast.success(t('เปลี่ยนรหัสผ่านแล้ว (อุปกรณ์อื่นที่เข้าสู่ระบบอยู่จะถูกออกจากระบบ)'));
      setF({ current: '', password: '', confirm: '' });
    } catch (er) {
      toast.error(er);
    }
  };
  return (
    <form className="card col" style={{ maxWidth: 480 }} onSubmit={save}>
      <div><span className="muted small">{t('ชื่อเข้าสู่ระบบ')}</span><div className="bold">{user?.username}</div></div>
      {user?.email && <div><span className="muted small">{t('อีเมล')}</span><div className="bold">{user.email}</div></div>}
      <Field label="รหัสผ่านปัจจุบัน"><Input type="password" autoComplete="current-password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} required /></Field>
      <Field label="รหัสผ่านใหม่ (อย่างน้อย 8 ตัวอักษร)"><Input type="password" autoComplete="new-password" minLength={8} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required /></Field>
      <Field label="ยืนยันรหัสผ่านใหม่"><Input type="password" autoComplete="new-password" minLength={8} value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} required /></Field>
      <Button type="submit" variant="primary" icon={KeyRound}>{t('เปลี่ยนรหัสผ่าน')}</Button>
    </form>
  );
}

export default function PlatformApp() {
  const { t, lang, setLang } = useT();
  const dialog = useDialog();
  const [user, setUser] = useState(LS.get('bb_platform_token') ? LS.get('bb_platform_user') : null);
  const [tab, setTab] = useState('stores');
  const [plans, setPlans] = useState(null);
  const loadPlans = useCallback(() => papi.get('/plans').then(setPlans).catch(() => {}), []);
  useEffect(() => {
    if (!user) return;
    papi.get('/me').then((d) => setUser(d.user)).catch(() => {});
    loadPlans();
  }, [user?.id]);
  useEffect(() => {
    const h = () => {
      LS.set('bb_platform_token', null);
      setUser(null);
    };
    window.addEventListener('bb:platform-unauthorized', h);
    return () => window.removeEventListener('bb:platform-unauthorized', h);
  }, []);
  if (!user) return <PlatformLogin onDone={setUser} />;
  const logout = async () => {
    if (!(await dialog.confirm({ title: 'ออกจากระบบ Super Owner?', message: 'ออกจากระบบ Super Owner?' }))) return;
    await papi.post('/logout').catch(() => {});
    LS.set('bb_platform_token', null);
    LS.set('bb_platform_user', null);
    setUser(null);
  };
  return (
    <div className="platform">
      <header className="topbar">
        <Shield size={20} color="var(--accent)" />
        <b>Super Owner</b>
        <span className="muted small hide-sm">{t('ศูนย์จัดการร้านค้าทั้งหมด')}</span>
        <div className="grow" />
        <span className="small">{user.displayName || user.username}</span>
        <Button variant="ghost" size="sm" icon={Globe} onClick={() => setLang(lang === 'th' ? 'en' : 'th')}>{lang === 'th' ? 'EN' : 'TH'}</Button>
        <Button variant="ghost icon" icon={LogOut} title={t('ออกจากระบบ')} onClick={logout} />
      </header>
      <main className="content">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'stores', label: 'ร้านค้าทั้งหมด' },
            { value: 'plans', label: 'แพ็กเกจและสิทธิ์' },
            { value: 'requests', label: 'คำขอต่ออายุ' },
            { value: 'settings', label: 'ตั้งค่าการสมัคร' },
            { value: 'account', label: 'บัญชีของฉัน' },
          ]}
        />
        <div className="mt">
          {!plans ? <Loading /> : tab === 'stores' ? <StoresTab plans={plans.plans} /> : tab === 'plans' ? <PlansTab data={plans} reload={loadPlans} /> : tab === 'requests' ? <RequestsTab /> : tab === 'settings' ? <SettingsTab /> : <AccountTab user={user} />}
        </div>
      </main>
    </div>
  );
}


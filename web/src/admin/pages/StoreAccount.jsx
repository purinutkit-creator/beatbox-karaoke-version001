// ตั้งค่าร้าน → บัญชีร้าน & PIN: how devices sign in to this store (store code + store account) and staff PINs.
// The owner sees the starting password / PIN until they change them, and can change everything.
import { useEffect, useState } from 'react';
import { Store, KeyRound, Copy, Eye, EyeOff, LogOut, Save, Hash, User } from 'lucide-react';
import { Button, Field, Input, Loading, Badge, useToast, useDialog } from '../../components/ui.jsx';
import { useT } from '../../lib/i18n.jsx';
import { api, storeSession } from '../../lib/api.js';
import { useAuth } from '../../lib/store.jsx';

export function CopyValue({ value, mono = true, secret = false }) {
  const { t } = useT();
  const toast = useToast();
  const [show, setShow] = useState(!secret);
  return (
    <div className="row nowrap">
      <code className="grow" style={{ background: 'var(--surface-2)', padding: '8px 10px', borderRadius: 8, fontSize: '1.05rem', letterSpacing: mono ? 1 : 0 }}>{show ? value : '••••••••••'}</code>
      {secret && <Button size="sm" variant="ghost" icon={show ? EyeOff : Eye} title={t(show ? 'ซ่อน' : 'แสดง')} onClick={() => setShow(!show)} />}
      <Button size="sm" variant="ghost" icon={Copy} title={t('คัดลอก')} onClick={() => navigator.clipboard?.writeText(value).then(() => toast.success('คัดลอกแล้ว'))} />
    </div>
  );
}

function MyPin() {
  const { t } = useT();
  const toast = useToast();
  const [f, setF] = useState({ current: '', pin: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const save = async (e) => {
    e.preventDefault();
    if (f.pin !== f.confirm) return toast.error('PIN ใหม่และการยืนยันไม่ตรงกัน');
    setBusy(true);
    try {
      await api.post('/auth/my-pin', { current: f.current, pin: f.pin });
      toast.success('เปลี่ยน PIN แล้ว');
      setF({ current: '', pin: '', confirm: '' });
    } catch (er) {
      toast.error(er);
    } finally {
      setBusy(false);
    }
  };
  const digits = (v) => v.replace(/\D/g, '').slice(0, 4);
  return (
    <form className="card" onSubmit={save}>
      <h3 className="row nowrap"><Hash size={18} /> {t('เปลี่ยน PIN ของฉัน')}</h3>
      <div className="grid grid-3">
        <Field label="PIN ปัจจุบัน"><Input type="password" inputMode="numeric" value={f.current} onChange={(e) => setF({ ...f, current: digits(e.target.value) })} required /></Field>
        <Field label="PIN ใหม่ (4 หลัก)"><Input type="password" inputMode="numeric" value={f.pin} onChange={(e) => setF({ ...f, pin: digits(e.target.value) })} required /></Field>
        <Field label="ยืนยัน PIN ใหม่"><Input type="password" inputMode="numeric" value={f.confirm} onChange={(e) => setF({ ...f, confirm: digits(e.target.value) })} required /></Field>
      </div>
      <div className="row end"><Button type="submit" variant="primary" icon={Save} loading={busy} disabled={f.pin.length !== 4}>{t('บันทึก PIN')}</Button></div>
    </form>
  );
}

export default function StoreAccountTab() {
  const { t } = useT();
  const toast = useToast();
  const { confirm } = useDialog();
  const { employee, setStoreLogin } = useAuth();
  const isOwner = employee?.isOwner || employee?.platformUserId;
  const [acc, setAcc] = useState(null);
  const [f, setF] = useState({ username: '', email: '', storeCode: '' });
  const [pw, setPw] = useState({ current: '', password: '', confirm: '' });
  const [busy, setBusy] = useState(null);
  const apply = (a) => {
    setAcc(a);
    setF({ username: a.owner?.username || '', email: a.owner?.email || '', storeCode: a.storeCode || '' });
    // this device's PIN screen shows the (new) store code
    const info = storeSession.info();
    if (info && info.id === a.storeId && info.code !== a.storeCode) {
      storeSession.set(storeSession.get(), { ...info, code: a.storeCode });
      setStoreLogin({ ...info, code: a.storeCode });
    }
  };
  useEffect(() => {
    if (isOwner) api.get('/auth/store-account').then(apply).catch((e) => toast.error(e));
  }, [isOwner]);
  const save = async () => {
    setBusy('save');
    try {
      apply(await api.put('/auth/store-account', { username: f.username.trim(), email: f.email.trim(), storeCode: f.storeCode.trim() }));
      toast.success('บันทึกเรียบร้อย');
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };
  const changePassword = async (e) => {
    e.preventDefault();
    if (pw.password !== pw.confirm) return toast.error('รหัสผ่านใหม่และการยืนยันไม่ตรงกัน');
    setBusy('pw');
    try {
      await api.post('/auth/password', { current: pw.current, password: pw.password });
      toast.success('เปลี่ยนรหัสผ่านแล้ว');
      setPw({ current: '', password: '', confirm: '' });
      apply(await api.get('/auth/store-account'));
    } catch (er) {
      toast.error(er);
    } finally {
      setBusy(null);
    }
  };
  const signOutDevices = async () => {
    if (!(await confirm({ title: 'ออกจากระบบทุกเครื่อง', message: 'ทุกเครื่องที่เข้าร้านไว้ (รวมเครื่องนี้) ต้องกรอกรหัสร้านค้าและบัญชีร้านใหม่ ก่อนใช้ PIN ได้อีกครั้ง', danger: true, okText: 'ออกจากระบบทุกเครื่อง' }))) return;
    try {
      await api.post('/auth/store-account/sign-out-devices');
      toast.success('ออกจากระบบทุกเครื่องแล้ว');
    } catch (e) {
      toast.error(e);
    }
  };
  if (!isOwner) {
    return (
      <div className="col">
        <div className="card flat small">{t('รหัสร้านค้าและบัญชีร้านจัดการได้โดยเจ้าของร้านเท่านั้น')}</div>
        <MyPin />
      </div>
    );
  }
  if (!acc) return <Loading />;
  const o = acc.owner || {};
  return (
    <div className="col">
      <div className="card flat small">
        {t('วิธีเข้าใช้งาน: 1) กรอกรหัสร้านค้า 2) เข้าสู่ระบบด้วยชื่อผู้ใช้หรืออีเมล + รหัสผ่านของร้าน (ครั้งเดียวต่อเครื่อง) 3) พนักงานแต่ละคนใช้ PIN 4 หลัก · เจ้าของร้านใช้งานได้ทุกระบบ')}
      </div>
      <div className="card">
        <h3 className="row nowrap"><Store size={18} /> {t('ข้อมูลเข้าสู่ระบบของร้าน')}</h3>
        <div className="grid grid-2">
          <Field label="รหัสร้านค้า (ใช้ค้นหาร้าน)"><CopyValue value={acc.storeCode} /></Field>
          <Field label="ชื่อผู้ใช้"><CopyValue value={o.username || '-'} /></Field>
          <Field label="อีเมล (ใช้แทนชื่อผู้ใช้ได้)"><CopyValue value={o.email || '-'} mono={false} /></Field>
          <Field label="รหัสผ่านของร้าน">
            {o.startingPassword ? (
              <>
                <CopyValue value={o.startingPassword} secret />
                <div className="xs" style={{ color: 'var(--warn)' }}>{t('รหัสผ่านเริ่มต้น — ควรเปลี่ยนเป็นรหัสของร้านเอง (หลังเปลี่ยนแล้วจะไม่แสดงอีก)')}</div>
              </>
            ) : (
              <div className="small muted">{t('ตั้งโดยเจ้าของร้านแล้ว (ไม่แสดง เพื่อความปลอดภัย)')}</div>
            )}
          </Field>
          <Field label="PIN เจ้าของร้าน">
            {o.pin ? (
              <>
                <CopyValue value={o.pin} secret />
                <div className="xs" style={{ color: 'var(--warn)' }}>{t('PIN เริ่มต้น — เปลี่ยนได้ด้านล่าง')}</div>
              </>
            ) : (
              <Badge color="#16a34a">{t('ตั้ง PIN ของตัวเองแล้ว')}</Badge>
            )}
          </Field>
        </div>
      </div>

      <div className="card">
        <h3 className="row nowrap"><User size={18} /> {t('แก้ไขรหัสร้านค้า / ชื่อผู้ใช้ / อีเมล')}</h3>
        <div className="grid grid-3">
          <Field label="รหัสร้านค้า (a-z 0-9 รวม 8 ตัว)"><Input value={f.storeCode} onChange={(e) => setF({ ...f, storeCode: e.target.value.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) })} style={{ fontFamily: 'ui-monospace, monospace', letterSpacing: 2 }} /></Field>
          <Field label="ชื่อผู้ใช้ (a-z 0-9 . _ -)"><Input value={f.username} autoCapitalize="off" onChange={(e) => setF({ ...f, username: e.target.value })} /></Field>
          <Field label="อีเมล"><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        </div>
        <div className="xs muted">{t('เปลี่ยนรหัสร้านค้าแล้ว เครื่องที่เข้าร้านไว้แล้วยังใช้งานต่อได้ เครื่องใหม่ต้องใช้รหัสใหม่')}</div>
        <div className="row end"><Button variant="primary" icon={Save} loading={busy === 'save'} onClick={save}>{t('บันทึก')}</Button></div>
      </div>

      <form className="card" onSubmit={changePassword}>
        <h3 className="row nowrap"><KeyRound size={18} /> {t('เปลี่ยนรหัสผ่านของร้าน')}</h3>
        <div className="grid grid-3">
          <Field label="รหัสผ่านปัจจุบัน"><Input type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} required /></Field>
          <Field label="รหัสผ่านใหม่ (อย่างน้อย 8 ตัว)"><Input type="password" autoComplete="new-password" value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} required /></Field>
          <Field label="ยืนยันรหัสผ่านใหม่"><Input type="password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} required /></Field>
        </div>
        <div className="row end"><Button type="submit" variant="primary" icon={Save} loading={busy === 'pw'}>{t('เปลี่ยนรหัสผ่าน')}</Button></div>
      </form>

      <MyPin />

      <div className="card">
        <h3 className="row nowrap"><LogOut size={18} /> {t('ออกจากระบบทุกเครื่อง')}</h3>
        <div className="small muted">{t('ใช้เมื่อสงสัยว่ามีเครื่องที่ไม่ควรเข้าร้านได้ (เช่น เครื่องหาย) — ทุกเครื่องต้องกรอกรหัสร้านค้าและบัญชีร้านใหม่')}</div>
        <div className="row end"><Button variant="danger" icon={LogOut} onClick={signOutDevices}>{t('ออกจากระบบทุกเครื่อง')}</Button></div>
      </div>
    </div>
  );
}

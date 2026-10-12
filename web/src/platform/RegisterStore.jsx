// Store self-registration: e-mail + password chosen by the owner (no verification code / OTP).
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Store, Check, X, Globe, Mic2 } from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/store.jsx';
import { useT } from '../lib/i18n.jsx';
import { BILLING_CYCLES } from '@beatbox/shared/plans.js';
import { Button, Field, Input, Loading, baht } from '../components/ui.jsx';

const EMPTY = { storeName: '', ownerFirstName: '', ownerLastName: '', email: '', phone: '', password: '', confirmPassword: '', planId: null };

export function validateRegister(f, t) {
  const e = {};
  if (f.storeName.trim().length < 2) e.storeName = t('กรุณากรอกชื่อร้าน');
  if (!f.ownerFirstName.trim()) e.ownerFirstName = t('กรุณากรอกชื่อเจ้าของ');
  if (!f.ownerLastName.trim()) e.ownerLastName = t('กรุณากรอกนามสกุลเจ้าของ');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim())) e.email = t('อีเมลไม่ถูกต้อง');
  if (!/^0\d{8,9}$/.test(f.phone.replace(/\D/g, ''))) e.phone = t('เบอร์โทรศัพท์ไม่ถูกต้อง');
  if (f.password.length < 8) e.password = t('รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร');
  if (f.password !== f.confirmPassword) e.confirmPassword = t('รหัสผ่านและยืนยันรหัสผ่านไม่ตรงกัน');
  if (!f.planId) e.planId = t('กรุณาเลือกแพ็กเกจ');
  return e;
}

export default function RegisterStore() {
  const { t, lang, setLang } = useT();
  const { applyLogin } = useAuth();
  const nav = useNavigate();
  const [info, setInfo] = useState(null);
  const [f, setF] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api
      .get('/platform/public', { auth: false })
      .then((d) => {
        setInfo(d);
        const want = Number(new URLSearchParams(window.location.search).get('plan'));
        setF((x) => ({ ...x, planId: d.plans.find((p) => p.id === want)?.id || d.plans[0]?.id || null }));
      })
      .catch((e) => setErr(e.message));
  }, []);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async (e) => {
    e.preventDefault();
    const v = validateRegister(f, t);
    setErrors(v);
    if (Object.keys(v).length) return;
    setBusy(true);
    setErr('');
    try {
      const r = await api.post('/platform/register', { ...f, phone: f.phone.replace(/\D/g, '') }, { auth: false });
      await applyLogin(r);
      nav('/admin/rooms', { replace: true });
    } catch (er) {
      setErr(er.message);
      if (er.code === 'EMAIL_TAKEN') setErrors({ email: er.message });
    } finally {
      setBusy(false);
    }
  };
  if (!info && !err) return <Loading />;
  const plan = info?.plans.find((p) => p.id === f.planId);
  const E = ({ k }) => (errors[k] ? <span className="hint" style={{ color: 'var(--danger)' }}>{errors[k]}</span> : null);
  return (
    <div className="login-wrap" style={{ alignItems: 'flex-start', overflow: 'auto' }}>
      <div className="card" style={{ width: 'min(980px, 100%)', margin: '24px auto' }}>
        <div className="row">
          <div className="brand-logo"><Mic2 size={20} /></div>
          <h2 className="grow" style={{ margin: 0 }}>{t('สมัครใช้งานระบบ POS คาราโอเกะสำหรับร้านใหม่')}</h2>
          <Button size="sm" variant="ghost" icon={Globe} onClick={() => setLang(lang === 'th' ? 'en' : 'th')}>{lang === 'th' ? 'EN' : 'TH'}</Button>
        </div>
        {info && !info.signupEnabled ? (
          <p style={{ color: 'var(--danger)' }}>{t('ปิดรับสมัครร้านค้าชั่วคราว กรุณาติดต่อผู้ดูแลระบบ')} {info.contact?.phone}</p>
        ) : (
          <form onSubmit={submit} className="col mt" noValidate>
            <h4 style={{ margin: 0 }}>1. {t('เลือกแพ็กเกจ')}</h4>
            <div className="plan-grid">
              {info?.plans.map((p) => (
                <button key={p.id} type="button" className={`plan-card ${f.planId === p.id ? 'on' : ''}`} onClick={() => setF({ ...f, planId: p.id })}>
                  <b>{p.name}</b>
                  <div className="plan-price">{baht(p.price, 0)} <span className="xs muted">/ {p.billingInterval > 1 ? `${p.billingInterval} ` : ''}{t(BILLING_CYCLES[p.billingCycle])}</span></div>
                  {p.trialDays > 0 && <div className="xs" style={{ color: 'var(--ok)' }}>{t('ทดลองใช้ฟรี {n} วัน', { n: p.trialDays })}</div>}
                  {p.description && <div className="xs muted">{p.description}</div>}
                  <ul className="plan-feats">
                    {info.features.map((x) => (
                      <li key={x.key} className={p.features?.[x.key] ? '' : 'off'}>{p.features?.[x.key] ? <Check size={12} /> : <X size={12} />} {t(x.label)}</li>
                    ))}
                  </ul>
                </button>
              ))}
            </div>
            <E k="planId" />
            <h4 style={{ margin: '8px 0 0' }}>2. {t('ข้อมูลร้านและเจ้าของ')}</h4>
            <div className="grid grid-2">
              <Field label="ชื่อร้าน *"><Input value={f.storeName} onChange={set('storeName')} /><E k="storeName" /></Field>
              <Field label="เบอร์โทร *"><Input inputMode="tel" value={f.phone} onChange={set('phone')} placeholder="08xxxxxxxx" /><E k="phone" /></Field>
              <Field label="ชื่อเจ้าของ *"><Input value={f.ownerFirstName} onChange={set('ownerFirstName')} /><E k="ownerFirstName" /></Field>
              <Field label="นามสกุลเจ้าของ *"><Input value={f.ownerLastName} onChange={set('ownerLastName')} /><E k="ownerLastName" /></Field>
              <Field label="อีเมล (ใช้เข้าสู่ระบบ) *" style={{ gridColumn: '1 / -1' }}><Input type="email" autoComplete="username" value={f.email} onChange={set('email')} /><E k="email" /></Field>
              <Field label="รหัสผ่าน (อย่างน้อย 8 ตัวอักษร) *"><Input type="password" autoComplete="new-password" value={f.password} onChange={set('password')} /><E k="password" /></Field>
              <Field label="ยืนยันรหัสผ่าน *"><Input type="password" autoComplete="new-password" value={f.confirmPassword} onChange={set('confirmPassword')} /><E k="confirmPassword" /></Field>
            </div>
            <div className="small muted">{t('ไม่ต้องยืนยันรหัส OTP — เมื่อสมัครสำเร็จระบบจะสร้างบัญชีเจ้าของร้านและพื้นที่ข้อมูลของร้านให้ทันที แล้วเข้าสู่ระบบอัตโนมัติ')}</div>
            {plan && <div className="small">{t('แพ็กเกจที่เลือก')}: <b>{plan.name}</b>{plan.trialDays > 0 ? ` — ${t('ทดลองใช้ฟรี {n} วัน', { n: plan.trialDays })}` : ''}</div>}
            {err && <div style={{ color: 'var(--danger)' }}>{t(err)}</div>}
            <Button type="submit" size="lg" variant="primary" icon={Store} loading={busy}>{t('สมัครใช้งาน')}</Button>
            <a href="/login" className="small center">{t('มีบัญชีอยู่แล้ว? เข้าสู่ระบบ')}</a>
          </form>
        )}
      </div>
    </div>
  );
}

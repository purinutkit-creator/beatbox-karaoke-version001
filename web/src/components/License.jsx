// Store license (package) widgets: top-right status, package details / renewal, the "package expired" page
// and the Super Owner banner. All times come from the server clock.
import { useEffect, useState } from 'react';
import { CalendarClock, AlertTriangle, PhoneCall, RefreshCw, Package, LogOut, Shield, ArrowLeft, Check, X } from 'lucide-react';
import { remainingParts, formatRemaining } from '@beatbox/shared/time.js';
import { SUBSCRIPTION_STATUS_LABEL, BILLING_CYCLES } from '@beatbox/shared/plans.js';
import { api, LS } from '../lib/api.js';
import { useAuth } from '../lib/store.jsx';
import { useT } from '../lib/i18n.jsx';
import { useServerNow } from '../lib/socket.js';
import { Button, Modal, Badge, Textarea, Field, useToast, baht, Loading } from './ui.jsx';

const DAY = 86400000;

export function fmtStoreDateTime(d, tz = 'Asia/Bangkok', lang = 'th') {
  if (!d) return '-';
  return new Date(d).toLocaleString(lang === 'en' ? 'en-GB' : 'th-TH', { timeZone: tz, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Severity of the remaining time: ok / warn (≤ 7 days) / danger (≤ 1 day) / expired. */
export function licenseLevel(sub, now) {
  if (!sub) return 'ok';
  if (sub.status === 'SUSPENDED' || sub.status === 'EXPIRED') return 'expired';
  if (!sub.expiresAt) return 'ok';
  const left = new Date(sub.expiresAt).getTime() - now;
  if (left <= 0) return 'expired';
  if (left <= DAY) return 'danger';
  if (left <= 7 * DAY) return 'warn';
  return 'ok';
}

function statusOf(sub, now) {
  if (!sub) return 'EXPIRED';
  if (sub.status === 'SUSPENDED') return 'SUSPENDED';
  if (sub.status === 'EXPIRED' || (sub.expiresAt && new Date(sub.expiresAt).getTime() <= now)) return 'EXPIRED';
  return sub.isTrial ? 'TRIAL' : 'ACTIVE';
}

const STATUS_COLOR = { TRIAL: '#3b82f6', ACTIVE: '#22c55e', EXPIRED: '#ef4444', SUSPENDED: '#f97316' };

export function StatusBadge({ status }) {
  const { t } = useT();
  return <Badge color={STATUS_COLOR[status] || '#888'}>{t(SUBSCRIPTION_STATUS_LABEL[status] || status)}</Badge>;
}

/** Top-right widget: store · package · status · expiry · time remaining (years / months / days / hours / minutes). */
export function LicenseWidget() {
  const { subscription, store } = useAuth();
  const { t, lang } = useT();
  const now = useServerNow(15000);
  const [open, setOpen] = useState(false);
  if (!subscription) return null;
  const tz = subscription.timezone || 'Asia/Bangkok';
  const status = statusOf(subscription, now);
  const level = licenseLevel(subscription, now);
  const parts = remainingParts(now, subscription.expiresAt ? new Date(subscription.expiresAt).getTime() : null, tz);
  return (
    <>
      <button className={`license-pill lv-${level}`} onClick={() => setOpen(true)} title={t('ดูรายละเอียดแพ็กเกจและต่ออายุ')}>
        <span className="lic-store ellipsis">{subscription.storeName || store?.name}</span>
        <span className="lic-plan">
          <Package size={13} /> {subscription.plan?.name || t('ไม่มีแพ็กเกจ')} · {t(SUBSCRIPTION_STATUS_LABEL[status])}
        </span>
        <span className="lic-left num">
          {level === 'expired' ? <AlertTriangle size={13} /> : <CalendarClock size={13} />}
          {status === 'SUSPENDED' ? t('ถูกระงับ') : subscription.expiresAt ? (
            <>
              <span className="hide-sm">{t('หมดอายุ')} {fmtStoreDateTime(subscription.expiresAt, tz, lang)} · </span>
              {parts.expired ? t('หมดอายุแล้ว') : `${t('เหลือ')} ${formatRemaining(parts, lang)}`}
            </>
          ) : t('ไม่มีวันหมดอายุ')}
        </span>
      </button>
      {open && <LicenseModal onClose={() => setOpen(false)} />}
    </>
  );
}

function Remaining({ sub, now }) {
  const { t, lang } = useT();
  const tz = sub.timezone || 'Asia/Bangkok';
  const p = remainingParts(now, sub.expiresAt ? new Date(sub.expiresAt).getTime() : null, tz);
  if (p.unlimited) return <div className="bold">{t('ไม่มีวันหมดอายุ')}</div>;
  if (p.expired) return <div className="bold" style={{ color: 'var(--danger)' }}>{t('หมดอายุแล้ว')}</div>;
  const units = lang === 'en' ? ['Years', 'Months', 'Days', 'Hours', 'Minutes'] : ['ปี', 'เดือน', 'วัน', 'ชั่วโมง', 'นาที'];
  const v = [p.years, p.months, p.days, p.hours, p.minutes];
  return (
    <div className="lic-units">
      {v.map((n, i) => (
        <div key={i} className="lic-unit">
          <b className="num">{n}</b>
          <span className="xs muted">{units[i]}</span>
        </div>
      ))}
    </div>
  );
}

const cycleText = (p, t) => `${p.billingInterval > 1 ? `${p.billingInterval} ` : ''}${t(BILLING_CYCLES[p.billingCycle] || p.billingCycle)}`;

/** Package details, the store's plans, renewal request and history. */
export function LicenseModal({ onClose }) {
  const { t, lang } = useT();
  const toast = useToast();
  const { refreshSubscription, can } = useAuth();
  const now = useServerNow(15000);
  const [data, setData] = useState(null);
  const [planId, setPlanId] = useState(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const load = async () => {
    const d = await api.get('/subscription');
    setData(d);
    setPlanId((p) => p || d.subscription?.plan?.id || d.plans[0]?.id || null);
  };
  useEffect(() => {
    load().catch((e) => toast.error(e));
  }, []);
  if (!data) return <Modal onClose={onClose} title={t('แพ็กเกจของร้าน')}><Loading /></Modal>;
  const sub = data.subscription;
  const tz = sub.timezone || 'Asia/Bangkok';
  const status = statusOf(sub, now);
  const request = async () => {
    setBusy(true);
    try {
      await api.post('/subscription/renewal-request', { planId, message });
      toast.success(t('ส่งคำขอต่ออายุแล้ว ผู้ดูแลระบบจะติดต่อกลับ'));
      await load();
      refreshSubscription();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} title={t('แพ็กเกจของร้าน')} size="wide">
      <div className="col">
        <div className="card flat">
          <div className="row">
            <div className="grow">
              <div className="xs muted">{t('ร้าน')}</div>
              <div className="bold">{sub.storeName}</div>
            </div>
            <StatusBadge status={status} />
          </div>
          <div className="grid grid-3 mt">
            <div><div className="xs muted">{t('แพ็กเกจ')}</div><div className="bold">{sub.plan?.name || '-'}</div></div>
            <div><div className="xs muted">{t('เริ่มใช้งาน')}</div><div>{fmtStoreDateTime(sub.startedAt, tz, lang)}</div></div>
            <div><div className="xs muted">{t('วันหมดอายุ')}</div><div>{sub.expiresAt ? fmtStoreDateTime(sub.expiresAt, tz, lang) : t('ไม่มีวันหมดอายุ')}</div></div>
          </div>
          <div className="mt">
            <div className="xs muted">{t('เวลาคงเหลือ')}</div>
            <Remaining sub={sub} now={now} />
          </div>
          {status === 'SUSPENDED' && sub.suspendReason && <div className="small mt" style={{ color: 'var(--danger)' }}>{t('เหตุผล')}: {sub.suspendReason}</div>}
          <div className="xs muted mt">{t('การนับเวลาคงเหลือ: นับตามปฏิทินจริงในเขตเวลาของร้าน ({tz}) — นับปีเต็ม แล้วเดือนเต็มตามจำนวนวันจริงของแต่ละเดือน ส่วนที่เหลือแสดงเป็นวัน ชั่วโมง นาที', { tz })}</div>
        </div>

        <h4 style={{ margin: '6px 0 0' }}>{t('แพ็กเกจที่เปิดให้เลือก')}</h4>
        <div className="plan-grid">
          {data.plans.map((p) => (
            <button key={p.id} type="button" className={`plan-card ${planId === p.id ? 'on' : ''}`} onClick={() => setPlanId(p.id)}>
              <div className="row nowrap">
                <b className="grow">{p.name}</b>
                {sub.plan?.id === p.id && <Badge color="#22c55e">{t('แพ็กเกจปัจจุบัน')}</Badge>}
              </div>
              <div className="plan-price">{baht(p.price, 0)} <span className="xs muted">/ {cycleText(p, t)}</span></div>
              {p.description && <div className="xs muted">{p.description}</div>}
              <ul className="plan-feats">
                {data.features.map((f) => (
                  <li key={f.key} className={p.features?.[f.key] ? '' : 'off'}>
                    {p.features?.[f.key] ? <Check size={12} /> : <X size={12} />} {t(f.label)}
                  </li>
                ))}
              </ul>
              {data.limits.some((l) => p.limits?.[l.key] != null && p.limits?.[l.key] !== '') && (
                <div className="xs muted">
                  {data.limits.filter((l) => p.limits?.[l.key] != null && p.limits?.[l.key] !== '').map((l) => `${t(l.label)} ${p.limits[l.key]}`).join(' · ')}
                </div>
              )}
            </button>
          ))}
        </div>

        {can('settings.manage') || status === 'EXPIRED' || status === 'SUSPENDED' ? (
          <div className="card flat">
            <b>{t('ต่ออายุ / เปลี่ยนแพ็กเกจ')}</b>
            {data.openRequest ? (
              <div className="small mt" style={{ color: 'var(--ok)' }}>{t('ส่งคำขอแล้วเมื่อ')} {fmtStoreDateTime(data.openRequest.created_at, tz, lang)} — {t('รอผู้ดูแลระบบดำเนินการ')}</div>
            ) : null}
            <Field label="ข้อความถึงผู้ดูแลระบบ (ไม่บังคับ)" className="mt">
              <Textarea rows={2} value={message} onChange={(e) => setMessage(e.target.value)} />
            </Field>
            <Button variant="primary" icon={RefreshCw} loading={busy} onClick={request} disabled={!planId}>{t('ส่งคำขอต่ออายุ')}</Button>
          </div>
        ) : null}

        <ContactBox contact={data.contact} />

        {data.events?.length > 0 && (
          <details>
            <summary className="small">{t('ประวัติการต่ออายุและเปลี่ยนแพ็กเกจ')}</summary>
            <table className="table small mt">
              <thead><tr><th>{t('เวลา')}</th><th>{t('รายการ')}</th><th>{t('แพ็กเกจ / หมดอายุ')}</th><th>{t('โดย')}</th></tr></thead>
              <tbody>
                {data.events.map((e, i) => (
                  <tr key={i}>
                    <td className="num">{fmtStoreDateTime(e.created_at, tz, lang)}</td>
                    <td>{t(EVENT_LABEL[e.action] || e.action)}{e.note ? ` — ${e.note}` : ''}</td>
                    <td>{e.after?.planName || ''} {e.after?.expiresAt ? `→ ${fmtStoreDateTime(e.after.expiresAt, tz, lang)}` : ''}</td>
                    <td>{e.actor_name || e.actor_type}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
      </div>
    </Modal>
  );
}

export const EVENT_LABEL = {
  REGISTER: 'สมัครใช้งาน',
  CREATE_STORE: 'สร้างร้าน',
  TRIAL: 'ให้ทดลองใช้',
  EXTEND_TRIAL: 'เพิ่มวันทดลองใช้',
  RENEW: 'ต่ออายุ',
  CHANGE_PLAN: 'เปลี่ยนแพ็กเกจ',
  SET_EXPIRY: 'กำหนดวันหมดอายุ',
  SUSPEND: 'ระงับการใช้งาน',
  ACTIVATE: 'เปิดใช้งาน',
  EDIT_STORE: 'แก้ไขข้อมูลร้าน',
  EDIT_PLAN: 'แก้ไขแพ็กเกจ/สิทธิ์',
};

function ContactBox({ contact }) {
  const { t } = useT();
  if (!contact || (!contact.phone && !contact.line && !contact.email)) return null;
  return (
    <div className="card flat" id="lic-contact">
      <b><PhoneCall size={14} /> {t('ติดต่อผู้ดูแลระบบ')}</b>
      <div className="small mt">
        {contact.phone && <div>{t('โทร')}: <a href={`tel:${contact.phone}`}>{contact.phone}</a></div>}
        {contact.line && <div>LINE: {contact.line}</div>}
        {contact.email && <div>{t('อีเมล')}: <a href={`mailto:${contact.email}`}>{contact.email}</a></div>}
      </div>
    </div>
  );
}

/** Full-screen page when the package expired or the store was suspended. Data is kept; renewing restores everything. */
export function ExpiredScreen() {
  const { subscription, logout, employee } = useAuth();
  const { t, lang } = useT();
  const [show, setShow] = useState(null); // 'plans' | 'contact'
  const [contact, setContact] = useState(null);
  useEffect(() => {
    api.get('/subscription').then((d) => setContact(d.contact)).catch(() => {});
  }, []);
  const suspended = subscription?.status === 'SUSPENDED';
  const tz = subscription?.timezone || 'Asia/Bangkok';
  return (
    <div className="expired-wrap">
      {employee?.superOwnerName && <SuperOwnerBanner />}
      <div className="card expired-card">
        <AlertTriangle size={64} color="var(--danger)" />
        <h1>{suspended ? t('ร้านถูกระงับการใช้งาน') : t('แพ็กเกจหมดอายุแล้ว')}</h1>
        <div className="bold">{subscription?.storeName}</div>
        <div className="muted">
          {t('แพ็กเกจ')} {subscription?.plan?.name || '-'}
          {subscription?.expiresAt ? ` · ${t('หมดอายุเมื่อ')} ${fmtStoreDateTime(subscription.expiresAt, tz, lang)}` : ''}
        </div>
        {suspended && subscription?.suspendReason && <div className="small" style={{ color: 'var(--danger)' }}>{t('เหตุผล')}: {subscription.suspendReason}</div>}
        <p className="small">{t('ระบบหยุดการขาย การเปิดห้อง และการแก้ไขข้อมูลชั่วคราว ข้อมูลทั้งหมดของร้านยังอยู่ครบ และจะกลับมาใช้งานได้ทันทีหลังต่ออายุ')}</p>
        <div className="grid grid-3" style={{ width: '100%' }}>
          <Button size="lg" icon={Package} onClick={() => setShow('plans')}>{t('ดูแพ็กเกจ')}</Button>
          <Button size="lg" variant="primary" icon={RefreshCw} onClick={() => setShow('plans')}>{t('ต่ออายุ')}</Button>
          <Button size="lg" icon={PhoneCall} onClick={() => setShow('contact')}>{t('ติดต่อผู้ดูแล')}</Button>
        </div>
        {show === 'contact' && (contact ? <ContactBox contact={contact} /> : <div className="small muted">{t('ยังไม่ได้ตั้งค่าช่องทางติดต่อ')}</div>)}
        <Button variant="ghost" icon={LogOut} onClick={logout}>{t('ออกจากระบบ')}</Button>
      </div>
      {show === 'plans' && <LicenseModal onClose={() => setShow(null)} />}
    </div>
  );
}

/** Shown while the Super Owner manages a store ("เข้าจัดการร้าน"). Actions are logged under the Super Owner's own name. */
export function SuperOwnerBanner() {
  const { employee, store, logout } = useAuth();
  const { t } = useT();
  if (!employee?.superOwnerName) return null;
  const back = async () => {
    await logout();
    window.location.href = '/platform';
  };
  return (
    <div className="super-banner">
      <Shield size={16} />
      <span className="grow ellipsis">
        {t('กำลังจัดการร้าน')} <b>{store?.name}</b> {t('ในนาม Super Owner')} ({employee.superOwnerName}) — {t('ทุกการกระทำถูกบันทึกในชื่อของคุณ')}
      </span>
      <Button size="sm" icon={ArrowLeft} onClick={back}>{t('กลับสู่หน้าจัดการส่วนกลาง')}</Button>
    </div>
  );
}

export function hasPlatformSession() {
  return !!LS.get('bb_platform_token');
}


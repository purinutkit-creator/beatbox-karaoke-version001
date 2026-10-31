// The booking pass (link from LINE): a live countdown to the booking (days, hours, minutes, seconds), the room, and
// the check-in QR + barcode to show at the counter, with directions and a call button.
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Mic2, MapPin, Phone, CalendarDays, Users, CheckCircle2 } from 'lucide-react';
import { useT } from '../lib/i18n.jsx';
import { api } from '../lib/api.js';
import { Loading, QRCode, Barcode } from '../components/ui.jsx';
import { HeroImg } from '../components/BookingCard.jsx';
import { RESERVATION_STATUS_LABEL } from '@beatbox/shared/constants.js';

const TZ = 'Asia/Bangkok';
const hm = (d) => new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
const longDate = (d, lang) => new Date(d).toLocaleDateString(lang === 'en' ? 'en-GB' : 'th-TH', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: TZ });

function useNow() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function Countdown({ to }) {
  const { t } = useT();
  const now = useNow();
  const left = Math.max(0, Math.floor((new Date(to) - now) / 1000));
  if (left <= 0) return <div className="bp-now">{t('ถึงเวลาของคุณแล้ว!')}</div>;
  const parts = [
    [Math.floor(left / 86400), 'วัน'],
    [Math.floor((left % 86400) / 3600), 'ชั่วโมง'],
    [Math.floor((left % 3600) / 60), 'นาที'],
    [left % 60, 'วินาที'],
  ];
  return (
    <div className="bp-count">
      {parts.map(([n, label]) => (
        <div key={label} className="bp-unit">
          <b>{String(n).padStart(2, '0')}</b>
          <span>{t(label)}</span>
        </div>
      ))}
    </div>
  );
}

export default function BookingPass() {
  const { token } = useParams();
  const { t, lang } = useT();
  const [b, setB] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api.get(`/public/line/booking/${token}`, { auth: false }).then(setB).catch((e) => setErr(e.message));
  }, [token]);
  if (err) return <div className="rg"><div className="rg-card center">{t(err)}</div></div>;
  if (!b) return <Loading />;
  const tel = b.store.phone ? `tel:${b.store.phone.replace(/[^0-9+]/g, '')}` : null;
  return (
    <div className="rg bp">
      <div className="rg-head">
        {b.store.logoUrl ? <img src={b.store.logoUrl} alt="" /> : <div className="brand-logo"><Mic2 size={22} /></div>}
        <div>
          <div className="rg-store">{b.store.name}</div>
          <div className="rg-muted">{t('บัตรเข้าใช้ห้อง')} · {b.bookingNo}</div>
        </div>
      </div>
      <div className="rg-hero">
        <HeroImg src={b.room.image} />
        <div className="rg-hero-text">
          <div className="bk-chips">
            {b.room.type && <span className="bk-chip">{b.room.type}</span>}
            {b.room.floor && <span className="bk-chip">{b.room.floor}</span>}
            {b.confirmed && <span className="bk-chip"><CheckCircle2 size={14} /> {t('ยืนยันแล้ว')}</span>}
          </div>
          <div className="rg-room">{b.room.name}</div>
        </div>
      </div>
      <div className="rg-card center">
        <div className="small muted">{t('นับถอยหลังถึงเวลาของคุณ')}</div>
        {['IN_USE', 'ARRIVED'].includes(b.status) ? <div className="bp-now">{t('กำลังใช้ห้อง')}</div> : ['CANCELLED', 'NO_SHOW', 'EXPIRED', 'COMPLETED', 'REFUNDED'].includes(b.status) ? <div className="bp-now muted">{t(RESERVATION_STATUS_LABEL[b.status] || b.status)}</div> : <Countdown to={b.startAt} />}
        <div className="bp-when"><CalendarDays size={16} /> {longDate(b.startAt, lang)}</div>
        <div className="bp-time">{hm(b.startAt)} – {hm(b.endAt)}</div>
        <div className="small muted"><Users size={14} /> {b.guests} {t('คน')} · {b.customerName} · {b.phone}</div>
      </div>
      {b.qr && (
        <div className="rg-card center bp-code">
          <div className="small muted">{t('แสดง QR หรือบาร์โค้ดนี้ที่เคาน์เตอร์')}</div>
          <QRCode value={b.qr} size={220} />
          <Barcode value={b.bookingNo} height={60} />
        </div>
      )}
      <div className="bp-actions">
        <a className="btn primary" href={b.store.mapUrl} target="_blank" rel="noreferrer"><MapPin size={18} /> {t('นำทาง Google Maps')}</a>
        {tel && <a className="btn" href={tel}><Phone size={18} /> {t('โทรหาร้าน')}</a>}
      </div>
    </div>
  );
}

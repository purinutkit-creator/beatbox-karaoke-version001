// A booking at a glance: the room's picture and name, the day, START → END in big digits, how long, how many people.
// Used when a booking is found (scan / search) on the staff screens and — larger — on the customer display.
import { useEffect, useState } from 'react';
import { CalendarDays, Users, Package, Layers, Clock, Wallet, Phone } from 'lucide-react';
import { useT } from '../lib/i18n.jsx';
import { money } from './ui.jsx';
import { formatMinutesShort } from '@beatbox/shared/roomPricing.js';
import { RESERVATION_STATUS_LABEL, RESERVATION_STATUS_COLOR } from '@beatbox/shared/constants.js';

const TZ = 'Asia/Bangkok';
const hm = (d) => new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
const longDate = (d, lang) => new Date(d).toLocaleDateString(lang === 'en' ? 'en-GB' : 'th-TH', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: TZ });

/** A room picture filling its box; the coloured background stays when there is no picture or it does not load. */
export function HeroImg({ src }) {
  const [bad, setBad] = useState(false);
  useEffect(() => setBad(false), [src]);
  return src && !bad ? <img src={src} alt="" onError={() => setBad(true)} /> : <div className="bk-hero-fallback" />;
}

/** The fields the card needs, from a reservation row (lookup / list). Also what the POS sends to the customer display. */
export function bookingCardData(rv) {
  return {
    bookingNo: rv.booking_no,
    status: rv.status,
    customerName: rv.customer_name,
    phone: rv.phone,
    roomName: rv.room_name,
    roomNumber: rv.room_number,
    typeName: rv.type_name,
    typeColor: rv.type_color,
    roomImage: rv.room_image,
    floorName: rv.floor_name,
    startAt: rv.start_at,
    endAt: rv.end_at,
    minutes: Math.round((new Date(rv.end_at) - new Date(rv.start_at)) / 60000),
    guests: rv.guest_count,
    packageName: rv.package_name,
    depositPaid: Number(rv.deposit_paid) || 0,
  };
}

/** variant: 'staff' (in a page / modal) or 'display' (customer display, large). */
export function BookingCard({ b, variant = 'staff', onClick, footer }) {
  const { t, lang } = useT();
  if (!b) return null;
  const color = b.typeColor || 'var(--primary)';
  return (
    <div className={`bk-card bk-${variant} ${onClick ? 'clickable' : ''}`} onClick={onClick} style={{ '--bk-color': color }}>
      <div className="bk-hero">
        <HeroImg src={b.roomImage} />
        <div className="bk-hero-text">
          <div className="bk-chips">
            {b.typeName && <span className="bk-chip">{b.typeName}</span>}
            {b.floorName && <span className="bk-chip"><Layers size={14} /> {b.floorName}</span>}
            {b.roomNumber && <span className="bk-chip">#{b.roomNumber}</span>}
          </div>
          <div className="bk-room">{b.roomName}</div>
        </div>
      </div>
      <div className="bk-body">
        <div className="bk-top">
          <div>
            <div className="bk-no">{b.bookingNo}</div>
            <div className="bk-name">{b.customerName}{variant === 'staff' && b.phone && <span className="bk-phone"><Phone size={13} /> {b.phone}</span>}</div>
          </div>
          {b.status && <span className="bk-status" style={{ background: RESERVATION_STATUS_COLOR[b.status] || '#6b7280' }}>{t(RESERVATION_STATUS_LABEL[b.status] || b.status)}</span>}
        </div>
        <div className="bk-date"><CalendarDays size={18} /> {longDate(b.startAt, lang)}</div>
        <div className="bk-time">
          <div><small>{t('เริ่ม')}</small><b>{hm(b.startAt)}</b></div>
          <span className="bk-arrow">→</span>
          <div><small>{t('สิ้นสุด')}</small><b>{hm(b.endAt)}</b></div>
        </div>
        <div className="bk-facts">
          <span><Clock size={16} /> {formatMinutesShort(b.minutes)}</span>
          {b.guests > 0 && <span><Users size={16} /> {b.guests} {t('คน')}</span>}
          <span><Package size={16} /> {b.packageName || t('รายชั่วโมง')}</span>
          {b.depositPaid > 0 && <span><Wallet size={16} /> {t('มัดจำ')} ฿{money(b.depositPaid)}</span>}
        </div>
        {footer}
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarPlus, Users, Clock, MapPin, Phone, MessageCircle, Mail, Star } from 'lucide-react';
import { useT } from '../lib/i18n.jsx';
import { useApp } from '../lib/store.jsx';
import { api } from '../lib/api.js';
import { Img, Badge, Loading, money } from '../components/ui.jsx';

export function useCatalog() {
  const [data, setData] = useState(null);
  useEffect(() => {
    api.get('/public/catalog', { auth: false }).then(setData).catch(() => setData({ types: [], rooms: [], packages: [], promotions: [], banners: [], rewards: [] }));
  }, []);
  return data;
}

function Banner({ banners }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (banners.length < 2) return;
    const id = setTimeout(() => setI((x) => (x + 1) % banners.length), (banners[i]?.duration_seconds || 6) * 1000);
    return () => clearTimeout(id);
  }, [i, banners]);
  return banners.map((b, k) => <img key={b.id} src={b.image_url} alt="" style={{ opacity: k === i ? 0.6 : 0, transition: 'opacity 1s' }} />);
}

export function HomePage() {
  const { t } = useT();
  const { publicSettings } = useApp();
  const cat = useCatalog();
  const store = publicSettings?.store;
  if (!cat) return <Loading />;
  return (
    <div className="stack">
      <div className="hero">
        <Banner banners={cat.banners} />
        <div className="txt">
          <h1 style={{ fontSize: 'clamp(1.8rem,5vw,3rem)' }}>{store?.name}</h1>
          <p style={{ fontSize: '1.1rem', opacity: 0.9 }}>{store?.slogan || t('ร้องให้สุด สนุกได้ทุกคืน')}</p>
          <Link to="/book/reserve" className="btn primary lg"><CalendarPlus size={22} /> {t('จองห้อง')}</Link>
          <div className="mt small"><Clock size={14} /> {t('ร้านเปิด')} {store?.openTime}–{store?.closeTime} {t('น.')} · <MapPin size={14} /> {store?.branchName}</div>
        </div>
      </div>
      <h2 className="mt">{t('ห้องแนะนำ')}</h2>
      <div className="grid grid-auto">
        {cat.types.map((ty) => (
          <div key={ty.id} className="room-tile">
            <div className="img" style={{ backgroundImage: `url(${ty.image_url})` }} />
            <div className="body">
              <div className="row between"><h3 style={{ margin: 0 }}>{ty.name}</h3><Badge color={ty.color}><Users size={12} /> {ty.capacity}</Badge></div>
              <div className="small muted">{(ty.amenities || []).join(' · ')}</div>
              <div className="row between"><span>{t('1 ชั่วโมง')} <b>฿{money(ty.price_hour, 0)}</b></span><span>{t('30 นาที')} <b>฿{money(ty.price_half, 0)}</b></span></div>
              <Link to={`/book/reserve?type=${ty.id}`} className="btn primary sm">{t('จองห้องนี้')}</Link>
            </div>
          </div>
        ))}
      </div>
      {cat.packages.length > 0 && (
        <>
          <h2 className="mt">{t('แพ็กเกจ')}</h2>
          <div className="grid grid-auto">
            {cat.packages.slice(0, 6).map((p) => (
              <div key={p.id} className="card"><b>{p.name}</b><div className="muted small">{p.hours} {t('ชม.')} {p.minutes ? `${p.minutes} ${t('นาที')}` : ''}</div><div style={{ fontSize: '1.4rem', fontWeight: 800 }}>฿{money(p.price, 0)}</div></div>
            ))}
          </div>
        </>
      )}
      {cat.promotions.length > 0 && (
        <>
          <h2 className="mt">{t('โปรโมชั่น')}</h2>
          <div className="grid grid-auto">
            {cat.promotions.slice(0, 6).map((p) => (
              <div key={p.id} className="room-tile">
                {p.image_url && <div className="img" style={{ backgroundImage: `url(${p.image_url})` }} />}
                <div className="body"><b>{p.name}</b><div className="small muted">{p.description}</div></div>
              </div>
            ))}
          </div>
        </>
      )}
      <ContactPage compact />
    </div>
  );
}

export function RoomsPage() {
  const { t } = useT();
  const cat = useCatalog();
  if (!cat) return <Loading />;
  return (
    <div>
      <h1>{t('ห้องของเรา')}</h1>
      {cat.types.map((ty) => (
        <div key={ty.id} className="mb">
          <h2><Badge color={ty.color}>{ty.name}</Badge> <span className="small muted">{ty.description}</span></h2>
          <div className="grid grid-auto">
            {cat.rooms.filter((r) => r.room_type_id === ty.id).map((r) => (
              <div key={r.id} className="room-tile">
                <div className="img" style={{ backgroundImage: `url(${r.image_url || ty.image_url})` }} />
                <div className="body">
                  <div className="row between"><b>{r.name}</b><span className="small"><Users size={12} /> {r.capacity} {t('คน')}</span></div>
                  <div className="small muted">{(r.amenities || []).join(' · ')}</div>
                  <div className="row between small"><span>{t('1 ชั่วโมง')} ฿{money(r.price_hour, 0)}</span><span>{t('30 นาที')} ฿{money(r.price_half, 0)}</span></div>
                  <div className="small">{t('มัดจำ')} ฿{money(r.deposit, 0)}</div>
                  <Link className="btn sm primary" to={`/book/reserve?room=${r.id}`}>{t('จองห้องนี้')}</Link>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function PackagesPage() {
  const { t } = useT();
  const cat = useCatalog();
  if (!cat) return <Loading />;
  return (
    <div>
      <h1>{t('แพ็กเกจ')}</h1>
      <div className="grid grid-auto">
        {cat.packages.map((p) => (
          <div key={p.id} className="room-tile">
            {p.image_url && <div className="img" style={{ backgroundImage: `url(${p.image_url})` }} />}
            <div className="body">
              <h3 style={{ margin: 0 }}>{p.name}</h3>
              <div className="muted">{p.hours} {t('ชม.')} {p.minutes ? `${p.minutes} ${t('นาที')}` : ''} {p.included_guests ? `· ${p.included_guests} ${t('คน')}` : ''}</div>
              <div style={{ fontSize: '1.5rem', fontWeight: 800 }}>฿{money(p.price, 0)}</div>
              <div className="small muted">{p.description}</div>
              {p.room_type_ids?.length > 0 && <div className="xs">{t('ใช้ได้กับ')}: {p.room_type_ids.map((id) => cat.types.find((x) => x.id === id)?.name).filter(Boolean).join(', ')}</div>}
              {p.member_only && <Badge color="#eab308">{t('เฉพาะสมาชิก')}</Badge>}
              <Link to="/book/reserve" className="btn sm primary">{t('จองเลย')}</Link>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function PromotionsPage() {
  const { t } = useT();
  const cat = useCatalog();
  if (!cat) return <Loading />;
  return (
    <div>
      <h1>{t('โปรโมชั่น')}</h1>
      <div className="grid grid-auto">
        {cat.promotions.map((p) => (
          <div key={p.id} className="room-tile">
            {p.image_url && <div className="img" style={{ backgroundImage: `url(${p.image_url})` }} />}
            <div className="body">
              <h3 style={{ margin: 0 }}>{p.name}</h3>
              <div className="small">{p.description}</div>
              <div className="xs muted">{p.start_date || ''} {p.end_date ? `– ${p.end_date}` : ''}</div>
              {p.needs_code && <Badge color="#8b5cf6">{t('ใช้ Promo Code ตอนจอง')}</Badge>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ContactPage({ compact }) {
  const { t } = useT();
  const { publicSettings } = useApp();
  const s = publicSettings?.store || {};
  const b = publicSettings?.booking || {};
  return (
    <div className="card">
      {!compact && <h1>{t('ติดต่อร้าน')}</h1>}
      {compact && <h2>{t('ติดต่อร้าน')}</h2>}
      <div className="grid grid-2">
        <div className="col">
          <div><MapPin size={16} /> {s.address}</div>
          <div><Phone size={16} /> <a href={`tel:${s.phone}`}>{s.phone}</a></div>
          <div><Clock size={16} /> {t('เปิดทุกวัน')} {s.openTime}–{s.closeTime} {t('น.')}</div>
          {b.contactEmail && <div><Mail size={16} /> {b.contactEmail}</div>}
        </div>
        <div className="col">
          {b.lineOaUrl && <a className="btn" style={{ background: '#06c755', color: '#fff' }} href={b.lineOaUrl} target="_blank" rel="noreferrer"><MessageCircle size={18} /> LINE Official Account</a>}
          {b.facebookUrl && <a className="btn" href={b.facebookUrl} target="_blank" rel="noreferrer">Facebook</a>}
          {b.mapUrl && <a className="btn" href={b.mapUrl} target="_blank" rel="noreferrer"><MapPin size={18} /> Google Maps</a>}
        </div>
      </div>
    </div>
  );
}

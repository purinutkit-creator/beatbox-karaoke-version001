// The way to a room — opened from the QR on the customer display / ticket. Always: the room, its floor and the floor
// plan with the room blinking. When the store turns it on and has saved the room's position: GPS directions (distance
// and an arrow using the phone's compass) until the customer is at the room.
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Navigation, Layers, MapPin, CheckCircle2, LocateFixed, Mic2 } from 'lucide-react';
import { useT } from '../lib/i18n.jsx';
import { api } from '../lib/api.js';
import { Loading } from '../components/ui.jsx';
import { FloorPlan, MARKERS } from '../components/FloorPlan.jsx';
import { HeroImg } from '../components/BookingCard.jsx';

const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;
/** Distance (m) and compass bearing (° from north) from a to b. */
function distanceBearing(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  const dist = 2 * R * Math.asin(Math.sqrt(h));
  const y = Math.sin(dLng) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(dLng);
  return { dist, bearing: ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360 };
}
const WINDS = ['เหนือ', 'ตะวันออกเฉียงเหนือ', 'ตะวันออก', 'ตะวันออกเฉียงใต้', 'ใต้', 'ตะวันตกเฉียงใต้', 'ตะวันตก', 'ตะวันตกเฉียงเหนือ'];

function GpsGuide({ nav, roomName }) {
  const { t } = useT();
  const [state, setState] = useState('idle'); // idle | asking | tracking | denied | error
  const [pos, setPos] = useState(null);
  const [heading, setHeading] = useState(null);
  const [arrived, setArrived] = useState(false);
  const watch = useRef(null);
  const buzzed = useRef(false);
  useEffect(() => () => {
    if (watch.current != null) navigator.geolocation?.clearWatch(watch.current);
  }, []);
  useEffect(() => {
    if (state !== 'tracking') return;
    const onOrient = (e) => {
      if (typeof e.webkitCompassHeading === 'number') setHeading(e.webkitCompassHeading);
      else if (e.absolute && e.alpha != null) setHeading((360 - e.alpha) % 360);
    };
    window.addEventListener('deviceorientationabsolute', onOrient);
    window.addEventListener('deviceorientation', onOrient);
    return () => {
      window.removeEventListener('deviceorientationabsolute', onOrient);
      window.removeEventListener('deviceorientation', onOrient);
    };
  }, [state]);
  const start = async () => {
    if (!navigator.geolocation) return setState('error');
    setState('asking');
    // iPhone asks for the compass separately, and only from a tap
    try {
      if (typeof window.DeviceOrientationEvent?.requestPermission === 'function') await window.DeviceOrientationEvent.requestPermission();
    } catch {
      /* no compass: the arrow then points from north */
    }
    watch.current = navigator.geolocation.watchPosition(
      (p) => {
        setState('tracking');
        setPos({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy });
      },
      (e) => setState(e.code === 1 ? 'denied' : 'error'),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 },
    );
  };
  const db = pos ? distanceBearing(pos, nav) : null;
  // arrived within the store's distance; leaves "arrived" only when clearly further away (GPS jumps around indoors)
  useEffect(() => {
    if (!db) return;
    if (!arrived && db.dist <= nav.arriveM) {
      setArrived(true);
      if (!buzzed.current) {
        buzzed.current = true;
        navigator.vibrate?.([200, 100, 200]);
      }
    } else if (arrived && db.dist > nav.arriveM * 2.5) setArrived(false);
  }, [db?.dist]);

  if (state === 'idle' || state === 'denied' || state === 'error')
    return (
      <div className="rg-card rg-gps">
        <div className="rg-gps-title"><Navigation size={20} /> {t('นำทางด้วย GPS')}</div>
        <div className="rg-muted">{t('อนุญาตตำแหน่ง แล้วเดินตามลูกศร ระบบจะบอกเมื่อถึงหน้าห้อง')}</div>
        {state === 'denied' && <div className="rg-warn">{t('ไม่ได้รับอนุญาตให้ใช้ตำแหน่ง — เปิด Location ให้เว็บนี้ในการตั้งค่าเบราว์เซอร์ แล้วลองใหม่')}</div>}
        {state === 'error' && <div className="rg-warn">{t('อ่านตำแหน่งไม่สำเร็จ ลองใหม่อีกครั้ง หรือดูผังร้านด้านบน')}</div>}
        <button type="button" className="rg-btn" onClick={start}><LocateFixed size={20} /> {t('เริ่มนำทาง')}</button>
      </div>
    );
  if (state === 'asking' || !db)
    return (
      <div className="rg-card rg-gps center">
        <span className="spinner" /> {t('กำลังหาตำแหน่งของคุณ')}…
      </div>
    );
  const arrow = heading == null ? db.bearing : (db.bearing - heading + 360) % 360;
  return (
    <div className={`rg-card rg-gps ${arrived ? 'rg-arrived' : ''}`}>
      {arrived ? (
        <div className="rg-arrived-box">
          <CheckCircle2 size={64} />
          <div className="rg-arrived-title">{t('ถึงแล้ว!')}</div>
          <div>{roomName} {t('อยู่ตรงนี้')}</div>
        </div>
      ) : (
        <>
          <div className="rg-compass">
            {heading != null && <span className="rg-north" style={{ transform: `rotate(${-heading}deg)` }}>N</span>}
            <Navigation className="rg-arrow" size={84} style={{ transform: `rotate(${arrow - 45}deg)` }} />
          </div>
          <div className="rg-dist">{db.dist < 1000 ? `${Math.round(db.dist)} ${t('ม.')}` : `${(db.dist / 1000).toFixed(1)} ${t('กม.')}`}</div>
          <div className="rg-muted">
            {heading == null ? `${t('ไปทางทิศ')}${t(WINDS[Math.round(db.bearing / 45) % 8])}` : t('เดินตามลูกศร')}
            {' · '}
            {t('ความแม่นยำ')} ±{Math.round(pos.accuracy)} {t('ม.')}
          </div>
          {pos.accuracy > db.dist && <div className="rg-muted">{t('คุณอยู่ใกล้ห้องแล้ว — ดูผังร้านด้านบนประกอบ')}</div>}
        </>
      )}
      <div className="rg-note">{t('ในอาคาร GPS อาจคลาดเคลื่อนได้หลายเมตร ใช้ผังร้านประกอบ')}</div>
    </div>
  );
}

export default function RoomGuide() {
  const { token } = useParams();
  const { t } = useT();
  const [g, setG] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api.get(`/public/guide/${token}`, { auth: false }).then(setG).catch((e) => setErr(e.message));
  }, [token]);
  if (err) return <div className="rg"><div className="rg-card center">{t(err)}</div></div>;
  if (!g) return <Loading />;
  const used = new Set((g.floor?.markers || []).map((m) => m.type));
  return (
    <div className="rg">
      <div className="rg-head">
        {g.store.logoUrl ? <img src={g.store.logoUrl} alt="" /> : <div className="brand-logo"><Mic2 size={22} /></div>}
        <div>
          <div className="rg-store">{g.store.name}</div>
          <div className="rg-muted">{t('ทางไปห้อง')}</div>
        </div>
      </div>
      <div className="rg-hero" style={{ '--bk-color': g.room.color || '#8b5cf6' }}>
        <HeroImg src={g.room.imageUrl} />
        <div className="rg-hero-text">
          <div className="bk-chips">
            {g.room.typeName && <span className="bk-chip">{g.room.typeName}</span>}
            {g.room.number && <span className="bk-chip">#{g.room.number}</span>}
          </div>
          <div className="rg-room">{g.room.name}</div>
        </div>
      </div>
      {g.floor ? (
        <>
          <div className="rg-floor"><Layers size={22} /> {t('ห้องอยู่ที่')} <b>{g.floor.name}</b></div>
          <div className="rg-card rg-plan">
            <FloorPlan floor={g.floor} rooms={g.rooms.map((r) => ({ id: r.id, name: r.name, number: r.number, x: Number(r.plan_x), y: Number(r.plan_y), w: Number(r.plan_w), h: Number(r.plan_h) }))} markers={g.floor.markers} targetId={g.room.id} />
            <div className="rg-legend">
              <span><i className="rg-dot" /> {t('ห้องของคุณ (กะพริบ)')}</span>
              {[...used].map((k) => <span key={k}>{MARKERS[k]?.icon} {t(MARKERS[k]?.label || '')}</span>)}
            </div>
          </div>
        </>
      ) : (
        <div className="rg-card center"><MapPin size={22} /> {t('สอบถามทางไปห้องได้ที่พนักงาน')}</div>
      )}
      {g.nav && <GpsGuide nav={g.nav} roomName={g.room.name} />}
    </div>
  );
}

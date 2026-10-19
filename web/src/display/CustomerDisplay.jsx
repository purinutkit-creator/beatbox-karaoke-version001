// Customer Display — runs on any device (tablet, Smart TV, phone, second screen), paired with a POS by connection code.
import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { CheckCircle2, Maximize, Mic2, Wifi, WifiOff, Globe, CreditCard, Camera, Phone, ArrowLeft, Delete, Search, XCircle } from 'lucide-react';
import { useCameraScanner } from '../lib/scanner.js';
import { useT } from '../lib/i18n.jsx';
import { api, LS } from '../lib/api.js';
import { useApp } from '../lib/store.jsx';
import { applyAppearance, applyTheme } from '../lib/fonts.js';
import { getLang } from '../lib/i18n.jsx';
import { QRCode, PinPad, money } from '../components/ui.jsx';
import { formatMinutesShort } from '@beatbox/shared/roomPricing.js';
import { PAYMENT_METHODS } from '@beatbox/shared/constants.js';
import { slideKind, youtubeId, youtubeEmbed } from '../lib/media.js';
import { BookingCard, HeroImg } from '../components/BookingCard.jsx';

/** One slide. A video plays only while it is on screen, and tells the slideshow when it has finished. */
function Slide({ item, active, single, onEnded }) {
  const ref = useRef(null);
  const kind = slideKind(item);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (active) {
      v.currentTime = 0;
      v.play().catch(() => {});
    } else v.pause();
  }, [active]);
  const style = { opacity: active ? 1 : 0 };
  let media;
  if (kind === 'YOUTUBE') media = active ? <iframe src={youtubeEmbed(youtubeId(item.image_url))} title={item.title || 'video'} allow="autoplay; encrypted-media" style={style} /> : null;
  else if (kind === 'VIDEO')
    media = <video ref={ref} src={item.image_url} muted playsInline autoPlay={active} loop={single} preload={active ? 'auto' : 'metadata'} onEnded={onEnded} onError={() => active && setTimeout(onEnded, 3000)} style={style} />;
  else media = <img src={item.image_url} alt={item.title || ''} style={style} />;
  return item.link_url && kind === 'IMAGE' ? <a href={item.link_url} target="_blank" rel="noreferrer">{media}</a> : media;
}

function Promo({ images, autoplay }) {
  const [i, setI] = useState(0);
  const cur = images.length ? i % images.length : 0;
  const next = () => setI((x) => (x + 1) % Math.max(1, images.length));
  useEffect(() => {
    if (images.length < 2 || autoplay === false) return;
    if (slideKind(images[cur]) === 'VIDEO') return; // a video file moves on when it ends
    const d = (images[cur]?.duration_seconds || 8) * 1000;
    const id = setTimeout(next, d);
    return () => clearTimeout(id);
  }, [cur, images, autoplay]);
  if (!images.length)
    return (
      <div className="overlay">
        <Mic2 size={120} />
      </div>
    );
  const single = images.length < 2 || autoplay === false;
  return images.map((img, k) => <Slide key={img.id} item={img} active={k === cur} single={single} onEnded={() => !single && next()} />);
}

export default function CustomerDisplay() {
  const { t, tp, lang, setLang } = useT();
  const { publicSettings: appSettings } = useApp();
  // the paired display belongs to the POS's store: use that store's name, logo, fonts and theme
  const [storeSettings, setStoreSettings] = useState(null);
  const publicSettings = storeSettings || appSettings;
  const params = new URLSearchParams(window.location.search);
  const [code, setCode] = useState(params.get('code') || LS.get('bb_cd_code') || '');
  const [input, setInput] = useState('');
  const [paired, setPaired] = useState(false);
  const [error, setError] = useState('');
  const [state, setState] = useState({ mode: 'IDLE' });
  const [images, setImages] = useState([]);
  const [online, setOnline] = useState(false);
  const sockRef = useRef(null);
  const successTimer = useRef(null);

  useEffect(() => {
    if (!code) return;
    let alive = true;
    api
      .get(`/public/display/${code}`, { auth: false })
      .then((d) => {
        if (!alive) return;
        setImages(d.images);
        if (d.state) setState(d.state);
        if (d.settings) {
          setStoreSettings(d.settings);
          try {
            if (d.settings.store?.slug) sessionStorage.setItem('bb_store_q', d.settings.store.slug);
          } catch {
            /* ignore */
          }
          applyAppearance(d.settings.appearance, getLang());
          applyTheme(d.settings.general);
        }
      })
      .catch((e) => {
        setError(e.message);
        setCode('');
        LS.set('bb_cd_code', null);
      });
    const s = io({ path: '/socket.io', auth: { kind: 'display' }, transports: ['websocket', 'polling'] });
    sockRef.current = s;
    const join = () =>
      s.emit('display:join', { code, clientId: LS.get('bb_device_key') || 'display' }, (r) => {
        if (r?.ok) {
          setPaired(true);
          LS.set('bb_cd_code', code);
          if (r.state) setState(r.state);
        } else setError(r?.error || 'ไม่พบรหัสเชื่อมต่อ');
      });
    s.on('connect', () => {
      setOnline(true);
      join();
    });
    s.on('disconnect', () => setOnline(false));
    s.on('display:state', (st) => setState(st || { mode: 'IDLE' }));
    s.on('sync', () => {});
    const imgPoll = setInterval(() => api.get(`/public/display/${code}`, { auth: false }).then((d) => setImages(d.images)).catch(() => {}), 120000);
    return () => {
      alive = false;
      clearInterval(imgPoll);
      s.disconnect();
    };
  }, [code]);

  useEffect(() => {
    clearTimeout(successTimer.current);
    if (state.mode === 'SUCCESS') successTimer.current = setTimeout(() => setState({ mode: 'IDLE' }), 15000);
  }, [state]);

  const store = publicSettings?.store;
  if (!code || !paired) {
    return (
      <div className="login-wrap">
        <div className="card login-card">
          <div className="row end"><button className="btn ghost sm" onClick={() => setLang(lang === 'th' ? 'en' : 'th')}><Globe size={16} /> {lang === 'th' ? 'EN' : 'TH'}</button></div>
          <h2>Customer Display</h2>
          <p className="muted">{t('กรอกรหัสเชื่อมต่อที่แสดงบนเครื่อง POS')}</p>
          {code && !error ? <p>{t('กำลังเชื่อมต่อ')}... <span className="spinner" /></p> : (
            <>
              <PinPad value={input} onChange={setInput} length={6} onComplete={(v) => { setError(''); setCode(v); }} />
              <button className="btn mt" onClick={() => { setError(''); setCode(input); }} disabled={input.length < 4}>{t('เชื่อมต่อ')}</button>
            </>
          )}
          {error && <p style={{ color: 'var(--danger)' }}>{t(error)}</p>}
        </div>
      </div>
    );
  }

  const mode = state.mode || 'IDLE';
  if (mode === 'CHECKIN' || mode === 'CHECKIN_RESULT') return <CheckInScreen state={state} socket={sockRef.current} store={store} facing={publicSettings?.general?.displayCameraFacing || 'user'} />;
  if (mode === 'ROOM_READY') return <RoomReadyScreen state={state} store={store} />;
  const split = ['CART', 'PAY_CASH', 'PAY_QR', 'PAY_OTHER'].includes(mode);
  const autoplay = publicSettings?.general?.displayAutoplay;
  return (
    <div className={`cd ${split ? 'split' : ''}`} onDoubleClick={() => document.documentElement.requestFullscreen?.()}>
      <div className="promo">
        <Promo images={images} autoplay={autoplay} />
        {mode === 'PAY_QR' && (
          <div className="overlay">
            <div style={{ fontSize: 'clamp(18px,2.4vw,36px)' }}>{t('สแกนเพื่อชำระเงิน')}</div>
            {state.qr?.data ? <QRCode value={state.qr.data} size={480} className="cd-qr" /> : state.qr?.imageUrl ? <img src={state.qr.imageUrl} alt="QR" className="cd-qr" /> : null}
            <div className="huge" style={{ color: '#facc15' }}>฿{money(state.due ?? state.net)}</div>
            <div style={{ fontSize: 'clamp(16px,2vw,30px)' }}>{state.qr?.accountName}</div>
            <div style={{ opacity: 0.8 }}>{state.qr?.bankName} {state.qr?.accountNumber}</div>
          </div>
        )}
        {mode === 'PAY_TERMINAL' && (
          <div className="overlay">
            <CreditCard size={90} />
            <div style={{ fontSize: 'clamp(20px,2.6vw,40px)', marginTop: '2vh' }}>{t('กรุณาชำระเงินที่เครื่องรับชำระเงิน')}</div>
            <div style={{ opacity: 0.8, fontSize: 'clamp(16px,1.8vw,28px)' }}>{state.method === 'CARD' ? t('แตะ/เสียบบัตร') : t('สแกน QR ที่เครื่อง')}</div>
            <div className="huge" style={{ color: '#facc15' }}>฿{money(state.due ?? state.net)}</div>
          </div>
        )}
        {mode === 'PAY_CASH' && (
          <div className="overlay">
            <div style={{ opacity: 0.8, fontSize: 'clamp(18px,2.5vw,40px)' }}>{t('ยอดสุทธิ')}</div>
            <div className="huge">฿{money(state.due ?? state.net)}</div>
            <div style={{ opacity: 0.8, fontSize: 'clamp(18px,2.5vw,40px)', marginTop: '3vh' }}>{t('รับเงินมา')}</div>
            <div className="huge" style={{ color: '#60a5fa' }}>฿{money(state.received || 0)}</div>
            <div style={{ opacity: 0.8, fontSize: 'clamp(18px,2.5vw,40px)', marginTop: '3vh' }}>{t('เงินทอน')}</div>
            <div className="huge" style={{ color: '#4ade80' }}>฿{money(state.change || 0)}</div>
          </div>
        )}
        {mode === 'PAY_OTHER' && (
          <div className="overlay">
            <div style={{ fontSize: 'clamp(18px,2.5vw,40px)' }}>{t(PAYMENT_METHODS[state.method] || state.method)}</div>
            <div className="huge">฿{money(state.due ?? state.net)}</div>
          </div>
        )}
      </div>
      <div className="panel">
        <div className="panel-inner">
          <div className="cd-head">
            {store?.logoUrl ? <img src={store.logoUrl} alt="" style={{ width: 64, height: 64, borderRadius: 14, objectFit: 'cover' }} /> : <div className="brand-logo" style={{ width: 64, height: 64 }}><Mic2 size={30} /></div>}
            <div className="grow">
              <div style={{ fontSize: 'clamp(18px,2vw,32px)', fontWeight: 800 }}>{store?.name}</div>
              <div style={{ opacity: 0.7 }}>{state.roomName ? `${state.roomName} · ${state.roomType || ''}` : store?.branchName}</div>
            </div>
            {state.queueNo && <div style={{ fontSize: 'clamp(20px,2.4vw,40px)', fontWeight: 800, background: '#ffffff1a', padding: '6px 14px', borderRadius: 12 }}>{state.queueNo}</div>}
          </div>
          <div className="cd-items">
            {(state.items || []).map((it, k) => (
              <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '0.6vh 0', borderBottom: '1px solid #ffffff1a' }}>
                <span>{it.type && it.type !== 'PRODUCT' ? tp(it.name) : it.name} {it.qty !== 1 && <span style={{ opacity: 0.6 }}>× {it.qty} @{money(it.unitPrice)}</span>}</span>
                <b>{money(it.total)}</b>
              </div>
            ))}
            {state.minutes > 0 && <div style={{ opacity: 0.7, marginTop: 8 }}>{t('จำนวนเวลา')} {formatMinutesShort(state.minutes)} · {t('ยอดค่าห้อง')} {money(state.roomCharge)}</div>}
          </div>
          <div style={{ fontSize: 'clamp(14px,1.5vw,24px)' }}>
            <div className="row between"><span>{t('ยอดรวม')}</span><span>{money(state.subtotal)}</span></div>
            {state.discount > 0 && <div className="row between" style={{ color: '#4ade80' }}><span>{t('ส่วนลด')}</span><span>-{money(state.discount)}</span></div>}
            {state.serviceCharge > 0 && <div className="row between"><span>Service Charge</span><span>{money(state.serviceCharge)}</span></div>}
            {state.vat > 0 && <div className="row between"><span>VAT</span><span>{money(state.vat)}</span></div>}
            {state.deposit > 0 && <div className="row between"><span>{t('เงินมัดจำ')}</span><span>-{money(state.deposit)}</span></div>}
          </div>
          <div className="row between" style={{ marginTop: '1vh' }}>
            <span style={{ fontSize: 'clamp(18px,2vw,32px)' }}>{t('ยอดสุทธิ')}</span>
            <span className="cd-total">฿{money(state.net ?? state.total)}</span>
          </div>
          {state.method && <div style={{ opacity: 0.7 }}>{t('ช่องทางชำระเงิน')}: {t(PAYMENT_METHODS[state.method] || state.method)}</div>}
        </div>
      </div>
      {mode === 'SUCCESS' && (
        <div className={`overlay ${state.room ? 'cd-success-room' : ''}`} style={{ zIndex: 5 }}>
          <div className="check-anim"><CheckCircle2 size="70%" color="#fff" /></div>
          <div className="huge" style={{ marginTop: state.room ? '1vh' : '3vh' }}>{t('ชำระเงินเรียบร้อย')}</div>
          <div style={{ fontSize: 'clamp(20px,3vw,48px)' }}>{t('ยอดที่ชำระ')} ฿{money(state.total)}</div>
          {state.change > 0 && <div style={{ fontSize: 'clamp(24px,4vw,64px)', color: '#4ade80', fontWeight: 800 }}>{t('เงินทอน')} ฿{money(state.change)}</div>}
          {state.points > 0 && <div style={{ fontSize: 'clamp(16px,2vw,30px)', color: '#facc15' }}>+{state.points} {t('คะแนน')}</div>}
          {state.room ? <div style={{ marginTop: '2vh', width: '100%', display: 'flex', justifyContent: 'center' }}><RoomPanel room={state.room} /></div> : <div style={{ fontSize: 'clamp(18px,2.5vw,40px)', marginTop: '2vh' }}>{publicSettings?.receipt?.thankYou || t('ขอบคุณที่ใช้บริการ')}</div>}
        </div>
      )}
      <div style={{ position: 'fixed', bottom: 8, right: 8, opacity: 0.4, display: 'flex', gap: 8, zIndex: 9 }}>
        {online ? <Wifi size={16} /> : <WifiOff size={16} color="#ef4444" />}
        <button className="btn ghost sm" onClick={() => setLang(lang === 'th' ? 'en' : 'th')}>{lang === 'th' ? 'EN' : 'TH'}</button>
        <button className="btn ghost sm" onClick={() => document.documentElement.requestFullscreen?.()}><Maximize size={14} /></button>
        <button className="btn ghost sm" onClick={() => { LS.set('bb_cd_code', null); window.location.href = '/display'; }}>{code}</button>
      </div>
    </div>
  );
}

/** POS asked the customer to check in on this display: scan the booking QR with the camera or type the phone number. */
/** The room the customer has just paid for / been given: picture, floor, START → END, how long, QR to the way there. */
function RoomPanel({ room }) {
  const { t, lang } = useT();
  if (!room) return null;
  const hm = (d) => new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' });
  const day = (d) => new Date(d).toLocaleDateString(lang === 'en' ? 'en-GB' : 'th-TH', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Bangkok' });
  return (
    <div className="cd-room">
      <div className="cd-room-pic">
        <HeroImg src={room.imageUrl} />
        <div className="cd-room-name">
          <div className="bk-chips">
            {room.typeName && <span className="bk-chip">{room.typeName}</span>}
            {room.floorName && <span className="bk-chip">{room.floorName}</span>}
            {room.number && <span className="bk-chip">#{room.number}</span>}
          </div>
          <div>{room.name}</div>
        </div>
      </div>
      <div className="cd-room-info">
        {room.startAt && (
          <>
            <div className="cd-room-day">{day(room.startAt)}</div>
            <div className="cd-room-time"><b>{hm(room.startAt)}</b><span>→</span><b>{room.endAt ? hm(room.endAt) : '--:--'}</b></div>
            {room.minutes > 0 && <div className="cd-room-len">{t('ระยะเวลา')} {formatMinutesShort(room.minutes)}</div>}
          </>
        )}
        {room.guideUrl && (
          <div className="cd-room-guide">
            <QRCode value={room.guideUrl} size={360} className="cd-room-qr" />
            <div><b>{t('สแกนเพื่อดูทางไปห้อง')}</b><div style={{ opacity: 0.8 }}>{t('ผังร้านและตำแหน่งห้องของคุณ')}</div></div>
          </div>
        )}
      </div>
    </div>
  );
}

function RoomReadyScreen({ state, store }) {
  const { t } = useT();
  return (
    <div className="cd">
      <div className="promo">
        <div className="overlay cd-room-wrap">
          <div className="cd-head" style={{ marginBottom: '2vh' }}>
            {store?.logoUrl ? <img src={store.logoUrl} alt="" style={{ width: 56, height: 56, borderRadius: 14, objectFit: 'cover' }} /> : <div className="brand-logo" style={{ width: 56, height: 56 }}><Mic2 size={26} /></div>}
            <div style={{ fontSize: 'clamp(20px,2.6vw,40px)', fontWeight: 800 }}>{t('ห้องของคุณพร้อมแล้ว')}</div>
          </div>
          <RoomPanel room={state.room} />
        </div>
      </div>
    </div>
  );
}

function CheckInScreen({ state, socket, store, facing = 'user' }) {
  const { t } = useT();
  const [how, setHow] = useState(null); // null | CAMERA | PHONE | SENT
  const [phone, setPhone] = useState('');
  const [err, setErr] = useState('');
  const videoRef = useRef();
  useEffect(() => {
    setHow(null);
    setPhone('');
    setErr('');
  }, [state.requestId]);
  const send = (kind, value) => {
    socket?.emit('display:checkin', { requestId: state.requestId, kind, value });
    setHow('SENT');
  };
  // the camera stays ready between customers (paused, not closed): the browser asks for permission only once
  useCameraScanner(videoRef, how === 'CAMERA', (v) => send('SCAN', v), (e) => { setErr(t(e.message)); setHow(null); }, { facing, keep: true });
  const result = state.mode === 'CHECKIN_RESULT' ? state : null;
  return (
    <div className="cd">
      <div className="promo">
        <div className="overlay">
          <div className="cd-head" style={{ marginBottom: '3vh' }}>
            {store?.logoUrl ? <img src={store.logoUrl} alt="" style={{ width: 64, height: 64, borderRadius: 14, objectFit: 'cover' }} /> : <div className="brand-logo" style={{ width: 64, height: 64 }}><Mic2 size={30} /></div>}
            <div style={{ fontSize: 'clamp(20px,2.4vw,36px)', fontWeight: 800 }}>{store?.name}</div>
          </div>
          {result ? (
            <div className="cd-checkin">
              {result.found ? <CheckCircle2 size={result.booking ? 64 : 110} color="#4ade80" /> : <XCircle size={110} color="#f87171" />}
              <div style={{ fontSize: 'clamp(24px,3.2vw,52px)', fontWeight: 800 }}>{result.found ? t('พบการจองของคุณ') : t('ไม่พบการจอง')}</div>
              {result.found ? (
                result.booking ? <BookingCard b={result.booking} variant="display" /> : <div style={{ fontSize: 'clamp(18px,2.2vw,34px)' }}>{result.customerName}</div>
              ) : <div style={{ opacity: 0.8 }}>{t('กรุณาติดต่อพนักงาน')}</div>}
            </div>
          ) : (
            <div className="cd-checkin">
              <div style={{ fontSize: 'clamp(22px,3vw,48px)', fontWeight: 800 }}>{t('ตรวจสอบการจอง')}</div>
              {how === null && (
                <>
                  <div style={{ opacity: 0.85, fontSize: 'clamp(16px,1.8vw,26px)' }}>{t('สแกน QR การจองในโทรศัพท์ของคุณ หรือกรอกเบอร์โทรที่ใช้จอง')}</div>
                  <button className="btn primary" onClick={() => setHow('CAMERA')}><Camera size={28} /> {t('เปิดกล้องสแกน QR การจอง')}</button>
                  <button className="btn" onClick={() => setHow('PHONE')}><Phone size={28} /> {t('กรอกเบอร์โทรศัพท์')}</button>
                  {err && <div style={{ color: '#fca5a5' }}>{err}</div>}
                </>
              )}
              {how === 'CAMERA' && (
                <>
                  <video ref={videoRef} muted playsInline className={facing === 'user' ? 'mirror' : ''} />
                  <div style={{ opacity: 0.85 }}>{t('หันหน้าจอ QR การจองเข้าหากล้อง')}</div>
                  <button className="btn ghost" onClick={() => setHow(null)}><ArrowLeft size={22} /> {t('ย้อนกลับ')}</button>
                </>
              )}
              {how === 'PHONE' && (
                <>
                  <div className={`cd-phone ${phone ? '' : 'empty'}`}>{phone.replace(/(\d{3})(\d{3})(\d{0,4})/, '$1-$2-$3') || '0__-___-____'}</div>
                  <div className="numpad cd-numpad">
                    {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'].map((k) => (
                      <button key={k} type="button" className={k === 'C' || k === '⌫' ? 'fn' : ''} onClick={() => setPhone(k === 'C' ? '' : k === '⌫' ? phone.slice(0, -1) : (phone + k).slice(0, 10))}>{k === '⌫' ? <Delete size={30} strokeWidth={2.5} /> : k}</button>
                    ))}
                  </div>
                  <div className="row" style={{ justifyContent: 'center' }}>
                    <button className="btn ghost" style={{ width: 'auto' }} onClick={() => setHow(null)}><ArrowLeft size={22} /> {t('ย้อนกลับ')}</button>
                    <button className="btn primary" style={{ width: 'auto' }} disabled={phone.length < 9} onClick={() => send('PHONE', phone)}><Search size={22} /> {t('ค้นหาการจอง')}</button>
                  </div>
                </>
              )}
              {how === 'SENT' && <div style={{ fontSize: 'clamp(18px,2.2vw,32px)' }}><span className="spinner lg" /> {t('กำลังค้นหาการจอง')}...</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

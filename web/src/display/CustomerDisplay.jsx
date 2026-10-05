// Customer Display — runs on any device (tablet, Smart TV, phone, second screen), paired with a POS by connection code.
import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { CheckCircle2, Maximize, Mic2, Wifi, WifiOff, Globe, CreditCard, Camera, Phone, ArrowLeft, Delete, Search, XCircle } from 'lucide-react';
import { useCameraScanner } from '../lib/scanner.js';
import { useT } from '../lib/i18n.jsx';
import { api, LS } from '../lib/api.js';
import { useApp } from '../lib/store.jsx';
import { QRCode, PinPad, money } from '../components/ui.jsx';
import { formatMinutesShort } from '@beatbox/shared/roomPricing.js';
import { PAYMENT_METHODS } from '@beatbox/shared/constants.js';

function Promo({ images, autoplay }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!images.length || autoplay === false) return;
    const d = (images[i % images.length]?.duration_seconds || 8) * 1000;
    const id = setTimeout(() => setI((x) => (x + 1) % images.length), d);
    return () => clearTimeout(id);
  }, [i, images, autoplay]);
  if (!images.length)
    return (
      <div className="overlay">
        <Mic2 size={120} />
      </div>
    );
  return images.map((img, k) => (
    <a key={img.id} href={img.link_url || undefined} target="_blank" rel="noreferrer">
      <img src={img.image_url} alt={img.title || ''} style={{ opacity: k === i % images.length ? 1 : 0 }} />
    </a>
  ));
}

export default function CustomerDisplay() {
  const { t, tp, lang, setLang } = useT();
  const { publicSettings } = useApp();
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
  if (mode === 'CHECKIN' || mode === 'CHECKIN_RESULT') return <CheckInScreen state={state} socket={sockRef.current} store={store} />;
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
        <div className="overlay" style={{ zIndex: 5 }}>
          <div className="check-anim"><CheckCircle2 size="70%" color="#fff" /></div>
          <div className="huge" style={{ marginTop: '3vh' }}>{t('ชำระเงินเรียบร้อย')}</div>
          <div style={{ fontSize: 'clamp(20px,3vw,48px)' }}>{t('ยอดที่ชำระ')} ฿{money(state.total)}</div>
          {state.change > 0 && <div style={{ fontSize: 'clamp(24px,4vw,64px)', color: '#4ade80', fontWeight: 800 }}>{t('เงินทอน')} ฿{money(state.change)}</div>}
          {state.points > 0 && <div style={{ fontSize: 'clamp(16px,2vw,30px)', color: '#facc15' }}>+{state.points} {t('คะแนน')}</div>}
          <div style={{ fontSize: 'clamp(18px,2.5vw,40px)', marginTop: '2vh' }}>{publicSettings?.receipt?.thankYou || t('ขอบคุณที่ใช้บริการ')}</div>
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
function CheckInScreen({ state, socket, store }) {
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
  useCameraScanner(videoRef, how === 'CAMERA', (v) => send('SCAN', v), (e) => { setErr(t(e.message)); setHow(null); });
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
              {result.found ? <CheckCircle2 size={110} color="#4ade80" /> : <XCircle size={110} color="#f87171" />}
              <div style={{ fontSize: 'clamp(24px,3.2vw,52px)', fontWeight: 800 }}>{result.found ? t('พบการจองของคุณ') : t('ไม่พบการจอง')}</div>
              {result.found ? (
                <div style={{ fontSize: 'clamp(18px,2.2vw,34px)' }}>
                  <div>{result.customerName}</div>
                  <div style={{ opacity: 0.85 }}>{result.bookingNo} · {result.roomName}</div>
                  <div style={{ opacity: 0.85 }}>{result.time}</div>
                </div>
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
                  <video ref={videoRef} muted playsInline />
                  <div style={{ opacity: 0.85 }}>{t('หันหน้าจอ QR การจองเข้าหากล้อง')}</div>
                  <button className="btn ghost" onClick={() => setHow(null)}><ArrowLeft size={22} /> {t('ย้อนกลับ')}</button>
                </>
              )}
              {how === 'PHONE' && (
                <>
                  <div className="cd-total" style={{ letterSpacing: 4, minHeight: '1.2em' }}>{phone.replace(/(\d{3})(\d{3})(\d{0,4})/, '$1-$2-$3') || '0__-___-____'}</div>
                  <div className="numpad" style={{ width: 'min(80vw, 420px)' }}>
                    {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'].map((k) => (
                      <button key={k} type="button" style={{ fontSize: 'clamp(22px,3vw,40px)' }} onClick={() => setPhone(k === 'C' ? '' : k === '⌫' ? phone.slice(0, -1) : (phone + k).slice(0, 10))}>{k === '⌫' ? <Delete size={26} /> : k}</button>
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

// In-room page opened from the QR on the customer's room ticket: order food & drinks (pay now with PromptPay or
// at the counter), see the remaining room time, and report a problem / call staff. The link expires when the room closes.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import QRCodeLib from 'qrcode';
import { Mic2, Clock, ShoppingCart, UtensilsCrossed, AlertTriangle, Plus, Minus, Trash2, CheckCircle2, Download, Upload, X, Globe, Receipt, BellRing, Hourglass } from 'lucide-react';
import { useT } from '../lib/i18n.jsx';
import { api, uid } from '../lib/api.js';
import { Button, Textarea, Badge, Spinner, Loading, money, useToast } from '../components/ui.jsx';
import { sessionTiming } from '@beatbox/shared/roomPricing.js';
import { fmtTime, fmtCountdown } from '@beatbox/shared/format.js';

function useRoom(token) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const offset = useRef(0);
  const load = async () => {
    try {
      const t0 = Date.now();
      const d = await api.get(`/public/room/${token}`, { auth: false, passive: true });
      offset.current = d.now - (t0 + Date.now()) / 2;
      setData(d);
      setError(null);
    } catch (e) {
      setError(e);
    }
  };
  useEffect(() => {
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [token]);
  return { data, error, reload: load, now: () => Date.now() + offset.current };
}

function Sheet({ title, onClose, children, footer }) {
  return (
    <div className="ro-sheet-wrap" onClick={onClose}>
      <div className="ro-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="row between nowrap" style={{ marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>{title}</h3>
          <button className="btn ghost icon" onClick={onClose}><X size={20} /></button>
        </div>
        <div className="ro-sheet-body">{children}</div>
        {footer && <div className="ro-sheet-foot">{footer}</div>}
      </div>
    </div>
  );
}

function ProductSheet({ product, onAdd, onClose }) {
  const { t } = useT();
  const [qty, setQty] = useState(1);
  const [opts, setOpts] = useState([]);
  const [note, setNote] = useState('');
  const price = Number(product.price) + (product.options || []).filter((o) => opts.includes(o.id)).reduce((s, o) => s + Number(o.price), 0);
  return (
    <Sheet title={product.name} onClose={onClose} footer={<Button variant="primary" size="lg" block icon={Plus} onClick={() => onAdd({ product, qty, options: opts, note, unitPrice: price })}>{t('ใส่ตะกร้า')} ฿{money(price * qty)}</Button>}>
      {product.image_url && <img src={product.image_url} alt="" style={{ width: '100%', maxHeight: 200, objectFit: 'cover', borderRadius: 12 }} />}
      {product.description && <p className="muted small">{product.description}</p>}
      {(product.options || []).length > 0 && (
        <div className="col" style={{ gap: 6 }}>
          {product.options.map((o) => (
            <label key={o.id} className="check card flat" style={{ padding: 10 }}>
              <input type="checkbox" checked={opts.includes(o.id)} onChange={(e) => setOpts(e.target.checked ? [...opts, o.id] : opts.filter((x) => x !== o.id))} />
              <span className="grow">{o.group ? `${o.group}: ` : ''}{o.name}</span>
              {Number(o.price) > 0 && <span>+{money(o.price)}</span>}
            </label>
          ))}
        </div>
      )}
      <Textarea className="mt" placeholder={t('หมายเหตุ เช่น ไม่ใส่น้ำแข็ง')} value={note} onChange={(e) => setNote(e.target.value)} style={{ minHeight: 44 }} />
      <div className="row mt" style={{ justifyContent: 'center' }}>
        <div className="qty big">
          <button onClick={() => setQty(Math.max(1, qty - 1))}><Minus size={18} /></button>
          <b>{qty}</b>
          <button onClick={() => setQty(qty + 1)}><Plus size={18} /></button>
        </div>
      </div>
    </Sheet>
  );
}

/** PromptPay QR + save button + slip upload + "check payment". */
function PayScreen({ token, order, payment, service, onDone, onClose }) {
  const { t } = useT();
  const toast = useToast();
  const [qrUrl, setQrUrl] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (payment?.qrData) QRCodeLib.toDataURL(payment.qrData, { width: 600, margin: 2 }).then(setQrUrl);
  }, [payment?.qrData]);
  const saveQr = async () => {
    const src = qrUrl || payment.qrImageUrl;
    try {
      const blob = await (await fetch(src)).blob();
      const f = new File([blob], `promptpay-${money(order.amount)}.png`, { type: blob.type || 'image/png' });
      if (navigator.canShare?.({ files: [f] })) await navigator.share({ files: [f], title: 'PromptPay QR' });
      else {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = f.name;
        a.click();
      }
    } catch {
      toast.info(t('กดค้างที่รูป QR แล้วเลือก "บันทึกรูปภาพ"'));
    }
  };
  const submit = async () => {
    setBusy(true);
    try {
      const fd = new FormData();
      if (file) fd.append('slip', file);
      const r = await api.post(`/public/room/${token}/orders/${order.id}/pay`, fd, { auth: false });
      onDone(r.order);
    } catch (e) {
      toast.error(e);
      onDone(null);
    } finally {
      setBusy(false);
    }
  };
  const toCounter = async () => {
    try {
      const r = await api.post(`/public/room/${token}/orders/${order.id}/counter`, {}, { auth: false });
      onDone(r.order);
    } catch (e) {
      toast.error(e);
    }
  };
  const cancel = async () => {
    try {
      await api.post(`/public/room/${token}/orders/${order.id}/cancel`, {}, { auth: false });
      onClose();
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <Sheet title={t('ชำระเงินค่าอาหาร')} onClose={onClose}>
      <div className="center">
        {qrUrl ? <img src={qrUrl} alt="PromptPay QR" className="ro-qr" /> : payment?.qrImageUrl ? <img src={payment.qrImageUrl} alt="QR" className="ro-qr" /> : <div className="muted">{t('ยังไม่ได้ตั้งค่า QR Code')}</div>}
        <div className="big-money" style={{ color: 'var(--primary)' }}>฿{money(order.amount)}</div>
        <div className="small">{payment?.accountName}</div>
        <div className="xs muted">{payment?.bankName} {payment?.accountNumber}</div>
        <Button className="mt" icon={Download} onClick={saveQr}>{t('บันทึกรูป QR')}</Button>
        <div className="xs muted mt">{t('บันทึกรูป QR แล้วเปิดแอปธนาคาร เลือกสแกนจากรูปภาพ')}</div>
      </div>
      {order.rejectReason && <div className="card flat mt" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}>{t('การชำระเงินไม่ผ่าน')}: {t(order.rejectReason)}</div>}
      <label className="ro-upload mt">
        <input type="file" accept="image/png,image/jpeg" hidden onChange={(e) => setFile(e.target.files[0])} />
        <Upload size={20} /> {file ? file.name : t('แนบสลิปการโอนเงิน')}
      </label>
      <Button className="mt" variant="primary" size="lg" block icon={CheckCircle2} loading={busy} disabled={service.requireSlip && !file} onClick={submit}>{t('ตรวจสอบการชำระเงิน')}</Button>
      <div className="row mt" style={{ justifyContent: 'center' }}>
        {service.allowPayAtCounter && <Button variant="ghost" size="sm" onClick={toCounter}>{t('เปลี่ยนเป็นชำระที่เคาน์เตอร์')}</Button>}
        <Button variant="ghost" size="sm" onClick={cancel}>{t('ยกเลิกรายการ')}</Button>
      </div>
    </Sheet>
  );
}

function OrderStatus({ o, service, now }) {
  const { t } = useT();
  if (o.status === 'AWAITING_PAYMENT') return <Badge color="#f97316">{o.paymentStatus === 'REJECTED' ? t('ชำระเงินไม่ผ่าน') : t('รอชำระเงิน')}</Badge>;
  if (o.status === 'VERIFYING') {
    const left = Math.max(0, Math.ceil(service.autoAcceptSeconds - (now - new Date(o.submittedAt).getTime()) / 1000));
    return <Badge color="#3b82f6"><Spinner /> {t('กำลังตรวจสอบการชำระเงิน')} {left > 0 ? `(${left}s)` : ''}</Badge>;
  }
  if (o.status === 'PLACED') {
    if (o.payMode === 'COUNTER') return <Badge color="#8b5cf6">{t('ส่งครัวแล้ว · ชำระที่เคาน์เตอร์')}</Badge>;
    if (o.paymentStatus === 'REJECTED') return <Badge color="#dc2626">{t('ส่งครัวแล้ว · กรุณาชำระที่เคาน์เตอร์')}</Badge>;
    return <Badge color="#16a34a">{t('ชำระเงินสำเร็จ · ส่งครัวแล้ว')}</Badge>;
  }
  return <Badge>{o.status}</Badge>;
}

export default function RoomOrderApp() {
  const { token } = useParams();
  const { t, lang, setLang } = useT();
  const toast = useToast();
  const { data, error, reload, now } = useRoom(token);
  const [tick, setTick] = useState(Date.now());
  const [tab, setTab] = useState('menu');
  const [cat, setCat] = useState(null);
  const [pick, setPick] = useState(null);
  const [cart, setCart] = useState([]);
  const [cartOpen, setCartOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [paying, setPaying] = useState(null); // { order, payment }
  const [issue, setIssue] = useState(null);
  const [issueText, setIssueText] = useState('');
  const opKey = useRef(uid());
  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const products = useMemo(() => (data?.products || []).filter((p) => !cat || p.category_id === cat), [data, cat]);
  if (error?.status === 410 || error?.code === 'ROOM_CLOSED')
    return (
      <div className="ro-center">
        <Mic2 size={60} />
        <h2>{t('QR นี้หมดอายุแล้ว')}</h2>
        <p className="muted">{t('ห้องนี้ปิดแล้ว ขอบคุณที่ใช้บริการ')}</p>
      </div>
    );
  if (error && !data) return <div className="ro-center"><AlertTriangle size={50} /><h3>{t(error.message)}</h3></div>;
  if (!data) return <Loading />;
  void tick;
  const nowMs = now();
  const timing = sessionTiming(data.room.session, nowMs);
  const service = data.service;
  const cartTotal = cart.reduce((s, i) => s + i.unitPrice * i.qty, 0);
  const cartCount = cart.reduce((s, i) => s + i.qty, 0);
  const placeOrder = async (payMode) => {
    setBusy(true);
    try {
      const r = await api.post(`/public/room/${token}/orders`, { items: cart.map((i) => ({ productId: i.product.id, qty: i.qty, note: i.note || null, options: i.options })), payMode, clientOpId: opKey.current }, { auth: false });
      opKey.current = uid();
      setCart([]);
      setCartOpen(false);
      if (payMode === 'NOW') setPaying(r);
      else toast.success(t('สั่งอาหารเรียบร้อย ส่งเข้าครัวแล้ว'));
      setTab('orders');
      reload();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const openPay = async (o) => {
    try {
      setPaying(await api.get(`/public/room/${token}/orders/${o.id}/payment`, { auth: false }));
    } catch (e) {
      toast.error(e);
    }
  };
  const sendIssue = async () => {
    try {
      await api.post(`/public/room/${token}/issues`, { category: issue, message: issueText || null }, { auth: false });
      toast.success(t('แจ้งพนักงานแล้ว พนักงานกำลังไปที่ห้อง'));
      setIssue(null);
      setIssueText('');
      reload();
    } catch (e) {
      toast.error(e);
    }
  };
  const ISSUE_STATUS = { OPEN: ['รอพนักงาน', '#f97316'], ACKNOWLEDGED: ['พนักงานรับเรื่องแล้ว', '#3b82f6'], RESOLVED: ['แก้ไขแล้ว', '#16a34a'] };
  return (
    <div className="ro">
      <header className="ro-head">
        <div className="row between nowrap">
          <div className="row nowrap">
            {data.store.logoUrl ? <img src={data.store.logoUrl} alt="" style={{ width: 36, height: 36, borderRadius: 10, objectFit: 'cover' }} /> : <div className="brand-logo" style={{ width: 36, height: 36 }}><Mic2 size={18} /></div>}
            <div>
              <div className="bold">{data.room.name}</div>
              <div className="xs" style={{ opacity: 0.8 }}>{data.store.name}</div>
            </div>
          </div>
          <button className="btn ghost sm" style={{ color: '#fff' }} onClick={() => setLang(lang === 'th' ? 'en' : 'th')}><Globe size={14} /> {lang === 'th' ? 'EN' : 'TH'}</button>
        </div>
        <div className="ro-timer">
          <Clock size={18} /> {timing.isPaused ? t('หยุดเวลาอยู่') : t('เวลาคงเหลือ')}
          <div className="ro-countdown" style={{ color: timing.remainingMs <= 10 * 60000 ? '#fca5a5' : undefined }}>{fmtCountdown(timing.remainingMs)}</div>
          <div className="xs" style={{ opacity: 0.85 }}>{t('เริ่ม')} {fmtTime(data.room.startedAt)} · {t('สิ้นสุด')} {fmtTime(timing.endMs)}</div>
        </div>
        <nav className="ro-tabs">
          <button className={tab === 'menu' ? 'on' : ''} onClick={() => setTab('menu')}><UtensilsCrossed size={16} /> {t('เมนู')}</button>
          <button className={tab === 'orders' ? 'on' : ''} onClick={() => setTab('orders')}><Receipt size={16} /> {t('รายการที่สั่ง')}{data.orders.length ? ` (${data.orders.length})` : ''}</button>
          <button className={tab === 'help' ? 'on' : ''} onClick={() => setTab('help')}><BellRing size={16} /> {t('แจ้งปัญหา')}</button>
        </nav>
      </header>

      <main className="ro-main">
        {tab === 'menu' && (
          !service.enabled ? <div className="ro-center"><UtensilsCrossed size={40} /><p>{t('ร้านปิดการสั่งอาหารผ่าน QR ชั่วคราว กรุณาติดต่อพนักงาน')}</p></div> : (
            <>
              <div className="ro-cats">
                <button className={!cat ? 'on' : ''} onClick={() => setCat(null)}>{t('ทั้งหมด')}</button>
                {data.categories.map((c) => <button key={c.id} className={cat === c.id ? 'on' : ''} onClick={() => setCat(c.id)}>{c.name}</button>)}
              </div>
              <div className="ro-grid">
                {products.map((p) => (
                  <button key={p.id} className="ro-item" disabled={p.sold_out} onClick={() => setPick(p)}>
                    <div className="ro-img" style={p.image_url ? { backgroundImage: `url(${p.image_url})` } : undefined}>{!p.image_url && <UtensilsCrossed size={28} />}</div>
                    <div className="ro-name">{p.name}</div>
                    <div className="row between nowrap"><b>฿{money(p.price, 0)}</b>{p.sold_out ? <Badge color="#dc2626">{t('หมด')}</Badge> : <Plus size={18} />}</div>
                  </button>
                ))}
              </div>
            </>
          )
        )}

        {tab === 'orders' && (
          <div className="col">
            {!data.orders.length && <div className="ro-center muted">{t('ยังไม่มีรายการที่สั่ง')}</div>}
            {data.orders.map((o) => (
              <div key={o.id} className="card">
                <div className="row between nowrap"><b>#{o.id} · {fmtTime(o.createdAt)}</b><b>฿{money(o.amount)}</b></div>
                <div className="small mt">{o.items.map((i, k) => <div key={k}>{i.name} × {i.qty}{i.note ? <span className="muted"> · {i.note}</span> : null}</div>)}</div>
                <div className="row between mt">
                  <OrderStatus o={o} service={service} now={nowMs} />
                  {o.status === 'AWAITING_PAYMENT' && <Button size="sm" variant="primary" onClick={() => openPay(o)}>{t('ชำระเงิน')}</Button>}
                </div>
                {o.rejectReason && <div className="xs mt" style={{ color: 'var(--danger)' }}>{t(o.rejectReason)}</div>}
              </div>
            ))}
          </div>
        )}

        {tab === 'help' && (
          <div className="col">
            <p className="muted small">{t('พบปัญหาในห้อง หรือต้องการเรียกพนักงาน เลือกหัวข้อด้านล่าง')}</p>
            <div className="grid grid-2" style={{ gap: 8 }}>
              {service.issueOptions.map((o) => <Button key={o} size="lg" onClick={() => setIssue(o)}>{t(o)}</Button>)}
              <Button size="lg" variant="warn" onClick={() => setIssue('OTHER')}>{t('อื่นๆ')}</Button>
            </div>
            {data.issues.length > 0 && <h4 className="mt">{t('ประวัติการแจ้ง')}</h4>}
            {data.issues.map((i) => (
              <div key={i.id} className="card flat row between nowrap" style={{ padding: 10 }}>
                <div className="grow"><b>{t(i.category)}</b>{i.message && <div className="small muted">{i.message}</div>}<div className="xs muted">{fmtTime(i.created_at)}</div></div>
                <Badge color={ISSUE_STATUS[i.status]?.[1]}>{t(ISSUE_STATUS[i.status]?.[0] || i.status)}</Badge>
              </div>
            ))}
          </div>
        )}
      </main>

      {tab === 'menu' && cartCount > 0 && (
        <button className="ro-cartbar" onClick={() => setCartOpen(true)}>
          <ShoppingCart size={20} /> {t('ตะกร้า')} {cartCount} {t('รายการ')} <span className="grow" /> ฿{money(cartTotal)}
        </button>
      )}

      {pick && <ProductSheet product={pick} onClose={() => setPick(null)} onAdd={(it) => { setCart((c) => [...c, it]); setPick(null); toast.success(`${t('เพิ่ม')} ${it.product.name}`); }} />}

      {cartOpen && (
        <Sheet title={t('ตะกร้าของฉัน')} onClose={() => setCartOpen(false)} footer={
          <div className="col" style={{ gap: 8 }}>
            <div className="row between"><span>{t('ยอดรวม')}</span><b style={{ fontSize: '1.3rem' }}>฿{money(cartTotal)}</b></div>
            {service.allowPayNow && <Button variant="primary" size="lg" block loading={busy} onClick={() => placeOrder('NOW')}>{t('สั่งและชำระเงินตอนนี้ (QR PromptPay)')}</Button>}
            {service.allowPayAtCounter && <Button size="lg" block loading={busy} onClick={() => placeOrder('COUNTER')}>{t('สั่งเลย ชำระทีเดียวที่เคาน์เตอร์')}</Button>}
          </div>
        }>
          {cart.map((i, k) => (
            <div key={k} className="row between nowrap card flat" style={{ padding: 10 }}>
              <div className="grow"><div>{i.product.name}</div>{i.note && <div className="xs muted">{i.note}</div>}<div className="xs">฿{money(i.unitPrice)}</div></div>
              <div className="qty">
                <button onClick={() => setCart(cart.map((x, j) => (j === k ? { ...x, qty: Math.max(1, x.qty - 1) } : x)))}><Minus size={14} /></button>
                <b>{i.qty}</b>
                <button onClick={() => setCart(cart.map((x, j) => (j === k ? { ...x, qty: x.qty + 1 } : x)))}><Plus size={14} /></button>
              </div>
              <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setCart(cart.filter((_, j) => j !== k))} />
            </div>
          ))}
          <div className="xs muted mt">{t('ราคารวมภาษีและค่าบริการตามที่ร้านกำหนด')}</div>
        </Sheet>
      )}

      {paying && (
        <PayScreen token={token} order={paying.order} payment={paying.payment} service={service} onClose={() => { setPaying(null); reload(); }}
          onDone={(o) => { if (o && o.status !== 'AWAITING_PAYMENT') { setPaying(null); toast.success(o.status === 'PLACED' ? t('ชำระเงินสำเร็จ ส่งเข้าครัวแล้ว') : t('ส่งข้อมูลการชำระเงินแล้ว กำลังตรวจสอบ')); } reload(); }} />
      )}

      {issue && (
        <Sheet title={issue === 'OTHER' ? t('แจ้งปัญหาอื่นๆ') : t(issue)} onClose={() => setIssue(null)} footer={<Button variant="danger" size="lg" block icon={BellRing} disabled={issue === 'OTHER' && !issueText.trim()} onClick={sendIssue}>{t('แจ้งพนักงาน')}</Button>}>
          <Textarea placeholder={issue === 'OTHER' ? t('อธิบายปัญหาที่พบ') : t('รายละเอียดเพิ่มเติม (ไม่บังคับ)')} value={issueText} onChange={(e) => setIssueText(e.target.value)} style={{ minHeight: 100 }} autoFocus />
          <div className="xs muted mt"><Hourglass size={12} /> {t('พนักงานจะได้รับแจ้งเตือนทันที')}</div>
        </Sheet>
      )}
    </div>
  );
}

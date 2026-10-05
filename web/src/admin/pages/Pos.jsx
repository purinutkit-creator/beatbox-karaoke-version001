import { useEffect, useMemo, useState } from 'react';
import { ShoppingCart, Trash2, Plus, Minus, CreditCard, DoorOpen, User, Percent, StickyNote, X } from 'lucide-react';
import { Button, Modal, Badge, Empty, money, useToast, useDialog, Field, Input, Seg } from '../../components/ui.jsx';
import { ProductCatalog } from '../../components/ProductCatalog.jsx';
import { MemberPicker } from '../../components/MemberPicker.jsx';
import Checkout from '../../components/Checkout.jsx';
import { useT } from '../../lib/i18n.jsx';
import { api, uid } from '../../lib/api.js';
import { useAuth } from '../../lib/store.jsx';
import { useLive } from '../../lib/socket.js';
import { pushDisplay, idleDisplay } from '../../lib/display.js';
import { calculateBill } from '@beatbox/shared/calc.js';

export default function Pos() {
  const { t } = useT();
  const toast = useToast();
  const { prompt } = useDialog();
  const { settings, shift, can } = useAuth();
  const [cart, setCart] = useState([]);
  const [member, setMember] = useState(null);
  const [checkoutId, setCheckoutId] = useState(null);
  const [modal, setModal] = useState(null);
  const [busy, setBusy] = useState(false);
  const [billDisc, setBillDisc] = useState(null);
  const { data: board } = useLive(() => api.get('/rooms/board', { passive: true }), ['rooms'], []);
  const activeRooms = (board?.rooms || []).filter((r) => r.session && ['ACTIVE', 'PAUSED', 'SCHEDULED', 'CLOSED'].includes(r.session.status));

  const add = (p, qty = 1, options = [], note = '') => {
    const optObjs = (p.options || []).filter((o) => options.includes(o.id));
    const unit = Number(p.price) + optObjs.reduce((s, o) => s + Number(o.price_delta), 0);
    setCart((c) => {
      const key = `${p.id}:${options.join(',')}:${note}`;
      const ex = c.find((x) => x.key === key);
      if (ex) return c.map((x) => (x.key === key ? { ...x, qty: x.qty + qty } : x));
      return [...c, { key, product: p, qty, options, optionNames: optObjs.map((o) => o.name), note, unitPrice: unit, discountType: null, discountValue: 0 }];
    });
  };
  const upd = (key, patch) => setCart((c) => c.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  const calc = useMemo(
    () =>
      calculateBill({
        items: cart.map((x) => ({ type: 'PRODUCT', name: x.product.name, qty: x.qty, unitPrice: x.unitPrice, discountType: x.discountType, discountValue: x.discountValue, scExempt: x.product.sc_exempt })),
        billDiscount: billDisc,
        tax: settings?.tax,
      }),
    [cart, billDisc, settings],
  );
  useEffect(() => {
    if (!cart.length) return idleDisplay();
    pushDisplay({
      mode: 'CART',
      items: cart.map((x, i) => ({ name: x.product.name, qty: x.qty, unitPrice: x.unitPrice, total: calc.lines[i]?.net })),
      subtotal: calc.grossTotal,
      discount: calc.discountTotal,
      serviceCharge: calc.serviceCharge,
      vat: calc.vat,
      total: calc.grandTotal,
      net: calc.netTotal,
      customer: member?.first_name,
    });
  }, [cart, calc]);

  const checkout = async () => {
    if (!shift) return toast.error('กรุณาเปิดรอบการขายก่อนทำรายการ');
    setBusy(true);
    try {
      const o = await api.post('/orders', {
        items: cart.map((x) => ({ productId: x.product.id, qty: x.qty, options: x.options, note: x.note || null, discountType: x.discountType, discountValue: x.discountValue })),
        memberId: member?.id || null,
        customerName: member ? member.first_name : null,
        phone: member?.phone || null,
        clientOpId: uid(),
      });
      if (billDisc) await api.put(`/orders/${o.id}/discount`, { billDiscountType: billDisc.type, billDiscountValue: Number(billDisc.value), billDiscountReason: billDisc.reason }).catch((e) => toast.warning(e.message));
      setCheckoutId(o.id);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const sendToRoom = async (room) => {
    setBusy(true);
    try {
      for (const x of cart) await api.post(`/orders/${room.session.order_id}/items`, { productId: x.product.id, qty: x.qty, options: x.options, note: x.note || null, discountType: x.discountType, discountValue: x.discountValue, clientOpId: uid() }, { queueable: true, queueLabel: x.product.name });
      toast.success(`${t('เพิ่มสินค้าเข้าห้อง')} ${room.name} ${t('เรียบร้อย')}`);
      setCart([]);
      setModal(null);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const itemDiscount = async (x) => {
    const v = await prompt({ title: `${t('ส่วนลด')}: ${x.product.name}`, message: 'ใส่จำนวนเงิน หรือเปอร์เซ็นต์ เช่น 20 หรือ 10%', required: false, defaultValue: x.discountValue ? `${x.discountValue}${x.discountType === 'PERCENT' ? '%' : ''}` : '' });
    if (v == null) return;
    upd(x.key, { discountType: v.endsWith('%') ? 'PERCENT' : 'AMOUNT', discountValue: Number(v.replace('%', '')) || 0 });
  };

  return (
    <div className="pos">
      <ProductCatalog onAdd={add} />
      <div className="cart">
        <div className="row between" style={{ padding: 12, borderBottom: '1px solid var(--border)' }}>
          <b className="row nowrap"><ShoppingCart size={18} /> {t('ตะกร้า')} ({cart.reduce((s, x) => s + x.qty, 0)})</b>
          <div className="row nowrap">
            <Button size="sm" icon={User} onClick={() => setModal('member')}>{member ? member.first_name : t('สมาชิก')}</Button>
            {cart.length > 0 && <Button size="sm" variant="ghost" icon={Trash2} onClick={() => { setCart([]); setBillDisc(null); setMember(null); }} />}
          </div>
        </div>
        <div className="items">
          {!cart.length && <Empty icon={ShoppingCart} text="เลือกสินค้าเพื่อเริ่มขาย" />}
          {cart.map((x, i) => (
            <div key={x.key} className="cart-item">
              <div>
                <div className="bold">{x.product.name}</div>
                {x.optionNames.length > 0 && <div className="xs muted">{x.optionNames.join(', ')}</div>}
                {x.note && <div className="xs" style={{ color: 'var(--warn)' }}>* {x.note}</div>}
                <div className="small muted">@{money(x.unitPrice)} {calc.lines[i]?.discount > 0 && <span style={{ color: 'var(--ok)' }}>−{money(calc.lines[i].discount)}</span>}</div>
              </div>
              <b className="num right">{money(calc.lines[i]?.net)}</b>
              <div className="row nowrap" style={{ gridColumn: '1/-1', justifyContent: 'space-between' }}>
                <div className="qty">
                  <button onClick={() => (x.qty > 1 ? upd(x.key, { qty: x.qty - 1 }) : setCart(cart.filter((y) => y.key !== x.key)))}><Minus size={14} /></button>
                  <b style={{ minWidth: 24, textAlign: 'center' }}>{x.qty}</b>
                  <button onClick={() => upd(x.key, { qty: x.qty + 1 })}><Plus size={14} /></button>
                </div>
                <div className="row nowrap">
                  <Button size="sm" variant="ghost" icon={StickyNote} onClick={async () => { const n = await prompt({ title: 'หมายเหตุ', required: false, defaultValue: x.note }); if (n != null) upd(x.key, { note: n }); }} />
                  {can('discount.give') && <Button size="sm" variant="ghost" icon={Percent} onClick={() => itemDiscount(x)} />}
                  <Button size="sm" variant="ghost" icon={X} onClick={() => setCart(cart.filter((y) => y.key !== x.key))} />
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="totals">
          <div className="sum-line"><span>{t('รวม')}</span><span className="num">{money(calc.grossTotal)}</span></div>
          {calc.discountTotal > 0 && <div className="sum-line" style={{ color: 'var(--ok)' }}><span>{t('ส่วนลด')}</span><span className="num">−{money(calc.discountTotal)}</span></div>}
          {calc.tax.scEnabled && <div className="sum-line small"><span>Service Charge {calc.tax.scRate}%</span><span>{money(calc.serviceCharge)}</span></div>}
          {calc.tax.vatEnabled && <div className="sum-line small"><span>VAT {calc.tax.vatRate}%{calc.tax.vatInclusive ? ` (${t('รวมใน')})` : ''}</span><span>{money(calc.vat)}</span></div>}
          <div className="row between"><span className="muted">{t('ยอดสุทธิ')}</span><span className="grand">฿{money(calc.netTotal)}</span></div>
          <div className="grid grid-2 mt" style={{ gap: 8 }}>
            {can('discount.give') && <Button icon={Percent} onClick={() => setModal('disc')} disabled={!cart.length}>{t('ส่วนลดทั้งบิล')}</Button>}
            <Button icon={DoorOpen} disabled={!cart.length} onClick={() => setModal('room')}>{t('เพิ่มเข้าห้อง')}</Button>
          </div>
          <Button className="mt" variant="primary" size="xl" block icon={CreditCard} disabled={!cart.length} loading={busy} onClick={checkout}>
            {t('ชำระเงิน')}
          </Button>
        </div>
      </div>
      {checkoutId && (
        <Checkout
          orderId={checkoutId}
          onClose={() => { setCheckoutId(null); }}
          onPaid={() => { setCart([]); setMember(null); setBillDisc(null); }}
        />
      )}
      {modal === 'member' && (
        <Modal title={t('เลือกสมาชิก')} onClose={() => setModal(null)}>
          <MemberPicker onPick={(m) => { setMember(m); setModal(null); }} />
        </Modal>
      )}
      {modal === 'room' && (
        <Modal title={t('เพิ่มสินค้าเข้าห้องที่กำลังใช้งาน')} onClose={() => setModal(null)}>
          {!activeRooms.length && <Empty text="ไม่มีห้องที่กำลังใช้งาน" />}
          <div className="grid grid-3">
            {activeRooms.map((r) => (
              <Button key={r.id} size="lg" loading={busy} onClick={() => sendToRoom(r)}>
                <div><div>{r.name}</div><div className="xs">{r.session.customer_name || '-'}</div></div>
              </Button>
            ))}
          </div>
        </Modal>
      )}
      {modal === 'disc' && <BillDiscount value={billDisc} onClose={() => setModal(null)} onSave={(v) => { setBillDisc(v); setModal(null); }} />}
    </div>
  );
}

function BillDiscount({ value, onSave, onClose }) {
  const { t } = useT();
  const [d, setD] = useState(value || { type: 'PERCENT', value: '', reason: '' });
  return (
    <Modal title={t('ส่วนลดทั้งบิล')} onClose={onClose} footer={<><Button onClick={() => onSave(null)}>{t('ล้างส่วนลด')}</Button><Button variant="primary" onClick={() => onSave({ ...d, value: Number(d.value) || 0 })}>{t('ใช้ส่วนลด')}</Button></>}>
      <Seg value={d.type} onChange={(v) => setD({ ...d, type: v })} options={[{ value: 'PERCENT', label: 'เปอร์เซ็นต์ (%)' }, { value: 'AMOUNT', label: 'จำนวนเงิน (บาท)' }]} />
      <div className="grid grid-2 mt">
        <Field label="มูลค่า"><Input type="number" value={d.value} onChange={(e) => setD({ ...d, value: e.target.value })} /></Field>
        <Field label="เหตุผล"><Input value={d.reason} onChange={(e) => setD({ ...d, reason: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

// Checkout: full bill summary (central Calculation Engine on the server), discounts, multi-tender payment,
// cash quick amounts + change, QR with slip check, idempotent confirm, receipt & Customer Display sync.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Banknote, QrCode, CreditCard, Wallet, ArrowRightLeft, MoreHorizontal, CheckCircle2, Trash2, Percent, Ticket, User, Printer, Gift } from 'lucide-react';
import { Modal, Button, Input, Field, Seg, NumPad, QRCode, Spinner, Badge, money, useToast, useDialog, useApprovalAction, Loading } from './ui.jsx';
import { MemberPicker } from './MemberPicker.jsx';
import { SaleReceipt } from './Receipt.jsx';
import { PrepayReview } from './RoomService.jsx';
import { usePrint } from './PrintPreview.jsx';
import { useT } from '../lib/i18n.jsx';
import { api, uid } from '../lib/api.js';
import { useAuth } from '../lib/store.jsx';
import { pushDisplay, orderToDisplay, idleDisplay } from '../lib/display.js';
import { openDrawer } from '../lib/print.jsx';
import { cashQuickAmounts } from '@beatbox/shared/calc.js';
import { promptPayPayload } from '@beatbox/shared/promptpay.js';
import { round2 } from '@beatbox/shared/money.js';
import { formatMinutesShort } from '@beatbox/shared/roomPricing.js';
import { PAYMENT_METHODS } from '@beatbox/shared/constants.js';

const METHOD_ICON = { CASH: Banknote, QR: QrCode, TRANSFER: ArrowRightLeft, CARD: CreditCard, CREDIT: Wallet, OTHER: MoreHorizontal };

/** QR payment panel with simulated (Demo) / provider / manual slip verification. */
export function QrPayPanel({ amount, orderId, depositRef, onVerified, method = 'QR' }) {
  const { t } = useT();
  const { settings } = useAuth();
  const toast = useToast();
  const [state, setState] = useState('idle'); // idle | checking | ok
  const [file, setFile] = useState(null);
  const p = settings?.payment || {};
  const payload = p.useDynamicPromptPay && p.promptPayId ? promptPayPayload(p.promptPayId, amount) : null;
  const production = settings?.runtime?.paymentMode === 'PRODUCTION';
  const verify = async (manual = false) => {
    setState('checking');
    try {
      const fd = new FormData();
      if (orderId) fd.append('orderId', orderId);
      if (depositRef) fd.append('depositRef', depositRef);
      fd.append('amount', amount);
      fd.append('method', method);
      if (manual) fd.append('manualConfirm', 'true');
      if (file) fd.append('slip', file);
      const r = await api.post('/payments/verify-slip', fd);
      setState('ok');
      onVerified(r);
    } catch (e) {
      setState('idle');
      toast.error(e);
    }
  };
  if (state === 'checking')
    return (
      <div className="center" style={{ padding: 30 }}>
        <Spinner lg />
        <h2 className="mt">{t('กำลังตรวจสอบการชำระเงิน')}</h2>
        <p className="muted">{production ? '' : t('ระบบจำลองการตรวจสอบสลิป (Demo Mode)')}</p>
      </div>
    );
  if (state === 'ok')
    return (
      <div className="center" style={{ padding: 30 }}>
        <CheckCircle2 size={90} color="var(--ok)" />
        <h2>{t('ตรวจสอบเรียบร้อย')}</h2>
        <Badge color="#16a34a">{t('ชำระเงินสำเร็จ')}</Badge>
      </div>
    );
  return (
    <div className="center">
      {method === 'QR' && (payload ? <QRCode value={payload} size={240} /> : p.qrImageUrl ? <img src={p.qrImageUrl} alt="QR" style={{ width: 240, background: '#fff', borderRadius: 8 }} /> : <div className="muted">{t('ยังไม่ได้ตั้งค่า QR Code')}</div>)}
      <div className="mt">
        <div className="bold">{p.accountName}</div>
        <div className="muted">{p.bankName} · {p.accountNumber}</div>
        {p.promptPayId && <div className="muted small">PromptPay: {p.promptPayId}</div>}
      </div>
      <div className="big-money" style={{ color: 'var(--primary)' }}>฿{money(amount)}</div>
      <div className="small muted">{p.instruction}</div>
      {production && (
        <div className="mt">
          <input type="file" accept="image/png,image/jpeg" onChange={(e) => setFile(e.target.files[0])} />
        </div>
      )}
      <div className="row mt" style={{ justifyContent: 'center' }}>
        <Button variant="primary" size="lg" icon={CheckCircle2} onClick={() => verify(false)} disabled={production && !file}>
          {t('ตรวจสอบสลิป')}
        </Button>
        {production && <Button size="lg" onClick={() => verify(true)}>{t('ยืนยันรับเงินด้วยตนเอง')}</Button>}
      </div>
    </div>
  );
}

/** Send the amount to the payment terminal (Beam Bolt / bank EDC) and wait for approval. */
export function TerminalPayPanel({ amount, orderId, method, provider, onVerified }) {
  const { t } = useT();
  const toast = useToast();
  const { prompt } = useDialog();
  const [tp, setTp] = useState(null);
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    try {
      setTp(await api.post('/terminal/payments', { orderId, amount, method }));
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!tp || tp.status !== 'PENDING') return;
    const id = setInterval(async () => {
      try {
        const r = await api.get(`/terminal/payments/${tp.id}`, { passive: true });
        setTp(r);
      } catch {
        /* keep polling */
      }
    }, 2000);
    return () => clearInterval(id);
  }, [tp?.id, tp?.status]);
  useEffect(() => {
    if (tp?.status === 'APPROVED' && tp.verificationToken) onVerified({ verificationToken: tp.verificationToken, reference: tp.approval_code || tp.provider_ref });
  }, [tp?.status]);
  const manual = async () => {
    const code = await prompt({ title: 'ยืนยันการชำระที่เครื่อง EDC', message: 'กรอกรหัสอนุมัติ (Approval Code) จากสลิปเครื่อง EDC' });
    if (!code) return;
    try {
      setTp(await api.post(`/terminal/payments/${tp.id}/confirm`, { approvalCode: code }));
    } catch (e) {
      toast.error(e);
    }
  };
  const cancel = async () => {
    await api.post(`/terminal/payments/${tp.id}/cancel`).catch(() => {});
    setTp(null);
  };
  if (!tp)
    return (
      <div className="center card flat">
        <CreditCard size={48} />
        <div className="big-money">฿{money(amount)}</div>
        <Button variant="primary" size="lg" loading={busy} onClick={start}>{provider === 'beam' ? t('ส่งยอดไปเครื่อง Beam Bolt') : t('ส่งยอดไปเครื่อง EDC')}</Button>
        <div className="xs muted mt">{method === 'QR' ? t('ลูกค้าสแกน QR ที่เครื่องรับชำระเงิน') : t('ลูกค้าแตะ/เสียบบัตรที่เครื่องรับชำระเงิน')}</div>
      </div>
    );
  if (tp.status === 'APPROVED')
    return (
      <div className="center card flat"><CheckCircle2 size={80} color="var(--ok)" /><h2>{t('เครื่องรับชำระเงินอนุมัติแล้ว')}</h2><div className="small muted">{tp.approval_code || tp.provider_ref}</div></div>
    );
  if (tp.status !== 'PENDING')
    return (
      <div className="center card flat" style={{ borderColor: 'var(--danger)' }}>
        <h3 style={{ color: 'var(--danger)' }}>{t({ DECLINED: 'ชำระเงินไม่สำเร็จ', CANCELLED: 'ยกเลิกแล้ว', EXPIRED: 'หมดเวลารอการชำระ', ERROR: 'เกิดข้อผิดพลาด' }[tp.status] || tp.status)}</h3>
        <div className="row" style={{ justifyContent: 'center' }}>
          <Button onClick={() => setTp(null)}>{t('ลองใหม่')}</Button>
          {tp.status === 'EXPIRED' && <Button onClick={manual}>{t('ยืนยันด้วยรหัสอนุมัติ')}</Button>}
        </div>
      </div>
    );
  return (
    <div className="center card flat">
      <Spinner lg />
      <h2 className="mt">{t('รอลูกค้าชำระที่เครื่องรับชำระเงิน')}</h2>
      <div className="big-money">฿{money(tp.amount)}</div>
      {tp.deep_link && <a className="btn primary" href={tp.deep_link}>{t('เปิดหน้าชำระเงินบน Beam Bolt')}</a>}
      <div className="row mt" style={{ justifyContent: 'center' }}>
        <Button onClick={manual}>{t('ยืนยันด้วยรหัสอนุมัติ')}</Button>
        <Button variant="ghost" onClick={cancel}>{t('ยกเลิก')}</Button>
      </div>
    </div>
  );
}

export default function Checkout({ orderId, onClose, onPaid }) {
  const { t, tp } = useT();
  const toast = useToast();
  const { prompt } = useDialog();
  const runApproval = useApprovalAction();
  const { can, settings } = useAuth();
  const { preview, printNow, defaultPrinter } = usePrint();
  const [data, setData] = useState(null);
  const [tenders, setTenders] = useState([]);
  const [method, setMethod] = useState('CASH');
  const [cashInput, setCashInput] = useState('');
  const [amountInput, setAmountInput] = useState('');
  const [ref, setRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [panel, setPanel] = useState(null); // discount | member | promo
  const [disc, setDisc] = useState({ type: 'PERCENT', value: '', reason: '' });
  const [promo, setPromo] = useState('');
  const [codes, setCodes] = useState('');
  const idemKey = useRef(uid());
  const approvalRef = useRef(null);
  const [autoPay, setAutoPay] = useState(false);
  const [terminal, setTerminal] = useState({ provider: 'none', methods: [] });
  useEffect(() => {
    api.get('/terminal/methods', { passive: true }).then(setTerminal).catch(() => {});
  }, []);
  const useTerminal = terminal.methods.includes(method);

  const load = async () => {
    try {
      const d = await api.get(`/orders/${orderId}`);
      setData(d);
      if (d.order.status === 'OPEN') pushDisplay(orderToDisplay(d));
    } catch (e) {
      toast.error(e);
    }
  };
  useEffect(() => {
    load();
  }, [orderId]);

  const calc = data?.calc;
  const net = calc?.netTotal || 0;
  const paidSoFar = round2(tenders.reduce((s, x) => s + x.amount, 0));
  const remaining = round2(Math.max(0, net - paidSoFar));
  const cashReceived = Number(cashInput || 0);
  const change = method === 'CASH' ? round2(Math.max(0, cashReceived - remaining)) : 0;
  const methods = Object.entries(PAYMENT_METHODS).filter(([k]) => settings?.payment?.methods?.[k] !== false);

  // keep the customer display in sync with the payment state
  useEffect(() => {
    if (!data || done) return;
    const base = orderToDisplay(data);
    if (method === 'CASH') pushDisplay({ ...base, mode: 'PAY_CASH', method: 'CASH', received: cashReceived, change, due: remaining });
    else if (terminal.methods.includes(method)) pushDisplay({ ...base, mode: 'PAY_TERMINAL', method, due: remaining });
    else if (method === 'QR') {
      const p = settings?.payment || {};
      pushDisplay({ ...base, mode: 'PAY_QR', method: 'QR', due: remaining, qr: { data: p.useDynamicPromptPay && p.promptPayId ? promptPayPayload(p.promptPayId, remaining) : null, imageUrl: p.qrImageUrl, accountName: p.accountName, accountNumber: p.accountNumber, bankName: p.bankName } });
    } else pushDisplay({ ...base, mode: 'PAY_OTHER', method, due: remaining });
  }, [method, cashInput, remaining, data, terminal]);

  const addTender = (tender) => {
    setTenders((x) => [...x, tender]);
    setCashInput('');
    setAmountInput('');
    setRef('');
  };

  const confirm = async (finalTenders) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await runApproval(
        (tok) => {
          if (tok) approvalRef.current = tok;
          return api.post(`/orders/${orderId}/pay`, { payments: finalTenders, approvalToken: approvalRef.current }, { idempotencyKey: idemKey.current });
        },
        'discount.approve',
        'ส่วนลดเกินวงเงิน',
      );
      const receipt = r.receipt;
      setDone({ receipt, change: r.change, pointsEarned: r.pointsEarned });
      pushDisplay({ mode: 'SUCCESS', total: receipt.snapshot.totals.netTotal, paid: receipt.snapshot.totals.paid, change: r.change, queueNo: receipt.queue_no, points: r.pointsEarned });
      setTimeout(() => idleDisplay(), 12000);
      toast.success(`${t('ชำระเงินเรียบร้อย')} ${receipt.receipt_no}`);
      const printer = defaultPrinter('MAIN');
      const hasCash = finalTenders.some((x) => x.method === 'CASH');
      const el = <SaleReceipt snap={receipt.snapshot} />;
      const markPrinted = () => api.post(`/receipts/${receipt.id}/print`, { printerId: printer?.id || null }).catch(() => {});
      if (printer?.auto_print) {
        const res = await printNow(el, { jobType: 'RECEIPT', reference: receipt.receipt_no, drawer: hasCash && printer.open_drawer });
        if (res.ok) markPrinted();
      } else if (hasCash && printer?.open_drawer) openDrawer(printer);
      onPaid?.(receipt);
    } catch (e) {
      if (!e.cancelled) toast.error(e);
      if (e.code === 'ALREADY_PAID') load();
    } finally {
      setBusy(false);
    }
  };

  // slip verified and the QR/transfer covers the bill → show the check, then record the payment automatically
  useEffect(() => {
    if (!autoPay || remaining > 0 || busy) return;
    const id = setTimeout(() => {
      setAutoPay(false);
      confirm(tenders);
    }, 1200);
    return () => clearTimeout(id);
  }, [autoPay, remaining, tenders]);

  const pay = () => {
    let list = [...tenders];
    if (remaining > 0) {
      if (method === 'CASH') {
        if (cashReceived + 0.001 < remaining) return toast.error(`${t('รับเงินไม่พอ')} (${t('ขาดอีก')} ${money(remaining - cashReceived)})`);
        list.push({ method: 'CASH', amount: remaining, received: cashReceived });
      } else if (method === 'QR' || method === 'TRANSFER' || useTerminal) {
        return toast.warning(useTerminal ? 'กรุณารอเครื่องรับชำระเงินอนุมัติ' : 'กรุณาตรวจสอบสลิปก่อน');
      } else list.push({ method, amount: remaining, reference: ref || null });
    }
    confirm(list);
  };

  const applyDiscount = async (body) => {
    try {
      await runApproval((tok) => api.put(`/orders/${orderId}/discount`, { billDiscountType: data.order.bill_discount_type, billDiscountValue: data.order.bill_discount_value, billDiscountReason: data.order.bill_discount_reason, promoCode: data.order.promo_code, promotionIds: data.order.promotion_ids, ...body, approvalToken: tok }), 'discount.approve', 'ส่วนลดเกินวงเงิน');
      setPanel(null);
      await load();
    } catch (e) {
      if (!e.cancelled) toast.error(e);
    }
  };

  const setLineDiscount = async (line) => {
    const v = await prompt({ title: `${t('ส่วนลด')}: ${line.name}`, message: 'ใส่จำนวนเงิน หรือเปอร์เซ็นต์ เช่น 20 หรือ 10%', defaultValue: line.discountValue ? `${line.discountValue}${line.discountType === 'PERCENT' ? '%' : ''}` : '' });
    if (v == null) return;
    const isPct = v.endsWith('%');
    try {
      await api.patch(`/orders/${orderId}/items/${line.id}`, { discountType: isPct ? 'PERCENT' : 'AMOUNT', discountValue: Number(v.replace('%', '')) || 0 });
      load();
    } catch (e) {
      toast.error(e);
    }
  };

  if (!data) return <Modal title={t('ชำระเงิน')} onClose={onClose}><Loading /></Modal>;

  if (done || data.order.status !== 'OPEN') {
    const rc = done?.receipt || data.receipt;
    return (
      <Modal title={t('ชำระเงินสำเร็จ')} onClose={onClose} size="wide">
        <div className="grid grid-2">
          <div className="center">
            <CheckCircle2 size={110} color="var(--ok)" />
            <h1>{t('ชำระเงินเรียบร้อย')}</h1>
            {rc && <div className="big-money">{rc.queue_no}</div>}
            {done && (
              <>
                <div className="sum-line total"><span>{t('ยอดสุทธิ')}</span><span>฿{money(rc.snapshot.totals.netTotal)}</span></div>
                <div className="sum-line total" style={{ color: 'var(--ok)' }}><span>{t('เงินทอน')}</span><span className="big-money">฿{money(done.change)}</span></div>
                {done.pointsEarned > 0 && <div className="mt"><Badge color="#eab308">+{done.pointsEarned} {t('คะแนน')}</Badge></div>}
              </>
            )}
            <div className="row mt" style={{ justifyContent: 'center' }}>
              {rc && (
                <Button
                  icon={Printer}
                  size="lg"
                  onClick={() =>
                    preview(<SaleReceipt snap={rc.snapshot} isCopy={rc.print_count > 0} />, {
                      reference: rc.receipt_no,
                      onPrinted: () => api.post(`/receipts/${rc.id}/print`, { confirmReprint: true }).catch((e) => toast.error(e)),
                    })
                  }
                >
                  {t('พิมพ์ใบเสร็จ')}
                </Button>
              )}
              <Button size="lg" variant="primary" onClick={onClose}>{t('เสร็จสิ้น')}</Button>
            </div>
          </div>
          <div className="receipt-preview">{rc && <SaleReceipt snap={rc.snapshot} />}</div>
        </div>
      </Modal>
    );
  }

  const s = data.session;
  const roomLines = calc.lines.filter((l) => ['ROOM', 'PACKAGE', 'EXTENSION', 'OVERTIME'].includes(l.type));
  return (
    <Modal title={`${t('ชำระเงิน')} ${s ? `· ${s.room_name}` : ''}`} onClose={onClose} size="xwide" closeOnBack={false}>
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.1fr)' }}>
        {/* ── summary ── */}
        <div className="card flat" style={{ background: 'var(--surface-2)' }}>
          {s && (
            <div className="small muted mb">
              {s.type_name} · {t('ลูกค้า')} {s.guest_count} {t('คน')} · {formatMinutesShort(roomLines.reduce((a, l) => a + Number(l.minutes || 0), 0))}
            </div>
          )}
          <div className="col" style={{ gap: 2 }}>
            {calc.lines.map((l) => (
              <div key={l.id} className="sum-line" style={{ alignItems: 'flex-start' }}>
                <div className="grow">
                  <div>{l.type === 'PRODUCT' ? l.name : tp(l.name)} {l.qty !== 1 && <span className="muted">× {l.qty}</span>}</div>
                  {l.detail && <div className="xs muted">{tp(l.detail)}</div>}
                  {l.discount > 0 && <div className="xs" style={{ color: 'var(--ok)' }}>{t('ส่วนลด')} -{money(l.discount)}</div>}
                </div>
                <div className="num right">
                  {money(l.gross)}
                  {can('discount.give') && !l.isSystem && <div><button className="btn ghost sm" onClick={() => setLineDiscount(l)}><Percent size={12} /></button></div>}
                </div>
              </div>
            ))}
          </div>
          <div className="divider" />
          <div className="sum-line"><span>{t('รวม')}</span><span className="num">{money(calc.grossTotal)}</span></div>
          {calc.lineDiscountTotal > 0 && <div className="sum-line"><span>{t('ส่วนลดรายการ')}</span><span className="num">-{money(calc.lineDiscountTotal)}</span></div>}
          {calc.discounts.map((d, i) => <div key={i} className="sum-line" style={{ color: 'var(--ok)' }}><span>{tp(d.name)}</span><span className="num">-{money(d.amount)}</span></div>)}
          {calc.tax.scEnabled && <div className="sum-line"><span>Service Charge {calc.tax.scRate}%</span><span className="num">{money(calc.serviceCharge)}</span></div>}
          {calc.tax.vatEnabled && <div className="sum-line"><span>VAT {calc.tax.vatRate}% {calc.tax.vatInclusive ? `(${t('รวมในราคา')})` : ''}</span><span className="num">{money(calc.vat)}</span></div>}
          {calc.rounding !== 0 && <div className="sum-line"><span>{t('ปัดเศษ')}</span><span className="num">{money(calc.rounding)}</span></div>}
          <div className="sum-line total"><span>{t('ยอดรวม')}</span><span className="num">{money(calc.grandTotal)}</span></div>
          {calc.depositApplied > 0 && <div className="sum-line"><span>{t('เงินมัดจำ')}</span><span className="num">-{money(calc.depositApplied)}</span></div>}
          {calc.pointsUsed > 0 && <div className="sum-line"><span>{t('คะแนนที่ใช้')}</span><span className="num">{calc.pointsUsed}</span></div>}
          <div className="sum-line total" style={{ fontSize: '1.6rem' }}><span>{t('ยอดสุทธิ')}</span><span className="num">฿{money(net)}</span></div>
          <div className="sum-line"><span>{t('ยอดที่ชำระแล้ว')}</span><span className="num">{money(paidSoFar)}</span></div>
          <div className="sum-line bold"><span>{t('ยอดคงเหลือ')}</span><span className="num">{money(remaining)}</span></div>
          {calc.depositRefundable > 0 && <div className="small" style={{ color: 'var(--warn)' }}>{t('มัดจำเกินยอดบิล ต้องคืนลูกค้า')} {money(calc.depositRefundable)}</div>}
          <details className="mt small muted"><summary>{t('รายละเอียดการคำนวณ')}</summary>{calc.steps.map((x, i) => <div key={i}>{tp(x)}</div>)}</details>
          <div className="row mt">
            {can('discount.give') && <Button size="sm" icon={Percent} onClick={() => { setDisc({ type: data.order.bill_discount_type || 'PERCENT', value: data.order.bill_discount_value || '', reason: data.order.bill_discount_reason || '' }); setPanel('discount'); }}>{t('ส่วนลดท้ายบิล')}</Button>}
            <Button size="sm" icon={Ticket} onClick={() => { setPromo(data.order.promo_code || ''); setPanel('promo'); }}>{t('โปรโมชั่น / Code')}</Button>
            <Button size="sm" icon={User} onClick={() => setPanel('member')}>{data.member ? `${data.member.first_name} (${Number(data.member.points_balance)} ${t('คะแนน')})` : t('สมาชิก')}</Button>
            <Button size="sm" icon={Gift} onClick={() => setPanel('reward')}>{t('ใช้คะแนน/รางวัล')}</Button>
          </div>
          {calc.pointsPreview > 0 && <div className="small mt">{t('คะแนนที่จะได้รับ')}: <b>+{calc.pointsPreview}</b></div>}
        </div>

        {/* ── payment ── */}
        <div className="col">
          <div className="row" style={{ gap: 6 }}>
            {methods.map(([k, label]) => {
              const I = METHOD_ICON[k];
              return (
                <Button key={k} size="lg" variant={method === k ? 'primary' : ''} icon={I} onClick={() => setMethod(k)} style={{ flex: '1 1 30%' }}>
                  {t(label)}
                </Button>
              );
            })}
          </div>
          {tenders.length > 0 && (
            <div className="card flat">
              <div className="small muted">{t('หลายช่องทางในบิลเดียว')}</div>
              {tenders.map((x, i) => (
                <div key={i} className="sum-line">
                  <span>{t(PAYMENT_METHODS[x.method])} {x.reference && <span className="xs muted">{x.reference}</span>}</span>
                  <span className="row nowrap">{money(x.amount)} <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setTenders(tenders.filter((_, j) => j !== i))} /></span>
                </div>
              ))}
            </div>
          )}
          {remaining <= 0 ? (
            <div className="center card flat">
              <CheckCircle2 size={autoPay ? 90 : 48} color="var(--ok)" />
              {autoPay ? <><h2>{t('ตรวจสอบเรียบร้อย')}</h2><div className="badge" style={{ background: '#16a34a26', color: '#16a34a' }}>{t('ชำระเงินสำเร็จ')}</div><div className="small muted mt">{t('กำลังบันทึกการชำระเงิน')}...</div></> : <div>{t('ชำระครบแล้ว')}</div>}
            </div>
          ) : method === 'CASH' ? (
            <div className="grid grid-2">
              <div className="col">
                <div className="card flat center"><div className="muted">{t('ยอดที่ต้องชำระ')}</div><div className="big-money">฿{money(remaining)}</div></div>
                <div className="card flat center"><div className="muted">{t('รับเงินมา')}</div><div className="big-money">{money(cashReceived)}</div></div>
                <div className="card flat center" style={{ borderColor: 'var(--ok)' }}><div className="muted">{t('เงินทอน')}</div><div className="big-money" style={{ color: 'var(--ok)' }}>{money(change)}</div></div>
              </div>
              <div className="col">
                <div className="grid grid-3" style={{ gap: 6 }}>
                  <Button onClick={() => setCashInput(String(remaining))}>{t('จ่ายพอดี')}</Button>
                  {[100, 500, 1000, 2000, ...cashQuickAmounts(remaining).filter((v) => ![100, 500, 1000, 2000].includes(v) && v !== Math.ceil(remaining))].slice(0, 5).map((v) => (
                    <Button key={v} onClick={() => setCashInput(String(v))}>{money(v, 0)}</Button>
                  ))}
                </div>
                <NumPad value={cashInput} onChange={setCashInput} />
                {cashReceived > 0 && cashReceived < remaining && <Button onClick={() => addTender({ method: 'CASH', amount: cashReceived, received: cashReceived })}>{t('รับเงินสดบางส่วน แล้วชำระช่องทางอื่น')}</Button>}
              </div>
            </div>
          ) : useTerminal ? (
            <div className="col">
              <Field label="จำนวนเงิน (กรณีชำระบางส่วน)"><Input type="number" value={amountInput} placeholder={String(remaining)} onChange={(e) => setAmountInput(e.target.value)} /></Field>
              <TerminalPayPanel key={`${method}-${remaining}-${amountInput}`} method={method} provider={terminal.provider} amount={Number(amountInput) || remaining} orderId={orderId} onVerified={(r) => { const amt = Number(amountInput) || remaining; addTender({ method, amount: amt, verificationToken: r.verificationToken, reference: r.reference }); if (amt >= remaining) setAutoPay(true); }} />
            </div>
          ) : method === 'QR' || method === 'TRANSFER' ? (
            <div className="col">
              <Field label="จำนวนเงิน (กรณีชำระบางส่วน)"><Input type="number" value={amountInput} placeholder={String(remaining)} onChange={(e) => setAmountInput(e.target.value)} /></Field>
              <QrPayPanel key={`${method}-${remaining}-${amountInput}`} method={method} amount={Number(amountInput) || remaining} orderId={orderId} onVerified={(r) => { const amt = Number(amountInput) || remaining; addTender({ method, amount: amt, verificationToken: r.verificationToken, reference: r.reference }); if (amt >= remaining) setAutoPay(true); }} />
            </div>
          ) : (
            <div className="col">
              <div className="card flat center"><div className="muted">{t('ยอดที่ต้องชำระ')}</div><div className="big-money">฿{money(remaining)}</div></div>
              <Field label="จำนวนเงิน"><Input type="number" value={amountInput} placeholder={String(remaining)} onChange={(e) => setAmountInput(e.target.value)} /></Field>
              <Field label="เลขอ้างอิง / หมายเหตุ"><Input value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
              {Number(amountInput) > 0 && Number(amountInput) < remaining && <Button onClick={() => addTender({ method, amount: Number(amountInput), reference: ref })}>{t('เพิ่มช่องทางนี้ แล้วชำระส่วนที่เหลือ')}</Button>}
            </div>
          )}
          {data.pendingPrepayments?.length > 0 && (
            <div className="col">
              <div className="card flat" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}>{t('มีการชำระเงินล่วงหน้าจากในห้องที่ยังไม่ได้ตรวจสลิป กรุณาตรวจสอบก่อนชำระเงิน')}</div>
              {data.pendingPrepayments.map((p) => <PrepayReview key={p.id} p={{ ...p, room_name: s?.room_name }} onDone={load} />)}
            </div>
          )}
          <Button variant="success" size="xl" block loading={busy} disabled={busy || data.pendingPrepayments?.length > 0 || (remaining > 0 && (['QR', 'TRANSFER'].includes(method) || useTerminal))} onClick={pay} icon={CheckCircle2}>
            {t('ยืนยันชำระเงิน')} ฿{money(net)}
          </Button>
        </div>
      </div>

      {panel === 'discount' && (
        <Modal title={t('ส่วนลดท้ายบิล')} onClose={() => setPanel(null)} footer={<><Button onClick={() => applyDiscount({ billDiscountType: null, billDiscountValue: 0, billDiscountReason: null })}>{t('ล้างส่วนลด')}</Button><Button variant="primary" onClick={() => applyDiscount({ billDiscountType: disc.type, billDiscountValue: Number(disc.value) || 0, billDiscountReason: disc.reason })}>{t('ใช้ส่วนลด')}</Button></>}>
          <Seg value={disc.type} onChange={(v) => setDisc({ ...disc, type: v })} options={[{ value: 'PERCENT', label: 'เปอร์เซ็นต์ (%)' }, { value: 'AMOUNT', label: 'จำนวนเงิน (บาท)' }]} />
          <div className="grid grid-2 mt">
            <Field label="มูลค่า"><Input type="number" value={disc.value} onChange={(e) => setDisc({ ...disc, value: e.target.value })} /></Field>
            <Field label="เหตุผล"><Input value={disc.reason} onChange={(e) => setDisc({ ...disc, reason: e.target.value })} /></Field>
          </div>
          <div className="small muted mt">{t('ส่วนลดเกินวงเงินที่กำหนดต้องให้ผู้จัดการกรอกรหัสอนุมัติ')}</div>
        </Modal>
      )}
      {panel === 'promo' && (
        <Modal title={t('โปรโมชั่น / Promo Code')} onClose={() => setPanel(null)} footer={<Button variant="primary" onClick={() => applyDiscount({ promoCode: promo || null })}>{t('ใช้โค้ด')}</Button>}>
          <Field label="Promo Code / คูปอง"><Input value={promo} onChange={(e) => setPromo(e.target.value.toUpperCase())} /></Field>
          <PromoList orderId={orderId} selected={data.order.promotion_ids || []} results={data.promotions} onChange={(ids) => applyDiscount({ promotionIds: ids })} />
        </Modal>
      )}
      {panel === 'member' && (
        <Modal title={t('เลือกสมาชิก')} onClose={() => setPanel(null)}>
          <MemberPicker initialPhone={data.order.phone || ''} onPick={async (m) => { await api.put(`/orders/${orderId}/customer`, { memberId: m.id, customerName: `${m.first_name} ${m.last_name || ''}`.trim(), phone: m.phone }); setPanel(null); load(); }} />
          {data.member && <Button className="mt" variant="ghost" onClick={async () => { await api.put(`/orders/${orderId}/customer`, { memberId: null, customerName: data.order.customer_name, phone: data.order.phone }); setPanel(null); load(); }}>{t('นำสมาชิกออกจากบิล')}</Button>}
        </Modal>
      )}
      {panel === 'reward' && (
        <Modal title={t('ใช้รหัสแลกรางวัล')} onClose={() => setPanel(null)} footer={<Button variant="primary" onClick={async () => { try { await api.put(`/orders/${orderId}/redemptions`, { codes: codes.split(/[\s,]+/).filter(Boolean) }); setPanel(null); load(); } catch (e) { toast.error(e); } }}>{t('ใช้รหัส')}</Button>}>
          <Field label="รหัส Redemption (สแกนหรือพิมพ์ คั่นด้วย ,)"><Input value={codes} onChange={(e) => setCodes(e.target.value.toUpperCase())} /></Field>
          {data.member && <RewardRedeemInline member={data.member} onRedeemed={(code) => setCodes((c) => (c ? `${c},${code}` : code))} />}
        </Modal>
      )}
    </Modal>
  );
}

function PromoList({ selected, onChange }) {
  const { t } = useT();
  const [promos, setPromos] = useState([]);
  useEffect(() => {
    api.get('/promotions').then((l) => setPromos(l.filter((p) => p.is_active && !p.code)));
  }, []);
  return (
    <div className="col mt">
      <div className="small muted">{t('โปรโมชั่นที่ใช้ได้')}</div>
      {promos.map((p) => (
        <label key={p.id} className="check card flat" style={{ padding: 10 }}>
          <input type="checkbox" checked={selected.includes(p.id)} onChange={(e) => onChange(e.target.checked ? [...selected, p.id] : selected.filter((x) => x !== p.id))} />
          <div><b>{p.name}</b><div className="xs muted">{p.description}</div></div>
        </label>
      ))}
    </div>
  );
}

function RewardRedeemInline({ member, onRedeemed }) {
  const { t } = useT();
  const toast = useToast();
  const { confirm } = useDialog();
  const [rewards, setRewards] = useState([]);
  useEffect(() => {
    api.get('/rewards').then((l) => setRewards(l.filter((r) => r.is_active)));
  }, []);
  const redeem = async (r) => {
    if (!(await confirm({ message: `${t('แลก')} ${r.name} ${t('ใช้')} ${r.points_cost} ${t('คะแนน')}?` }))) return;
    try {
      const rd = await api.post(`/members/${member.id}/redeem`, { rewardId: r.id }, { idempotencyKey: uid() });
      toast.success(`${t('แลกสำเร็จ')} ${rd.code}`);
      onRedeemed(rd.code);
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <div className="col mt">
      <div className="small muted">{t('คะแนนคงเหลือ')} {Number(member.points_balance)}</div>
      {rewards.map((r) => (
        <div key={r.id} className="row between card flat" style={{ padding: 10 }}>
          <span>{r.name} <span className="muted small">({r.points_cost} {t('คะแนน')})</span></span>
          <Button size="sm" disabled={Number(member.points_balance) < r.points_cost} onClick={() => redeem(r)}>{t('แลก')}</Button>
        </div>
      ))}
    </div>
  );
}

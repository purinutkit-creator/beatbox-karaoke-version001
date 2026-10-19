// Document designer: every printed document, every element — font, size, bold, alignment, spacing, show / hide, order.
// Saved per store per document type; the preview uses the real paper width of the chosen printer.
import { useEffect, useMemo, useState } from 'react';
import { FileText, ArrowUp, ArrowDown, Eye, EyeOff, RotateCcw, Save, Printer } from 'lucide-react';
import { PageHead, Button, Field, Input, Select, Switch, Seg, Textarea, Loading, useToast } from '../../components/ui.jsx';
import { DocsPreview, usePrint } from '../../components/PrintPreview.jsx';
import { DEFAULT_LOGO_MM } from '../../components/DocView.jsx';
import { useT } from '../../lib/i18n.jsx';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/store.jsx';
import { PRESET_FONTS, loadFont } from '../../lib/fonts.js';
import { DOC_TYPES, DOC_ELEMENTS, resolveLayout, SIZE_LIMITS, QR_SIZE_LIMITS } from '@beatbox/shared/documents.js';
import { DRIVER_FALLBACK } from '../../lib/print.jsx';
import { zonedNow } from '@beatbox/shared/time.js';

const now = Date.now();
const H = 3600000;

/** Sample data so every document can be previewed without real transactions. */
export function sampleData(docType, store) {
  const tz = store?.timezone || 'Asia/Bangkok';
  const ticket = {
    store, timezone: tz, sessionId: 1, sessionNo: 'S2610-0042', refNo: 'OR261012-0042', status: 'ACTIVE', paymentMode: 'PREPAY', prepaidAmount: 600,
    room: 'VIP 1', roomNumber: '101', type: 'VIP', customer: 'คุณสมชาย', guests: 6, capacity: 6, extraMics: 1, packageName: null,
    // 23:00 → 01:00 store time: shows how a session across midnight prints the date on both sides
    startAt: new Date(`${zonedNow(Date.now(), tz).date}T23:00:00+07:00`).toISOString(), endAt: new Date(new Date(`${zonedNow(Date.now(), tz).date}T23:00:00+07:00`).getTime() + 2 * H).toISOString(), minutes: 120,
    employee: 'นภา (แคชเชียร์)', orderToken: 'sample-token', roomServiceEnabled: true, ticket: { customerNote: 'สแกน QR เพื่อสั่งอาหาร/เครื่องดื่ม ดูเวลาคงเหลือ และเรียกพนักงาน' },
  };
  switch (docType) {
    case 'ROOM_TICKET_CUSTOMER':
    case 'ROOM_TICKET_STAFF':
      return ticket;
    case 'TIME_ADJUST':
      return { ...ticket, minutes: 150, endAt: new Date(new Date(ticket.endAt).getTime() + 0.5 * H).toISOString(), adjust: { type: 'EXTEND', minutes: 30, before: { scheduled_end_at: ticket.endAt }, after: { scheduled_end_at: new Date(new Date(ticket.endAt).getTime() + 0.5 * H).toISOString() }, reason: 'ลูกค้าขอเพิ่มเวลา', employee: 'นภา (แคชเชียร์)', at: new Date().toISOString() } };
    case 'RECEIPT':
      return {
        version: 2, timezone: tz, receiptNo: 'RC20261013-0042', orderNo: 'OR261012-0042', queueNo: 'BEATBOX07', issuedAt: new Date(now).toISOString(), store, employee: 'นภา (แคชเชียร์)',
        slogan: 'ร้องให้สุด หยุดที่ BEATBOX', thankYou: 'ขอบคุณที่ใช้บริการ แล้วพบกันใหม่', footerNote: '', showLogo: true, showQr: true,
        customer: { name: 'คุณสมชาย', phone: '0812345678' },
        room: { name: 'VIP 1', number: '101', type: 'VIP', guests: 6, startedAt: ticket.startAt, endedAt: new Date(new Date(ticket.endAt).getTime() + 0.5 * H).toISOString(), billedMinutes: 150, openedBy: 'นภา (แคชเชียร์)' },
        lines: [
          { type: 'ROOM', name: 'ค่าห้อง 2 ชม.', qty: 1, unitPrice: 600, gross: 600 },
          { type: 'EXTENSION', name: 'เพิ่มเวลา 30 นาที', qty: 1, unitPrice: 150, gross: 150 },
          { type: 'PRODUCT', name: 'เบียร์สิงห์ (ขวดใหญ่)', qty: 3, unitPrice: 120, gross: 360 },
          { type: 'PRODUCT', name: 'เฟรนช์ฟรายส์', qty: 1, unitPrice: 89, gross: 89 },
        ],
        discounts: [],
        totals: { grossTotal: 1199, lineDiscountTotal: 0, serviceCharge: 0, vat: 78.44, rounding: 0, grandTotal: 1199, depositApplied: 600, netTotal: 599, change: 1, excessDeposit: 0 },
        tax: { vatEnabled: true, vatRate: 7, vatMode: 'INCLUSIVE', scEnabled: false },
        payments: [{ method: 'CASH', amount: 599, received: 600, change: 1 }],
        prepayments: [{ method: 'QR', amount: 600, reference: 'TXN2610123456' }],
        settlement: { prepaid: 600, deposits: 0, paidAtClose: 599, cashReceived: 600, change: 1, outstanding: 0, fullyPaid: true },
        member: null,
        memberSignup: { path: `/book/signup?store=${store?.slug || 'beatbox'}`, note: 'สำหรับการสมัครสมาชิกครั้งแรก รหัสผ่านเริ่มต้นคือเลข 4 ตัวท้ายของเบอร์โทรศัพท์ และสามารถเปลี่ยนรหัสผ่านได้หลังเข้าสู่ระบบ' },
      };
    case 'ORDER_LIST':
      return { store, timezone: tz, room: 'VIP 1', type: 'VIP', roomNumber: '101', orderNo: 'OR261012-0042', time: new Date().toISOString(), lines: [{ name: 'เบียร์สิงห์ (ขวดใหญ่)', qty: 3, unitPrice: 120, gross: 360 }, { name: 'เฟรนช์ฟรายส์', qty: 1, unitPrice: 89, gross: 89, note: 'ไม่ใส่เกลือ' }] };
    case 'PAY_QR':
      return { store, timezone: tz, amount: 1199, payload: '00020101021229370016A000000677010111011300668123456785303764540411995802TH6304ABCD', accountName: 'บจก. บีทบ็อกซ์ คาราโอเกะ', bankName: 'กสิกรไทย', accountNumber: '123-4-56789-0', promptPayId: '0812345678', room: 'VIP 1', reference: 'OR261012-0042', employee: 'นภา (แคชเชียร์)', time: new Date().toISOString() };
    case 'KITCHEN':
      return { timezone: tz, station: 'KITCHEN', queueNo: 'BEATBOX07', room: 'VIP 1', orderNo: 'OR261012-0042', time: new Date().toISOString(), employee: 'นภา', items: [{ name: 'เฟรนช์ฟรายส์', qty: 1, note: 'ไม่ใส่เกลือ' }, { name: 'ปีกไก่ทอด', qty: 2 }] };
    case 'MEMBER_SIGNUP':
      return { store, path: `/book/signup?store=${store?.slug || 'beatbox'}`, note: 'สำหรับการสมัครสมาชิกครั้งแรก รหัสผ่านเริ่มต้นคือเลข 4 ตัวท้ายของเบอร์โทรศัพท์ และสามารถเปลี่ยนรหัสผ่านได้หลังเข้าสู่ระบบ' };
    case 'DEPOSIT':
      return { store, timezone: tz, deposit: { deposit_no: 'DP261012-0005', booking_no: 'BK2610-0099', received_at: new Date().toISOString(), customer_name: 'คุณสมชาย', phone: '0812345678', room_name: 'VIP 1', start_at: ticket.startAt, amount: 300, method: 'QR', received_by_name: 'นภา' } };
    case 'VOID':
      return { store, timezone: tz, receipt: { receipt_no: 'RC20261013-0041', grand_total: 450 }, reason: 'คีย์รายการผิด', employee: 'ผู้จัดการ' };
    case 'SHIFT_REPORT':
      return { store, timezone: tz, shift: { shift_no: 'SH261012-01', opened_at: new Date(now - 8 * H).toISOString(), closed_at: new Date().toISOString(), employee_name: 'นภา', closed_by_name: 'นภา' }, summary: { openingCash: 1000, cashSales: 5230, qrSales: 4100, transferSales: 0, cardSales: 1200, otherSales: 0, prepaidReceived: 3600, depositsReceived: 600, depositsRefunded: 0, refundsTotal: 0, discountTotal: 120, serviceCharge: 0, vat: 685, expectedCash: 7830, receipts: 18, itemsSold: 64, roomsSold: 9, hoursSold: 21.5, newMembers: 3, voids: [], refunds: [] } };
    case 'REPORT':
      return { store, report: { title: 'ยอดขายตามวัน', from: '01/10/2026', to: '12/10/2026', columns: [{ key: 'day', label: 'วันที่' }, { key: 'sales', label: 'ยอดขาย', type: 'money' }, { key: 'bills', label: 'บิล' }], rows: [{ day: '11/10/2026', sales: 15420, bills: 22 }, { day: '12/10/2026', sales: 18990, bills: 27 }], totals: { sales: 34410, bills: 49 } } };
    case 'TEST':
      return { store, timezone: tz, printer: { name: 'ตัวอย่าง', connection: 'BROWSER', paper_width: 80 } };
    default:
      return {};
  }
}

export default function Documents() {
  const { t } = useT();
  const toast = useToast();
  const { settings, loadSettings } = useAuth();
  const { printers, preview } = usePrint();
  const [doc, setDoc] = useState('RECEIPT');
  const [layouts, setLayouts] = useState(null);
  const [printerId, setPrinterId] = useState('');
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sampleMember, setSampleMember] = useState(false);
  useEffect(() => {
    if (settings && !layouts) setLayouts(structuredClone(settings.documents?.layouts || {}));
  }, [settings]);
  const fonts = useMemo(() => [...PRESET_FONTS.map((f) => f.family), ...(settings?.appearance?.customFonts || []).map((f) => f.family)], [settings]);
  if (!layouts || !settings) return <Loading />;
  const elements = resolveLayout(doc, layouts[doc]);
  const printer = printers.find((p) => p.id === Number(printerId)) || printers.find((p) => p.is_default) || printers[0] || DRIVER_FALLBACK;
  const update = (key, patch) => {
    if (patch.font) loadFont(patch.font, settings.appearance?.customFonts || []);
    setLayouts((l) => {
      const cur = l[doc] || {};
      return { ...l, [doc]: { order: cur.order || elements.map((e) => e.key), elements: { ...(cur.elements || {}), [key]: { ...(cur.elements?.[key] || {}), ...patch } } } };
    });
  };
  const move = (key, dir) => {
    const order = elements.map((e) => e.key);
    const i = order.indexOf(key);
    const j = i + dir;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    setLayouts((l) => ({ ...l, [doc]: { ...(l[doc] || {}), order } }));
  };
  const reset = () => setLayouts((l) => ({ ...l, [doc]: { order: [], elements: {} } }));
  const save = async () => {
    setBusy(true);
    try {
      await api.put('/documents/settings', { layouts });
      await loadSettings();
      toast.success('บันทึกรูปแบบเอกสารแล้ว');
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  let data = sampleData(doc, settings.store);
  if (doc === 'RECEIPT' && sampleMember) data = { ...data, member: { code: 'M000123', name: 'คุณสมชาย ใจดี', tier: 'Gold' }, memberSignup: null, points: { earned: 47, balance: 1250, used: 0 } };
  const docs = [{ docType: doc, data }];
  return (
    <div>
      <PageHead icon={FileText} title="ออกแบบเอกสารและใบเสร็จ">
        <Button icon={RotateCcw} onClick={reset}>{t('ค่าเริ่มต้นของเอกสารนี้')}</Button>
        <Button icon={Printer} onClick={() => preview(docs, { title: 'ทดสอบพิมพ์รูปแบบเอกสาร', clientJobId: `design-${doc}-${Date.now()}` })}>{t('ทดสอบพิมพ์')}</Button>
        <Button variant="primary" icon={Save} loading={busy} onClick={save}>{t('บันทึก')}</Button>
      </PageHead>
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', alignItems: 'start' }}>
        <div className="col">
          <Field label="เอกสาร">
            <Select value={doc} onChange={(e) => { setDoc(e.target.value); setOpen(null); }} options={DOC_TYPES.map((d) => ({ value: d.key, label: d.label }))} />
          </Field>
          <div className="xs muted">{t('ฟอนต์หลักของเอกสาร = ฟอนต์ใบเสร็จในหน้าตั้งค่าร้าน (ค่าเริ่มต้น Kanit) · เลือกฟอนต์ของแต่ละส่วนได้ด้านล่าง · ขนาดเป็นพอยต์ (pt) เท่ากับขนาดจริงบนกระดาษ')}</div>
          {elements.map((el, i) => {
            const meta = DOC_ELEMENTS[el.key] || { label: el.key };
            const isOpen = open === el.key;
            return (
              <div key={el.key} className="card flat" style={{ padding: 10, opacity: el.show === false ? 0.55 : 1 }}>
                <div className="row nowrap">
                  <Button size="sm" variant="ghost icon" icon={el.show === false ? EyeOff : Eye} title={t(el.show === false ? 'ซ่อนอยู่' : 'แสดง')} onClick={() => update(el.key, { show: el.show === false })} />
                  <b className="grow" style={{ cursor: 'pointer' }} onClick={() => setOpen(isOpen ? null : el.key)}>{i + 1}. {t(meta.label)}</b>
                  <span className="xs muted">{el.size ? `${el.size}pt` : ''} {el.bold ? 'B' : ''} {el.align}</span>
                  <Button size="sm" variant="ghost icon" icon={ArrowUp} disabled={i === 0} onClick={() => move(el.key, -1)} />
                  <Button size="sm" variant="ghost icon" icon={ArrowDown} disabled={i === elements.length - 1} onClick={() => move(el.key, 1)} />
                </div>
                {isOpen && (
                  <div className="grid grid-2 mt">
                    <Field label="ฟอนต์">
                      <Select value={el.font || ''} onChange={(e) => update(el.key, { font: e.target.value })} options={[{ value: '', label: t('ฟอนต์ใบเสร็จของร้าน') }, ...fonts.map((f) => ({ value: f, label: f }))]} />
                    </Field>
                    {el.key !== 'logo' && (
                      <Field label="ขนาดตัวอักษร (pt)">
                        <Input type="number" step="0.5" min={SIZE_LIMITS.min} max={SIZE_LIMITS.max} value={el.size} onChange={(e) => update(el.key, { size: Number(e.target.value) })} />
                      </Field>
                    )}
                    <Field label="การจัดวาง">
                      <Seg value={el.align || 'left'} onChange={(v) => update(el.key, { align: v })} options={[{ value: 'left', label: 'ซ้าย' }, { value: 'center', label: 'กลาง' }, { value: 'right', label: 'ขวา' }]} />
                    </Field>
                    <Field label="ตัวหนา"><Switch checked={!!el.bold} onChange={(v) => update(el.key, { bold: v })} label="ตัวหนาทั้งส่วน" /></Field>
                    <Field label="ระยะห่างด้านบน (mm)"><Input type="number" step="0.5" min={0} max={20} value={el.spaceBefore || 0} onChange={(e) => update(el.key, { spaceBefore: Number(e.target.value) })} /></Field>
                    <Field label="ระยะห่างด้านล่าง (mm)"><Input type="number" step="0.5" min={0} max={20} value={el.spaceAfter || 0} onChange={(e) => update(el.key, { spaceAfter: Number(e.target.value) })} /></Field>
                    {el.key === 'logo' && (
                      <Field label="ขนาดโลโก้ — ความกว้าง (mm)" hint={t('กระดาษ 80 มม. พิมพ์ได้กว้างสุดประมาณ 72 มม. · 58 มม. ประมาณ 48 มม.')}>
                        <Input type="number" min={10} max={80} step="1" value={el.logoWidth || DEFAULT_LOGO_MM} onChange={(e) => update(el.key, { logoWidth: Number(e.target.value) })} />
                      </Field>
                    )}
                    {['qr', 'memberSignup'].includes(el.key) && (
                      <Field label="ขนาด QR (mm)"><Input type="number" min={QR_SIZE_LIMITS.min} max={QR_SIZE_LIMITS.max} value={el.qrSize || 30} onChange={(e) => update(el.key, { qrSize: Number(e.target.value) })} /></Field>
                    )}
                    {meta.text && (
                      <Field label={el.key === 'title' ? 'ข้อความหัวเอกสาร (ว่าง = ค่าเริ่มต้น)' : el.key === 'memberSignup' ? 'ข้อความเชิญชวนสมัครสมาชิก' : 'ข้อความ'} style={{ gridColumn: '1 / -1' }}>
                        <Textarea rows={2} value={el.text || ''} onChange={(e) => update(el.key, { text: e.target.value })} />
                      </Field>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="col" style={{ position: 'sticky', top: 70 }}>
          <div className="row">
            <Field label="ดูตัวอย่างบนเครื่องพิมพ์" style={{ flex: 1 }}>
              <Select value={printerId} onChange={(e) => setPrinterId(e.target.value)} options={[{ value: '', label: printer.name }, ...printers.map((p) => ({ value: p.id, label: `${p.name} · ${p.paper_width}mm` }))]} />
            </Field>
            {doc === 'RECEIPT' && <Switch checked={sampleMember} onChange={setSampleMember} label="บิลมีสมาชิก" />}
          </div>
          <DocsPreview docs={docs} printer={printer} layouts={layouts} />
          {doc === 'RECEIPT' && <div className="xs muted">{t('QR สมัครสมาชิกพิมพ์เฉพาะบิลที่ไม่มีสมาชิก · ลิงก์มีเพียงรหัสร้าน ไม่มีรหัสผ่านหรือข้อมูลส่วนตัว')}</div>}
        </div>
      </div>
    </div>
  );
}


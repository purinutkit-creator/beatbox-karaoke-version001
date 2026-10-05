// 80mm thermal receipt templates (font = receipt font chosen in Admin, default Kanit).
import { QRCode, Barcode, money } from './ui.jsx';
import { useT } from '../lib/i18n.jsx';
import { fmtDate, fmtTime, fmtDateTime } from '@beatbox/shared/format.js';
import { formatMinutesShort } from '@beatbox/shared/roomPricing.js';
import { PAYMENT_METHODS } from '@beatbox/shared/constants.js';

function Head({ store, queueNo, isCopy, title }) {
  const { t } = useT();
  return (
    <>
      {queueNo && <div className="queue">{queueNo}</div>}
      {isCopy && <div className="copy">{t('สำเนา')} / COPY</div>}
      {store?.logoUrl && <img className="logo" src={store.logoUrl} alt="" crossOrigin="anonymous" />}
      <div className="store">{store?.name}</div>
      {store?.branchName && <div className="c">{store.branchName}</div>}
      {store?.address && <div className="c">{store.address}</div>}
      {store?.phone && <div className="c">{t('โทร')} {store.phone}</div>}
      {store?.taxId && <div className="c">{t('เลขประจำตัวผู้เสียภาษี')} {store.taxId}</div>}
      {title && (
        <>
          <div className="hr2" />
          <div className="c big">{t(title)}</div>
        </>
      )}
      <div className="hr" />
    </>
  );
}

const KV = ({ k, v, bold }) => (
  <div className={`kv ${bold ? 'big' : ''}`}>
    <span>{k}</span>
    <span>{v}</span>
  </div>
);

/** Sale receipt (FULL or SHORT) from the immutable snapshot stored at payment time. */
export function SaleReceipt({ snap, isCopy, short }) {
  const { t, tp } = useT();
  if (!snap) return null;
  const tot = snap.totals || {};
  const tax = snap.tax || {};
  return (
    <div className="receipt">
      <Head store={snap.store} queueNo={snap.queueNo} isCopy={isCopy} title={short ? 'ใบเสร็จรับเงิน (ย่อ)' : 'ใบเสร็จรับเงิน / ใบกำกับภาษีอย่างย่อ'} />
      <KV k={t('เลขที่')} v={snap.receiptNo} />
      <KV k={t('วันที่')} v={fmtDateTime(snap.issuedAt)} />
      <KV k={t('พนักงาน')} v={snap.employee} />
      {snap.customer?.name && <KV k={t('ลูกค้า')} v={`${snap.customer.name}${snap.customer.memberCode ? ` (${snap.customer.memberCode})` : ''}`} />}
      {snap.customer?.phone && !short && <KV k={t('โทร')} v={snap.customer.phone} />}
      {snap.room && (
        <>
          <div className="hr" />
          <KV k={t('ห้อง')} v={`${snap.room.name} (${snap.room.type})`} />
          {!short && <KV k={t('จำนวนลูกค้า')} v={`${snap.room.guests} ${t('คน')}`} />}
          <KV k={t('เวลา')} v={`${fmtTime(snap.room.startedAt)} - ${fmtTime(snap.room.endedAt)}`} />
          <KV k={t('จำนวนชั่วโมง')} v={formatMinutesShort(snap.room.billedMinutes)} />
          {snap.room.packageName && !short && <KV k={t('แพ็กเกจ')} v={snap.room.packageName} />}
        </>
      )}
      <div className="hr" />
      {(snap.lines || []).map((l, i) => (
        <div className="item" key={i}>
          <span>
            {l.type === 'PRODUCT' || !l.type ? l.name : tp(l.name)}
            {!short && l.qty !== 1 ? ` × ${l.qty}` : ''}
          </span>
          <span>{money(l.gross)}</span>
          {!short && l.qty !== 1 && <span className="sub">@ {money(l.unitPrice)}</span>}
          {!short && l.discount > 0 && <span className="sub">{t('ส่วนลด')} -{money(l.discount)}</span>}
          {!short && l.note && <span className="sub">* {l.note}</span>}
        </div>
      ))}
      <div className="hr" />
      <KV k={t('รวม')} v={money(tot.grossTotal)} />
      {(snap.discounts || []).map((d, i) => (
        <KV key={i} k={tp(d.name)} v={`-${money(d.amount)}`} />
      ))}
      {tot.lineDiscountTotal > 0 && <KV k={t('ส่วนลดรายการ')} v={`-${money(tot.lineDiscountTotal)}`} />}
      {tax.scEnabled && <KV k={`Service Charge ${tax.scRate}%`} v={money(tot.serviceCharge)} />}
      {tax.vatEnabled && <KV k={`VAT ${tax.vatRate}% ${tax.vatInclusive ? `(${t('รวมใน')})` : ''}`} v={money(tot.vat)} />}
      {tot.rounding ? <KV k={t('ปัดเศษ')} v={money(tot.rounding)} /> : null}
      <div className="hr2" />
      <KV k={t('ยอดรวม')} v={money(tot.grandTotal)} bold />
      {tot.depositApplied > 0 && <KV k={t('หักเงินมัดจำ')} v={`-${money(tot.depositApplied)}`} />}
      <KV k={t('ยอดสุทธิ')} v={money(tot.netTotal)} bold />
      <div className="hr" />
      {(snap.payments || []).map((p, i) => (
        <KV key={i} k={t(PAYMENT_METHODS[p.method] || p.method)} v={money(p.received ?? p.amount)} />
      ))}
      {tot.change > 0 && <KV k={t('เงินทอน')} v={money(tot.change)} bold />}
      {tot.excessDeposit > 0 && <KV k={t('มัดจำคงเหลือ (คืนลูกค้า)')} v={money(tot.excessDeposit)} />}
      {snap.points && snap.showPoints !== false && (
        <>
          <div className="hr" />
          {snap.points.used > 0 && <KV k={t('คะแนนที่ใช้')} v={snap.points.used} />}
          <KV k={t('คะแนนที่ได้รับ')} v={`+${snap.points.earned}`} />
          <KV k={t('คะแนนคงเหลือ')} v={snap.points.balance} />
        </>
      )}
      <div className="hr" />
      {snap.showQr !== false && !short ? <QRCode value={`RECEIPT:${snap.receiptNo}`} size={110} className="qr" /> : <Barcode value={snap.receiptNo} height={36} className="barcode" />}
      {snap.slogan && <div className="c bold">{snap.slogan}</div>}
      {snap.thankYou && <div className="c">{snap.thankYou}</div>}
      {snap.footerNote && <div className="c xs">{snap.footerNote}</div>}
    </div>
  );
}

export function KitchenTicket({ ticket }) {
  const { t } = useT();
  const station = { KITCHEN: 'ครัว', BAR: 'บาร์', PREP: 'จุดเตรียมสินค้า' }[ticket.station] || ticket.station;
  return (
    <div className="receipt">
      <div className="queue">{t(station)}</div>
      {ticket.queueNo && <KV k={t('คิว')} v={ticket.queueNo} bold />}
      <KV k={t('ห้อง')} v={ticket.room || t('หน้าร้าน')} bold />
      <KV k={t('บิล')} v={ticket.orderNo} />
      <KV k={t('เวลา')} v={fmtDateTime(ticket.time)} />
      <KV k={t('พนักงาน')} v={ticket.employee} />
      <div className="hr2" />
      {ticket.items.map((i, k) => (
        <div key={k} style={{ marginBottom: 4 }}>
          <div className="kv big">
            <span>{i.name}</span>
            <span>x{i.qty}</span>
          </div>
          {i.note && <div>** {i.note}</div>}
        </div>
      ))}
      <div className="hr" />
    </div>
  );
}

export function DepositSlip({ store, deposit, refund, isCopy }) {
  const { t } = useT();
  const d = deposit || {};
  return (
    <div className="receipt">
      <Head store={store} isCopy={isCopy} title={refund ? 'ใบคืนเงินมัดจำ' : 'ใบรับเงินมัดจำ'} />
      <KV k={t('เลขที่')} v={refund ? refund.refund_no : d.deposit_no} />
      {d.booking_no && <KV k={t('เลขที่การจอง')} v={d.booking_no} />}
      <KV k={t('วันที่')} v={fmtDateTime(refund?.created_at || d.received_at)} />
      <KV k={t('ลูกค้า')} v={d.customer_name || '-'} />
      {d.phone && <KV k={t('โทร')} v={d.phone} />}
      {d.room_name && <KV k={t('ห้อง')} v={d.room_name} />}
      {d.start_at && <KV k={t('วันเวลาใช้บริการ')} v={`${fmtDate(d.start_at)} ${fmtTime(d.start_at)}`} />}
      <div className="hr" />
      {refund ? (
        <>
          <KV k={t('ยอดมัดจำ')} v={money(d.amount)} />
          <KV k={t('ยอดคืน')} v={money(refund.amount)} bold />
          <KV k={t('ช่องทางคืนเงิน')} v={t(PAYMENT_METHODS[refund.refund_type] || refund.refund_type)} />
          <KV k={t('เหตุผล')} v={refund.reason} />
        </>
      ) : (
        <>
          <KV k={t('จำนวนเงินมัดจำ')} v={money(d.amount)} bold />
          <KV k={t('ช่องทางชำระ')} v={t(PAYMENT_METHODS[d.method] || d.method)} />
        </>
      )}
      <KV k={t('พนักงาน')} v={refund?.employee_name || d.received_by_name || '-'} />
      <div className="hr" />
      <Barcode value={refund ? refund.refund_no : d.deposit_no} height={36} className="barcode" />
      <div className="c xs">{t('กรุณาเก็บเอกสารนี้ไว้เป็นหลักฐาน')}</div>
    </div>
  );
}

export function VoidSlip({ store, receipt, reason, employee }) {
  const { t } = useT();
  return (
    <div className="receipt">
      <Head store={store} title="ใบยกเลิกรายการ" />
      <KV k={t('ใบเสร็จ')} v={receipt.receipt_no || receipt.receiptNo} />
      <KV k={t('ยอด')} v={money(receipt.snapshot?.totals?.grandTotal ?? receipt.grand_total)} bold />
      <KV k={t('เหตุผล')} v={reason} />
      <KV k={t('ผู้ยกเลิก')} v={employee} />
      <KV k={t('วันที่')} v={fmtDateTime(new Date())} />
      <div className="hr" />
    </div>
  );
}

export function ShiftReport({ store, shift, summary }) {
  const { t } = useT();
  const s = summary || {};
  return (
    <div className="receipt">
      <Head store={store} title="รายงานปิดรอบการขาย" />
      <KV k={t('รอบ')} v={shift.shift_no} />
      <KV k={t('เปิดรอบ')} v={`${fmtDateTime(shift.opened_at)} (${shift.employee_name})`} />
      <KV k={t('ปิดรอบ')} v={shift.closed_at ? `${fmtDateTime(shift.closed_at)} (${shift.closed_by_name || ''})` : '-'} />
      <div className="hr" />
      <KV k={t('เงินสดตั้งต้น')} v={money(s.openingCash)} />
      <KV k={t('ยอดขายเงินสด')} v={money(s.cashSales)} />
      <KV k={t('ยอดขาย QR Code')} v={money(s.qrSales)} />
      <KV k={t('ยอดขายโอนเงิน')} v={money(s.transferSales)} />
      <KV k={t('ยอดขายบัตร')} v={money(s.cardSales)} />
      <KV k={t('ยอดขายช่องทางอื่น')} v={money(s.otherSales)} />
      <KV k={t('ยอดมัดจำที่รับ')} v={money(s.depositsReceived)} />
      <KV k={t('ยอดมัดจำที่คืน')} v={money(s.depositsRefunded)} />
      <KV k={t('ยอดคืนเงิน')} v={money(s.refundsTotal)} />
      <KV k={t('ส่วนลดทั้งหมด')} v={money(s.discountTotal)} />
      <KV k="Service Charge" v={money(s.serviceCharge)} />
      <KV k="VAT" v={money(s.vat)} />
      <div className="hr2" />
      <KV k={t('เงินสดที่ควรมีในลิ้นชัก')} v={money(s.expectedCash)} bold />
      {s.countedCash != null && <KV k={t('เงินสดที่นับได้จริง')} v={money(s.countedCash)} bold />}
      {s.shortage > 0 && <KV k={t('เงินขาด')} v={money(s.shortage)} bold />}
      {s.overage > 0 && <KV k={t('เงินเกิน')} v={money(s.overage)} bold />}
      <div className="hr" />
      <KV k={t('จำนวนใบเสร็จ')} v={s.receipts} />
      <KV k={t('จำนวนรายการขาย')} v={s.itemsSold} />
      <KV k={t('จำนวนห้องที่ขาย')} v={s.roomsSold} />
      <KV k={t('จำนวนชั่วโมงที่ขาย')} v={s.hoursSold} />
      <KV k={t('จำนวนสมาชิกใหม่')} v={s.newMembers} />
      <KV k={t('รายการยกเลิก')} v={(s.voids || []).length} />
      <KV k={t('รายการคืนเงิน')} v={(s.refunds || []).length} />
      {(s.voids || []).map((v, i) => (
        <div key={i} className="xs">
          - {v.order_no} {money(v.grand_total)} {v.void_reason}
        </div>
      ))}
      <div className="hr" />
      <div className="c xs">{t('ลงชื่อ')} ........................................</div>
    </div>
  );
}

export function ReportSlip({ store, report }) {
  const { t } = useT();
  return (
    <div className="receipt">
      <Head store={store} title={report.title} />
      <div className="c">
        {report.from} – {report.to}
      </div>
      <div className="hr" />
      {report.rows.slice(0, 200).map((r, i) => (
        <div key={i} style={{ marginBottom: 3 }}>
          {report.columns.map((c, j) => (
            <div className="kv" key={c.key} style={j === 0 ? { fontWeight: 700 } : undefined}>
              {j > 0 && <span>{c.label}</span>}
              <span>{c.type === 'money' ? money(r[c.key]) : c.type?.startsWith('date') && r[c.key] ? fmtDateTime(r[c.key]) : String(r[c.key] ?? '')}</span>
            </div>
          ))}
          <div className="hr" />
        </div>
      ))}
      {Object.keys(report.totals || {}).length > 0 && (
        <>
          <div className="c big">{t('รวม')}</div>
          {report.columns
            .filter((c) => report.totals[c.key] != null)
            .map((c) => (
              <KV key={c.key} k={c.label} v={c.type === 'money' ? money(report.totals[c.key]) : report.totals[c.key]} bold />
            ))}
        </>
      )}
    </div>
  );
}

export function TestPage({ store, printer }) {
  const { t } = useT();
  return (
    <div className="receipt">
      <Head store={store} title="ทดสอบพิมพ์" />
      <KV k={t('เครื่องพิมพ์')} v={printer?.name || '-'} />
      <KV k={t('การเชื่อมต่อ')} v={printer?.connection || '-'} />
      <KV k={t('ขนาดกระดาษ')} v="80 mm" />
      <KV k={t('เวลา')} v={fmtDateTime(new Date())} />
      <div className="hr" />
      <div className="c big">กขคง ABCD 0123456789</div>
      <div className="c">ภาษาไทย / English ✓</div>
      <Barcode value="BEATBOX-TEST" height={40} className="barcode" />
    </div>
  );
}

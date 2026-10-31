// The online receipt (link from LINE): the bill as printed — store, room, items, discounts, totals, payment — and
// "collect points" when the bill was paid without a member.
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Mic2, Star, CheckCircle2 } from 'lucide-react';
import { useT } from '../lib/i18n.jsx';
import { api } from '../lib/api.js';
import { Loading, money } from '../components/ui.jsx';
import { fmtDate, fmtTime } from '@beatbox/shared/format.js';

const PAY = { CASH: 'เงินสด', QR: 'QR พร้อมเพย์', TRANSFER: 'โอนเงิน', CARD: 'บัตร', CREDIT: 'เครดิต', OTHER: 'อื่นๆ' };

export default function OnlineReceipt() {
  const { token } = useParams();
  const { t } = useT();
  const [r, setR] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api.get(`/public/receipts/${token}`, { auth: false }).then(setR).catch((e) => setErr(e.message));
  }, [token]);
  if (err) return <div className="rg"><div className="rg-card center">{t(err)}</div></div>;
  if (!r) return <Loading />;
  const tt = r.totals || {};
  const claimUrl = `/book/claim/${token}?store=${encodeURIComponent(r.store?.slug || '')}`;
  const row = (label, value, strong = false, key = label) => (
    <div key={key} className={`orc-row ${strong ? 'strong' : ''}`}><span>{label}</span><span>{value}</span></div>
  );
  return (
    <div className="rg orc">
      <div className="rg-head">
        {r.store?.logoUrl ? <img src={r.store.logoUrl} alt="" /> : <div className="brand-logo"><Mic2 size={22} /></div>}
        <div>
          <div className="rg-store">{r.store?.name}</div>
          <div className="rg-muted">{[r.store?.branchName, r.store?.phone].filter(Boolean).join(' · ')}</div>
        </div>
      </div>
      <div className="rg-card orc-paper">
        <div className="orc-title">{t('ใบเสร็จรับเงิน')}</div>
        <div className="orc-meta">{r.receiptNo} · {fmtDate(r.issuedAt)} {fmtTime(r.issuedAt)}</div>
        {r.status !== 'PAID' && <div className="orc-void">{r.status === 'VOID' ? t('ยกเลิกแล้ว') : t('คืนเงินแล้ว')}</div>}
        {r.room && <div className="orc-room">{t('ห้อง')} {r.room.name} · {fmtTime(r.room.startedAt)} – {fmtTime(r.room.endedAt)} · {r.room.guests} {t('คน')}</div>}
        <div className="orc-lines">
          {r.lines.map((l, i) => (
            <div key={i} className="orc-line">
              <div>{l.name}{Number(l.qty) > 1 && <span className="muted"> × {Number(l.qty)}</span>}{Number(l.discount) > 0 && <div className="xs muted">{t('ส่วนลด')} -{money(l.discount)}</div>}</div>
              <div>{money(l.net)}</div>
            </div>
          ))}
        </div>
        {r.discounts.map((d, i) => row(d.name, `-${money(d.amount)}`, false, i))}
        {Number(tt.serviceCharge) > 0 && row(t('ค่าบริการ'), money(tt.serviceCharge))}
        {Number(tt.vat) > 0 && row(t('ภาษีมูลค่าเพิ่ม'), money(tt.vat))}
        {Number(tt.depositApplied) > 0 && row(t('หักเงินมัดจำ'), `-${money(tt.depositApplied)}`)}
        {row(t('ยอดชำระ'), `฿${money(tt.grandTotal)}`, true)}
        <div className="orc-pay">{r.payments.map((p) => `${t(PAY[p.method] || p.method)} ${money(p.amount)}`).join(' · ')}</div>
        {r.thankYou && <div className="orc-thanks">{r.thankYou}</div>}
      </div>
      {r.claim?.state === 'OPEN' && (
        <a className="btn primary block orc-claim" href={claimUrl}><Star size={18} /> {t('สะสมแต้มบิลนี้')} (+{r.claim.points} {t('แต้ม')})</a>
      )}
      {['MINE', 'TAKEN'].includes(r.claim?.state) && <div className="rg-card center small"><CheckCircle2 size={16} /> {t('บิลนี้สะสมแต้มแล้ว')}</div>}
    </div>
  );
}

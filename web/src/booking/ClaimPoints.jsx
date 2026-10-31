// "สะสมแต้ม" from the receipt in LINE: a bill paid without a member → sign in (or sign up) and the bill's points go to
// the member. Once per bill, within the store's time limit.
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Star, CheckCircle2, AlertTriangle, Receipt, LogIn } from 'lucide-react';
import { useT } from '../lib/i18n.jsx';
import { api } from '../lib/api.js';
import { Button, Loading, money, useToast } from '../components/ui.jsx';
import { useMember } from './BookingApp.jsx';
import { fmtDate } from '@beatbox/shared/format.js';

const MSG = {
  TAKEN: 'บิลนี้สะสมแต้มให้สมาชิกท่านอื่นแล้ว',
  VOID: 'บิลนี้ถูกยกเลิกหรือคืนเงินแล้ว',
  EXPIRED: 'เกินเวลารับแต้มของบิลนี้แล้ว',
  NONE: 'บิลนี้ไม่มีแต้มให้สะสม',
};

export default function ClaimPoints() {
  const { token } = useParams();
  const { t } = useT();
  const toast = useToast();
  const { me, ready, reload } = useMember();
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  useEffect(() => {
    if (!ready) return;
    const load = me ? api.get(`/public/receipts/${token}/claim`, { member: true }) : api.get(`/public/receipts/${token}`, { auth: false }).then((r) => ({ ...r.claim, receiptNo: r.receiptNo, total: r.totals?.grandTotal, issuedAt: r.issuedAt }));
    load.then(setInfo).catch((e) => setInfo({ error: e.message }));
  }, [ready, me?.id, token]);
  const claim = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/public/receipts/${token}/claim`, {}, { member: true });
      setDone(r);
      reload?.();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  if (!ready || !info) return <Loading />;
  const here = encodeURIComponent(window.location.pathname);
  return (
    <div className="col" style={{ maxWidth: 480, margin: '0 auto' }}>
      <div className="card center claim-card">
        <div className="claim-star"><Star size={40} /></div>
        {info.error ? (
          <p>{t(info.error)}</p>
        ) : (
          <>
            <div className="small muted"><Receipt size={14} /> {info.receiptNo} · {fmtDate(info.issuedAt)} · ฿{money(info.total)}</div>
            <div className="claim-points">+{Number(done?.points ?? info.points)} <small>{t('แต้ม')}</small></div>
            {done || info.state === 'MINE' ? (
              <>
                <div className="claim-ok"><CheckCircle2 size={20} /> {done?.already || (!done && info.state === 'MINE') ? t('บิลนี้สะสมแต้มให้คุณแล้ว') : t('สะสมแต้มเรียบร้อย')}</div>
                {(done?.balance ?? info.balance) != null && <div className="mt">{t('แต้มคงเหลือ')} <b>{Number(done?.balance ?? info.balance)}</b></div>}
                <Link className="btn primary block mt" to="/book/points">{t('ดูแต้มสะสมของฉัน')}</Link>
              </>
            ) : info.state === 'OPEN' ? (
              me ? (
                <>
                  <div className="small">{t('สะสมแต้มของบิลนี้เข้าบัญชี')} <b>{me.first_name}</b> ({me.phone})</div>
                  <Button variant="primary" size="lg" block className="mt" icon={Star} loading={busy} onClick={claim}>{t('รับแต้ม')}</Button>
                  <div className="xs muted mt">{t('รับแต้มได้ภายใน')} {fmtDate(info.expiresAt)}</div>
                </>
              ) : (
                <>
                  <div className="small">{t('เข้าสู่ระบบหรือสมัครสมาชิกเพื่อรับแต้มของบิลนี้')}</div>
                  <Link className="btn primary block mt" to={`/book/login?redirect=${here}`}><LogIn size={18} /> {t('เข้าสู่ระบบ')}</Link>
                  <Link className="btn block mt" to={`/book/signup?redirect=${here}`}>{t('สมัครสมาชิกใหม่')}</Link>
                </>
              )
            ) : (
              <div className="claim-warn"><AlertTriangle size={18} /> {t(MSG[info.state] || info.state)}</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

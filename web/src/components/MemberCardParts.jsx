// Member cards on the staff screens: the card of a member (front / back), printing (A4 duplex or a card printer),
// "ออกบัตรใหม่" (a new number, the old card stops working) and "ซิงค์บัตร" (tap / scan an existing card so its number
// becomes the member number, then print the card again).
import { useEffect, useRef, useState } from 'react';
import { CreditCard, Printer, RefreshCcw, Nfc, Sparkles, CheckCircle2, AlertTriangle } from 'lucide-react';
import { Button, Modal, Input, Badge, useToast, useDialog } from './ui.jsx';
import { useT } from '../lib/i18n.jsx';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/store.jsx';
import { useLive } from '../lib/socket.js';
import { CardFront, CardBack, printCards, groupNo } from './MemberCard.jsx';
import { useCardReader, cleanCardNo, readerConfig, nfcSupported, startNfc } from '../lib/cardReader.js';
import { fmtDateTime } from '@beatbox/shared/format.js';

const tierOf = (tiers, m) => (tiers || []).find((x) => x.id === m.tier_id) || { id: m.tier_id, name: m.tier_name, code: m.tier_code, sort_order: m.tier_sort };

export function CardPreview({ member, tiers, zoom = 1, side = 'BOTH' }) {
  const { t } = useT();
  const { settings } = useAuth();
  const cfg = settings?.memberCard || {};
  const tier = tierOf(tiers, member);
  return (
    <div className="mc-pair">
      {side !== 'BACK' && <div className="mc-side"><span>{t('ด้านหน้า')}</span><div className="mc-zoom" style={{ zoom }}><CardFront member={member} tier={tier} cfg={cfg} store={settings?.store} /></div></div>}
      {side !== 'FRONT' && <div className="mc-side"><span>{t('ด้านหลัง')}</span><div className="mc-zoom" style={{ zoom }}><CardBack tier={tier} cfg={cfg} store={settings?.store} /></div></div>}
    </div>
  );
}

/** Print the cards of these members (first card issued on the way). */
export function PrintCardsModal({ memberIds, onClose, onPrinted }) {
  const { t } = useT();
  const toast = useToast();
  const { settings } = useAuth();
  const { data: tiers } = useLive(() => api.get('/member-tiers'), [], []);
  const [side, setSide] = useState('BOTH');
  const [busy, setBusy] = useState(false);
  const cfg = settings?.memberCard || {};
  const card = cfg.print?.paper === 'CARD';
  const go = async () => {
    setBusy(true);
    try {
      const rows = await api.post('/members/cards/print', { memberIds });
      await printCards(rows, { tiers, cfg, store: settings.store, side });
      onPrinted?.(rows);
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const sheets = card ? memberIds.length : Math.ceil(memberIds.length / 10);
  const opts = [
    { v: 'BOTH', label: 'ทั้งสองด้าน', hint: card ? 'หน้า/หลังสลับกัน สำหรับเครื่องพิมพ์บัตรที่พิมพ์สองด้าน' : 'หน้าแรกด้านหน้า หน้าถัดไปด้านหลัง — ตั้งเครื่องพิมพ์ให้พิมพ์สองหน้า' },
    { v: 'FRONT', label: 'เฉพาะด้านหน้า', hint: 'เครื่องพิมพ์หน้าเดียว: พิมพ์ด้านหน้าก่อน' },
    { v: 'BACK', label: 'เฉพาะด้านหลัง', hint: 'แล้วใส่กระดาษแผ่นเดิมกลับเข้าไปโดยพลิกด้าน แล้วพิมพ์ด้านหลัง' },
  ];
  return (
    <Modal title={<span className="row nowrap"><Printer size={20} /> {t('พิมพ์บัตรสมาชิก')} ({memberIds.length})</span>} onClose={onClose} footer={<Button variant="primary" icon={Printer} loading={busy} onClick={go}>{t('พิมพ์')}</Button>}>
      <div className="col">
        <div className="small muted">
          {card ? `${t('เครื่องพิมพ์บัตร: 1 บัตรต่อหน้า')} (85.5 × 54 ${t('มม.')})` : `${t('กระดาษ A4: 10 ใบต่อแผ่น')} · ${sheets} ${t('แผ่น')}`}
        </div>
        {opts.map((o) => (
          <label key={o.v} className={`card flat row nowrap clickable ${side === o.v ? 'selected' : ''}`} style={{ padding: 10, alignItems: 'flex-start' }}>
            <input type="radio" checked={side === o.v} onChange={() => setSide(o.v)} />
            <div><b>{t(o.label)}</b><div className="xs muted">{t(o.hint)}</div></div>
          </label>
        ))}
        <div className="xs muted">
          {t('ในหน้าต่างพิมพ์: เลือกขนาดกระดาษให้ตรง, ขนาด 100% (Actual size / ไม่ย่อให้พอดี), ไม่มีขอบ (Margins: None) และเปิด "กราฟิกพื้นหลัง" (Background graphics)')}
          {!card && side === 'BOTH' && ` ${t('พิมพ์สองหน้าแบบพลิกด้าน')}${cfg.print?.flip === 'SHORT' ? t('สั้น') : t('ยาว')}`}
        </div>
      </div>
    </Modal>
  );
}

/** "ซิงค์บัตร": wait for a card (reader / scanner / typed), check who it belongs to, make it this member's number. */
export function SyncCardModal({ m, onClose, onSynced }) {
  const { t } = useT();
  const toast = useToast();
  const [no, setNo] = useState('');
  const [check, setCheck] = useState(null); // { code, valid, owner }
  const [busy, setBusy] = useState(false);
  const [nfcOn, setNfcOn] = useState(false);
  const [printAfter, setPrintAfter] = useState(true);
  const stopNfc = useRef(null);
  const input = useRef(null);
  const cfg = readerConfig();
  const read = async (raw) => {
    const code = cleanCardNo(raw);
    if (!code) return;
    setNo(code);
    navigator.vibrate?.(80);
    try {
      setCheck(await api.get(`/members/card-owner?no=${encodeURIComponent(code)}`));
    } catch (e) {
      toast.error(e);
    }
  };
  useCardReader(read, !check);
  useEffect(() => () => stopNfc.current?.(), []);
  useEffect(() => {
    if (!check) input.current?.focus();
  }, [check]);
  const nfc = async () => {
    try {
      stopNfc.current = await startNfc(read);
      setNfcOn(true);
    } catch (e) {
      toast.error(e.message);
    }
  };
  const mine = check?.owner?.id === m.id;
  const taken = check?.owner && !mine;
  const save = async () => {
    setBusy(true);
    try {
      await api.post(`/members/${m.id}/card/sync`, { cardNo: check.code });
      toast.success(`${t('ซิงค์บัตรแล้ว เลขสมาชิกใหม่')} ${check.code}`);
      onSynced(printAfter);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={<span className="row nowrap"><RefreshCcw size={20} /> {t('ซิงค์บัตร')} · {m.first_name}</span>}
      onClose={onClose}
      footer={check && (
        <>
          <Button onClick={() => { setCheck(null); setNo(''); }}>{t('อ่านบัตรใหม่')}</Button>
          <Button variant="primary" icon={RefreshCcw} loading={busy} disabled={!check.valid || taken} onClick={save}>{t('ใช้บัตรนี้')}{printAfter ? ` + ${t('พิมพ์บัตร')}` : ''}</Button>
        </>
      )}
    >
      {!check ? (
        <div className="reader-pad">
          <div className="reader-icon"><Nfc size={38} /></div>
          <b style={{ fontSize: '1.15rem' }}>{t('แตะบัตรที่เครื่องอ่าน หรือสแกนบาร์โค้ดบัตรใบเก่า')}</b>
          <div className="small muted">{t('เลขบนบัตรจะกลายเป็นเลขสมาชิกของ')} {m.first_name} {t('— เลขสมาชิกกับเลขบัตรตรงกันเสมอ')}</div>
          <form className="row nowrap" style={{ width: '100%', maxWidth: 360 }} onSubmit={(e) => { e.preventDefault(); read(no); }}>
            <Input ref={input} autoFocus value={no} onChange={(e) => setNo(e.target.value)} placeholder={t('หรือพิมพ์เลขบัตร แล้วกด Enter')} />
            <Button type="submit">{t('ตกลง')}</Button>
          </form>
          <div className="xs muted">
            {t('เครื่องอ่านของเครื่องนี้')}: {cfg.mode === 'SERIAL' ? 'USB Serial' : cfg.mode === 'NFC' ? 'NFC' : t('USB/บลูทูธ แบบคีย์บอร์ด')}
          </div>
          {nfcSupported() && !nfcOn && <Button size="sm" icon={Nfc} onClick={nfc}>{t('อ่านด้วย NFC ของเครื่องนี้')}</Button>}
          {nfcOn && <Badge color="#16a34a">{t('NFC พร้อม — แตะบัตรที่หลังเครื่อง')}</Badge>}
        </div>
      ) : (
        <div className="col">
          <div className="card flat center" style={{ padding: 16 }}>
            <div className="small muted">{t('เลขบัตร')}</div>
            <div style={{ fontSize: '1.7rem', fontWeight: 800, letterSpacing: 2, fontFamily: 'ui-monospace, monospace' }}>{groupNo(check.code)}</div>
          </div>
          {!check.valid && <div className="alert danger"><AlertTriangle size={18} /> {t('เลขบัตรไม่ถูกต้อง (ตัวอักษร/ตัวเลข 4–32 ตัว)')}</div>}
          {taken && <div className="alert danger"><AlertTriangle size={18} /> {check.owner.deleted ? t('เลขบัตรนี้เคยใช้กับสมาชิกที่ถูกลบแล้ว ใช้บัตรใบอื่น') : `${t('บัตรนี้เป็นของสมาชิก')} ${check.owner.name} ${t('อยู่แล้ว')}`}</div>}
          {mine && <div className="alert"><CheckCircle2 size={18} /> {t('บัตรนี้เป็นของสมาชิกคนนี้อยู่แล้ว')}</div>}
          {check.valid && !taken && !mine && (
            <div className="small">{t('เลขสมาชิกจะเปลี่ยนจาก')} <b>{m.member_code}</b> {t('เป็น')} <b>{check.code}</b> · {t('บัตรใบเดิมของสมาชิกจะใช้ไม่ได้')}</div>
          )}
          <label className="row nowrap small"><input type="checkbox" checked={printAfter} onChange={(e) => setPrintAfter(e.target.checked)} /> {t('พิมพ์รูปบัตรใหม่หลังซิงค์')}</label>
        </div>
      )}
    </Modal>
  );
}

/** The card section of a member (drawer). */
export function MemberCardPanel({ m, tiers, onChanged }) {
  const { t } = useT();
  const toast = useToast();
  const { confirm } = useDialog();
  const { can } = useAuth();
  const [modal, setModal] = useState(null); // print | sync
  const edit = can('member.edit');
  const issue = async () => {
    if (!(await confirm({ title: 'ออกบัตรใหม่', message: `${t('สุ่มเลขบัตรใหม่ให้')} ${m.first_name} — ${t('เลขสมาชิกจะเปลี่ยนเป็นเลขบัตรใหม่ และบัตรใบเดิม')} (${m.member_code}) ${t('จะใช้ไม่ได้อีก')}`, okText: 'ออกบัตรใหม่' }))) return;
    try {
      const card = await api.post(`/members/${m.id}/card/issue`);
      toast.success(`${t('ออกบัตรใหม่แล้ว')} ${card.card_no}`);
      await onChanged();
      setModal('print');
    } catch (e) {
      toast.error(e);
    }
  };
  const cards = m.cards || [];
  return (
    <div className="card flat">
      <div className="card-title">
        <span><CreditCard size={16} /> {t('บัตรสมาชิก')}</span>
        {m.card_kind ? <Badge color="#16a34a">{m.card_kind === 'SYNCED' ? t('บัตรที่ซิงค์') : t('ออกบัตรแล้ว')} · {t('พิมพ์')} {m.card_print_count} {t('ครั้ง')}</Badge> : <Badge color="#f97316">{t('ยังไม่มีบัตร')}</Badge>}
      </div>
      <CardPreview member={m} tiers={tiers} zoom={0.92} />
      {edit && (
        <div className="row mt">
          <Button variant="primary" icon={Printer} onClick={() => setModal('print')}>{m.card_kind ? t('พิมพ์บัตร') : t('ออกบัตร + พิมพ์')}</Button>
          <Button icon={Sparkles} onClick={issue}>{t('ออกบัตรใหม่')}</Button>
          <Button icon={RefreshCcw} onClick={() => setModal('sync')}>{t('ซิงค์บัตร')}</Button>
        </div>
      )}
      <div className="xs muted mt">{t('เลขสมาชิก = เลขบัตร · ออกบัตรใหม่ = สุ่มเลขใหม่ (บัตรเดิมใช้ไม่ได้) · ซิงค์บัตร = แตะ/สแกนบัตรที่มีอยู่ ให้เลขบนบัตรเป็นเลขสมาชิก แล้วพิมพ์รูปบัตรใหม่')}</div>
      {cards.length > 0 && (
        <div className="col mt" style={{ gap: 4 }}>
          {cards.map((c) => (
            <div key={c.id} className="row between small" style={{ opacity: c.status === 'ACTIVE' ? 1 : 0.6 }}>
              <span><b style={{ fontFamily: 'ui-monospace, monospace' }}>{groupNo(c.card_no)}</b> · {c.kind === 'SYNCED' ? t('ซิงค์') : t('ออกบัตร')} · {c.issued_by_name || '-'}</span>
              <span>{c.status === 'ACTIVE' ? <Badge color="#16a34a">{t('ใช้งาน')}</Badge> : <Badge>{t('ยกเลิกแล้ว')}</Badge>} {fmtDateTime(c.created_at)}</span>
            </div>
          ))}
        </div>
      )}
      {modal === 'print' && <PrintCardsModal memberIds={[m.id]} onClose={() => setModal(null)} onPrinted={onChanged} />}
      {modal === 'sync' && <SyncCardModal m={m} onClose={() => setModal(null)} onSynced={async (print) => { await onChanged(); setModal(print ? 'print' : null); }} />}
    </div>
  );
}

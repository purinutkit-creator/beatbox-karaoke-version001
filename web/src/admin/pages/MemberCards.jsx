// Member card designer: the look of each tier's card, what is on the front and the back (text, picture, QR codes to
// the store's links), the card number length, how cards are printed (A4 duplex / card printer, alignment) and the card
// reader of this device.
import { useEffect, useMemo, useState } from 'react';
import { CreditCard, Save, Plus, Trash2, Printer, RotateCcw, Nfc, Usb, Keyboard } from 'lucide-react';
import { PageHead, Button, Input, Field, Select, Switch, Textarea, Tabs, Loading, ImageUrlInput, Badge, useToast } from '../../components/ui.jsx';
import { useT } from '../../lib/i18n.jsx';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/store.jsx';
import { useLive } from '../../lib/socket.js';
import { CARD_THEMES, CardFront, CardBack, tierLook, printCards } from '../../components/MemberCard.jsx';
import { readerConfig, setReaderConfig, pairSerialReader, serialSupported, nfcSupported, startNfc, useCardReader } from '../../lib/cardReader.js';

const SAMPLE = { first_name: 'สมชาย', last_name: 'ใจดี', member_code: '482915736051', created_at: new Date().toISOString(), photo_url: '' };

function ReaderSettings() {
  const { t } = useT();
  const toast = useToast();
  const [cfg, setCfg] = useState(readerConfig);
  const [last, setLast] = useState(null);
  const [nfcOn, setNfcOn] = useState(false);
  const set = (k, v) => {
    const next = { ...cfg, [k]: v };
    setCfg(next);
    setReaderConfig(next);
  };
  useCardReader((code) => setLast({ code, at: new Date() }), true);
  const pair = async () => {
    try {
      await pairSerialReader();
      toast.success('เชื่อมต่อเครื่องอ่านแล้ว');
      setCfg({ ...cfg }); // restart reading with the paired port
    } catch (e) {
      if (e.name !== 'NotFoundError') toast.error(e.message);
    }
  };
  const nfc = async () => {
    try {
      await startNfc((code) => setLast({ code: code.replace(/:/g, '').toUpperCase(), at: new Date() }));
      setNfcOn(true);
    } catch (e) {
      toast.error(e.message);
    }
  };
  return (
    <div className="card">
      <div className="card-title"><span><Nfc size={18} /> {t('เครื่องอ่านบัตร (เฉพาะเครื่องนี้)')}</span></div>
      <div className="grid grid-3">
        {[
          { v: 'KEYBOARD', icon: Keyboard, label: 'USB / บลูทูธ แบบคีย์บอร์ด', hint: 'เครื่องอ่าน RFID และเครื่องสแกนบาร์โค้ดส่วนใหญ่ เสียบแล้วใช้ได้เลย' },
          { v: 'SERIAL', icon: Usb, label: 'USB Serial (COM)', hint: 'เครื่องอ่านที่ต่อเป็นพอร์ต COM — Chrome/Edge บนคอมพิวเตอร์' },
          { v: 'NFC', icon: Nfc, label: 'NFC ของแท็บเล็ต/มือถือ', hint: 'Chrome บน Android ที่มี NFC' },
        ].map((o) => (
          <label key={o.v} className={`card flat clickable ${cfg.mode === o.v ? 'selected' : ''}`} style={{ padding: 12 }}>
            <div className="row nowrap"><input type="radio" checked={cfg.mode === o.v} onChange={() => set('mode', o.v)} /><o.icon size={18} /><b>{t(o.label)}</b></div>
            <div className="xs muted mt">{t(o.hint)}</div>
          </label>
        ))}
      </div>
      {cfg.mode === 'SERIAL' && (
        <div className="row mt">
          <Field label="ความเร็วพอร์ต (baud)"><Select value={String(cfg.baud)} onChange={(e) => set('baud', Number(e.target.value))} options={['9600', '19200', '38400', '57600', '115200']} /></Field>
          <Button icon={Usb} disabled={!serialSupported()} onClick={pair}>{t('เลือกพอร์ตเครื่องอ่าน')}</Button>
          {!serialSupported() && <span className="small muted">{t('เบราว์เซอร์นี้ไม่รองรับ Web Serial (ใช้ Chrome/Edge บนคอมพิวเตอร์)')}</span>}
        </div>
      )}
      {cfg.mode === 'NFC' && (
        <div className="row mt">
          {nfcSupported() ? <Button icon={Nfc} onClick={nfc} disabled={nfcOn}>{nfcOn ? t('NFC พร้อม — แตะบัตรที่หลังเครื่อง') : t('เริ่มอ่าน NFC')}</Button> : <span className="small muted">{t('อุปกรณ์นี้ไม่รองรับ NFC ผ่านเว็บ (ใช้ Chrome บน Android)')}</span>}
        </div>
      )}
      <div className="grid grid-2 mt">
        <Field label="ตัดอักษรนำหน้าที่เครื่องอ่านส่งมา (ถ้ามี)"><Input value={cfg.strip || ''} onChange={(e) => set('strip', e.target.value)} placeholder={t('เช่น ;')} /></Field>
        <div className="reader-pad" style={{ padding: 12 }}>
          <b>{t('ทดสอบ: แตะบัตรหรือสแกนบาร์โค้ด')}</b>
          {last ? <div style={{ fontSize: '1.4rem', fontWeight: 800, fontFamily: 'ui-monospace, monospace' }}>{last.code}</div> : <div className="small muted">{t('ยังไม่ได้อ่านบัตร')}</div>}
        </div>
      </div>
      <div className="xs muted mt">{t('แตะบัตรสมาชิกที่หน้า POS หรือหน้าสมาชิก ระบบจะเปิดข้อมูลสมาชิกให้ทันที (เลขบัตร = เลขสมาชิก)')}</div>
    </div>
  );
}

export default function MemberCards() {
  const { t } = useT();
  const toast = useToast();
  const { settings, setSettings } = useAuth();
  const { data: tiers } = useLive(() => api.get('/member-tiers'), [], []);
  const [f, setF] = useState(() => structuredClone(settings.memberCard || {}));
  const [tierId, setTierId] = useState(null);
  const [tab, setTab] = useState('look');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!tierId && tiers?.length) setTierId(tiers[0].id);
  }, [tiers]);
  const tier = useMemo(() => (tiers || []).find((x) => x.id === tierId), [tiers, tierId]);
  if (!tiers) return <Loading />;
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const setBack = (k, v) => setF((x) => ({ ...x, back: { ...x.back, [k]: v } }));
  const setPrint = (k, v) => setF((x) => ({ ...x, print: { ...x.print, [k]: v } }));
  const own = (tier && f.tiers?.[tier.id]) || {};
  const look = tier ? tierLook(f, tier) : null;
  const setLook = (patch) => setF((x) => ({ ...x, tiers: { ...(x.tiers || {}), [tier.id]: { ...((x.tiers || {})[tier.id] || {}), ...patch } } }));
  const resetLook = () => setF((x) => {
    const next = { ...(x.tiers || {}) };
    delete next[tier.id];
    return { ...x, tiers: next };
  });
  const links = f.back?.links || [];
  const save = async () => {
    setBusy(true);
    try {
      setSettings(await api.put('/settings/memberCard', f));
      toast.success('บันทึกเรียบร้อย');
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  // a full sheet of sample cards (each tier in turn) to check the colours and the front / back alignment
  const testSheet = () => {
    const per = f.print?.paper === 'CARD' ? Math.min(2, tiers.length) : 10;
    const ms = Array.from({ length: per }, (_, i) => {
      const tr = tiers[i % tiers.length];
      return { ...SAMPLE, member_code: String(482915736051 + i), tier_id: tr.id, tier_name: tr.name };
    });
    printCards(ms, { tiers, cfg: f, store: settings.store });
  };
  return (
    <div>
      <PageHead icon={CreditCard} title="บัตรสมาชิก">
        <Button icon={Printer} onClick={testSheet}>{t('พิมพ์หน้าทดสอบ')}</Button>
        <Button variant="primary" icon={Save} loading={busy} onClick={save}>{t('บันทึก')}</Button>
      </PageHead>
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.05fr)', alignItems: 'start', gap: 16 }}>
        <div className="col">
          <Tabs value={tab} onChange={setTab} tabs={[{ value: 'look', label: 'แบบบัตรแต่ละระดับ' }, { value: 'front', label: 'ด้านหน้า' }, { value: 'back', label: 'ด้านหลัง' }, { value: 'print', label: 'การพิมพ์' }, { value: 'reader', label: 'เครื่องอ่านบัตร' }]} />
          {tab === 'look' && tier && (
            <div className="card">
              <div className="row">
                {tiers.map((x) => <Button key={x.id} size="sm" variant={x.id === tierId ? 'primary' : undefined} onClick={() => setTierId(x.id)}>{x.name}</Button>)}
              </div>
              <h3 className="mt">{t('ธีม')}</h3>
              <div className="mc-themes">
                {Object.entries(CARD_THEMES).map(([k, th]) => (
                  <button key={k} type="button" className={`mc-theme ${look.theme === k ? 'on' : ''}`} style={{ background: `linear-gradient(135deg, ${th.color1}, ${th.color2})`, color: th.textColor }} onClick={() => setLook({ theme: k, color1: '', color2: '', textColor: '', accent: '' })}>
                    {th.label}
                  </button>
                ))}
              </div>
              <div className="grid grid-4 mt">
                <Field label="สีไล่ 1"><Input type="color" value={look.color1} onChange={(e) => setLook({ color1: e.target.value })} /></Field>
                <Field label="สีไล่ 2"><Input type="color" value={look.color2} onChange={(e) => setLook({ color2: e.target.value })} /></Field>
                <Field label="สีตัวอักษร"><Input type="color" value={look.textColor} onChange={(e) => setLook({ textColor: e.target.value })} /></Field>
                <Field label="สีเน้น"><Input type="color" value={look.accent} onChange={(e) => setLook({ accent: e.target.value })} /></Field>
              </div>
              <Field label="รูปพื้นหลังบัตร (URL, ไม่บังคับ)"><ImageUrlInput value={own.imageUrl || ''} onChange={(v) => setLook({ imageUrl: v })} /></Field>
              <Field label="ข้อความหัวบัตรของระดับนี้ (เว้นว่าง = ใช้ข้อความด้านหน้า)"><Input value={own.title || ''} onChange={(e) => setLook({ title: e.target.value })} placeholder={f.title || 'MEMBER CARD'} /></Field>
              <Button size="sm" icon={RotateCcw} className="mt" onClick={resetLook}>{t('คืนค่าแบบเริ่มต้นของระดับนี้')}</Button>
            </div>
          )}
          {tab === 'front' && (
            <div className="card col">
              <Field label="ข้อความหัวบัตร"><Input value={f.title || ''} onChange={(e) => set('title', e.target.value)} placeholder="MEMBER CARD" /></Field>
              <Switch checked={f.showLogo !== false} onChange={(v) => set('showLogo', v)} label="แสดงโลโก้ร้าน" />
              <Switch checked={f.showTier !== false} onChange={(v) => set('showTier', v)} label="แสดงชื่อระดับสมาชิก" />
              <Switch checked={f.showSince !== false} onChange={(v) => set('showSince', v)} label="แสดงเดือน/ปีที่สมัคร" />
              <Switch checked={!!f.showPhoto} onChange={(v) => set('showPhoto', v)} label="แสดงรูปสมาชิก (ถ้ามี)" />
              <Field label="จำนวนหลักของเลขบัตร/เลขสมาชิก (สุ่ม)"><Input type="number" min={8} max={16} value={f.numberDigits || 12} onChange={(e) => set('numberDigits', Number(e.target.value))} /></Field>
              <div className="xs muted">{t('ด้านหน้ามีชื่อสมาชิกและบาร์โค้ดของเลขสมาชิกเสมอ — เลขสมาชิกกับเลขบัตรเป็นเลขเดียวกัน ใช้กับสมาชิกใหม่และบัตรที่ออกใหม่')}</div>
            </div>
          )}
          {tab === 'back' && (
            <div className="card col">
              <Field label="หัวข้อ"><Input value={f.back?.heading || ''} onChange={(e) => setBack('heading', e.target.value)} /></Field>
              <Field label="รายละเอียด"><Textarea rows={3} value={f.back?.text || ''} onChange={(e) => setBack('text', e.target.value)} /></Field>
              <Field label="รูปภาพ (URL)"><ImageUrlInput value={f.back?.imageUrl || ''} onChange={(v) => setBack('imageUrl', v)} /></Field>
              <Switch checked={f.back?.showStoreInfo !== false} onChange={(v) => setBack('showStoreInfo', v)} label="แสดงชื่อร้าน เบอร์โทร ที่อยู่" />
              <h3>{t('QR ลิงก์ของร้าน (สูงสุด 4)')}</h3>
              {links.map((l, i) => (
                <div key={i} className="row nowrap">
                  <Input style={{ maxWidth: 140 }} value={l.label} placeholder={t('ชื่อ เช่น LINE')} onChange={(e) => setBack('links', links.map((x, k) => (k === i ? { ...x, label: e.target.value } : x)))} />
                  <Input value={l.url} placeholder="https://" onChange={(e) => setBack('links', links.map((x, k) => (k === i ? { ...x, url: e.target.value } : x)))} />
                  <Button icon={Trash2} variant="ghost" onClick={() => setBack('links', links.filter((_, k) => k !== i))} />
                </div>
              ))}
              {links.length < 4 && (
                <div className="row">
                  <Button size="sm" icon={Plus} onClick={() => setBack('links', [...links, { label: '', url: '' }])}>{t('เพิ่มลิงก์')}</Button>
                  {[['LINE', settings.booking?.lineOaUrl], ['Facebook', settings.booking?.facebookUrl], ['แผนที่', settings.booking?.mapUrl], ['จองห้อง', `${location.origin}/book?store=${encodeURIComponent(settings.store?.slug || '')}`]]
                    .filter(([, url]) => url && !links.some((x) => x.url === url))
                    .map(([label, url]) => <Button key={label} size="sm" onClick={() => setBack('links', [...links, { label, url }])}>+ {t(label)}</Button>)}
                </div>
              )}
              <Field label="เงื่อนไข (ตัวเล็กด้านล่าง)"><Textarea rows={2} value={f.back?.terms || ''} onChange={(e) => setBack('terms', e.target.value)} /></Field>
            </div>
          )}
          {tab === 'print' && (
            <div className="card col">
              <Field label="กระดาษ">
                <Select value={f.print?.paper || 'A4'} onChange={(e) => setPrint('paper', e.target.value)} options={[{ value: 'A4', label: 'A4 — 10 ใบต่อแผ่น (หน้า/หลัง)' }, { value: 'CARD', label: 'เครื่องพิมพ์บัตร PVC — 1 ใบต่อหน้า (85.5 × 54 มม.)' }]} />
              </Field>
              {f.print?.paper !== 'CARD' && (
                <>
                  <Field label="การพลิกกระดาษเมื่อพิมพ์สองหน้า">
                    <Select value={f.print?.flip || 'LONG'} onChange={(e) => setPrint('flip', e.target.value)} options={[{ value: 'LONG', label: 'พลิกด้านยาว (ค่าปกติ)' }, { value: 'SHORT', label: 'พลิกด้านสั้น' }]} />
                  </Field>
                  <div className="grid grid-2">
                    <Field label="เลื่อนด้านหลัง แนวนอน (มม.)"><Input type="number" step="0.5" value={f.print?.offsetX ?? 0} onChange={(e) => setPrint('offsetX', Number(e.target.value))} /></Field>
                    <Field label="เลื่อนด้านหลัง แนวตั้ง (มม.)"><Input type="number" step="0.5" value={f.print?.offsetY ?? 0} onChange={(e) => setPrint('offsetY', Number(e.target.value))} /></Field>
                  </div>
                  <Switch checked={f.print?.cutMarks !== false} onChange={(v) => setPrint('cutMarks', v)} label="พิมพ์เส้นตัด" />
                </>
              )}
              <div className="xs muted">
                {t('บัตรขนาด 85.5 × 54 มม. (ขนาดบัตรมาตรฐาน หนา 0.83 มม. เมื่อเคลือบ/ใช้บัตร PVC) · พิมพ์หน้าทดสอบ แล้วส่องกับไฟดูว่าด้านหลังตรงกับด้านหน้าไหม ถ้าเลื่อน ให้ปรับ "เลื่อนด้านหลัง" ทีละ 0.5 มม.')}
              </div>
              <div className="xs muted">{t('ในหน้าต่างพิมพ์: ขนาด 100% (Actual size), ขอบกระดาษ None, เปิด Background graphics')}</div>
            </div>
          )}
          {tab === 'reader' && <ReaderSettings />}
        </div>
        <div className="card col" style={{ position: 'sticky', top: 12 }}>
          <div className="row between"><b>{t('ตัวอย่าง')}</b>{tier && <Badge color={tier.color}>{tier.name}</Badge>}</div>
          {tier && (
            <>
              <div className="mc-zoom" style={{ zoom: 1.45 }}><CardFront member={{ ...SAMPLE, tier_id: tier.id }} tier={tier} cfg={f} store={settings.store} /></div>
              <div className="mc-zoom" style={{ zoom: 1.45 }}><CardBack tier={tier} cfg={f} store={settings.store} /></div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

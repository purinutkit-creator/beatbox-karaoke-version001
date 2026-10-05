import { useEffect, useState } from 'react';
import { Settings as Cog, Save, Upload, Link2, Trash2, Type, Plus, Database } from 'lucide-react';
import { PageHead, Button, Field, Input, Select, Switch, Textarea, Tabs, Badge, ImageUrlInput, Modal, Loading, money, useToast, Seg } from '../../components/ui.jsx';
import { FormField } from '../../components/Crud.jsx';
import { SaleReceipt } from '../../components/Receipt.jsx';
import { useT } from '../../lib/i18n.jsx';
import { api } from '../../lib/api.js';
import { useAuth, useApp } from '../../lib/store.jsx';
import { useLive } from '../../lib/socket.js';
import { PRESET_FONTS, loadFont } from '../../lib/fonts.js';
import { calculateBill } from '@beatbox/shared/calc.js';
import { renderNumber, renderQueue } from '@beatbox/shared/numbering.js';
import { PARTIAL_RULES } from '@beatbox/shared/roomPricing.js';
import { ROUNDING_MODES } from '@beatbox/shared/money.js';
import { fmtDateTime } from '@beatbox/shared/format.js';

function useSection(key) {
  const { settings, setSettings } = useAuth();
  const { reloadPublic } = useApp();
  const toast = useToast();
  const [v, setV] = useState(settings?.[key] || {});
  const [busy, setBusy] = useState(false);
  useEffect(() => setV(settings?.[key] || {}), [settings, key]);
  const set = (k, val) => setV((x) => ({ ...x, [k]: val }));
  const save = async (override) => {
    setBusy(true);
    try {
      const s = await api.put(`/settings/${key}`, override || v);
      setSettings(s);
      reloadPublic();
      toast.success('บันทึกการตั้งค่าเรียบร้อย');
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return { v, set, setV, save, busy };
}

function SaveBar({ onSave, busy }) {
  const { t } = useT();
  return (
    <div className="row end mt">
      <Button variant="primary" icon={Save} loading={busy} onClick={() => onSave()}>{t('บันทึก')}</Button>
    </div>
  );
}

function Grid({ fields, v, set }) {
  return (
    <div className="grid grid-2">
      {fields.map((f) => <FormField key={f.key} f={f} form={v} set={set} />)}
    </div>
  );
}

function StoreTab() {
  const { settings, setSettings } = useAuth();
  const { reloadPublic } = useApp();
  const toast = useToast();
  const [v, setV] = useState(settings.store);
  const set = (k, val) => setV((x) => ({ ...x, [k]: val }));
  const save = async () => {
    try {
      setSettings(await api.put('/settings/store', v));
      reloadPublic();
      toast.success('บันทึกการตั้งค่าเรียบร้อย');
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <div className="card">
      <Grid v={v} set={set} fields={[
        { key: 'name', label: 'ชื่อร้านคาราโอเกะ', required: true },
        { key: 'branchName', label: 'ชื่อสาขา' },
        { key: 'logoUrl', label: 'โลโก้ร้าน (URL รูปภาพ)', type: 'image', full: true },
        { key: 'address', label: 'ที่อยู่ร้าน', type: 'textarea', full: true },
        { key: 'phone', label: 'เบอร์โทรศัพท์ร้าน' },
        { key: 'taxId', label: 'เลขประจำตัวผู้เสียภาษี' },
        { key: 'openTime', label: 'เวลาเปิดร้าน', type: 'time' },
        { key: 'closeTime', label: 'เวลาปิดร้าน', type: 'time' },
        { key: 'slogan', label: 'ข้อความสโลแกนท้ายใบเสร็จ', full: true },
        { key: 'currency', label: 'สกุลเงิน', type: 'select', options: [{ value: 'THB', label: 'บาท (THB)' }, { value: 'USD', label: 'USD' }] },
      ]} />
      <SaveBar onSave={save} />
    </div>
  );
}

function FontPicker({ label, value, onChange, customFonts, script }) {
  const { t } = useT();
  const [custom, setCustom] = useState('');
  const options = [...PRESET_FONTS.filter((f) => !script || f.script === script || script === 'any'), ...customFonts.map((f) => ({ family: f.family, source: 'custom' }))];
  const uniq = [...new Map(options.map((o) => [o.family, o])).values()];
  useEffect(() => uniq.forEach((f) => loadFont(f.family, customFonts)), [customFonts.length]);
  const isListed = uniq.some((o) => o.family === value);
  return (
    <Field label={label}>
      <select className="input" value={isListed ? value : '__other'} onChange={(e) => e.target.value !== '__other' && onChange(e.target.value)} style={{ fontFamily: `'${value}'` }}>
        {uniq.map((o) => (
          <option key={o.family} value={o.family} style={{ fontFamily: `'${o.family}'` }}>
            {o.family} {o.source === 'custom' ? `(${t('ฟอนต์ที่นำเข้า')})` : o.source === 'local' ? `(${t('ฟอนต์ระบบ')})` : ''}
          </option>
        ))}
        <option value="__other">{t('ฟอนต์ Google อื่นๆ (พิมพ์ชื่อ)')}</option>
      </select>
      {!isListed && <div className="small muted">Google Font: <b>{value}</b></div>}
      <div className="row nowrap">
        <Input placeholder={t('พิมพ์ชื่อฟอนต์จาก Google Fonts เช่น Mali, Itim, Lexend')} value={custom} onChange={(e) => setCustom(e.target.value)} />
        <Button size="sm" disabled={!custom.trim()} onClick={() => { loadFont(custom.trim()); onChange(custom.trim()); setCustom(''); }}>{t('ใช้ฟอนต์นี้')}</Button>
      </div>
      <div className="font-sample" style={{ fontFamily: `'${value}', sans-serif` }}>
        <div style={{ fontSize: '1.3rem', fontWeight: 700 }}>BEATBOX คาราโอเกะ ร้องให้สุด 0123456789</div>
        <div>The quick brown fox · ราคา ฿1,299.00 · {value}</div>
      </div>
    </Field>
  );
}

function AppearanceTab() {
  const { t, lang, setLang } = useT();
  const toast = useToast();
  const { settings, setSettings } = useAuth();
  const { reloadPublic } = useApp();
  const app = useSection('appearance');
  const gen = useSection('general');
  const [imp, setImp] = useState(null);
  const custom = app.v.customFonts || [];
  const upload = async () => {
    try {
      let list;
      if (imp.mode === 'file') {
        const fd = new FormData();
        fd.append('file', imp.file);
        fd.append('family', imp.family);
        fd.append('weight', imp.weight || '400');
        fd.append('style', imp.style || 'normal');
        list = await api.post('/fonts/upload', fd);
      } else list = await api.post('/fonts/url', { family: imp.family, url: imp.url, weight: imp.weight || '400', style: imp.style || 'normal' });
      setSettings(await api.get('/settings'));
      reloadPublic();
      toast.success(`${t('นำเข้าฟอนต์')} ${imp.family} ${t('เรียบร้อย')}`);
      setImp(null);
      return list;
    } catch (e) {
      toast.error(e);
    }
  };
  const removeFont = async (f) => {
    try {
      await api.del(`/fonts/${f.id}`);
      setSettings(await api.get('/settings'));
      reloadPublic();
    } catch (e) {
      toast.error(e);
    }
  };
  const sampleSnap = {
    receiptNo: 'RC20261005-0001', queueNo: `${settings.queue.prefix}01`, issuedAt: new Date(), store: settings.store, slogan: settings.receipt.slogan, thankYou: settings.receipt.thankYou, employee: 'Admin',
    lines: [{ name: 'ค่าห้อง 2 ชม.', qty: 1, unitPrice: 798, gross: 798, net: 798 }, { name: 'โค้ก', qty: 2, unitPrice: 35, gross: 70, net: 70 }],
    totals: { grossTotal: 868, grandTotal: 868, netTotal: 868, paid: 1000, change: 132, vat: 56.79 }, tax: { vatEnabled: true, vatRate: 7, vatInclusive: true }, payments: [{ method: 'CASH', received: 1000 }], discounts: [], showQr: false,
  };
  return (
    <div className="col">
      <div className="card">
        <h3><Type size={18} /> {t('ภาษาและฟอนต์ของเว็บไซต์ทั้งหมด')} (POS · Customer Display · {t('เว็บไซต์จอง')})</h3>
        <div className="grid grid-2">
          <Field label="ภาษาเริ่มต้นของระบบ">
            <Seg value={app.v.defaultLanguage || 'th'} onChange={(v) => app.set('defaultLanguage', v)} options={[{ value: 'th', label: 'ไทย (TH)' }, { value: 'en', label: 'English (EN)' }]} />
          </Field>
          <Field label="ภาษาของเครื่องนี้">
            <Seg value={lang} onChange={setLang} options={[{ value: 'th', label: 'ไทย (TH)' }, { value: 'en', label: 'English (EN)' }]} />
          </Field>
          <FontPicker label="ฟอนต์ภาษาไทย (เมื่อใช้ภาษา TH)" value={app.v.thFont || 'Sarabun'} onChange={(v) => app.set('thFont', v)} customFonts={custom} script="any" />
          <FontPicker label="ฟอนต์ภาษาอังกฤษ (เมื่อใช้ภาษา EN)" value={app.v.enFont || 'Poppins'} onChange={(v) => app.set('enFont', v)} customFonts={custom} script="any" />
        </div>
        <h3 className="mt">{t('ฟอนต์ใบเสร็จ')}</h3>
        <div className="grid grid-2">
          <FontPicker label="ฟอนต์ใบเสร็จภาษาไทย (ค่าเริ่มต้น Kanit)" value={app.v.receiptThFont || 'Kanit'} onChange={(v) => app.set('receiptThFont', v)} customFonts={custom} script="any" />
          <FontPicker label="ฟอนต์ใบเสร็จภาษาอังกฤษ" value={app.v.receiptEnFont || 'Kanit'} onChange={(v) => app.set('receiptEnFont', v)} customFonts={custom} script="any" />
        </div>
        <div className="row end mt">
          <Button onClick={() => app.save({ ...app.v, thFont: 'Sarabun', enFont: 'Poppins', receiptThFont: 'Kanit', receiptEnFont: 'Kanit' })}>{t('คืนค่าเริ่มต้น')}</Button>
          <Button variant="primary" icon={Save} loading={app.busy} onClick={() => app.save()}>{t('บันทึกและใช้กับทุกหน้า')}</Button>
        </div>
      </div>
      <div className="card">
        <div className="card-title">
          <span>{t('ฟอนต์ที่นำเข้าเอง')}</span>
          <div className="row">
            <Button size="sm" icon={Upload} onClick={() => setImp({ mode: 'file', family: '', weight: '400' })}>{t('อัปโหลดไฟล์ฟอนต์')}</Button>
            <Button size="sm" icon={Link2} onClick={() => setImp({ mode: 'url', family: '', url: '', weight: '400' })}>{t('นำเข้าจาก URL')}</Button>
          </div>
        </div>
        <p className="small muted">{t('รองรับ .woff2 .woff .ttf .otf หรือ URL ของไฟล์ฟอนต์/ไฟล์ CSS — เช่นนำเข้า Sukhumvit Set (ฟอนต์ระบบของ Apple ที่ไม่มีใน Google Fonts) ให้แสดงผลได้ทุกอุปกรณ์')}</p>
        {!custom.length && <div className="muted small">{t('ยังไม่มีฟอนต์ที่นำเข้า')}</div>}
        {custom.map((f) => (
          <div key={f.id} className="row between card flat" style={{ padding: 10 }}>
            <span style={{ fontFamily: `'${f.family}'`, fontSize: '1.1rem' }}>{f.family} — กขค ABC 123</span>
            <span className="row nowrap"><Badge>{f.source}</Badge><Badge>{f.weight}</Badge><Button size="sm" variant="ghost" icon={Trash2} onClick={() => removeFont(f)} /></span>
          </div>
        ))}
      </div>
      <div className="grid grid-2">
        <div className="card">
          <h3>{t('สีและพื้นหลัง')}</h3>
          <Grid v={gen.v} set={gen.set} fields={[
            { key: 'primaryColor', label: 'สีหลักของระบบ', type: 'color' },
            { key: 'accentColor', label: 'สีรอง', type: 'color' },
            { key: 'backgroundUrl', label: 'รูปพื้นหลังระบบ (URL)', type: 'image', full: true },
            { key: 'defaultTheme', label: 'ธีมเริ่มต้น', type: 'select', options: [{ value: 'dark', label: 'Dark Mode' }, { value: 'light', label: 'Light Mode' }] },
          ]} />
          <SaveBar onSave={gen.save} busy={gen.busy} />
        </div>
        <div className="card">
          <h3>{t('ตัวอย่างใบเสร็จ')}</h3>
          <div className="receipt-preview" style={{ '--font-receipt': `'${lang === 'en' ? app.v.receiptEnFont : app.v.receiptThFont}', sans-serif` }}><SaleReceipt snap={sampleSnap} /></div>
        </div>
      </div>
      {imp && (
        <Modal title={t('นำเข้าฟอนต์')} onClose={() => setImp(null)} footer={<Button variant="primary" disabled={!imp.family || (imp.mode === 'file' ? !imp.file : !imp.url)} onClick={upload}>{t('นำเข้า')}</Button>}>
          <div className="grid grid-2">
            <Field label="ชื่อฟอนต์ (Font family)"><Input value={imp.family} placeholder="Sukhumvit Set" onChange={(e) => setImp({ ...imp, family: e.target.value })} /></Field>
            <Field label="น้ำหนัก (weight)"><Select value={imp.weight} onChange={(e) => setImp({ ...imp, weight: e.target.value })} options={['300', '400', '500', '600', '700', '800']} /></Field>
            {imp.mode === 'file' ? (
              <Field label="ไฟล์ฟอนต์" style={{ gridColumn: '1/-1' }}><input type="file" accept=".woff2,.woff,.ttf,.otf" onChange={(e) => setImp({ ...imp, file: e.target.files[0], family: imp.family || e.target.files[0]?.name.replace(/\.[^.]+$/, '').replace(/[-_](Regular|Bold|Medium|Light|Text).*$/i, '') })} /></Field>
            ) : (
              <Field label="URL ไฟล์ฟอนต์ หรือ CSS" style={{ gridColumn: '1/-1' }}><Input value={imp.url} onChange={(e) => setImp({ ...imp, url: e.target.value })} placeholder="https://.../font.woff2" /></Field>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

function TaxTab() {
  const { t, tp } = useT();
  const s = useSection('tax');
  const v = s.v;
  const demo = calculateBill({ items: [{ type: 'ROOM', qty: 1, unitPrice: 1000 }, { type: 'PRODUCT', qty: 1, unitPrice: 500 }], tax: v, deposit: 300 });
  return (
    <div className="grid grid-2">
      <div className="card">
        <h3>VAT</h3>
        <Switch checked={v.vatEnabled} onChange={(x) => s.set('vatEnabled', x)} label="เปิดใช้งาน VAT" />
        <div className="row mt">
          {[0, 7].map((r) => <Button key={r} size="sm" variant={Number(v.vatRate) === r ? 'primary' : ''} onClick={() => s.set('vatRate', r)}>{r}%</Button>)}
          <Input type="number" style={{ width: 100 }} value={v.vatRate ?? ''} onChange={(e) => s.set('vatRate', Number(e.target.value))} />%
        </div>
        <Field label="ราคาสินค้า" style={{ marginTop: 10 }}><Seg value={v.vatMode} onChange={(x) => s.set('vatMode', x)} options={[{ value: 'INCLUSIVE', label: 'รวม VAT แล้ว (Inclusive)' }, { value: 'EXCLUSIVE', label: 'ยังไม่รวม VAT (Exclusive)' }]} /></Field>
        <h3 className="mt">Service Charge</h3>
        <Switch checked={v.scEnabled} onChange={(x) => s.set('scEnabled', x)} label="เปิดใช้งาน Service Charge" />
        <div className="row mt">
          {[0, 5, 10].map((r) => <Button key={r} size="sm" variant={Number(v.scRate) === r ? 'primary' : ''} onClick={() => s.set('scRate', r)}>{r}%</Button>)}
          <Input type="number" style={{ width: 100 }} value={v.scRate ?? ''} onChange={(e) => s.set('scRate', Number(e.target.value))} />%
        </div>
        <Field label="ฐานคำนวณ Service Charge" style={{ marginTop: 10 }}><Select value={v.scBase} onChange={(e) => s.set('scBase', e.target.value)} options={[{ value: 'ALL', label: 'คิดทั้งบิล' }, { value: 'ROOM', label: 'คิดเฉพาะค่าห้อง' }, { value: 'PRODUCT', label: 'คิดเฉพาะสินค้า' }]} /></Field>
        <div className="xs muted">{t('สินค้าที่ตั้งค่า "ไม่คิด Service Charge" จะไม่ถูกนำมาคำนวณ')}</div>
        <h3 className="mt">{t('ระบบปัดเศษ')}</h3>
        <div className="grid grid-2">
          <Field label="รูปแบบ"><Select value={v.rounding?.mode || 'NONE'} onChange={(e) => s.set('rounding', { ...v.rounding, mode: e.target.value })} options={Object.entries(ROUNDING_MODES).map(([value, label]) => ({ value, label }))} /></Field>
          <Field label="หน่วย"><Select value={v.rounding?.unit || 1} onChange={(e) => s.set('rounding', { ...v.rounding, unit: Number(e.target.value) })} options={[{ value: 0.25, label: '0.25 บาท' }, { value: 0.5, label: '0.50 บาท' }, { value: 1, label: '1 บาท' }, { value: 5, label: '5 บาท' }, { value: 10, label: '10 บาท' }]} /></Field>
        </div>
        <SaveBar onSave={s.save} busy={s.busy} />
      </div>
      <div className="card">
        <h3>{t('ตัวอย่างการคำนวณ (Calculation Engine กลาง)')}</h3>
        <div className="small muted mb">{t('ค่าห้อง 1,000 + สินค้า 500 มัดจำ 300')}</div>
        {demo.steps.map((x, i) => <div key={i} className="sum-line small"><span>{tp(x)}</span></div>)}
        <div className="sum-line total"><span>{t('ยอดสุทธิ')}</span><span>฿{money(demo.netTotal)}</span></div>
        <div className="small muted mt">{t('ทุกบิลจะบันทึก Snapshot ค่า VAT/Service Charge ณ เวลาขาย การเปลี่ยนการตั้งค่าจะไม่ทำให้ใบเสร็จเก่าเปลี่ยน')}</div>
      </div>
    </div>
  );
}

function ReceiptQueueTab() {
  const { t } = useT();
  const toast = useToast();
  const r = useSection('receipt');
  const q = useSection('queue');
  const [last, setLast] = useState('');
  const { data: cur, reload } = useLive(() => api.get('/settings/queue/current'), [], []);
  const setQueue = async (n) => {
    try {
      await api.post('/settings/queue/set', { lastNumber: n });
      toast.success('บันทึกเลขคิวเรียบร้อย');
      reload();
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <div className="grid grid-2">
      <div className="card">
        <h3>{t('ใบเสร็จ')}</h3>
        <Grid v={r.v} set={r.set} fields={[
          { key: 'numberFormat', label: 'รูปแบบเลขที่ใบเสร็จ', full: true, hint: `{YYYY} {YY} {MM} {DD} {SEQ:4} → ${renderNumber(r.v.numberFormat || '', 1)}` },
          { key: 'slogan', label: 'สโลแกนท้ายใบเสร็จ', full: true },
          { key: 'thankYou', label: 'ข้อความขอบคุณ', full: true },
          { key: 'footerNote', label: 'หมายเหตุท้ายใบเสร็จ', full: true },
          { key: 'showLogo', label: 'โลโก้', type: 'switch', switchLabel: 'แสดงโลโก้' },
          { key: 'showQr', label: 'QR Code', type: 'switch', switchLabel: 'แสดง QR Code ใบเสร็จ' },
          { key: 'showPoints', label: 'คะแนน', type: 'switch', switchLabel: 'แสดงคะแนนสมาชิก' },
        ]} />
        <SaveBar onSave={r.save} busy={r.busy} />
      </div>
      <div className="card">
        <h3>{t('เลขคิว')}</h3>
        <Grid v={q.v} set={q.set} fields={[
          { key: 'prefix', label: 'คำนำหน้าเลขคิว' },
          { key: 'digits', label: 'จำนวนหลักของตัวเลข', type: 'number' },
          { key: 'start', label: 'ตัวเลขเริ่มต้น', type: 'number' },
          { key: 'resetMode', label: 'การรีเซ็ต', type: 'select', options: [{ value: 'DAILY', label: 'รีเซ็ตทุกวันอัตโนมัติ' }, { value: 'SHIFT', label: 'รีเซ็ตทุกครั้งที่เปิดรอบการขาย' }, { value: 'NEVER', label: 'ไม่รีเซ็ตและนับต่อเนื่อง' }] },
        ]} />
        <div className="big-money center mt">{renderQueue(q.v, q.v.start ?? 1)}</div>
        <SaveBar onSave={q.save} busy={q.busy} />
        <div className="divider" />
        <div className="small muted">{t('เลขคิวล่าสุด')}: {cur ? `${cur.value} (${cur.period})` : '-'}</div>
        <div className="row mt">
          <Input type="number" placeholder={t('เลขคิวล่าสุด')} value={last} onChange={(e) => setLast(e.target.value)} style={{ width: 140 }} />
          <Button onClick={() => setQueue(Number(last) || 0)}>{t('กำหนดเลขคิวล่าสุดเอง')}</Button>
          <Button variant="danger" onClick={() => setQueue(Math.max(0, Number(q.v.start ?? 1) - 1))}>{t('รีเซ็ตเลขคิว')}</Button>
        </div>
      </div>
    </div>
  );
}

function PaymentTab() {
  const { t } = useT();
  const { settings } = useAuth();
  const s = useSection('payment');
  const m = s.v.methods || {};
  return (
    <div className="card">
      <div className="row mb"><Badge color={settings.runtime.paymentMode === 'PRODUCTION' ? '#dc2626' : '#f97316'}>Payment Mode: {settings.runtime.paymentMode}</Badge><Badge>Slip Provider: {settings.runtime.slipProvider}</Badge><span className="xs muted">{t('ตั้งค่าโหมดและ API Key ฝั่งเซิร์ฟเวอร์ (Environment Variables) เท่านั้น')}</span></div>
      <Grid v={s.v} set={s.set} fields={[
        { key: 'accountName', label: 'ชื่อบัญชี' },
        { key: 'accountNumber', label: 'เลขบัญชี' },
        { key: 'bankName', label: 'ชื่อธนาคาร' },
        { key: 'promptPayId', label: 'PromptPay ID (เบอร์โทร/เลขผู้เสียภาษี)' },
        { key: 'useDynamicPromptPay', label: 'Dynamic QR', type: 'switch', switchLabel: 'สร้าง QR PromptPay พร้อมยอดเงินอัตโนมัติ' },
        { key: 'qrImageUrl', label: 'URL รูปภาพ QR Code (กรณีไม่ใช้ Dynamic)', type: 'image', full: true },
        { key: 'instruction', label: 'ข้อความแนะนำการชำระเงิน', type: 'textarea', full: true },
        { key: 'slipCheckSeconds', label: 'เวลาจำลองตรวจสลิป (วินาที, Demo Mode)', type: 'number' },
      ]} />
      <h3 className="mt">{t('ช่องทางชำระเงินที่เปิดใช้')}</h3>
      <div className="row">
        {['CASH', 'QR', 'TRANSFER', 'CARD', 'CREDIT', 'OTHER'].map((k) => <Switch key={k} checked={m[k] !== false} onChange={(x) => s.set('methods', { ...m, [k]: x })} label={k} />)}
      </div>
      <SaveBar onSave={s.save} busy={s.busy} />
    </div>
  );
}

function RoomTab() {
  const { t } = useT();
  const s = useSection('room');
  return (
    <div className="card">
      <Grid v={s.v} set={s.set} fields={[
        { key: 'extraGuestFee', label: 'ค่าบริการลูกค้าที่เกินจำนวนห้อง (บาท/คน)', type: 'money' },
        { key: 'partialRule', label: 'วิธีคิดเวลาที่ไม่ครบ 30 นาที', type: 'select', options: Object.entries(PARTIAL_RULES).map(([value, label]) => ({ value, label })) },
        { key: 'graceMinutes', label: 'Grace Period (นาที)', type: 'number', hidden: (f) => f.partialRule !== 'GRACE' },
        { key: 'nearEndMinutes', label: 'ถือว่า "ใกล้หมดเวลา" เมื่อเหลือ (นาที)', type: 'number' },
        { key: 'alertMinutes', label: 'แจ้งเตือนล่วงหน้า (นาที) คั่นด้วย ,', type: 'custom', render: (f, set) => <Input value={(f.alertMinutes || []).join(', ')} onChange={(e) => set('alertMinutes', e.target.value.split(',').map((x) => Number(x.trim())).filter((x) => x > 0))} /> },
        { key: 'upcomingReservationMinutes', label: 'แสดงสถานะ "จองแล้ว" ก่อนเวลาจอง (นาที)', type: 'number' },
        { key: 'alertSoundUrl', label: 'ไฟล์เสียงแจ้งเตือน (URL) — เว้นว่าง = เสียงมาตรฐาน', full: true },
        { key: 'useSpeech', label: 'เสียงพูด', type: 'switch', switchLabel: 'อ่านข้อความแจ้งเตือนด้วยเสียง' },
        { key: 'speechTemplate', label: 'ข้อความเสียงเมื่อหมดเวลา ({room})', full: true },
        { key: 'nearSpeechTemplate', label: 'ข้อความเสียงเมื่อใกล้หมดเวลา ({room} {minutes})', full: true },
      ]} />
      <Button className="mt" onClick={() => { const u = new SpeechSynthesisUtterance((s.v.speechTemplate || '').replace('{room}', 'BEATBOX 01')); u.lang = 'th-TH'; speechSynthesis.speak(u); if (s.v.alertSoundUrl) new Audio(s.v.alertSoundUrl).play().catch(() => {}); }}>{t('ทดสอบเสียง')}</Button>
      <SaveBar onSave={s.save} busy={s.busy} />
    </div>
  );
}

function PointsDepositTab() {
  const { t } = useT();
  const d = useSection('deposit');
  const p = useSection('points');
  const disc = useSection('discount');
  const sec = useSection('security');
  return (
    <div className="grid grid-2">
      <div className="card">
        <h3>{t('ระบบมัดจำ')}</h3>
        <Grid v={d.v} set={d.set} fields={[
          { key: 'rule', label: 'รูปแบบมัดจำ', type: 'select', options: [{ value: 'FIXED', label: 'จำนวนเงินคงที่' }, { value: 'PERCENT', label: 'เปอร์เซ็นต์จากราคาห้อง' }, { value: 'ROOM_TYPE', label: 'กำหนดตาม Type ห้อง/ห้อง' }, { value: 'PACKAGE', label: 'กำหนดตามแพ็กเกจ' }, { value: 'PROMOTION', label: 'กำหนดตามโปรโมชั่น' }] },
          { key: 'fixedAmount', label: 'จำนวนเงินคงที่', type: 'money', hidden: (f) => f.rule !== 'FIXED' },
          { key: 'percent', label: 'เปอร์เซ็นต์', type: 'number', hidden: (f) => f.rule !== 'PERCENT' },
        ]} />
        <SaveBar onSave={d.save} busy={d.busy} />
        <h3 className="mt">{t('ส่วนลดและความปลอดภัย')}</h3>
        <Grid v={disc.v} set={disc.set} fields={[
          { key: 'approvalAbovePercent', label: 'ต้องอนุมัติเมื่อส่วนลดเกิน (%)', type: 'number' },
          { key: 'approvalAboveAmount', label: 'ต้องอนุมัติเมื่อส่วนลดเกิน (บาท)', type: 'money' },
        ]} />
        <SaveBar onSave={disc.save} busy={disc.busy} />
        <Grid v={sec.v} set={sec.set} fields={[
          { key: 'sessionIdleMinutes', label: 'หมดเวลา Session เมื่อไม่ใช้งาน (นาที)', type: 'number' },
          { key: 'refundRequiresApproval', label: 'การคืนเงิน', type: 'switch', switchLabel: 'ต้องได้รับอนุมัติ' },
        ]} />
        <SaveBar onSave={sec.save} busy={sec.busy} />
      </div>
      <div className="card">
        <h3>{t('ระบบคะแนนสมาชิก')}</h3>
        <Grid v={p.v} set={p.set} fields={[
          { key: 'enabled', label: 'สถานะ', type: 'switch', switchLabel: 'เปิดระบบคะแนน' },
          { key: 'amountPerPoint', label: 'ทุกยอดใช้จ่าย (บาท)', type: 'money' },
          { key: 'pointsPerUnit', label: 'ได้คะแนน', type: 'number' },
          { key: 'base', label: 'คำนวณคะแนน', type: 'select', options: [{ value: 'AFTER_DISCOUNT', label: 'หลังส่วนลด' }, { value: 'BEFORE_DISCOUNT', label: 'ก่อนส่วนลด' }] },
          { key: 'includeRoom', label: 'ค่าห้อง', type: 'switch', switchLabel: 'ให้คะแนน' },
          { key: 'includeProduct', label: 'สินค้า', type: 'switch', switchLabel: 'ให้คะแนน' },
          { key: 'includePackage', label: 'แพ็กเกจ', type: 'switch', switchLabel: 'ให้คะแนน' },
          { key: 'includeServiceCharge', label: 'Service Charge', type: 'switch', switchLabel: 'ให้คะแนน' },
          { key: 'includeVat', label: 'VAT', type: 'switch', switchLabel: 'ให้คะแนน' },
          { key: 'onlyFullPayment', label: 'เงื่อนไข', type: 'switch', switchLabel: 'ให้คะแนนหลังชำระเต็มจำนวนเท่านั้น' },
          { key: 'expiryMonths', label: 'คะแนนหมดอายุ (เดือน, 0 = ไม่หมดอายุ)', type: 'number' },
          { key: 'reverseOnRefund', label: 'คืนเงิน', type: 'switch', switchLabel: 'ย้อนคะแนนเมื่อคืนเงิน' },
        ]} />
        <div className="small muted">{t('Point Multiplier ตาม Tier ตั้งค่าได้ที่เมนู Rewards & Tier')}</div>
        <SaveBar onSave={p.save} busy={p.busy} />
      </div>
    </div>
  );
}

function BookingTab() {
  const { t } = useT();
  const s = useSection('booking');
  const c = s.v.cancellation || { tiers: [] };
  const setTier = (i, k, val) => s.set('cancellation', { ...c, tiers: c.tiers.map((x, j) => (j === i ? { ...x, [k]: Number(val) } : x)) });
  return (
    <div className="grid grid-2">
      <div className="card">
        <h3>{t('การจองออนไลน์')}</h3>
        <Grid v={s.v} set={s.set} fields={[
          { key: 'enabled', label: 'สถานะ', type: 'switch', switchLabel: 'เปิดรับจองออนไลน์' },
          { key: 'requireDeposit', label: 'มัดจำ', type: 'switch', switchLabel: 'ต้องชำระมัดจำ' },
          { key: 'holdMinutes', label: 'ล็อกห้องชั่วคราว (นาที)', type: 'number' },
          { key: 'minAdvanceMinutes', label: 'ต้องจองล่วงหน้าอย่างน้อย (นาที)', type: 'number' },
          { key: 'maxAdvanceDays', label: 'จองล่วงหน้าได้สูงสุด (วัน)', type: 'number' },
          { key: 'durations', label: 'ระยะเวลาให้เลือก (นาที) คั่นด้วย ,', type: 'custom', render: (f, set) => <Input value={(f.durations || []).join(', ')} onChange={(e) => set('durations', e.target.value.split(',').map((x) => Number(x.trim())).filter((x) => x > 0))} /> },
          { key: 'gracePeriodMinutes', label: 'Grace Period ไม่มาตามนัด (นาที)', type: 'number' },
          { key: 'autoNoShow', label: 'No-show', type: 'switch', switchLabel: 'ยกเลิกอัตโนมัติเมื่อเกิน Grace Period' },
          { key: 'noShowDepositAction', label: 'มัดจำเมื่อไม่มาตามนัด', type: 'select', options: [{ value: 'FORFEIT', label: 'ริบมัดจำ' }, { value: 'KEEP', label: 'เก็บไว้ (จัดการเอง)' }] },
          { key: 'reminderHours', label: 'แจ้งเตือนก่อนถึงเวลาจอง (ชั่วโมง)', type: 'number' },
          { key: 'arriveEarlyMinutes', label: 'แนะนำให้มาก่อน (นาที)', type: 'number' },
          { key: 'lineOaUrl', label: 'ลิงก์ LINE Official Account', full: true },
          { key: 'facebookUrl', label: 'Facebook', full: true },
          { key: 'mapUrl', label: 'Google Maps', full: true },
          { key: 'contactEmail', label: 'อีเมลติดต่อ', full: true },
        ]} />
        <SaveBar onSave={s.save} busy={s.busy} />
      </div>
      <div className="card">
        <h3>{t('Cancellation & Refund Policy')}</h3>
        <Switch checked={c.allowOnline} onChange={(x) => s.set('cancellation', { ...c, allowOnline: x })} label="อนุญาตให้ลูกค้ายกเลิกออนไลน์" />
        {c.tiers.map((x, i) => (
          <div key={i} className="row nowrap mt">
            {t('ยกเลิกก่อน')} <Input type="number" style={{ width: 90 }} value={x.hoursBefore} onChange={(e) => setTier(i, 'hoursBefore', e.target.value)} /> {t('ชั่วโมง คืน')}
            <Input type="number" style={{ width: 90 }} value={x.percent} onChange={(e) => setTier(i, 'percent', e.target.value)} />%
            <Button size="sm" variant="ghost" icon={Trash2} onClick={() => s.set('cancellation', { ...c, tiers: c.tiers.filter((_, j) => j !== i) })} />
          </div>
        ))}
        <Button size="sm" className="mt" icon={Plus} onClick={() => s.set('cancellation', { ...c, tiers: [...c.tiers, { hoursBefore: 1, percent: 0 }] })}>{t('เพิ่มเงื่อนไข')}</Button>
        <div className="row nowrap mt">{t('น้อยกว่านั้น คืน')} <Input type="number" style={{ width: 90 }} value={c.defaultPercent} onChange={(e) => s.set('cancellation', { ...c, defaultPercent: Number(e.target.value) })} />%</div>
        <Field label="รูปแบบการคืน" style={{ marginTop: 10 }}><Select value={c.refundType} onChange={(e) => s.set('cancellation', { ...c, refundType: e.target.value })} options={[{ value: 'ORIGINAL', label: 'คืนเงินตามช่องทางเดิม' }, { value: 'STORE_CREDIT', label: 'Store Credit' }]} /></Field>
        <SaveBar onSave={s.save} busy={s.busy} />
      </div>
    </div>
  );
}

function LineTab() {
  const { t } = useT();
  const { settings } = useAuth();
  const s = useSection('line');
  return (
    <div className="card">
      <div className="row mb"><Badge color={settings.runtime.lineLoginEnabled ? '#16a34a' : '#6b7280'}>LINE Login: {settings.runtime.lineLoginEnabled ? 'Connected' : 'Not configured'}</Badge><span className="xs muted">{t('Channel ID/Secret และ Messaging Access Token ตั้งค่าใน Environment Variables ฝั่งเซิร์ฟเวอร์เท่านั้น')}</span></div>
      <Grid v={s.v} set={s.set} fields={[
        { key: 'messagingEnabled', label: 'LINE Messaging API', type: 'switch', switchLabel: 'ส่งข้อความแจ้งเตือนผ่าน LINE OA' },
        ...[['notifyBookingConfirmed', 'ยืนยันการจอง'], ['notifyDeposit', 'แจ้งรับเงินมัดจำ'], ['notifyReminder', 'แจ้งเตือนก่อนถึงเวลาจอง'], ['notifyRoomChange', 'แจ้งเปลี่ยนห้อง'], ['notifyCancel', 'แจ้งยกเลิก'], ['notifyRefund', 'แจ้งคืนเงินมัดจำ'], ['notifyPoints', 'แจ้งคะแนนที่ได้รับ'], ['notifyRewards', 'แจ้ง Reward'], ['notifyPromotions', 'แจ้งโปรโมชั่น']].map(([key, label]) => ({ key, label, type: 'switch', switchLabel: 'ส่ง' })),
      ]} />
      <SaveBar onSave={s.save} busy={s.busy} />
    </div>
  );
}

function BackupTab() {
  const { t } = useT();
  const toast = useToast();
  const s = useSection('backup');
  const { data, reload } = useLive(() => api.get('/backups'), [], []);
  return (
    <div className="card">
      <Grid v={s.v} set={s.set} fields={[
        { key: 'enabled', label: 'สำรองข้อมูลอัตโนมัติ', type: 'switch', switchLabel: 'เปิด' },
        { key: 'hour', label: 'เวลาสำรองข้อมูล (ชั่วโมง 0-23)', type: 'number' },
        { key: 'keep', label: 'เก็บไฟล์ย้อนหลัง (ไฟล์)', type: 'number' },
      ]} />
      <SaveBar onSave={s.save} busy={s.busy} />
      <Button icon={Database} onClick={async () => { try { await api.post('/backups'); toast.success('สำรองข้อมูลเรียบร้อย'); reload(); } catch (e) { toast.error(e); } }}>{t('สำรองข้อมูลตอนนี้')}</Button>
      <div className="col mt">{(data || []).map((b) => <div key={b.id} className="row between card flat small" style={{ padding: 8 }}><span>{b.file_name}</span><span><Badge color={b.status === 'SUCCESS' ? '#16a34a' : '#dc2626'}>{b.status}</Badge> {b.size_bytes ? `${(b.size_bytes / 1024).toFixed(0)} KB` : ''} · {fmtDateTime(b.created_at)}</span></div>)}</div>
    </div>
  );
}

export default function Settings() {
  const { t } = useT();
  const { settings } = useAuth();
  const [tab, setTab] = useState('store');
  if (!settings) return <Loading />;
  return (
    <div>
      <PageHead icon={Cog} title="ตั้งค่าร้าน" />
      <Tabs value={tab} onChange={setTab} tabs={[
        { value: 'store', label: 'ข้อมูลร้าน' },
        { value: 'appearance', label: 'ภาษา ฟอนต์ และธีม' },
        { value: 'tax', label: 'VAT & Service Charge' },
        { value: 'receipt', label: 'ใบเสร็จ & เลขคิว' },
        { value: 'payment', label: 'การชำระเงิน & QR Code' },
        { value: 'room', label: 'ห้อง เวลา & แจ้งเตือน' },
        { value: 'points', label: 'มัดจำ คะแนน & ความปลอดภัย' },
        { value: 'booking', label: 'การจองออนไลน์' },
        { value: 'line', label: 'LINE' },
        { value: 'backup', label: 'สำรองข้อมูล' },
      ]} />
      {tab === 'store' && <StoreTab />}
      {tab === 'appearance' && <AppearanceTab />}
      {tab === 'tax' && <TaxTab />}
      {tab === 'receipt' && <ReceiptQueueTab />}
      {tab === 'payment' && <PaymentTab />}
      {tab === 'room' && <RoomTab />}
      {tab === 'points' && <PointsDepositTab />}
      {tab === 'booking' && <BookingTab />}
      {tab === 'line' && <LineTab />}
      {tab === 'backup' && <BackupTab />}
    </div>
  );
}

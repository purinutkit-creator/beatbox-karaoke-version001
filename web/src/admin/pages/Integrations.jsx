// Admin → ตั้งค่าร้าน → การเชื่อมต่อ: LINE, SMS, slip verification, payment terminal (EDC / Beam Bolt).
// Secrets are write-only: the server only tells whether a key is set (and its last 4 characters).
import { useEffect, useState } from 'react';
import { Save, PlugZap, KeyRound, Trash2, Upload, MessageCircle, MessageSquare, ShieldCheck, CreditCard, CheckCircle2, XCircle, Plus, Copy } from 'lucide-react';
import { Button, Field, Input, Select, Switch, Textarea, Badge, Seg, Loading, useToast } from '../../components/ui.jsx';
import { useT } from '../../lib/i18n.jsx';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/store.jsx';

function Secret({ label, value, onChange, hint }) {
  const { t } = useT();
  const set = value && typeof value === 'object' ? value : null;
  const typed = typeof value === 'string' ? value : '';
  return (
    <Field label={label} hint={hint}>
      <div className="row nowrap">
        <Input type="password" autoComplete="new-password" value={typed} placeholder={set?.set ? `${t('ตั้งค่าแล้ว')} •••• ${set.last4} — ${t('กรอกเพื่อเปลี่ยน')}` : t('ยังไม่ได้ตั้งค่า')} onChange={(e) => onChange(e.target.value)} />
        {set?.set && <Button variant="ghost" icon={Trash2} title={t('ลบค่า')} onClick={() => onChange(null)} />}
      </div>
      {value === null && <div className="xs" style={{ color: 'var(--danger)' }}>{t('จะลบค่านี้เมื่อกดบันทึก')}</div>}
    </Field>
  );
}

function Results({ out }) {
  if (!out) return null;
  return (
    <div className="col mt">
      {out.results.map((r, i) => (
        <div key={i} className="card flat small" style={{ padding: 10, borderColor: r.ok ? 'var(--ok)' : 'var(--danger)' }}>
          {r.ok ? <CheckCircle2 size={14} color="var(--ok)" /> : <XCircle size={14} color="var(--danger)" />} {r.message}
        </div>
      ))}
    </div>
  );
}

function useIntegration(section, all, setAll) {
  const toast = useToast();
  const { loadSettings } = useAuth();
  const [v, setV] = useState(all[section]);
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState(null);
  useEffect(() => setV(all[section]), [all, section]);
  const set = (k, x) => setV((s) => ({ ...s, [k]: x }));
  const save = async () => {
    setBusy(true);
    try {
      // secrets: only send typed strings (replace) or null (clear); masked objects are not sent
      const body = Object.fromEntries(Object.entries(v).filter(([, x]) => !(x && typeof x === 'object' && 'set' in x)));
      setAll(await api.put(`/integrations/${section}`, body));
      loadSettings?.();
      toast.success('บันทึกการตั้งค่าเรียบร้อย');
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const runTest = async (body = {}) => {
    setTest({ results: [{ ok: true, message: '...' }] });
    try {
      setTest(await api.post(`/integrations/${section}/test`, body));
    } catch (e) {
      setTest({ results: [{ ok: false, message: e.message }] });
    }
  };
  return { v, set, save, busy, test, runTest };
}

function Bar({ s, children }) {
  const { t } = useT();
  return (
    <div className="row end mt">
      {children}
      <Button variant="primary" icon={Save} loading={s.busy} onClick={s.save}>{t('บันทึก')}</Button>
    </div>
  );
}

function CopyLine({ label, value }) {
  const { t } = useT();
  const toast = useToast();
  return (
    <div className="row nowrap small">
      <span className="muted nowrap">{t(label)}</span>
      <code className="ellipsis grow" style={{ background: 'var(--surface-2)', padding: '4px 8px', borderRadius: 6 }}>{value}</code>
      <Button size="sm" variant="ghost" icon={Copy} onClick={() => navigator.clipboard?.writeText(value).then(() => toast.success('คัดลอกแล้ว'))} />
    </div>
  );
}

function LineCard({ all, setAll }) {
  const { t } = useT();
  const s = useIntegration('line', all, setAll);
  const [uid, setUid] = useState('');
  const v = s.v;
  return (
    <div className="card">
      <h3 className="row nowrap"><MessageCircle size={20} color="#06c755" /> LINE Login & LINE Official Account</h3>
      <p className="small muted">{t('สร้าง Channel ที่ LINE Developers Console: LINE Login (ให้ลูกค้าเข้าสู่ระบบ) และ Messaging API (ส่งข้อความแจ้งเตือนผ่าน LINE OA)')}</p>
      <CopyLine label="Callback URL (ใส่ใน LINE Login Channel)" value={all.meta.lineCallbackUrl} />
      <div className="grid grid-2 mt">
        <Field label="LINE Login"><Switch checked={v.loginEnabled !== false} onChange={(x) => s.set('loginEnabled', x)} label={t('เปิดให้ลูกค้าเข้าสู่ระบบด้วย LINE')} /></Field>
        <Field label="LINE Login Channel ID"><Input value={v.loginChannelId || ''} onChange={(e) => s.set('loginChannelId', e.target.value)} placeholder="1650000000" /></Field>
        <Secret label="LINE Login Channel Secret" value={v.loginChannelSecret} onChange={(x) => s.set('loginChannelSecret', x)} />
        <Field label="Callback URL (เว้นว่าง = ค่าเริ่มต้น)"><Input value={v.callbackUrl === all.meta.lineCallbackUrl ? '' : v.callbackUrl || ''} onChange={(e) => s.set('callbackUrl', e.target.value)} placeholder={all.meta.lineCallbackUrl} /></Field>
        <Secret label="Messaging API Channel Access Token (long-lived)" value={v.messagingAccessToken} onChange={(x) => s.set('messagingAccessToken', x)} />
        <Field label="LINE OA Basic ID"><Input value={v.oaBasicId || ''} onChange={(e) => s.set('oaBasicId', e.target.value)} placeholder="@beatbox" /></Field>
      </div>
      <div className="small muted mt">{t('เลือกประเภทข้อความที่จะส่งได้ที่แท็บ "LINE"')}</div>
      <Results out={s.test} />
      <Bar s={s}>
        <Input style={{ maxWidth: 220 }} placeholder={t('LINE User ID สำหรับส่งข้อความทดสอบ')} value={uid} onChange={(e) => setUid(e.target.value)} />
        <Button icon={PlugZap} onClick={() => s.runTest(uid ? { lineUserId: uid } : {})}>{t('ทดสอบการเชื่อมต่อ')}</Button>
      </Bar>
    </div>
  );
}

const SMS_PROVIDERS = [
  { value: 'thsms', label: 'THSMS (thsms.com)' },
  { value: 'thaibulksms', label: 'ThaiBulkSMS' },
  { value: 'smsmkt', label: 'SMSMKT' },
  { value: 'twilio', label: 'Twilio' },
  { value: 'webhook', label: 'ผู้ให้บริการอื่น (Webhook)' },
];

function SmsCard({ all, setAll }) {
  const { t } = useT();
  const s = useIntegration('sms', all, setAll);
  const [phone, setPhone] = useState('');
  const v = s.v;
  const p = v.provider;
  return (
    <div className="card">
      <h3 className="row nowrap"><MessageSquare size={20} /> SMS</h3>
      <div className="grid grid-2">
        <Field label="การส่ง SMS"><Switch checked={!!v.enabled} onChange={(x) => s.set('enabled', x)} label={t('เปิดใช้งาน SMS')} /></Field>
        <Field label="ผู้ให้บริการ SMS"><Select value={p} onChange={(e) => s.set('provider', e.target.value)} options={SMS_PROVIDERS} /></Field>
        {p === 'twilio' && <Field label="Account SID"><Input value={v.accountSid || ''} onChange={(e) => s.set('accountSid', e.target.value)} /></Field>}
        {p === 'webhook' && <Field label="Webhook URL (POST JSON { to, msisdn, message, sender })"><Input value={v.webhookUrl || ''} onChange={(e) => s.set('webhookUrl', e.target.value)} placeholder="https://..." /></Field>}
        <Secret label={p === 'twilio' ? 'Auth Token' : p === 'webhook' ? 'Bearer Token (ถ้ามี)' : 'API Key'} value={v.apiKey} onChange={(x) => s.set('apiKey', x)} />
        {['thaibulksms', 'smsmkt'].includes(p) && <Secret label="API Secret" value={v.apiSecret} onChange={(x) => s.set('apiSecret', x)} />}
        <Field label="ชื่อผู้ส่ง (Sender name)" hint={t('ต้องลงทะเบียนชื่อผู้ส่งกับผู้ให้บริการก่อน')}><Input value={v.sender || ''} onChange={(e) => s.set('sender', e.target.value)} /></Field>
        <Field label="แสดง OTP บนหน้าจอ (โหมดทดสอบ)"><Switch checked={!!v.otpDebug} onChange={(x) => s.set('otpDebug', x)} label={t('แสดงรหัส OTP บนหน้าเว็บ (ปิดเมื่อใช้งานจริง)')} /></Field>
      </div>
      <h4 className="mt">{t('ข้อความ SMS')}</h4>
      <div className="xs muted">{t('ตัวแปร')}: {'{store} {code} {minutes} {booking} {room} {date} {time} {guests}'}</div>
      <div className="grid grid-2 mt">
        <Field label="ข้อความ OTP"><Textarea value={v.otpTemplate || ''} onChange={(e) => s.set('otpTemplate', e.target.value)} /></Field>
        <div className="col">
          <Switch checked={!!v.sendBookingConfirm} onChange={(x) => s.set('sendBookingConfirm', x)} label={t('ส่ง SMS ยืนยันการจอง')} />
          <Textarea value={v.bookingConfirmTemplate || ''} onChange={(e) => s.set('bookingConfirmTemplate', e.target.value)} />
        </div>
        <div className="col">
          <Switch checked={!!v.sendReminder} onChange={(x) => s.set('sendReminder', x)} label={t('ส่ง SMS แจ้งเตือนก่อนถึงเวลาจอง')} />
          <Textarea value={v.reminderTemplate || ''} onChange={(e) => s.set('reminderTemplate', e.target.value)} />
        </div>
      </div>
      <Results out={s.test} />
      <Bar s={s}>
        <Input style={{ maxWidth: 180 }} placeholder={t('เบอร์โทรทดสอบ')} value={phone} onChange={(e) => setPhone(e.target.value)} />
        <Button icon={PlugZap} disabled={phone.length < 9} onClick={() => s.runTest({ phone })}>{t('ส่ง SMS ทดสอบ')}</Button>
      </Bar>
    </div>
  );
}

const SLIP_PROVIDERS = [
  { value: 'manual', label: 'พนักงานตรวจสอบเอง (ไม่ใช้บริการภายนอก)' },
  { value: 'slipok', label: 'SlipOK (slipok.com)' },
  { value: 'easyslip', label: 'EasySlip (easyslip.com)' },
  { value: 'rdcw', label: 'RDCW Slip Verify (slip.rdcw.co.th)' },
  { value: 'scb', label: 'SCB Open API — ธนาคารไทยพาณิชย์ (ตรวจสลิปได้ทุกธนาคาร)' },
  { value: 'webhook', label: 'บริการอื่น (Webhook)' },
];

function SlipTestImage() {
  const { t } = useT();
  const toast = useToast();
  const [file, setFile] = useState(null);
  const [amount, setAmount] = useState('');
  const [out, setOut] = useState(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('slip', file);
      if (amount) fd.append('amount', amount);
      setOut(await api.post('/integrations/slip/test-image', fd));
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card flat mt">
      <b>{t('ทดลองตรวจสลิปจริง')}</b>
      <div className="xs muted">{t('อัปโหลดสลิปจากแอปธนาคารเพื่อดูว่าระบบอ่านข้อมูลอะไรได้ (ไม่บันทึกลงระบบ)')}</div>
      <div className="row mt">
        <input type="file" accept="image/png,image/jpeg" onChange={(e) => setFile(e.target.files[0])} />
        <Input type="number" style={{ width: 140 }} placeholder={t('ยอดที่คาดว่า (บาท)')} value={amount} onChange={(e) => setAmount(e.target.value)} />
        <Button icon={Upload} disabled={!file} loading={busy} onClick={run}>{t('ตรวจสอบ')}</Button>
      </div>
      {out && (
        <div className="small mt col" style={{ gap: 4 }}>
          <div>{out.ok ? <Badge color="#16a34a">{t('ผ่าน')}</Badge> : <Badge color="#dc2626">{t('ไม่ผ่าน')}</Badge>} {out.mode} · {out.provider} {out.reason && `· ${t(out.reason)}`}</div>
          <div>{t('QR บนสลิป')}: {out.qr ? `${out.qr.transRef} · ${out.qr.sendingBankName || out.qr.sendingBank || ''}` : t('อ่านไม่ได้ / ไม่พบ')}</div>
          {out.amount != null && <div>{t('ยอดเงิน')}: {out.amount} · {out.paidAt ? new Date(out.paidAt).toLocaleString() : ''}</div>}
          {out.receiver && <div>{t('ผู้รับ')}: {out.receiver.name || ''} {out.receiver.account || ''} {out.receiver.proxy || ''}</div>}
          {out.sender && <div>{t('ผู้โอน')}: {out.sender.name || ''} {out.sender.bank || ''}</div>}
        </div>
      )}
    </div>
  );
}

function SlipCard({ all, setAll }) {
  const { t } = useT();
  const s = useIntegration('slip', all, setAll);
  const v = s.v;
  const p = v.provider;
  const prod = v.mode === 'PRODUCTION';
  return (
    <div className="card">
      <h3 className="row nowrap"><ShieldCheck size={20} /> {t('ระบบตรวจสอบสลิป')}</h3>
      <div className="small muted">
        {t('ระบบอ่าน QR Code ของธนาคารบนสลิปทุกใบ (เลขอ้างอิงรายการ + ธนาคารผู้โอน) เพื่อกันสลิปซ้ำ แล้วส่งไปตรวจกับธนาคาร/ผู้ให้บริการว่ามีการโอนจริง จากนั้นตรวจยอดเงิน บัญชีผู้รับ และวันเวลาให้ตรงกับรายการ')}
      </div>
      <Field label="โหมดการชำระเงิน" style={{ marginTop: 10 }}>
        <Seg value={v.mode} onChange={(x) => s.set('mode', x)} options={[{ value: 'DEMO', label: 'Demo (จำลอง ไม่ตรวจเงินจริง)' }, { value: 'PRODUCTION', label: 'ใช้งานจริง (ตรวจสลิปจริง)' }]} />
      </Field>
      {!prod && <div className="small" style={{ color: 'var(--warn)' }}>{t('Demo Mode: สลิปทุกใบผ่าน ใช้สำหรับทดสอบระบบเท่านั้น')}</div>}
      <div className="grid grid-2 mt">
        <Field label="ผู้ให้บริการตรวจสลิป"><Select value={p} onChange={(e) => s.set('provider', e.target.value)} options={SLIP_PROVIDERS} /></Field>
        {p === 'slipok' && <Field label="Branch ID (SlipOK)"><Input value={v.branchId || ''} onChange={(e) => s.set('branchId', e.target.value)} /></Field>}
        {p === 'scb' && <Field label="สภาพแวดล้อม SCB"><Switch checked={v.scbSandbox !== false} onChange={(x) => s.set('scbSandbox', x)} label="Sandbox (ทดสอบ)" /></Field>}
        {p !== 'manual' && <Secret label={p === 'rdcw' ? 'Client ID' : p === 'scb' ? 'API Key (Application Key)' : p === 'webhook' ? 'Bearer Token (ถ้ามี)' : 'API Key'} value={v.apiKey} onChange={(x) => s.set('apiKey', x)} />}
        {['rdcw', 'scb'].includes(p) && <Secret label={p === 'rdcw' ? 'Client Secret' : 'API Secret (Application Secret)'} value={v.apiSecret} onChange={(x) => s.set('apiSecret', x)} />}
        {p !== 'manual' && <Field label={p === 'webhook' ? 'Webhook URL' : 'API URL (เว้นว่าง = ค่าเริ่มต้นของผู้ให้บริการ)'}><Input value={v.apiUrl || ''} onChange={(e) => s.set('apiUrl', e.target.value)} placeholder="https://..." /></Field>}
      </div>
      <h4 className="mt">{t('กฎการตรวจสอบ')}</h4>
      <div className="grid grid-2">
        <Switch checked={v.requireSlipQr !== false} onChange={(x) => s.set('requireSlipQr', x)} label={t('ต้องมี QR Code ของธนาคารบนสลิป (กันรูปแต่ง/ครอป)')} />
        <Switch checked={v.checkReceiver !== false} onChange={(x) => s.set('checkReceiver', x)} label={t('ตรวจบัญชีผู้รับเงินให้ตรงกับบัญชีร้าน')} />
        <Field label="บัญชี/PromptPay อื่นที่รับเงินได้ (คั่นด้วย ,)" hint={t('บัญชีหลักและ PromptPay ID ในแท็บการชำระเงินถูกตรวจอัตโนมัติ')}><Input value={v.receiverAccounts || ''} onChange={(e) => s.set('receiverAccounts', e.target.value)} /></Field>
        <Field label="ไม่รับสลิปที่เก่ากว่า (นาที, 0 = ไม่จำกัด)"><Input type="number" value={v.maxSlipAgeMinutes ?? 1440} onChange={(e) => s.set('maxSlipAgeMinutes', Number(e.target.value))} /></Field>
      </div>
      <SlipTestImage />
      <Results out={s.test} />
      <Bar s={s}><Button icon={PlugZap} onClick={() => s.runTest()}>{t('ทดสอบการเชื่อมต่อ')}</Button></Bar>
    </div>
  );
}

function TerminalCard({ all, setAll }) {
  const { t } = useT();
  const s = useIntegration('terminal', all, setAll);
  const v = s.v;
  const p = v.provider;
  return (
    <div className="card">
      <h3 className="row nowrap"><CreditCard size={20} /> {t('เครื่องรับชำระเงิน (EDC / Beam Bolt)')}</h3>
      <p className="small muted">{t('เมื่อตั้งค่าแล้ว ตอนชำระเงินด้วย QR หรือบัตร ระบบจะส่งยอดไปแสดงที่เครื่องรับชำระเงิน ถ้าไม่ได้ตั้งค่า QR จะแสดงบนจอลูกค้าตามปกติ')}</p>
      <div className="grid grid-2">
        <Field label="เครื่องรับชำระเงิน">
          <Select value={p} onChange={(e) => s.set('provider', e.target.value)} options={[
            { value: 'none', label: 'ไม่ใช้ (แสดง QR บนจอลูกค้า)' },
            { value: 'beam', label: 'Beam Bolt+ (Beam Checkout API)' },
            { value: 'http', label: 'EDC ธนาคารผ่าน EDC Bridge (HTTP)' },
            { value: 'manual', label: 'EDC ทั่วไป — แคชเชียร์ยืนยันรหัสอนุมัติเอง' },
          ]} />
        </Field>
        {p !== 'none' && (
          <Field label="ใช้กับช่องทาง">
            <div className="row"><Switch checked={v.useForQr !== false} onChange={(x) => s.set('useForQr', x)} label="QR PromptPay" /><Switch checked={v.useForCard !== false} onChange={(x) => s.set('useForCard', x)} label={t('บัตร')} /></div>
          </Field>
        )}
        {p === 'beam' && (
          <>
            <Field label="Merchant ID"><Input value={v.beamMerchantId || ''} onChange={(e) => s.set('beamMerchantId', e.target.value)} /></Field>
            <Secret label="API Key" value={v.beamApiKey} onChange={(x) => s.set('beamApiKey', x)} />
            <Field label="API Base URL"><Input value={v.beamBaseUrl || ''} onChange={(e) => s.set('beamBaseUrl', e.target.value)} /></Field>
            <Field label="หน่วยของยอดเงินที่ส่ง"><Select value={v.beamAmountUnit} onChange={(e) => s.set('beamAmountUnit', e.target.value)} options={[{ value: 'SATANG', label: 'สตางค์ (100 = 1 บาท)' }, { value: 'BAHT', label: 'บาท' }]} /></Field>
            <Field label="Payment method (QR)"><Input value={v.beamQrMethod || ''} onChange={(e) => s.set('beamQrMethod', e.target.value)} /></Field>
            <Field label="Payment method (บัตร)"><Input value={v.beamCardMethod || ''} onChange={(e) => s.set('beamCardMethod', e.target.value)} /></Field>
            <div style={{ gridColumn: '1/-1' }}><CopyLine label="Webhook URL (ตั้งค่าใน Beam Dashboard)" value={all.meta.beamWebhookUrl} /></div>
            <div className="xs muted" style={{ gridColumn: '1/-1' }}>{t('ตรวจสอบชื่อ payment method และหน่วยยอดเงินกับเอกสาร Beam ของร้าน แล้วทดลองชำระจริง 1 บาทก่อนเปิดใช้งาน')}</div>
          </>
        )}
        {p === 'http' && (
          <>
            <Field label="EDC Bridge URL" hint="POST /sale · GET /sale/{id} · POST /sale/{id}/cancel · GET /status"><Input value={v.httpUrl || ''} onChange={(e) => s.set('httpUrl', e.target.value)} placeholder="http://192.168.1.50:8080" /></Field>
            <Secret label="Bearer Token" value={v.httpToken} onChange={(x) => s.set('httpToken', x)} />
          </>
        )}
        {p !== 'none' && <Field label="หมดเวลารอการชำระ (วินาที)"><Input type="number" value={v.timeoutSeconds ?? 180} onChange={(e) => s.set('timeoutSeconds', Number(e.target.value))} /></Field>}
      </div>
      <Results out={s.test} />
      <Bar s={s}><Button icon={PlugZap} onClick={() => s.runTest()}>{t('ทดสอบการเชื่อมต่อ')}</Button></Bar>
    </div>
  );
}

export function IntegrationsTab() {
  const { t } = useT();
  const toast = useToast();
  const [all, setAll] = useState(null);
  useEffect(() => {
    api.get('/integrations').then(setAll).catch((e) => toast.error(e));
  }, []);
  if (!all) return <Loading />;
  return (
    <div className="col">
      <SlipCard all={all} setAll={setAll} />
      <TerminalCard all={all} setAll={setAll} />
      <LineCard all={all} setAll={setAll} />
      <SmsCard all={all} setAll={setAll} />
      <div className="xs muted"><KeyRound size={12} /> {t('API Key / Secret ถูกเข้ารหัสก่อนบันทึก และจะไม่ถูกส่งกลับมาแสดงที่หน้าเว็บ')}</div>
    </div>
  );
}

/** Room ticket + in-room QR ordering + problem buttons. */
export function RoomServiceTab({ useSection, SaveBar }) {
  const { t } = useT();
  const rs = useSection('roomService');
  const tk = useSection('roomTicket');
  const [newIssue, setNewIssue] = useState('');
  const opts = rs.v.issueOptions || [];
  return (
    <div className="col">
      <div className="card">
        <h3>{t('ใบเปิดห้อง')}</h3>
        <div className="grid grid-2">
          <Switch checked={tk.v.printOnOpen !== false} onChange={(x) => tk.set('printOnOpen', x)} label={t('พิมพ์ใบเปิดห้องอัตโนมัติเมื่อเปิดห้อง')} />
          <Switch checked={tk.v.storeCopy !== false} onChange={(x) => tk.set('storeCopy', x)} label={t('ใบสำหรับร้าน (ห้อง เวลาเริ่ม เวลาหมด จำนวนชั่วโมง)')} />
          <Switch checked={tk.v.customerCopy !== false} onChange={(x) => tk.set('customerCopy', x)} label={t('ใบสำหรับลูกค้า (พร้อม QR สั่งอาหาร)')} />
          <Field label="ข้อความบนใบลูกค้า"><Input value={tk.v.customerNote || ''} onChange={(e) => tk.set('customerNote', e.target.value)} /></Field>
        </div>
        <SaveBar onSave={tk.save} busy={tk.busy} />
      </div>
      <div className="card">
        <h3>{t('สั่งอาหารผ่าน QR ในห้อง')}</h3>
        <div className="small muted">{t('QR บนใบลูกค้าใช้ได้เฉพาะรอบการใช้ห้องนั้น เมื่อปิดห้องแล้ว QR จะหมดอายุ')}</div>
        <div className="grid grid-2 mt">
          <Switch checked={rs.v.enabled !== false} onChange={(x) => rs.set('enabled', x)} label={t('เปิดให้ลูกค้าสั่งอาหารผ่าน QR')} />
          <Switch checked={rs.v.allowPayNow !== false} onChange={(x) => rs.set('allowPayNow', x)} label={t('ให้ลูกค้าชำระเงินทันที (QR PromptPay)')} />
          <Switch checked={rs.v.allowPayAtCounter !== false} onChange={(x) => rs.set('allowPayAtCounter', x)} label={t('ให้ลูกค้าชำระทีเดียวที่เคาน์เตอร์')} />
          <Switch checked={rs.v.requireSlip !== false} onChange={(x) => rs.set('requireSlip', x)} label={t('ต้องแนบสลิปเมื่อชำระทันที')} />
          <Field label="ถ้าแคชเชียร์ไม่ตรวจสลิปภายใน (วินาที) ให้แจ้งลูกค้าว่าชำระสำเร็จ" hint={t('แคชเชียร์ยังต้องตรวจสอบสลิป ยอดจะหักจากบิลเมื่อตรวจผ่านแล้วเท่านั้น')}>
            <Input type="number" value={rs.v.autoAcceptSeconds ?? 60} onChange={(e) => rs.set('autoAcceptSeconds', Number(e.target.value))} />
          </Field>
          <Field label="เสียงแจ้งเตือนเมื่อลูกค้าแจ้งปัญหา (URL) — เว้นว่าง = เสียงมาตรฐาน"><Input value={rs.v.issueSoundUrl || ''} onChange={(e) => rs.set('issueSoundUrl', e.target.value)} /></Field>
        </div>
        <h4 className="mt">{t('ปุ่มแจ้งปัญหาหลัก')}</h4>
        <div className="xs muted">{t('ลูกค้าจะเห็นปุ่มเหล่านี้ และมีปุ่ม "อื่นๆ" ให้พิมพ์อธิบายปัญหาเองเสมอ')}</div>
        <div className="col mt" style={{ gap: 6 }}>
          {opts.map((o, i) => (
            <div key={i} className="row nowrap">
              <Input value={o} onChange={(e) => rs.set('issueOptions', opts.map((x, j) => (j === i ? e.target.value : x)))} />
              <Button variant="ghost" icon={Trash2} onClick={() => rs.set('issueOptions', opts.filter((_, j) => j !== i))} />
            </div>
          ))}
          <div className="row nowrap">
            <Input value={newIssue} placeholder={t('เพิ่มปุ่มปัญหา เช่น รีโมทไม่ทำงาน')} onChange={(e) => setNewIssue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && newIssue.trim()) { rs.set('issueOptions', [...opts, newIssue.trim()]); setNewIssue(''); } }} />
            <Button icon={Plus} disabled={!newIssue.trim()} onClick={() => { rs.set('issueOptions', [...opts, newIssue.trim()]); setNewIssue(''); }}>{t('เพิ่ม')}</Button>
          </div>
        </div>
        <SaveBar onSave={rs.save} busy={rs.busy} />
      </div>
    </div>
  );
}

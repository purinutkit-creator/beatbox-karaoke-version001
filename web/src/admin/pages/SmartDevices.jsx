// Admin → อุปกรณ์อัจฉริยะ (Tuya): connection, named systems (trigger + command), the device of each room, and the log.
import { useEffect, useMemo, useState } from 'react';
import { Cpu, PlugZap, Plus, Pencil, Trash2, Power, PowerOff, Zap, CheckCircle2, XCircle, RefreshCw, Search, KeyRound, ListTree } from 'lucide-react';
import { PageHead, Button, Field, Input, Select, Switch, Badge, Modal, Loading, Empty, useToast, useDialog } from '../../components/ui.jsx';
import { useT } from '../../lib/i18n.jsx';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/store.jsx';
import { useLive } from '../../lib/socket.js';
import { fmtDateTime } from '@beatbox/shared/format.js';
import { Secret, Results, useIntegration, Bar } from './Integrations.jsx';

export const TRIGGERS = [
  { value: 'MANUAL', label: 'กดสั่งเองเท่านั้น (ปุ่ม)' },
  { value: 'ON_START', label: 'เมื่อเริ่มเวลาห้อง (และเมื่อเพิ่มเวลาหลังหมดเวลา)' },
  { value: 'BEFORE_END', label: 'เมื่อเวลาเหลือ … นาที' },
  { value: 'AT_END', label: 'เมื่อหมดเวลา (ตัดอัตโนมัติ)' },
  { value: 'ON_CLOSE', label: 'เมื่อปิดห้อง / ยกเลิกห้อง' },
];
export const triggerLabel = (s, t) => (s.trigger === 'BEFORE_END' ? `${t('เมื่อเวลาเหลือ')} ${s.minutes} ${t('นาที')}` : t(TRIGGERS.find((x) => x.value === s.trigger)?.label || s.trigger));
const cmdText = (c, t) => (c.value === true ? t('เปิด') : c.value === false ? t('ปิด') : String(c.value));

/** Tuya Cloud project credentials (Access Secret is write-only). */
function TuyaCard({ all, setAll }) {
  const { t } = useT();
  const s = useIntegration('tuya', all, setAll);
  const v = s.v;
  const regions = all.meta?.tuyaRegions || [];
  return (
    <div className="card">
      <h3 className="row nowrap"><PlugZap size={20} /> {t('เชื่อมต่อ Tuya Cloud')}</h3>
      <Switch checked={!!v.enabled} onChange={(x) => s.set('enabled', x)} label={t('เปิดใช้งานระบบอุปกรณ์อัจฉริยะ (ปุ่มสั่งงาน + ทำงานอัตโนมัติตามเวลาห้อง)')} />
      <div className="grid grid-2 mt">
        <Field label="Data Center (ตรงกับโปรเจกต์ใน Tuya Developer)">
          <Select value={v.endpoint} onChange={(e) => s.set('endpoint', e.target.value)} options={regions.length ? regions : [{ value: v.endpoint, label: v.endpoint }]} />
        </Field>
        <Field label="Access ID / Client ID"><Input value={v.accessId || ''} onChange={(e) => s.set('accessId', e.target.value)} /></Field>
        <Secret label="Access Secret / Client Secret" value={v.accessSecret} onChange={(x) => s.set('accessSecret', x)} />
      </div>
      <details className="small muted mt">
        <summary>{t('วิธีหา Access ID / Secret')}</summary>
        <ol>
          <li>{t('สมัคร iot.tuya.com → Cloud → Development → Create Cloud Project (เลือก Data Center เดียวกับบัญชีแอป Smart Life / Tuya)')}</li>
          <li>{t('เปิดบริการ API: IoT Core และ Authorization')}</li>
          <li>{t('แท็บ Devices → Link App Account → สแกน QR ด้วยแอป Smart Life / Tuya เพื่อดึงอุปกรณ์ของร้านเข้าโปรเจกต์')}</li>
          <li>{t('คัดลอก Access ID และ Access Secret จากหน้า Overview มาใส่ที่นี่ แล้วกด "ทดสอบการเชื่อมต่อ"')}</li>
        </ol>
      </details>
      <Results out={s.test} />
      {s.test?.results?.[0]?.suggestEndpoint && (
        <Button className="mt" onClick={() => s.set('endpoint', s.test.results[0].suggestEndpoint)}>{t('ใช้ Data Center นี้')}</Button>
      )}
      <Bar s={s}>
        {/* tests what is typed now (no need to save first) */}
        <Button icon={PlugZap} onClick={() => s.runTest({ endpoint: v.endpoint, accessId: v.accessId, accessSecret: typeof v.accessSecret === 'string' ? v.accessSecret.trim() : undefined })}>{t('ทดสอบการเชื่อมต่อ')}</Button>
      </Bar>
    </div>
  );
}

const EMPTY = { name: '', trigger: 'MANUAL', minutes: 5, code: 'switch_1', action: 'ON', customValue: '', extra: [], showButton: true, isActive: true, sortOrder: 0 };

function toForm(s) {
  const [first, ...extra] = s.commands || [];
  const action = first?.value === true ? 'ON' : first?.value === false ? 'OFF' : 'CUSTOM';
  return { id: s.id, name: s.name, trigger: s.trigger, minutes: s.minutes, code: first?.code || 'switch_1', action, customValue: action === 'CUSTOM' ? String(first?.value ?? '') : '', extra, showButton: s.show_button, isActive: s.is_active, sortOrder: s.sort_order };
}
function parseValue(x) {
  const v = String(x).trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v !== '' && !Number.isNaN(Number(v))) return Number(v);
  return v;
}
function toBody(f) {
  const value = f.action === 'ON' ? true : f.action === 'OFF' ? false : parseValue(f.customValue);
  return { name: f.name, trigger: f.trigger, minutes: Number(f.minutes) || 5, commands: [{ code: f.code.trim() || 'switch_1', value }, ...f.extra], showButton: f.showButton, isActive: f.isActive, sortOrder: Number(f.sortOrder) || 0 };
}

function SystemModal({ initial, onClose, onSaved }) {
  const { t } = useT();
  const toast = useToast();
  const [f, setF] = useState(initial ? toForm(initial) : EMPTY);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => {
    if (!f.name.trim()) return toast.error('กรุณาตั้งชื่อระบบ');
    setBusy(true);
    try {
      if (f.id) await api.put(`/smart/systems/${f.id}`, toBody(f));
      else await api.post('/smart/systems', toBody(f));
      toast.success('บันทึกเรียบร้อย');
      onSaved();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={f.id ? t('แก้ไขระบบ') : t('เพิ่มระบบ')} onClose={onClose} footer={<Button variant="primary" loading={busy} onClick={save}>{t('บันทึก')}</Button>}>
      <div className="grid grid-2">
        <Field label="ชื่อระบบ (แสดงบนปุ่ม)"><Input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder={t('เช่น ไฟเตือนใกล้หมดเวลา, ตัดไฟห้อง, เปิดแอร์')} autoFocus /></Field>
        <Field label="ทำงานเมื่อ"><Select value={f.trigger} onChange={(e) => set('trigger', e.target.value)} options={TRIGGERS.map((x) => ({ value: x.value, label: t(x.label) }))} /></Field>
        {f.trigger === 'BEFORE_END' && <Field label="เมื่อเวลาเหลือ (นาที)"><Input type="number" min={1} max={240} value={f.minutes} onChange={(e) => set('minutes', e.target.value)} /></Field>}
        <Field label="คำสั่ง (data point code)" hint={t('ปลั๊ก/สวิตช์ส่วนใหญ่ใช้ switch_1 · สวิตช์หลายช่องใช้ switch_2, switch_3 · ไฟบางรุ่นใช้ switch_led')}>
          <Input value={f.code} onChange={(e) => set('code', e.target.value)} />
        </Field>
        <Field label="ค่าที่ส่ง">
          <Select value={f.action} onChange={(e) => set('action', e.target.value)} options={[{ value: 'ON', label: t('เปิด (true)') }, { value: 'OFF', label: t('ปิด (false)') }, { value: 'CUSTOM', label: t('ค่าอื่น (ตัวเลข / ข้อความ)') }]} />
        </Field>
        {f.action === 'CUSTOM' && <Field label="ค่า"><Input value={f.customValue} onChange={(e) => set('customValue', e.target.value)} placeholder="เช่น 1, white, scene_1" /></Field>}
        <Switch checked={f.showButton} onChange={(x) => set('showButton', x)} label={t('แสดงเป็นปุ่มในหน้าห้อง (กดสั่งเองได้)')} />
        <Switch checked={f.isActive} onChange={(x) => set('isActive', x)} label={t('เปิดใช้งานระบบนี้')} />
      </div>
      {f.extra.length > 0 && <div className="xs muted mt">{t('คำสั่งเพิ่มเติม')}: {f.extra.map((c) => `${c.code}=${String(c.value)}`).join(', ')}</div>}
    </Modal>
  );
}

/** What a device accepts: its data points, or the keys of an IR remote (air conditioner, fan, TV …). */
function DeviceInfo({ deviceId, onClose }) {
  const { t } = useT();
  const [info, setInfo] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api.get(`/smart/devices/${encodeURIComponent(deviceId)}/info`).then(setInfo).catch((e) => setErr(e.message));
  }, [deviceId]);
  return (
    <Modal title={`${t('คำสั่งที่อุปกรณ์รองรับ')} · ${deviceId}`} onClose={onClose}>
      {err ? <div style={{ color: 'var(--danger)' }}>{err}</div> : !info ? <Loading /> : (
        <div className="col small">
          {info.kind === 'dp' && (
            <>
              <div className="muted">{t('อุปกรณ์ Wi-Fi ทั่วไป — ใช้ "คำสั่ง (data point code)" ตามรายการนี้ · ระบบเปิด/ปิดจะใช้สวิตช์ของอุปกรณ์ให้อัตโนมัติ')}</div>
              <table className="table">
                <thead><tr><th>Code</th><th>{t('ชนิด')}</th><th>{t('ชื่อ')}</th></tr></thead>
                <tbody>{info.functions.map((f) => <tr key={f.code}><td><code>{f.code}</code></td><td>{f.type}</td><td>{f.name || '-'}</td></tr>)}</tbody>
              </table>
            </>
          )}
          {info.kind === 'ir' && (
            <>
              <div className="muted">{info.categoryId === 5 ? t('รีโมตแอร์ผ่าน IR Hub — ระบบเปิด/ปิด จะส่งคำสั่ง power ให้อัตโนมัติ') : t('รีโมต IR ผ่าน IR Hub — เปิด/ปิด จะกดปุ่ม PowerOn / PowerOff (ถ้าไม่มีจะกด Power ซึ่งเป็นการสลับเปิด/ปิด)')}</div>
              <div>{t('ปุ่มของรีโมต')}: {info.keys.map((k) => <code key={k} style={{ marginRight: 6 }}>{k}</code>)}</div>
              <div className="xs muted">{t('ต้องการกดปุ่มอื่น: ตั้ง "ค่าที่ส่ง" เป็น "ค่าอื่น" แล้วใส่ชื่อปุ่ม เช่น Speed')}</div>
            </>
          )}
          {info.kind === 'unknown' && <div style={{ color: 'var(--danger)' }}>{t('อ่านข้อมูลอุปกรณ์ไม่ได้')} {info.error || ''}</div>}
        </div>
      )}
    </Modal>
  );
}

/** Device of every room for every system. */
function Bindings({ data, rooms, devices, reload }) {
  const { t } = useT();
  const toast = useToast();
  const byKey = useMemo(() => Object.fromEntries((data.bindings || []).map((b) => [`${b.system_id}:${b.room_id}`, b])), [data.bindings]);
  const [draft, setDraft] = useState({});
  const [infoFor, setInfoFor] = useState(null);
  const val = (sys, room) => draft[`${sys}:${room}`] ?? byKey[`${sys}:${room}`]?.device_id ?? '';
  const save = async (sysId, roomId, deviceId) => {
    try {
      const dev = devices?.find((d) => d.id === deviceId);
      await api.put('/smart/bindings', { systemId: sysId, roomId, deviceId: deviceId || null, deviceName: dev?.name || null });
      setDraft((d) => {
        const n = { ...d };
        delete n[`${sysId}:${roomId}`];
        return n;
      });
      reload();
    } catch (e) {
      toast.error(e);
    }
  };
  const test = async (sys, deviceId) => {
    try {
      await api.post('/smart/test-device', { deviceId, commands: sys.commands });
      toast.success(`${t('ส่งคำสั่งแล้ว')}: ${sys.name}`);
    } catch (e) {
      toast.error(e);
    }
  };
  const copyDown = (sys) => {
    // same device ID for every room (e.g. one shared device) — fills only the empty rooms
    const first = rooms.map((r) => val(sys.id, r.id)).find(Boolean);
    if (!first) return toast.info('กรอกอุปกรณ์ของห้องแรกก่อน');
    rooms.filter((r) => !val(sys.id, r.id)).forEach((r) => save(sys.id, r.id, first));
  };
  if (!data.systems.length) return <Empty text={t('เพิ่มระบบก่อน แล้วเลือกอุปกรณ์ของแต่ละห้อง')} />;
  const list = devices ? `smart-devices` : undefined;
  return (
    <div className="table-wrap">
      {devices && (
        <datalist id="smart-devices">
          {devices.map((d) => <option key={d.id} value={d.id}>{`${d.name}${d.online === false ? ' (ออฟไลน์)' : ''}`}</option>)}
        </datalist>
      )}
      <table className="table">
        <thead>
          <tr>
            <th>{t('ห้อง')}</th>
            {data.systems.map((s) => <th key={s.id}>{s.name}<div className="xs muted">{triggerLabel(s, t)}</div>{rooms.length > 1 && <button className="btn ghost sm" onClick={() => copyDown(s)}>{t('ใช้กับห้องที่ว่าง')}</button>}</th>)}
          </tr>
        </thead>
        <tbody>
          {rooms.map((r) => (
            <tr key={r.id}>
              <td className="bold">{r.name}</td>
              {data.systems.map((s) => {
                const k = `${s.id}:${r.id}`;
                const v = val(s.id, r.id);
                const saved = byKey[k];
                const name = devices?.find((d) => d.id === v)?.name || saved?.device_name;
                return (
                  <td key={s.id} style={{ minWidth: 200 }}>
                    <div className="row nowrap">
                      <Input list={list} value={v} placeholder="Device ID" onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))} onBlur={() => v !== (saved?.device_id || '') && save(s.id, r.id, v.trim())} style={{ minWidth: 120 }} />
                      {v && <Button size="sm" variant="ghost" icon={Zap} title={t('ทดสอบสั่งงาน')} onClick={() => test(s, v)} />}
                      {v && <Button size="sm" variant="ghost" icon={ListTree} title={t('คำสั่งที่อุปกรณ์รองรับ')} onClick={() => setInfoFor(v)} />}
                    </div>
                    {name && <div className="xs muted">{name}</div>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {infoFor && <DeviceInfo deviceId={infoFor} onClose={() => setInfoFor(null)} />}
    </div>
  );
}

export default function SmartDevices() {
  const { t } = useT();
  const toast = useToast();
  const { confirm } = useDialog();
  const { can } = useAuth();
  const [all, setAll] = useState(null);
  const [edit, setEdit] = useState(null);
  const [devices, setDevices] = useState(null);
  const [loadingDevices, setLoadingDevices] = useState(false);
  const { data, reload } = useLive(() => api.get('/smart'), ['smart', 'settings'], []);
  const { data: rooms } = useLive(() => api.get('/rooms'), ['rooms'], []);
  const { data: logs } = useLive(() => api.get('/smart/logs?limit=40'), ['smart'], []);
  const manage = can('settings.manage');
  useEffect(() => {
    if (manage) api.get('/integrations').then(setAll).catch(() => {});
  }, [manage]);
  const loadDevices = async () => {
    setLoadingDevices(true);
    try {
      const d = await api.get('/smart/devices');
      setDevices(d);
      toast.success(`${t('พบอุปกรณ์')} ${d.length} ${t('เครื่อง')}`);
    } catch (e) {
      toast.error(e);
    } finally {
      setLoadingDevices(false);
    }
  };
  const toggle = async (on) => {
    try {
      if (on && !data.configured) return toast.error('กรุณากรอก Access ID / Access Secret แล้วกดบันทึกก่อน');
      const r = await api.put('/integrations/tuya', { enabled: on });
      setAll(r);
      reload();
      toast.success(on ? 'เปิดใช้งานแล้ว' : 'ปิดแล้ว');
    } catch (e) {
      toast.error(e);
    }
  };
  const remove = async (s) => {
    if (!(await confirm({ title: 'ลบระบบ', message: `${t('ต้องการลบ')} "${s.name}" ?`, danger: true, okText: 'ลบ' }))) return;
    try {
      await api.del(`/smart/systems/${s.id}`);
      reload();
    } catch (e) {
      toast.error(e);
    }
  };
  if (!data || !rooms) return <Loading />;
  const activeRooms = (rooms || []).filter((r) => r.is_active !== false);
  return (
    <div className="col">
      <PageHead icon={Cpu} title="อุปกรณ์อัจฉริยะ (Tuya)">
        {manage ? (
          <Switch checked={!!data.enabled} onChange={toggle} label={data.enabled ? t('เปิดใช้งานอยู่') : t('ปิดอยู่ — กดเพื่อเปิดใช้งาน')} />
        ) : (
          <Badge color={data.enabled ? '#16a34a' : '#6b7280'}>{data.enabled ? t('เปิดใช้งาน') : t('ปิดอยู่')}</Badge>
        )}
      </PageHead>
      {!data.enabled && data.systems.length > 0 && (
        <div className="card flat small" style={{ borderColor: 'var(--warn)' }}>{t('ระบบอุปกรณ์อัจฉริยะยังปิดอยู่ — ปุ่มในหน้าห้องและการทำงานอัตโนมัติจะยังไม่ทำงาน จนกว่าจะเปิดสวิตช์ด้านบน')}</div>
      )}
      <div className="card flat small">
        {t('ตั้งชื่อ "ระบบ" ได้เอง เช่น ไฟเตือนใกล้หมดเวลา / ตัดไฟห้องเมื่อหมดเวลา / เปิดแอร์ แล้วเลือกว่าจะทำงานเมื่อไร และใช้อุปกรณ์ Tuya ตัวไหนในแต่ละห้อง · ระบบที่ตั้ง "แสดงเป็นปุ่ม" จะมีปุ่มในหน้าห้องให้พนักงานกดสั่งเองได้')}
      </div>
      {manage && all && <TuyaCard all={{ ...all, meta: { ...(all.meta || {}), tuyaRegions: data.regions } }} setAll={(x) => { setAll(x); reload(); }} />}

      <div className="card">
        <div className="row between">
          <h3>{t('ระบบ')}</h3>
          {manage && <Button variant="primary" icon={Plus} onClick={() => setEdit({})}>{t('เพิ่มระบบ')}</Button>}
        </div>
        {!data.systems.length ? <Empty text={t('ยังไม่มีระบบ')} /> : (
          <div className="col">
            {data.systems.map((s) => (
              <div key={s.id} className="card flat row between" style={{ padding: 10, opacity: s.is_active ? 1 : 0.55 }}>
                <div>
                  <b>{s.name}</b> {!s.is_active && <Badge color="#6b7280">{t('ปิดใช้งาน')}</Badge>} {s.show_button && <Badge color="#2563eb">{t('มีปุ่ม')}</Badge>}
                  <div className="small muted">{triggerLabel(s, t)} · {s.commands.map((c) => `${c.code} = ${cmdText(c, t)}`).join(', ')}</div>
                </div>
                {manage && (
                  <div className="row nowrap">
                    <Button size="sm" variant="ghost" icon={Pencil} title={t('แก้ไข')} onClick={() => setEdit(s)} />
                    <Button size="sm" variant="ghost" icon={Trash2} title={t('ลบ')} onClick={() => remove(s)} />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {manage && (
        <div className="card">
          <div className="row between">
            <h3>{t('อุปกรณ์ของแต่ละห้อง')}</h3>
            <Button icon={loadingDevices ? RefreshCw : Search} loading={loadingDevices} onClick={loadDevices} disabled={!data.configured}>{t('ดึงรายการอุปกรณ์จาก Tuya')}</Button>
          </div>
          <div className="xs muted mb">{t('ใส่ Device ID (ดูได้ในแอป Smart Life → อุปกรณ์ → ข้อมูลอุปกรณ์ หรือกดดึงรายการแล้วเลือก) · เว้นว่าง = ห้องนี้ไม่ใช้ระบบนั้น')}</div>
          <Bindings data={data} rooms={activeRooms} devices={devices} reload={reload} />
        </div>
      )}

      <div className="card">
        <h3>{t('ประวัติการสั่งงาน')}</h3>
        {!logs?.length ? <Empty text={t('ยังไม่มีการสั่งงาน')} /> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>{t('เวลา')}</th><th>{t('ห้อง')}</th><th>{t('ระบบ')}</th><th>{t('สั่งโดย')}</th><th>{t('ผล')}</th></tr></thead>
              <tbody>
                {logs.map((l) => (
                  <tr key={l.id}>
                    <td className="small num">{fmtDateTime(l.created_at)}</td>
                    <td>{l.room_name || '-'}</td>
                    <td>{l.name}</td>
                    <td className="small">{l.employee_name || t(l.trigger === 'MANUAL' ? 'พนักงาน' : 'อัตโนมัติ')}{l.trigger !== 'MANUAL' && <div className="xs muted">{triggerLabel({ trigger: l.trigger, minutes: '' }, t)}</div>}</td>
                    <td>{l.ok ? <CheckCircle2 size={16} color="var(--ok)" /> : <span className="small" style={{ color: 'var(--danger)' }}><XCircle size={14} /> {l.error}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="xs muted"><KeyRound size={12} /> {t('Access Secret ถูกเข้ารหัสก่อนบันทึก และจะไม่ถูกส่งกลับมาแสดงที่หน้าเว็บ')}</div>
      {edit && <SystemModal initial={edit.id ? edit : null} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
    </div>
  );
}

/** Room screen: the buttons of the systems that have a device in this room. */
export function RoomSmartButtons({ roomId }) {
  const { t } = useT();
  const toast = useToast();
  const { can } = useAuth();
  const { data } = useLive(() => api.get('/smart', { passive: true }), ['smart', 'settings'], []);
  const [busy, setBusy] = useState(null);
  if (!data) return null;
  const list = data.systems.filter((s) => s.is_active && s.show_button && data.bindings.some((b) => b.system_id === s.id && b.room_id === roomId));
  if (!list.length) {
    // systems exist but no device was chosen for this room yet → tell the manager where to set it
    const unbound = data.systems.filter((s) => s.is_active && s.show_button);
    if (!unbound.length || !can('settings.manage')) return null;
    return (
      <div className="card flat small muted" style={{ padding: 10 }}>
        <Cpu size={14} /> {t('ห้องนี้ยังไม่ได้เลือกอุปกรณ์ Tuya')} ({unbound.map((s) => s.name).join(', ')}) · <a href="/admin/smart">{t('เลือกอุปกรณ์ของห้อง')}</a>
      </div>
    );
  }
  if (!data.enabled) {
    // devices are set up for this room but the whole Tuya feature is switched off
    return (
      <div className="card flat small" style={{ padding: 10, borderColor: 'var(--warn)' }}>
        <Cpu size={14} /> {t('ห้องนี้มีอุปกรณ์ Tuya แต่ระบบอุปกรณ์อัจฉริยะยังปิดอยู่')}
        {can('settings.manage') && <> · <a href="/admin/smart">{t('เปิดใช้งาน')}</a></>}
      </div>
    );
  }
  const run = async (s) => {
    setBusy(s.id);
    try {
      await api.post('/smart/run', { systemId: s.id, roomId });
      toast.success(`${s.name}: ${t('สั่งงานแล้ว')}`);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="card flat" style={{ padding: 10 }}>
      <div className="small muted mb"><Cpu size={14} /> {t('อุปกรณ์ในห้อง')}</div>
      <div className="row" style={{ gap: 6 }}>
        {list.map((s) => {
          const off = s.commands[0]?.value === false;
          return (
            <Button key={s.id} size="sm" variant={off ? 'danger' : ''} icon={off ? PowerOff : Power} loading={busy === s.id} disabled={!can('room.operate')} onClick={() => run(s)} title={triggerLabel(s, t)}>
              {s.name}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

// ผังร้าน & ทางไปห้อง: floors with their plan (background picture optional), rooms dragged onto the plan, markers
// (entrance, stairs …), the GPS position of each room's door, and the switch for GPS directions on the guide page.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Map as MapIcon, Plus, Save, Trash2, Upload, Crosshair, ExternalLink, Navigation, Layers, X } from 'lucide-react';
import { PageHead, Button, Input, Field, Select, Switch, Badge, Empty, Loading, useToast, useDialog } from '../../components/ui.jsx';
import { FloorPlan, MARKERS } from '../../components/FloorPlan.jsx';
import { useT } from '../../lib/i18n.jsx';
import { api, uploadInChunks, uid } from '../../lib/api.js';
import { useAuth } from '../../lib/store.jsx';
import { useLive } from '../../lib/socket.js';

const ASPECTS = [
  { value: '1.6', label: 'แนวนอน 16:10' },
  { value: '1.333', label: 'แนวนอน 4:3' },
  { value: '2', label: 'แนวนอนยาว 2:1' },
  { value: '1', label: 'จัตุรัส 1:1' },
  { value: '0.75', label: 'แนวตั้ง 3:4' },
];
const placed = (r) => r.plan_x != null;
const toPlan = (r) => ({ id: r.id, name: r.name, number: r.number, x: Number(r.plan_x), y: Number(r.plan_y), w: Number(r.plan_w), h: Number(r.plan_h) });

export default function FloorPlans() {
  const { t } = useT();
  const toast = useToast();
  const { confirm, prompt } = useDialog();
  const { settings, loadSettings } = useAuth();
  const { data, reload } = useLive(() => api.get('/floors'), ['floors'], []);
  const [floorId, setFloorId] = useState(null);
  const [rooms, setRooms] = useState([]); // rooms on the plan of this floor (being edited)
  const [markers, setMarkers] = useState([]);
  const [sel, setSel] = useState(null); // { kind: 'room' | 'marker', id }
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [gps, setGps] = useState(null); // { roomId, state, accuracy }
  const fileRef = useRef(null);
  const floors = data?.floors || [];
  const floor = floors.find((f) => f.id === floorId) || null;

  useEffect(() => {
    if (!floorId && floors.length) setFloorId(floors[0].id);
  }, [floors.length]);
  // load the plan of the floor being edited (not while there are unsaved moves)
  useEffect(() => {
    if (!data || !floor || dirty) return;
    setRooms(data.rooms.filter((r) => r.floor_id === floor.id && placed(r)).map(toPlan));
    setMarkers(floor.markers || []);
  }, [data, floorId]);

  const allRooms = data?.rooms || [];
  const floorName = (id) => floors.find((f) => f.id === id)?.name;
  const notHere = useMemo(() => allRooms.filter((r) => !rooms.some((x) => x.id === r.id)), [allRooms, rooms]);
  const change = (rs, ms) => {
    setRooms(rs);
    setMarkers(ms);
    setDirty(true);
  };
  const switchFloor = async (id) => {
    if (dirty && !(await confirm({ title: t('ยังไม่ได้บันทึกผังชั้นนี้'), message: t('เปลี่ยนชั้นโดยไม่บันทึก?') }))) return;
    setDirty(false);
    setSel(null);
    setFloorId(id);
  };

  const addFloor = async () => {
    const name = await prompt({ title: t('เพิ่มชั้น'), message: t('ชื่อชั้น เช่น ชั้น 1, ชั้น 2, ชั้นลอย'), defaultValue: `${t('ชั้น')} ${floors.length + 1}` });
    if (!name) return;
    try {
      const f = await api.post('/floors', { name, aspect: 1.6, sortOrder: floors.length });
      await reload();
      setDirty(false);
      setFloorId(f.id);
    } catch (e) {
      toast.error(e);
    }
  };
  const saveFloor = async (patch) => {
    try {
      await api.put(`/floors/${floor.id}`, { name: floor.name, branchId: floor.branch_id, planImageUrl: floor.plan_image_url || null, aspect: Number(floor.aspect), sortOrder: floor.sort_order, ...patch });
      reload();
    } catch (e) {
      toast.error(e);
    }
  };
  const removeFloor = async () => {
    if (!(await confirm({ title: `${t('ลบ')} ${floor.name}?`, message: t('ห้องบนผังชั้นนี้จะถูกนำออกจากผัง (ข้อมูลห้องไม่หาย)'), danger: true }))) return;
    await api.del(`/floors/${floor.id}`).catch((e) => toast.error(e));
    setDirty(false);
    setFloorId(null);
    reload();
  };
  const uploadPlan = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const r = await uploadInChunks('/promotion-images/upload', file);
      if (r.mediaType !== 'IMAGE') throw new Error(t('กรุณาเลือกไฟล์รูปภาพ'));
      // keep the plan in the picture's own proportions
      const img = new Image();
      img.src = r.url;
      await img.decode().catch(() => {});
      await saveFloor({ planImageUrl: r.url, aspect: img.naturalWidth && img.naturalHeight ? Math.min(4, Math.max(0.4, img.naturalWidth / img.naturalHeight)) : Number(floor.aspect) });
      toast.success('อัปโหลดผังแล้ว');
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const placeRoom = (r) => {
    const n = rooms.length;
    change([...rooms, { id: r.id, name: r.name, number: r.number, x: 5 + ((n * 20) % 80), y: 8 + Math.floor((n * 20) / 80) * 22, w: 16, h: 16 }], markers);
    setSel({ kind: 'room', id: r.id });
  };
  const addMarker = (type) => {
    const m = { id: uid(), type, x: 50, y: 50, label: '' };
    change(rooms, [...markers, m]);
    setSel({ kind: 'marker', id: m.id });
  };
  const saveLayout = async () => {
    setBusy(true);
    try {
      await api.put(`/floors/${floor.id}/layout`, { rooms: rooms.map(({ id, x, y, w, h }) => ({ id, x, y, w, h })), markers });
      setDirty(false);
      await reload();
      toast.success('บันทึกผังชั้นนี้แล้ว');
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  // "บันทึกตำแหน่งห้องนี้": staff stand at the room's door; the best of a few GPS readings is saved
  const saveGps = (room) => {
    if (!navigator.geolocation) return toast.error('อุปกรณ์นี้ไม่มี GPS / ไม่อนุญาตตำแหน่ง');
    setGps({ roomId: room.id, state: 'reading', accuracy: null });
    let best = null;
    const id = navigator.geolocation.watchPosition(
      (p) => {
        if (!best || p.coords.accuracy < best.coords.accuracy) best = p;
        setGps({ roomId: room.id, state: 'reading', accuracy: Math.round(best.coords.accuracy) });
      },
      (e) => {
        navigator.geolocation.clearWatch(id);
        setGps(null);
        toast.error(e.code === 1 ? 'ไม่ได้รับอนุญาตให้ใช้ตำแหน่ง — อนุญาต Location ในเบราว์เซอร์แล้วลองใหม่' : 'อ่านตำแหน่งไม่สำเร็จ ลองออกไปใกล้หน้าต่าง/ที่โล่งแล้วลองใหม่');
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
    );
    // read for up to 8 seconds (GPS gets more precise after a few readings)
    setTimeout(async () => {
      navigator.geolocation.clearWatch(id);
      if (!best) return setGps(null);
      try {
        await api.put(`/floors/rooms/${room.id}/location`, { lat: best.coords.latitude, lng: best.coords.longitude, accuracy: Math.round(best.coords.accuracy) });
        toast.success(`${t('บันทึกตำแหน่งห้องแล้ว')}: ${room.name} (±${Math.round(best.coords.accuracy)} ${t('ม.')})`);
        reload();
      } catch (e) {
        toast.error(e);
      } finally {
        setGps(null);
      }
    }, 8000);
  };
  const clearGps = async (room) => {
    await api.put(`/floors/rooms/${room.id}/location`, { lat: null, lng: null }).catch((e) => toast.error(e));
    reload();
  };

  const nav = { enabled: !!settings?.general?.roomNavEnabled, arriveM: settings?.general?.roomNavArriveM ?? 10 };
  const saveNav = async (patch) => {
    try {
      await api.put('/settings/general', { ...settings.general, ...patch });
      await loadSettings();
    } catch (e) {
      toast.error(e);
    }
  };

  if (!data) return <Loading />;
  const selRoom = sel?.kind === 'room' ? allRooms.find((r) => r.id === sel.id) : null;
  const selMarker = sel?.kind === 'marker' ? markers.find((m) => m.id === sel.id) : null;
  return (
    <div>
      <PageHead icon={MapIcon} title="ผังร้าน & ทางไปห้อง">
        <Button icon={Plus} onClick={addFloor}>{t('เพิ่มชั้น')}</Button>
      </PageHead>
      <div className="card mb">
        <div className="row between">
          <div>
            <Switch checked={nav.enabled} onChange={(v) => saveNav({ roomNavEnabled: v })} label={t('นำทางด้วย GPS ในหน้าทางไปห้อง')} />
            <div className="xs muted">{t('ผังร้านและห้องที่กะพริบแสดงให้ลูกค้าเสมอ · GPS จะนำทางไปยังตำแหน่งที่บันทึกไว้ของห้อง (ในอาคาร GPS อาจคลาดเคลื่อน 5–20 ม.)')}</div>
          </div>
          <Field label="ระยะที่ถือว่า &quot;ถึงห้องแล้ว&quot; (เมตร)">
            <Input type="number" style={{ width: 120 }} value={nav.arriveM} onChange={(e) => saveNav({ roomNavArriveM: Math.max(3, Number(e.target.value) || 10) })} />
          </Field>
        </div>
      </div>

      {!floors.length ? (
        <Empty text="ยังไม่มีผังร้าน — กด &quot;เพิ่มชั้น&quot; เพื่อเริ่ม" />
      ) : (
        <>
          <div className="seg mb">
            {floors.map((f) => (
              <button key={f.id} type="button" className={f.id === floorId ? 'on' : ''} onClick={() => switchFloor(f.id)}><Layers size={14} /> {f.name}</button>
            ))}
          </div>
          {floor && (
            <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 320px)', gap: 16, alignItems: 'start' }}>
              <div className="col" style={{ gap: 10 }}>
                <div className="card row" style={{ gap: 10 }}>
                  <Field label="ชื่อชั้น"><Input key={`${floor.id}-${floor.name}`} defaultValue={floor.name} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== floor.name && saveFloor({ name: e.target.value.trim() })} /></Field>
                  <Field label="สัดส่วนผัง"><Select value={String(Number(floor.aspect))} onChange={(e) => saveFloor({ aspect: Number(e.target.value) })} options={ASPECTS.some((a) => Number(a.value) === Number(floor.aspect)) ? ASPECTS : [...ASPECTS, { value: String(Number(floor.aspect)), label: t('ตามรูปผัง') }]} /></Field>
                  <input ref={fileRef} type="file" hidden accept="image/*" onChange={(e) => { uploadPlan(e.target.files?.[0]); e.target.value = ''; }} />
                  <Button icon={Upload} loading={busy} onClick={() => fileRef.current?.click()}>{floor.plan_image_url ? t('เปลี่ยนรูปผัง') : t('อัปโหลดรูปผัง (ไม่บังคับ)')}</Button>
                  {floor.plan_image_url && <Button variant="ghost" icon={X} onClick={() => saveFloor({ planImageUrl: null })}>{t('ไม่ใช้รูปผัง')}</Button>}
                  <Button variant="ghost" icon={Trash2} onClick={removeFloor}>{t('ลบชั้นนี้')}</Button>
                </div>
                <FloorPlan floor={{ aspect: floor.aspect, planImageUrl: floor.plan_image_url }} rooms={rooms} markers={markers} editable onChange={change} selected={sel} onSelect={setSel} />
                <div className="row">
                  <span className="small muted">{t('เพิ่มจุดสังเกต:')}</span>
                  {Object.entries(MARKERS).map(([k, m]) => (
                    <Button key={k} size="sm" onClick={() => addMarker(k)}>{m.icon} {t(m.label)}</Button>
                  ))}
                </div>
                <div className="row">
                  <Button variant="primary" icon={Save} loading={busy} disabled={!dirty} onClick={saveLayout}>{t('บันทึกผังชั้นนี้')}</Button>
                  {dirty && <Badge color="#f59e0b">{t('ยังไม่ได้บันทึก')}</Badge>}
                  <span className="xs muted">{t('ลากห้อง/จุดสังเกตเพื่อย้าย · ลากมุมขวาล่างของห้องเพื่อปรับขนาด')}</span>
                </div>
              </div>

              <div className="col" style={{ gap: 10 }}>
                {selRoom && (
                  <div className="card">
                    <h3 className="row nowrap">{selRoom.name}</h3>
                    <div className="col" style={{ gap: 8 }}>
                      <div className="small">
                        <b>{t('ตำแหน่ง GPS ของห้อง')}</b>
                        <div className="muted xs">{t('ยืนที่หน้าประตูห้องนี้ แล้วกดบันทึก (ใช้โทรศัพท์/แท็บเล็ตที่มี GPS)')}</div>
                      </div>
                      {selRoom.geo_lat != null ? (
                        <div className="row">
                          <Badge color="#16a34a">{t('บันทึกแล้ว')} ±{Number(selRoom.geo_accuracy) || '?'} {t('ม.')}</Badge>
                          <Button size="sm" variant="ghost" onClick={() => clearGps(selRoom)}>{t('ลบตำแหน่ง')}</Button>
                        </div>
                      ) : <Badge color="#6b7280">{t('ยังไม่ได้บันทึก')}</Badge>}
                      <Button icon={Crosshair} loading={gps?.roomId === selRoom.id} onClick={() => saveGps(selRoom)}>
                        {gps?.roomId === selRoom.id ? `${t('กำลังอ่านตำแหน่ง')}${gps.accuracy ? ` ±${gps.accuracy} ${t('ม.')}` : ''}` : t('บันทึกตำแหน่งห้องนี้ (ตรงที่ยืนอยู่)')}
                      </Button>
                      <a className="btn sm" href={`/guide/${selRoom.guide_token}`} target="_blank" rel="noreferrer"><ExternalLink size={14} /> {t('เปิดหน้าทางไปห้อง')}</a>
                      {rooms.some((x) => x.id === selRoom.id) && <Button size="sm" variant="ghost" icon={Trash2} onClick={() => { change(rooms.filter((x) => x.id !== selRoom.id), markers); setSel(null); }}>{t('เอาออกจากผังชั้นนี้')}</Button>}
                    </div>
                  </div>
                )}
                {selMarker && (
                  <div className="card col" style={{ gap: 8 }}>
                    <h3>{MARKERS[selMarker.type]?.icon} {t(MARKERS[selMarker.type]?.label || 'จุดสังเกต')}</h3>
                    <Field label="ข้อความ (ไม่บังคับ)"><Input value={selMarker.label || ''} onChange={(e) => change(rooms, markers.map((m) => (m.id === selMarker.id ? { ...m, label: e.target.value } : m)))} /></Field>
                    <Button size="sm" variant="ghost" icon={Trash2} onClick={() => { change(rooms, markers.filter((m) => m.id !== selMarker.id)); setSel(null); }}>{t('ลบจุดนี้')}</Button>
                  </div>
                )}
                <div className="card">
                  <h3>{t('ห้องที่ยังไม่อยู่บนผังชั้นนี้')}</h3>
                  {!notHere.length && <div className="small muted">{t('ทุกห้องอยู่บนผังชั้นนี้แล้ว')}</div>}
                  <div className="col" style={{ gap: 6 }}>
                    {notHere.map((r) => (
                      <div key={r.id} className="row between nowrap">
                        <span className="small">
                          <b>{r.name}</b> {r.floor_id && placed(r) ? <span className="xs muted">({floorName(r.floor_id)})</span> : null}
                          {r.geo_lat != null && <Navigation size={12} style={{ marginLeft: 4 }} />}
                        </span>
                        <Button size="sm" icon={Plus} onClick={() => placeRoom(r)}>{t('วางบนผัง')}</Button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

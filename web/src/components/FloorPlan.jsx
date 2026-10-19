// A floor plan: optional background picture, the rooms as boxes and markers (entrance, stairs …), all placed in % of
// the plan so it fits any screen. Read-only it shows the customer's room blinking; editable (admin) the rooms and
// markers are dragged into place and rooms resized from their corner.
import { useRef } from 'react';
import { useT } from '../lib/i18n.jsx';

export const MARKERS = {
  ENTRANCE: { icon: '🚪', label: 'ทางเข้า' },
  STAIRS: { icon: '🪜', label: 'บันได' },
  LIFT: { icon: '🛗', label: 'ลิฟต์' },
  TOILET: { icon: '🚻', label: 'ห้องน้ำ' },
  COUNTER: { icon: '🛎️', label: 'เคาน์เตอร์' },
  EXIT: { icon: '🏃', label: 'ทางออก' },
  LABEL: { icon: '📍', label: 'จุดสังเกต' },
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r1 = (v) => Math.round(v * 2) / 2; // 0.5 % steps

/**
 * floor: { aspect, planImageUrl } · rooms: [{ id, name, number, x, y, w, h }] · markers: [{ id, type, x, y, label }]
 * targetId: the room to make blink · editable + onChange(rooms, markers) + selected / onSelect for the editor.
 */
export function FloorPlan({ floor, rooms = [], markers = [], targetId = null, editable = false, onChange, selected, onSelect }) {
  const { t } = useT();
  const box = useRef(null);
  const drag = useRef(null);
  const aspect = Number(floor?.aspect) || 1.6;

  const start = (e, kind, item, mode) => {
    if (!editable) return;
    e.preventDefault();
    e.stopPropagation();
    onSelect?.({ kind, id: item.id });
    const rect = box.current.getBoundingClientRect();
    drag.current = { kind, id: item.id, mode, x0: e.clientX, y0: e.clientY, w: rect.width, h: rect.height, orig: { ...item } };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const move = (e) => {
    const d = drag.current;
    if (!d) return;
    const dx = ((e.clientX - d.x0) / d.w) * 100;
    const dy = ((e.clientY - d.y0) / d.h) * 100;
    if (d.kind === 'room') {
      const o = d.orig;
      const next =
        d.mode === 'resize'
          ? { ...o, w: r1(clamp(o.w + dx, 3, 100 - o.x)), h: r1(clamp(o.h + dy, 3, 100 - o.y)) }
          : { ...o, x: r1(clamp(o.x + dx, 0, 100 - o.w)), y: r1(clamp(o.y + dy, 0, 100 - o.h)) };
      onChange?.(rooms.map((x) => (x.id === d.id ? next : x)), markers);
    } else {
      const o = d.orig;
      onChange?.(rooms, markers.map((m) => (m.id === d.id ? { ...m, x: r1(clamp(o.x + dx, 0, 100)), y: r1(clamp(o.y + dy, 0, 100)) } : m)));
    }
  };
  const end = () => (drag.current = null);

  return (
    <div className={`fp ${editable ? 'fp-edit' : ''}`} ref={box} style={{ aspectRatio: String(aspect) }} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onPointerDown={() => editable && onSelect?.(null)}>
      {floor?.planImageUrl ? <img className="fp-bg" src={floor.planImageUrl} alt="" draggable={false} /> : <div className="fp-grid" />}
      {rooms.map((r) => {
        const target = r.id === targetId;
        const sel = selected?.kind === 'room' && selected.id === r.id;
        return (
          <div
            key={r.id}
            className={`fp-room ${target ? 'fp-target' : ''} ${sel ? 'fp-sel' : ''} ${targetId && !target ? 'fp-dim' : ''}`}
            style={{ left: `${r.x}%`, top: `${r.y}%`, width: `${r.w}%`, height: `${r.h}%` }}
            onPointerDown={(e) => start(e, 'room', r, 'move')}
          >
            <span className="fp-room-name">{r.name}</span>
            {target && <span className="fp-pin">📍</span>}
            {editable && <span className="fp-resize" onPointerDown={(e) => start(e, 'room', r, 'resize')} />}
          </div>
        );
      })}
      {markers.map((m) => {
        const def = MARKERS[m.type] || MARKERS.LABEL;
        const sel = selected?.kind === 'marker' && selected.id === m.id;
        return (
          <div key={m.id} className={`fp-marker ${sel ? 'fp-sel' : ''}`} style={{ left: `${m.x}%`, top: `${m.y}%` }} onPointerDown={(e) => start(e, 'marker', m, 'move')}>
            <span className="fp-marker-icon">{def.icon}</span>
            <span className="fp-marker-label">{m.label || t(def.label)}</span>
          </div>
        );
      })}
    </div>
  );
}

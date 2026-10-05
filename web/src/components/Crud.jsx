import { useState, useMemo } from 'react';
import { Plus, Pencil, Trash2, Search } from 'lucide-react';
import { Button, Modal, Field, Input, Textarea, Select, Switch, ImageUrlInput, Img, PageHead, Loading, Empty, useToast, useDialog, money } from './ui.jsx';
import { useT } from '../lib/i18n.jsx';
import { api } from '../lib/api.js';
import { useLive } from '../lib/socket.js';
import { useAuth } from '../lib/store.jsx';

export const DAYS = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];

export function DaysInput({ value = [], onChange }) {
  const { t } = useT();
  const v = value || [];
  return (
    <div className="row" style={{ gap: 4 }}>
      {DAYS.map((d, i) => (
        <button key={i} type="button" className={`btn sm ${v.includes(i) ? 'primary' : ''}`} onClick={() => onChange(v.includes(i) ? v.filter((x) => x !== i) : [...v, i].sort())}>
          {t(d)}
        </button>
      ))}
    </div>
  );
}

export function MultiCheck({ value = [], onChange, options = [] }) {
  const { t } = useT();
  const v = (value || []).map(Number);
  return (
    <div className="row" style={{ gap: 6 }}>
      {options.map((o) => (
        <label key={o.value} className="check badge" style={{ padding: '6px 10px' }}>
          <input type="checkbox" checked={v.includes(Number(o.value))} onChange={(e) => onChange(e.target.checked ? [...v, Number(o.value)] : v.filter((x) => x !== Number(o.value)))} />
          {t(o.label)}
        </label>
      ))}
      {!options.length && <span className="muted small">-</span>}
    </div>
  );
}

/** Render a form field from a config object. */
export function FormField({ f, form, set }) {
  const { t } = useT();
  const v = form[f.key];
  const onV = (x) => set(f.key, x);
  if (f.hidden?.(form)) return null;
  let input;
  switch (f.type) {
    case 'textarea':
      input = <Textarea value={v ?? ''} onChange={(e) => onV(e.target.value)} />;
      break;
    case 'number':
    case 'money':
      input = <Input type="number" step={f.step || (f.type === 'money' ? '0.01' : '1')} value={v ?? ''} onChange={(e) => onV(e.target.value === '' ? null : e.target.value)} placeholder={f.placeholder} />;
      break;
    case 'image':
      input = <ImageUrlInput value={v} onChange={onV} />;
      break;
    case 'select':
      input = <Select value={v ?? ''} onChange={(e) => onV(e.target.value)} options={typeof f.options === 'function' ? f.options(form) : f.options} placeholder={f.placeholder ?? (f.required ? undefined : '-')} />;
      break;
    case 'switch':
      input = <Switch checked={!!v} onChange={onV} label={f.switchLabel} />;
      break;
    case 'color':
      input = (
        <div className="row nowrap">
          <input type="color" value={v || '#7c3aed'} onChange={(e) => onV(e.target.value)} style={{ width: 48, height: 42, border: 0, background: 'none' }} />
          <Input value={v || ''} onChange={(e) => onV(e.target.value)} />
        </div>
      );
      break;
    case 'time':
      input = <Input type="time" value={(v || '').slice(0, 5)} onChange={(e) => onV(e.target.value)} />;
      break;
    case 'date':
      input = <Input type="date" value={(v || '').slice(0, 10)} onChange={(e) => onV(e.target.value)} />;
      break;
    case 'tags':
      input = <Input value={Array.isArray(v) ? v.join(', ') : v || ''} onChange={(e) => onV(e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} placeholder={t('คั่นด้วยเครื่องหมายจุลภาค ,')} />;
      break;
    case 'days':
      input = <DaysInput value={v} onChange={onV} />;
      break;
    case 'multi':
      input = <MultiCheck value={v} onChange={onV} options={typeof f.options === 'function' ? f.options(form) : f.options} />;
      break;
    case 'custom':
      input = f.render(form, set);
      break;
    default:
      input = <Input type={f.inputType || 'text'} value={v ?? ''} onChange={(e) => onV(e.target.value)} placeholder={f.placeholder} maxLength={f.maxLength} />;
  }
  return (
    <Field label={f.label + (f.required ? ' *' : '')} hint={f.hint} style={f.full ? { gridColumn: '1 / -1' } : undefined}>
      {input}
    </Field>
  );
}

/**
 * Generic list + create/edit/delete page.
 */
export function CrudPage({ title, icon, endpoint, listEndpoint, topics = [], columns, fields, defaults = {}, toForm = (r) => r, toPayload = (f) => f, createPerm, editPerm, deletePerm, searchKeys = ['name'], extraHead, rowActions, cards, modalSize = 'wide', canDelete = true, onSaved }) {
  const { t } = useT();
  const toast = useToast();
  const { confirm } = useDialog();
  const { can } = useAuth();
  const { data, loading, reload } = useLive(() => api.get(listEndpoint || endpoint), topics, []);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [q, setQ] = useState('');
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const rows = useMemo(() => {
    const list = Array.isArray(data) ? data : [];
    if (!q) return list;
    const s = q.toLowerCase();
    return list.filter((r) => searchKeys.some((k) => String(r[k] ?? '').toLowerCase().includes(s)));
  }, [data, q]);
  const save = async () => {
    for (const f of fields) {
      if (f.required && !f.hidden?.(form) && (form[f.key] == null || form[f.key] === '')) return toast.error(`${t('กรุณากรอก')} ${t(f.label)}`);
    }
    setSaving(true);
    try {
      const payload = toPayload(form);
      if (form.id) await api.put(`${endpoint}/${form.id}`, payload);
      else await api.post(endpoint, payload);
      toast.success('บันทึกเรียบร้อย');
      setForm(null);
      reload();
      onSaved?.();
    } catch (e) {
      toast.error(e);
    } finally {
      setSaving(false);
    }
  };
  const remove = async (row) => {
    if (!(await confirm({ title: 'ยืนยันการลบ', message: `${t('ต้องการลบ')} "${row.name || row.title || row.id}" ?`, danger: true, okText: 'ลบ' }))) return;
    try {
      await api.del(`${endpoint}/${row.id}`);
      toast.success('ลบเรียบร้อย');
      reload();
    } catch (e) {
      toast.error(e);
    }
  };
  const allowCreate = !createPerm || can(createPerm);
  const allowEdit = !editPerm || can(editPerm);
  const allowDelete = canDelete && (!deletePerm || can(deletePerm));
  return (
    <div>
      <PageHead icon={icon} title={title}>
        <div className="row nowrap" style={{ position: 'relative' }}>
          <Search size={16} style={{ position: 'absolute', left: 10, color: 'var(--muted)' }} />
          <Input style={{ paddingLeft: 32, width: 220 }} placeholder={t('ค้นหา...')} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {extraHead}
        {allowCreate && (
          <Button variant="primary" icon={Plus} onClick={() => setForm({ ...defaults })}>
            {t('เพิ่ม')}
          </Button>
        )}
      </PageHead>
      {loading ? (
        <Loading />
      ) : !rows.length ? (
        <Empty />
      ) : cards ? (
        <div className="grid grid-auto">
          {rows.map((r) => (
            <div key={r.id} className="card" style={{ padding: 0, overflow: 'hidden' }}>
              {cards(r)}
              <div className="row end" style={{ padding: '0 12px 12px' }}>
                {rowActions?.(r, reload)}
                {allowEdit && <Button size="sm" icon={Pencil} onClick={() => setForm(toForm(r))}>{t('แก้ไข')}</Button>}
                {allowDelete && <Button size="sm" variant="ghost" icon={Trash2} onClick={() => remove(r)} />}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c.key || c.label} className={c.right ? 'right' : ''}>{t(c.label)}</th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  {columns.map((c) => (
                    <td key={c.key || c.label} className={c.right ? 'right num' : ''}>
                      {c.render ? c.render(r) : c.type === 'money' ? money(r[c.key]) : c.type === 'image' ? <Img src={r[c.key]} style={{ width: 44, height: 44, borderRadius: 8, objectFit: 'cover' }} /> : c.type === 'bool' ? (r[c.key] ? '✓' : '—') : r[c.key]}
                    </td>
                  ))}
                  <td className="right nowrap">
                    {rowActions?.(r, reload)}
                    {allowEdit && <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setForm(toForm(r))} />}
                    {allowDelete && <Button size="sm" variant="ghost" icon={Trash2} onClick={() => remove(r)} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {form && (
        <Modal
          size={modalSize}
          title={`${form.id ? t('แก้ไข') : t('เพิ่ม')} ${t(title)}`}
          onClose={() => setForm(null)}
          footer={
            <>
              <Button onClick={() => setForm(null)}>{t('ยกเลิก')}</Button>
              <Button variant="primary" loading={saving} onClick={save}>
                {t('บันทึก')}
              </Button>
            </>
          }
        >
          <div className="grid grid-2">
            {fields.map((f) => (
              <FormField key={f.key} f={f} form={form} set={set} />
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}

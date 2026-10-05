import { Package, Plus, Trash2 } from 'lucide-react';
import { CrudPage } from '../../components/Crud.jsx';
import { Badge, Button, Input, Switch, money, useToast } from '../../components/ui.jsx';
import { useT } from '../../lib/i18n.jsx';
import { useLive } from '../../lib/socket.js';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/store.jsx';

function OptionsEditor({ value = [], onChange }) {
  const { t } = useT();
  const up = (i, k, v) => onChange(value.map((o, j) => (j === i ? { ...o, [k]: v } : o)));
  return (
    <div className="col">
      {value.map((o, i) => (
        <div key={i} className="row nowrap">
          <Input placeholder={t('กลุ่ม เช่น ความหวาน')} value={o.groupName} onChange={(e) => up(i, 'groupName', e.target.value)} />
          <Input placeholder={t('ชื่อตัวเลือก')} value={o.name} onChange={(e) => up(i, 'name', e.target.value)} />
          <Input type="number" style={{ width: 100 }} placeholder="+฿" value={o.priceDelta} onChange={(e) => up(i, 'priceDelta', e.target.value)} />
          <Switch checked={o.isAddon} onChange={(v) => up(i, 'isAddon', v)} label="Add-on" />
          <Button variant="ghost icon" icon={Trash2} onClick={() => onChange(value.filter((_, j) => j !== i))} />
        </div>
      ))}
      <Button size="sm" icon={Plus} onClick={() => onChange([...value, { groupName: 'ตัวเลือก', name: '', priceDelta: 0, isAddon: false }])}>
        {t('เพิ่มตัวเลือก / Add-on')}
      </Button>
    </div>
  );
}

export default function Products() {
  const { t } = useT();
  const toast = useToast();
  const { can } = useAuth();
  const { data: cats } = useLive(() => api.get('/categories'), ['products'], []);
  const catOpts = (cats || []).map((c) => ({ value: c.id, label: c.name }));
  const toggle = async (r, patch, reload) => {
    try {
      await api.patch(`/products/${r.id}/availability`, patch);
      reload();
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <CrudPage
      title="สินค้า"
      icon={Package}
      endpoint="/products"
      topics={['products']}
      createPerm="product.create"
      editPerm="product.edit"
      deletePerm="product.delete"
      searchKeys={['name', 'sku', 'barcode', 'category_name']}
      defaults={{ price: 0, cost: 0, unit: 'ชิ้น', trackStock: true, minStock: 0, isAvailable: true, isSoldOut: false, scExempt: false, pointsEligible: true, sortOrder: 0, options: [], initialStock: 0 }}
      toForm={(r) => ({ id: r.id, sku: r.sku, barcode: r.barcode, name: r.name, imageUrl: r.image_url, categoryId: r.category_id, description: r.description, price: r.price, cost: r.cost, unit: r.unit, trackStock: r.track_stock, minStock: r.min_stock, isAvailable: r.is_available, isSoldOut: r.is_sold_out, scExempt: r.sc_exempt, pointsEligible: r.points_eligible, note: r.note, sortOrder: r.sort_order, options: (r.options || []).map((o) => ({ id: o.id, groupName: o.group_name, name: o.name, priceDelta: o.price_delta, isAddon: o.is_addon })) })}
      toPayload={(f) => ({ ...f, categoryId: f.categoryId ? Number(f.categoryId) : null, cost: f.cost ?? 0 })}
      columns={[
        { key: 'image_url', label: 'รูป', type: 'image' },
        { key: 'sku', label: 'รหัส' },
        { label: 'ชื่อสินค้า', render: (r) => <div><b>{r.name}</b><div className="xs muted">{r.barcode}</div></div> },
        { label: 'หมวดหมู่', render: (r) => <Badge color={r.category_color}>{r.category_name || '-'}</Badge> },
        { key: 'price', label: 'ราคาขาย', type: 'money', right: true },
        ...(can('cost.view') ? [{ key: 'cost', label: 'ราคาทุน', type: 'money', right: true }] : []),
        { label: 'คงเหลือ', right: true, render: (r) => (r.track_stock ? <span style={{ color: Number(r.stock) <= Number(r.min_stock) ? 'var(--danger)' : undefined }}>{money(r.stock, 0)} {r.unit}</span> : '—') },
        { label: 'สถานะ', render: (r) => (r.is_sold_out ? <Badge color="#dc2626">{t('สินค้าหมด')}</Badge> : r.is_available ? <Badge color="#16a34a">{t('พร้อมขาย')}</Badge> : <Badge color="#6b7280">{t('ไม่พร้อมขาย')}</Badge>) },
      ]}
      rowActions={(r, reload) =>
        can('product.edit') && (
          <Button size="sm" variant="ghost" onClick={() => toggle(r, { isSoldOut: !r.is_sold_out }, reload)}>
            {r.is_sold_out ? t('มีสินค้า') : t('ของหมด')}
          </Button>
        )
      }
      fields={[
        { key: 'name', label: 'ชื่อสินค้า', required: true },
        { key: 'categoryId', label: 'หมวดหมู่', type: 'select', options: catOpts },
        { key: 'sku', label: 'รหัสสินค้า', required: true },
        { key: 'barcode', label: 'Barcode' },
        { key: 'imageUrl', label: 'รูปสินค้า (URL)', type: 'image', full: true },
        { key: 'price', label: 'ราคาขาย', type: 'money', required: true },
        { key: 'cost', label: 'ราคาทุน', type: 'money', hidden: () => !can('cost.view') },
        { key: 'unit', label: 'หน่วยสินค้า' },
        { key: 'sortOrder', label: 'ลำดับการแสดงผล', type: 'number' },
        { key: 'trackStock', label: 'ติดตามสต็อก', type: 'switch', switchLabel: 'เปิดติดตามสต็อก' },
        { key: 'minStock', label: 'สต็อกขั้นต่ำ', type: 'number', hidden: (f) => !f.trackStock },
        { key: 'initialStock', label: 'จำนวนสต็อกเริ่มต้น', type: 'number', hidden: (f) => f.id || !f.trackStock },
        { key: 'isAvailable', label: 'สถานะพร้อมขาย', type: 'switch', switchLabel: 'พร้อมขาย' },
        { key: 'isSoldOut', label: 'สถานะสินค้าหมด', type: 'switch', switchLabel: 'สินค้าหมด' },
        { key: 'scExempt', label: 'Service Charge', type: 'switch', switchLabel: 'ไม่คิด Service Charge' },
        { key: 'pointsEligible', label: 'คะแนนสมาชิก', type: 'switch', switchLabel: 'ให้คะแนน' },
        { key: 'options', label: 'ตัวเลือกสินค้า / Add-on', type: 'custom', full: true, render: (f, set) => <OptionsEditor value={f.options} onChange={(v) => set('options', v)} /> },
        { key: 'description', label: 'รายละเอียด', type: 'textarea' },
        { key: 'note', label: 'หมายเหตุ', type: 'textarea' },
      ]}
    />
  );
}

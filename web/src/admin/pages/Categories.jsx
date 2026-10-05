import { Tags } from 'lucide-react';
import { CrudPage } from '../../components/Crud.jsx';
import { Badge } from '../../components/ui.jsx';
import { useT } from '../../lib/i18n.jsx';

const STATIONS = [
  { value: 'NONE', label: 'ไม่ส่งครัว' },
  { value: 'KITCHEN', label: 'ครัว' },
  { value: 'BAR', label: 'บาร์' },
  { value: 'PREP', label: 'จุดเตรียมสินค้า' },
];

export default function Categories() {
  const { t } = useT();
  return (
    <CrudPage
      title="หมวดหมู่"
      icon={Tags}
      endpoint="/categories"
      topics={['products']}
      createPerm="product.create"
      editPerm="product.edit"
      deletePerm="product.delete"
      defaults={{ color: '#8b5cf6', station: 'NONE', sortOrder: 0, isActive: true }}
      toForm={(r) => ({ id: r.id, name: r.name, icon: r.icon, color: r.color, station: r.station, sortOrder: r.sort_order, isActive: r.is_active })}
      columns={[
        { label: 'หมวดหมู่', render: (r) => <Badge color={r.color} dot>{r.name}</Badge> },
        { label: 'ส่งคำสั่งไปที่', render: (r) => t(STATIONS.find((s) => s.value === r.station)?.label) },
        { key: 'product_count', label: 'จำนวนสินค้า', right: true },
        { key: 'sort_order', label: 'ลำดับ', right: true },
        { key: 'is_active', label: 'เปิดใช้งาน', type: 'bool' },
      ]}
      fields={[
        { key: 'name', label: 'ชื่อหมวดหมู่', required: true },
        { key: 'color', label: 'สี', type: 'color' },
        { key: 'station', label: 'เครื่องพิมพ์ปลายทาง (ใบสั่งอาหาร)', type: 'select', options: STATIONS, required: true },
        { key: 'sortOrder', label: 'ลำดับ', type: 'number' },
        { key: 'isActive', label: 'สถานะ', type: 'switch', switchLabel: 'เปิดใช้งาน' },
      ]}
      modalSize=""
    />
  );
}

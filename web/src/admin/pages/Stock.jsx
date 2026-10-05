import { useState } from 'react';
import { Boxes, Plus, ClipboardCheck, History } from 'lucide-react';
import { PageHead, Button, Modal, Field, Input, Select, Textarea, Badge, Tabs, Loading, Empty, money, useToast } from '../../components/ui.jsx';
import { useT } from '../../lib/i18n.jsx';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/store.jsx';
import { useLive } from '../../lib/socket.js';
import { STOCK_MOVEMENT_TYPES } from '@beatbox/shared/constants.js';
import { fmtDateTime } from '@beatbox/shared/format.js';

export default function Stock() {
  const { t } = useT();
  const toast = useToast();
  const { can } = useAuth();
  const [tab, setTab] = useState('balance');
  const [move, setMove] = useState(null);
  const [count, setCount] = useState(null);
  const { data: stock, loading, reload } = useLive(() => api.get('/stock'), ['products'], []);
  const { data: moves } = useLive(() => api.get('/stock/movements'), ['products'], [tab]);
  const low = (stock || []).filter((s) => s.is_low);
  const saveMove = async () => {
    try {
      await api.post('/stock/movements', { ...move, productId: Number(move.productId), quantity: Number(move.quantity) });
      toast.success('บันทึกเรียบร้อย');
      setMove(null);
      reload();
    } catch (e) {
      toast.error(e);
    }
  };
  const saveCount = async () => {
    try {
      const counts = Object.entries(count).filter(([, v]) => v !== '' && v != null).map(([productId, counted]) => ({ productId: Number(productId), counted: Number(counted) }));
      await api.post('/stock/count', { counts });
      toast.success('บันทึกการนับสต็อกเรียบร้อย');
      setCount(null);
      reload();
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <div>
      <PageHead icon={Boxes} title="สต็อก">
        {can('stock.manage') && <Button icon={ClipboardCheck} onClick={() => setCount({})}>{t('นับสต็อก')}</Button>}
        {can('stock.manage') && <Button variant="primary" icon={Plus} onClick={() => setMove({ type: 'IN', quantity: '', productId: '' })}>{t('ทำรายการสต็อก')}</Button>}
      </PageHead>
      {low.length > 0 && <div className="card flat mb" style={{ borderColor: 'var(--danger)' }}>⚠ {t('สินค้าเหลือต่ำกว่าสต็อกขั้นต่ำ')}: {low.map((s) => `${s.name} (${money(s.quantity, 0)})`).join(', ')}</div>}
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'balance', label: 'คงเหลือ' }, { value: 'history', label: 'ประวัติสต็อก' }]} />
      {loading ? <Loading /> : tab === 'balance' ? (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>{t('รหัส')}</th><th>{t('สินค้า')}</th><th>{t('หมวดหมู่')}</th><th className="right">{t('คงเหลือ')}</th><th className="right">{t('ขั้นต่ำ')}</th>{can('cost.view') && <th className="right">{t('มูลค่า')}</th>}<th>{t('อัปเดตล่าสุด')}</th></tr></thead>
            <tbody>
              {(stock || []).map((s) => (
                <tr key={s.id}>
                  <td>{s.sku}</td><td className="bold">{s.name}</td><td>{s.category_name}</td>
                  <td className="right num" style={{ color: s.is_low ? 'var(--danger)' : undefined }}>{money(s.quantity, 0)} {s.unit}</td>
                  <td className="right num">{money(s.min_stock, 0)}</td>
                  {can('cost.view') && <td className="right num">{money(s.quantity * s.cost)}</td>}
                  <td className="small">{fmtDateTime(s.updated_at)} {s.is_low && <Badge color="#dc2626">{t('ใกล้หมด')}</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : !moves?.length ? <Empty /> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>{t('วันเวลา')}</th><th>{t('สินค้า')}</th><th>{t('ประเภท')}</th><th className="right">{t('จำนวน')}</th><th className="right">{t('คงเหลือ')}</th><th>{t('อ้างอิง')}</th><th>{t('พนักงาน')}</th><th>{t('หมายเหตุ')}</th></tr></thead>
            <tbody>{moves.map((m) => <tr key={m.id}><td className="small nowrap">{fmtDateTime(m.created_at)}</td><td>{m.product_name}</td><td><Badge>{t(STOCK_MOVEMENT_TYPES[m.type] || m.type)}</Badge></td><td className="right num" style={{ color: m.quantity > 0 ? 'var(--ok)' : 'var(--danger)' }}>{m.quantity > 0 ? '+' : ''}{money(m.quantity, 0)}</td><td className="right num">{money(m.balance_after, 0)}</td><td>{m.reference}</td><td>{m.employee_name}</td><td className="small">{m.note}</td></tr>)}</tbody>
          </table>
        </div>
      )}
      {move && (
        <Modal title={t('ทำรายการสต็อก')} onClose={() => setMove(null)} footer={<Button variant="primary" onClick={saveMove} disabled={!move.productId || move.quantity === ''}>{t('บันทึก')}</Button>}>
          <div className="grid grid-2">
            <Field label="ประเภท"><Select value={move.type} onChange={(e) => setMove({ ...move, type: e.target.value })} options={['IN', 'OUT', 'ADJUST', 'DAMAGED', 'EXPIRED', 'RETURN'].map((k) => ({ value: k, label: STOCK_MOVEMENT_TYPES[k] }))} /></Field>
            <Field label="สินค้า"><Select value={move.productId} onChange={(e) => setMove({ ...move, productId: e.target.value })} options={(stock || []).map((s) => ({ value: s.id, label: `${s.name} (${money(s.quantity, 0)})` }))} placeholder="เลือกสินค้า" /></Field>
            <Field label={move.type === 'ADJUST' ? 'ปรับ +/- จำนวน' : 'จำนวน'}><Input type="number" value={move.quantity} onChange={(e) => setMove({ ...move, quantity: e.target.value })} /></Field>
            {move.type === 'IN' && can('cost.view') && <Field label="ราคาทุนต่อหน่วย"><Input type="number" value={move.unitCost || ''} onChange={(e) => setMove({ ...move, unitCost: e.target.value })} /></Field>}
            <Field label="เลขอ้างอิง"><Input value={move.reference || ''} onChange={(e) => setMove({ ...move, reference: e.target.value })} /></Field>
            <Field label="หมายเหตุ" style={{ gridColumn: '1/-1' }}><Textarea value={move.note || ''} onChange={(e) => setMove({ ...move, note: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
      {count && (
        <Modal title={t('นับสต็อก')} size="wide" onClose={() => setCount(null)} footer={<Button variant="primary" onClick={saveCount}>{t('บันทึกยอดนับ')}</Button>}>
          <div className="table-wrap"><table className="table"><thead><tr><th>{t('สินค้า')}</th><th className="right">{t('ในระบบ')}</th><th>{t('นับได้จริง')}</th></tr></thead>
            <tbody>{(stock || []).map((s) => <tr key={s.id}><td>{s.name}</td><td className="right">{money(s.quantity, 0)}</td><td><Input type="number" style={{ width: 120 }} value={count[s.id] ?? ''} onChange={(e) => setCount({ ...count, [s.id]: e.target.value })} /></td></tr>)}</tbody></table></div>
        </Modal>
      )}
    </div>
  );
}

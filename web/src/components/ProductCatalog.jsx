import { useState, useMemo, useEffect, useRef } from 'react';
import { Search, ScanLine } from 'lucide-react';
import { Input, Img, Modal, Button, Field, Textarea, money, useToast, Loading } from './ui.jsx';
import { useT } from '../lib/i18n.jsx';
import { api } from '../lib/api.js';
import { useLive } from '../lib/socket.js';

/** Product grid with category filter, name/code search and barcode-scanner support (keyboard wedge). */
export function ProductCatalog({ onAdd, compact }) {
  const { t } = useT();
  const toast = useToast();
  const { data: products, loading } = useLive(() => api.get('/products'), ['products'], []);
  const { data: cats } = useLive(() => api.get('/categories'), ['products'], []);
  const [cat, setCat] = useState('ALL');
  const [q, setQ] = useState('');
  const [opt, setOpt] = useState(null);
  const inputRef = useRef();
  const list = useMemo(() => {
    let l = (products || []).filter((p) => p.is_available);
    if (cat !== 'ALL') l = l.filter((p) => p.category_id === cat);
    if (q) {
      const s = q.toLowerCase();
      l = l.filter((p) => p.name.toLowerCase().includes(s) || p.sku.toLowerCase().includes(s) || (p.barcode || '').includes(s));
    }
    return l;
  }, [products, cat, q]);
  const out = (p) => p.is_sold_out || (p.track_stock && Number(p.stock) <= 0);
  const pick = (p) => {
    if (out(p)) return toast.warning(`${p.name} ${t('สินค้าหมด')}`);
    if ((p.options || []).length) setOpt({ product: p, selected: [], qty: 1, note: '' });
    else onAdd(p, 1, [], '');
  };
  // barcode scanners type quickly then press Enter
  const onEnter = async (e) => {
    if (e.key !== 'Enter' || !q.trim()) return;
    const exact = (products || []).find((p) => p.barcode === q.trim() || p.sku.toLowerCase() === q.trim().toLowerCase());
    if (exact) {
      pick(exact);
      setQ('');
      return;
    }
    try {
      const p = await api.get(`/products/barcode/${encodeURIComponent(q.trim())}`);
      pick(p);
      setQ('');
    } catch {
      if (list.length === 1) {
        pick(list[0]);
        setQ('');
      }
    }
  };
  useEffect(() => {
    if (!compact) inputRef.current?.focus();
  }, []);
  return (
    <div className="catalog" style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, height: '100%' }}>
      <div className="row nowrap" style={{ position: 'relative' }}>
        <Search size={18} style={{ position: 'absolute', left: 12, color: 'var(--muted)' }} />
        <Input ref={inputRef} style={{ paddingLeft: 38 }} placeholder={t('ค้นหาชื่อ / รหัส / สแกน Barcode')} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onEnter} />
        <ScanLine size={22} color="var(--muted)" />
      </div>
      <div className="cat-strip">
        <button className={`btn sm ${cat === 'ALL' ? 'primary' : ''}`} onClick={() => setCat('ALL')}>{t('ทั้งหมด')}</button>
        {(cats || []).filter((c) => c.is_active).map((c) => (
          <button key={c.id} className={`btn sm ${cat === c.id ? 'primary' : ''}`} style={cat === c.id ? undefined : { borderColor: c.color }} onClick={() => setCat(c.id)}>
            {c.name}
          </button>
        ))}
      </div>
      {loading ? <Loading /> : (
        <div className="product-grid" style={compact ? { maxHeight: '55vh' } : undefined}>
          {list.map((p) => (
            <div key={p.id} className={`product ${out(p) ? 'out' : ''}`} onClick={() => pick(p)}>
              <div className="img">
                <Img src={p.image_url} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                {out(p) && <div className="sold">{t('สินค้าหมด')}</div>}
              </div>
              <div className="info">
                <div className="ellipsis bold small">{p.name}</div>
                <div className="row between">
                  <span className="price">฿{money(p.price, 0)}</span>
                  {p.track_stock && <span className="xs muted">{t('เหลือ')} {money(p.stock, 0)}</span>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {opt && (
        <Modal
          title={opt.product.name}
          onClose={() => setOpt(null)}
          footer={<Button variant="primary" onClick={() => { onAdd(opt.product, opt.qty, opt.selected, opt.note); setOpt(null); }}>{t('เพิ่มลงตะกร้า')}</Button>}
        >
          {Object.entries((opt.product.options || []).reduce((g, o) => ((g[o.group_name] ||= []).push(o), g), {})).map(([g, os]) => (
            <Field key={g} label={g}>
              <div className="row">
                {os.map((o) => {
                  const on = opt.selected.includes(o.id);
                  return (
                    <Button key={o.id} size="sm" variant={on ? 'primary' : ''} onClick={() => setOpt({ ...opt, selected: on ? opt.selected.filter((x) => x !== o.id) : [...opt.selected.filter((x) => o.is_addon || !os.some((y) => y.id === x)), o.id] })}>
                      {o.name} {Number(o.price_delta) ? `+${money(o.price_delta, 0)}` : ''}
                    </Button>
                  );
                })}
              </div>
            </Field>
          ))}
          <div className="grid grid-2 mt">
            <Field label="จำนวน"><Input type="number" min={1} value={opt.qty} onChange={(e) => setOpt({ ...opt, qty: Number(e.target.value) || 1 })} /></Field>
            <Field label="หมายเหตุ"><Textarea style={{ minHeight: 42 }} value={opt.note} onChange={(e) => setOpt({ ...opt, note: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
    </div>
  );
}

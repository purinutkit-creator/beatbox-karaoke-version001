import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, CheckCircle2, AlertTriangle, Info, XCircle, ImageOff, KeyRound, Delete } from 'lucide-react';
import QRCodeLib from 'qrcode';
import JsBarcode from 'jsbarcode';
import { useT, translate, translatePhrase } from '../lib/i18n.jsx';
import { api } from '../lib/api.js';
import { formatMoney } from '@beatbox/shared/money.js';

export const money = (n, d = 2) => formatMoney(n, { decimals: d });
export const baht = (n, d = 2) => `฿${formatMoney(n, { decimals: d })}`;

export function Button({ variant = '', size = '', block, icon: Icon, loading, children, className = '', ...p }) {
  return (
    <button className={`btn ${variant} ${size} ${block ? 'block' : ''} ${className}`} disabled={loading || p.disabled} {...p}>
      {loading ? <span className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} /> : Icon ? <Icon size={size === 'lg' || size === 'xl' ? 22 : 18} /> : null}
      {children}
    </button>
  );
}

export function Modal({ open = true, onClose, title, children, footer, size = '', closeOnBack = true }) {
  useEffect(() => {
    if (!open) return;
    const h = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && closeOnBack && onClose?.()}>
      <div className={`modal ${size}`} role="dialog">
        {title != null && (
          <div className="modal-head">
            <h3>{title}</h3>
            {onClose && <Button variant="ghost icon" icon={X} onClick={onClose} aria-label="close" />}
          </div>
        )}
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Drawer({ onClose, title, children, footer, actions }) {
  return createPortal(
    <>
      <div className="drawer-back" onClick={onClose} />
      <div className="drawer">
        <div className="modal-head">
          <h3 className="grow">{title}</h3>
          {actions}
          <Button variant="ghost icon" icon={X} onClick={onClose} />
        </div>
        <div className="modal-body" style={{ flex: 1 }}>
          {children}
        </div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </>,
    document.body,
  );
}

export function Field({ label, hint, children, style, className = '' }) {
  const { t } = useT();
  return (
    <div className={`field ${className}`} style={style}>
      {label && <label>{typeof label === 'string' ? t(label) : label}</label>}
      {children}
      {hint && <span className="hint">{typeof hint === 'string' ? t(hint) : hint}</span>}
    </div>
  );
}

export const Input = ({ className = '', ...p }) => <input className={`input ${className}`} {...p} />;
export const Textarea = ({ className = '', ...p }) => <textarea className={`input ${className}`} {...p} />;
export function Select({ options = [], className = '', placeholder, ...p }) {
  const { t } = useT();
  return (
    <select className={`input ${className}`} {...p}>
      {placeholder != null && <option value="">{t(placeholder)}</option>}
      {options.map((o) => {
        const v = typeof o === 'object' ? o.value : o;
        const l = typeof o === 'object' ? o.label : o;
        return (
          <option key={v} value={v}>
            {t(l)}
          </option>
        );
      })}
    </select>
  );
}

export function Switch({ checked, onChange, label, disabled }) {
  const { t } = useT();
  return (
    <label className="check">
      <span className="switch">
        <input type="checkbox" checked={!!checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span />
      </span>
      {label && <span>{t(label)}</span>}
    </label>
  );
}

export function Seg({ value, onChange, options }) {
  const { t } = useT();
  return (
    <div className="seg">
      {options.map((o) => {
        const v = typeof o === 'object' ? o.value : o;
        return (
          <button key={v} type="button" className={value === v ? 'on' : ''} onClick={() => onChange(v)}>
            {t(typeof o === 'object' ? o.label : o)}
          </button>
        );
      })}
    </div>
  );
}

export function Tabs({ value, onChange, tabs }) {
  const { t } = useT();
  return (
    <div className="tabs">
      {tabs.map((x) => (
        <button key={x.value} className={value === x.value ? 'on' : ''} onClick={() => onChange(x.value)}>
          {t(x.label)}
          {x.count ? <span className="badge" style={{ marginLeft: 6 }}>{x.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Badge({ color, children, dot }) {
  const style = color ? { background: `${color}26`, color } : undefined;
  return (
    <span className={`badge ${dot ? 'dot' : ''}`} style={style}>
      {children}
    </span>
  );
}

export const Spinner = ({ lg }) => <span className={`spinner ${lg ? 'lg' : ''}`} />;

export function Loading({ text = 'กำลังโหลด...' }) {
  const { t } = useT();
  return (
    <div className="row" style={{ justifyContent: 'center', padding: 40 }}>
      <Spinner /> <span className="muted">{t(text)}</span>
    </div>
  );
}

export function Empty({ icon: Icon = Info, text = 'ไม่มีข้อมูล', children }) {
  const { t } = useT();
  return (
    <div className="center muted" style={{ padding: 40 }}>
      <Icon size={40} style={{ opacity: 0.5 }} />
      <div style={{ marginTop: 8 }}>{t(text)}</div>
      {children}
    </div>
  );
}

export function Img({ src, alt = '', style, className, fallback }) {
  const [err, setErr] = useState(false);
  useEffect(() => setErr(false), [src]);
  if (!src || err) return fallback || <div className={className} style={{ ...style, display: 'grid', placeItems: 'center', background: 'var(--surface-2)', color: 'var(--muted)' }}><ImageOff size={22} /></div>;
  return <img src={src} alt={alt} style={style} className={className} onError={() => setErr(true)} loading="lazy" />;
}

/** Image input — images are always added by URL (no uploads for content images). */
export function ImageUrlInput({ value, onChange, placeholder = 'https://...' }) {
  const { t } = useT();
  return (
    <div className="row nowrap">
      <Img src={value} style={{ width: 54, height: 54, borderRadius: 10, objectFit: 'cover', flex: 'none' }} />
      <Input value={value || ''} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} title={t('ใส่ URL รูปภาพเท่านั้น')} />
    </div>
  );
}

export function QRCode({ value, size = 220, className, style }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!value) return setUrl('');
    QRCodeLib.toDataURL(String(value), { margin: 1, width: size * 2, errorCorrectionLevel: 'M' }).then(setUrl).catch(() => setUrl(''));
  }, [value, size]);
  if (!url) return null;
  return <img src={url} width={size} height={size} alt="QR" className={className} style={{ background: '#fff', borderRadius: 8, ...style }} />;
}

export function Barcode({ value, height = 50, className, displayValue = true }) {
  const ref = useRef();
  useEffect(() => {
    if (!ref.current || !value) return;
    try {
      JsBarcode(ref.current, String(value), { format: 'CODE128', height, width: 1.6, margin: 4, displayValue, fontSize: 12, background: '#ffffff' });
    } catch {
      /* invalid */
    }
  }, [value, height, displayValue]);
  return <svg ref={ref} className={className} />;
}

// ───── Toasts ─────
const ToastCtx = createContext(null);
export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((type, msg, opts = {}) => {
    const id = Math.random();
    setItems((x) => [...x, { id, type, msg: translatePhrase(msg), title: opts.title ? translatePhrase(opts.title) : null }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), opts.duration || 4000);
  }, []);
  const api2 = {
    success: (m, o) => push('success', m, o),
    error: (m, o) => push('error', m?.message || m, o),
    warning: (m, o) => push('warning', m, o),
    info: (m, o) => push('info', m, o),
  };
  const Icon = { success: CheckCircle2, error: XCircle, warning: AlertTriangle, info: Info };
  return (
    <ToastCtx.Provider value={api2}>
      {children}
      {createPortal(
        <div className="toasts">
          {items.map((i) => {
            const I = Icon[i.type];
            return (
              <div key={i.id} className={`toast ${i.type}`}>
                <I size={20} style={{ flex: 'none', marginTop: 2 }} />
                <div>
                  {i.title && <div className="bold">{i.title}</div>}
                  <div>{i.msg}</div>
                </div>
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

// ───── Dialogs: confirm / prompt (reason) / manager approval ─────
const DialogCtx = createContext(null);
export function DialogProvider({ children }) {
  const [dlg, setDlg] = useState(null);
  const [value, setValue] = useState('');
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const { t } = useT();
  const confirm = (opts) =>
    new Promise((resolve) => {
      setValue(opts.defaultValue || '');
      setDlg({ kind: 'confirm', ...opts, resolve });
    });
  const prompt = (opts) =>
    new Promise((resolve) => {
      setValue(opts.defaultValue || '');
      setDlg({ kind: 'prompt', ...opts, resolve });
    });
  const approve = (permission, reason) =>
    new Promise((resolve) => {
      setPin('');
      setErr('');
      setDlg({ kind: 'approve', permission, reason, resolve });
    });
  const close = (v) => {
    dlg?.resolve(v);
    setDlg(null);
  };
  const submitPin = async (p) => {
    setBusy(true);
    try {
      const r = await api.post('/auth/approve', { pin: p, permission: dlg.permission, reason: dlg.reason });
      close(r.approvalToken);
    } catch (e) {
      setErr(e.message);
      setPin('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <DialogCtx.Provider value={{ confirm, prompt, approve }}>
      {children}
      {dlg?.kind === 'confirm' && (
        <Modal
          title={t(dlg.title || 'ยืนยันการทำรายการ')}
          onClose={() => close(false)}
          footer={
            <>
              <Button onClick={() => close(false)}>{t('ยกเลิก')}</Button>
              <Button variant={dlg.danger ? 'danger' : 'primary'} onClick={() => close(true)} autoFocus>
                {t(dlg.okText || 'ยืนยัน')}
              </Button>
            </>
          }
        >
          <div className="row nowrap" style={{ alignItems: 'flex-start' }}>
            <AlertTriangle size={28} color={dlg.danger ? 'var(--danger)' : 'var(--warn)'} style={{ flex: 'none' }} />
            <div style={{ whiteSpace: 'pre-line' }}>{typeof dlg.message === 'string' ? t(dlg.message) : dlg.message}</div>
          </div>
        </Modal>
      )}
      {dlg?.kind === 'prompt' && (
        <Modal
          title={t(dlg.title || 'ระบุข้อมูล')}
          onClose={() => close(null)}
          footer={
            <>
              <Button onClick={() => close(null)}>{t('ยกเลิก')}</Button>
              <Button variant={dlg.danger ? 'danger' : 'primary'} disabled={dlg.required !== false && !value.trim()} onClick={() => close(value.trim())}>
                {t(dlg.okText || 'ยืนยัน')}
              </Button>
            </>
          }
        >
          {dlg.message && <p>{t(dlg.message)}</p>}
          {dlg.options ? (
            <div className="col">
              {dlg.options.map((o) => (
                <Button key={o} variant={value === o ? 'primary' : ''} onClick={() => setValue(o)}>
                  {t(o)}
                </Button>
              ))}
              <Input placeholder={t('หรือระบุเอง')} value={dlg.options.includes(value) ? '' : value} onChange={(e) => setValue(e.target.value)} />
            </div>
          ) : (
            <Input autoFocus type={dlg.type || 'text'} placeholder={t(dlg.placeholder || '')} value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && value.trim() && close(value.trim())} />
          )}
        </Modal>
      )}
      {dlg?.kind === 'approve' && (
        <Modal title={t('ต้องได้รับอนุมัติจากผู้จัดการ')} onClose={() => close(null)}>
          <div className="center">
            <KeyRound size={36} color="var(--primary)" />
            <p className="muted">{t('ให้ผู้จัดการกรอกรหัสพนักงาน 4 หลักเพื่ออนุมัติ')}</p>
            <PinPad value={pin} onChange={setPin} onComplete={submitPin} busy={busy} />
            {err && <p style={{ color: 'var(--danger)' }}>{err}</p>}
          </div>
        </Modal>
      )}
    </DialogCtx.Provider>
  );
}
export const useDialog = () => useContext(DialogCtx);

export function PinPad({ value, onChange, onComplete, length = 4, busy }) {
  const press = (d) => {
    if (busy) return;
    const v = (value + d).slice(0, length);
    onChange(v);
    if (v.length === length) onComplete?.(v);
  };
  useEffect(() => {
    const h = (e) => {
      if (/^\d$/.test(e.key)) press(e.key);
      if (e.key === 'Backspace') onChange(value.slice(0, -1));
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });
  return (
    <div>
      <div className="pin-dots">
        {Array.from({ length }).map((_, i) => (
          <span key={i} className={i < value.length ? 'on' : ''} />
        ))}
      </div>
      <div className="numpad" style={{ maxWidth: 300, margin: '0 auto' }}>
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'].map((k) => (
          <button key={k} type="button" disabled={busy} onClick={() => (k === 'C' ? onChange('') : k === '⌫' ? onChange(value.slice(0, -1)) : press(k))}>
            {k === '⌫' ? <Delete size={22} /> : k}
          </button>
        ))}
      </div>
    </div>
  );
}

export function NumPad({ value, onChange }) {
  const press = (k) => {
    let v = String(value ?? '');
    if (k === 'C') v = '';
    else if (k === '⌫') v = v.slice(0, -1);
    else if (k === '.' && v.includes('.')) return;
    else v = v === '0' && k !== '.' ? k : v + k;
    onChange(v);
  };
  return (
    <div className="numpad">
      {['7', '8', '9', '4', '5', '6', '1', '2', '3', '.', '0', '⌫'].map((k) => (
        <button key={k} type="button" onClick={() => press(k)}>
          {k === '⌫' ? <Delete size={22} /> : k}
        </button>
      ))}
    </div>
  );
}

/**
 * Run an API action that may need manager approval (server answers 409 APPROVAL_REQUIRED).
 */
export function useApprovalAction() {
  const { approve } = useDialog();
  return async (fn, permission = 'discount.approve', reason) => {
    try {
      return await fn(null);
    } catch (e) {
      if (e.code === 'APPROVAL_REQUIRED') {
        const tok = await approve(permission, reason);
        if (!tok) throw Object.assign(new Error(translate('ยกเลิกการอนุมัติ')), { cancelled: true });
        return fn(tok);
      }
      throw e;
    }
  };
}

export function StatCard({ icon: Icon, label, value, sub, color }) {
  const { t } = useT();
  return (
    <div className="card kpi">
      <div className="label">
        {Icon && <Icon size={16} color={color} />}
        {t(label)}
      </div>
      <div className="value" style={color ? { color } : undefined}>
        {value}
      </div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

export function PageHead({ icon: Icon, title, children }) {
  const { t } = useT();
  return (
    <div className="page-head">
      <h1>
        {Icon && <Icon size={26} color="var(--primary)" />}
        {t(title)}
      </h1>
      <div className="row">{children}</div>
    </div>
  );
}

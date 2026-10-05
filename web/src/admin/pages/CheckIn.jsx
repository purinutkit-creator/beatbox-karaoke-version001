import { useEffect, useRef, useState } from 'react';
import { ScanLine, Search, Camera, Phone } from 'lucide-react';
import { PageHead, Input, Button, Empty, Badge, money, useToast } from '../../components/ui.jsx';
import { ReservationDrawer, StatusBadge } from '../../components/ReservationParts.jsx';
import { useT } from '../../lib/i18n.jsx';
import { api } from '../../lib/api.js';
import { fmtDate, fmtTime } from '@beatbox/shared/format.js';

/** Staff check-in: scan the customer's booking QR/barcode, or type booking number / phone number. */
export default function CheckIn() {
  const { t } = useT();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [rows, setRows] = useState(null);
  const [open, setOpen] = useState(null);
  const [camera, setCamera] = useState(false);
  const videoRef = useRef();
  const inputRef = useRef();
  const search = async (value = q) => {
    if (!value.trim()) return;
    try {
      const r = await api.get(`/reservations/lookup?q=${encodeURIComponent(value.trim())}`);
      setRows(r);
      if (r.length === 1) setOpen(r[0].id);
    } catch (e) {
      toast.error(e);
    }
  };
  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => {
    if (!camera) return;
    let stream;
    let stop = false;
    (async () => {
      try {
        if (!('BarcodeDetector' in window)) throw new Error(t('อุปกรณ์นี้ไม่รองรับการสแกนด้วยกล้อง กรุณาใช้เครื่องสแกนหรือพิมพ์เลขที่จอง'));
        const det = new window.BarcodeDetector({ formats: ['qr_code', 'code_128'] });
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        while (!stop) {
          const codes = await det.detect(videoRef.current).catch(() => []);
          if (codes[0]) {
            setQ(codes[0].rawValue);
            setCamera(false);
            search(codes[0].rawValue);
            break;
          }
          await new Promise((r) => setTimeout(r, 300));
        }
      } catch (e) {
        toast.error(e.message);
        setCamera(false);
      }
    })();
    return () => {
      stop = true;
      stream?.getTracks().forEach((tr) => tr.stop());
    };
  }, [camera]);
  return (
    <div>
      <PageHead icon={ScanLine} title="Check-in / ค้นหาการจอง" />
      <div className="card">
        <p className="muted">{t('สแกน QR Code / Barcode การจองของลูกค้า หรือพิมพ์เลขที่จอง / เบอร์โทรศัพท์ที่ใช้จอง')}</p>
        <div className="row nowrap">
          <Input ref={inputRef} className="lg" placeholder={t('เลขที่จอง เช่น BK20261005001 หรือ เบอร์โทร')} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} />
          <Button size="lg" variant="primary" icon={Search} onClick={() => search()}>{t('ค้นหา')}</Button>
          <Button size="lg" icon={Camera} onClick={() => setCamera(!camera)} />
        </div>
        {camera && <video ref={videoRef} style={{ width: '100%', maxWidth: 420, marginTop: 12, borderRadius: 12 }} muted playsInline />}
      </div>
      <div className="col mt">
        {rows && !rows.length && <Empty text="ไม่พบการจอง" />}
        {rows?.map((r) => (
          <div key={r.id} className="card row between clickable" style={{ cursor: 'pointer' }} onClick={() => setOpen(r.id)}>
            <div>
              <div className="row"><b style={{ fontSize: '1.15rem' }}>{r.booking_no}</b><StatusBadge status={r.status} /><Badge>{r.source}</Badge></div>
              <div>{r.customer_name} · <Phone size={13} /> {r.phone} {r.member_code && <Badge color="#eab308">{r.member_code}</Badge>}</div>
              <div className="small muted">{r.room_name} ({r.type_name}) · {fmtDate(r.start_at)} {fmtTime(r.start_at)}–{fmtTime(r.end_at)} · {r.guest_count} {t('คน')} · {r.package_name || t('รายชั่วโมง')}</div>
            </div>
            <div className="right">
              <div className="small muted">{t('มัดจำ')}</div>
              <b>฿{money(r.deposit_paid)}</b>
              <div className="xs muted">{r.payment_status || ''}</div>
            </div>
          </div>
        ))}
      </div>
      {open && <ReservationDrawer id={open} onClose={() => setOpen(null)} onChanged={() => search()} />}
    </div>
  );
}

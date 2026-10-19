import { useEffect, useRef, useState } from 'react';
import { ScanLine, Search, Camera, MonitorSmartphone } from 'lucide-react';
import { PageHead, Input, Button, Empty, useToast } from '../../components/ui.jsx';
import { ReservationDrawer } from '../../components/ReservationParts.jsx';
import { BookingCard, bookingCardData } from '../../components/BookingCard.jsx';
import { useT } from '../../lib/i18n.jsx';
import { api, uid } from '../../lib/api.js';
import { useCameraScanner, useScannerWedge } from '../../lib/scanner.js';
import { useSocketEvent } from '../../lib/socket.js';
import { pushDisplay, idleDisplay, getPairCode } from '../../lib/display.js';

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
      return r;
    } catch (e) {
      toast.error(e);
      return null;
    }
  };
  useEffect(() => inputRef.current?.focus(), []);
  // a USB / Bluetooth barcode scanner works even when the cursor is not in the search box
  useScannerWedge((code) => {
    setQ(code);
    search(code);
  });
  useCameraScanner(videoRef, camera, (v) => { setQ(v); setCamera(false); search(v); }, (e) => { toast.error(t(e.message)); setCamera(false); });

  // Customer checks in on the Customer Display (camera scan or phone number) → result comes back here
  const [displayReq, setDisplayReq] = useState(null);
  const askDisplay = () => {
    const requestId = uid();
    setDisplayReq(requestId);
    pushDisplay({ mode: 'CHECKIN', requestId });
    toast.info('ให้ลูกค้าสแกน QR การจองหรือกรอกเบอร์โทรที่จอลูกค้า');
  };
  useSocketEvent('display:checkin', async (m) => {
    if (!displayReq || m.requestId !== displayReq || m.code !== getPairCode()) return;
    setQ(m.value);
    const r = await search(m.value);
    const rv = r?.find((x) => ['PENDING', 'CONFIRMED', 'DEPOSIT_PAID', 'WAITING', 'ARRIVED'].includes(x.status)) || r?.[0];
    pushDisplay(rv ? { mode: 'CHECKIN_RESULT', requestId: displayReq, found: true, booking: bookingCardData(rv) } : { mode: 'CHECKIN_RESULT', requestId: displayReq, found: false });
    setDisplayReq(null);
    setTimeout(() => idleDisplay(), rv ? 20000 : 10000);
  });
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
        <div className="row mt">
          <Button icon={MonitorSmartphone} variant={displayReq ? 'primary' : ''} onClick={displayReq ? () => { setDisplayReq(null); idleDisplay(); } : askDisplay}>
            {displayReq ? t('ยกเลิก — รอลูกค้าที่จอลูกค้า...') : t('ให้ลูกค้าสแกน QR / กรอกเบอร์ที่จอลูกค้า')}
          </Button>
        </div>
        {camera && <video ref={videoRef} style={{ width: '100%', maxWidth: 420, marginTop: 12, borderRadius: 12 }} muted playsInline />}
      </div>
      <div className="col mt">
        {rows && !rows.length && <Empty text="ไม่พบการจอง" />}
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 340px), 1fr))', gap: 14 }}>
          {rows?.map((r) => <BookingCard key={r.id} b={bookingCardData(r)} onClick={() => setOpen(r.id)} />)}
        </div>
      </div>
      {open && <ReservationDrawer id={open} onClose={() => setOpen(null)} onChanged={() => search()} />}
    </div>
  );
}

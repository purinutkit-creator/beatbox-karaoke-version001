// On-screen views of printed documents (same builder and layout as printing; real text, real paper width).
// To print, pass a document descriptor { docType, data, isCopy } to usePrint().print / preview.
import { buildDoc } from '../lib/docs.js';
import { paperGeometry, DRIVER_FALLBACK } from '../lib/print.jsx';
import { DocView } from './DocView.jsx';
import { usePrint } from './PrintPreview.jsx';
import { useAuth } from '../lib/store.jsx';

export function DocScreen({ docType, data, isCopy, printer, layouts }) {
  const pr = usePrint();
  const auth = useAuth();
  if (!data) return null;
  const p = printer || pr?.printerFor?.(docType, data.station) || DRIVER_FALLBACK;
  const sections = buildDoc(docType, data, { isCopy, layouts: layouts || auth?.settings?.documents?.layouts });
  return <DocView sections={sections} geometry={paperGeometry(p)} />;
}

export const SaleReceipt = ({ snap, isCopy, layouts, printer }) => <DocScreen docType="RECEIPT" data={snap} isCopy={isCopy} layouts={layouts} printer={printer} />;
export const KitchenTicket = ({ ticket }) => <DocScreen docType="KITCHEN" data={ticket} />;
export const RoomTicket = ({ data, copy = 'STAFF' }) => <DocScreen docType={copy === 'CUSTOMER' ? 'ROOM_TICKET_CUSTOMER' : 'ROOM_TICKET_STAFF'} data={data} />;

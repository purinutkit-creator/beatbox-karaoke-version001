// Print the two room-open tickets (store copy + customer copy with the in-room ordering QR).
import { api } from './api.js';
import { RoomTicket } from '../components/Receipt.jsx';
import { usePrint } from '../components/PrintPreview.jsx';
import { useToast } from '../components/ui.jsx';

export function usePrintRoomTickets() {
  const { printNow, preview, defaultPrinter } = usePrint();
  const toast = useToast();
  /** auto = called right after opening a room (respects the "print on open" setting). */
  return async (sessionId, { auto = false, only = null } = {}) => {
    try {
      const data = await api.get(`/sessions/${sessionId}/ticket`);
      const tk = data.ticket || {};
      if (auto && tk.printOnOpen === false) return;
      const copies = [];
      if ((only ? only === 'STORE' : tk.storeCopy !== false)) copies.push('STORE');
      if ((only ? only === 'CUSTOMER' : tk.customerCopy !== false)) copies.push('CUSTOMER');
      if (!copies.length) return;
      const opts = { jobType: 'ROOM_TICKET', reference: data.sessionNo, drawer: false, copies: 1, title: 'ใบเปิดห้อง' };
      const browser = (defaultPrinter('MAIN')?.connection || 'BROWSER') === 'BROWSER';
      if (!auto || browser) {
        // one print job: both tickets on separate pages (one OS print dialog)
        const el = (
          <>
            {copies.map((copy, i) => (
              <div key={copy} style={i < copies.length - 1 ? { pageBreakAfter: 'always', breakAfter: 'page' } : undefined}>
                <RoomTicket data={data} copy={copy} />
              </div>
            ))}
          </>
        );
        if (auto) await printNow(el, opts);
        else preview(el, opts);
        return;
      }
      // thermal printers: one job per ticket so the paper is cut between them
      for (const copy of copies) await printNow(<RoomTicket data={data} copy={copy} />, { ...opts, reference: `${data.sessionNo}-${copy}` });
    } catch (e) {
      toast.error(e);
    }
  };
}

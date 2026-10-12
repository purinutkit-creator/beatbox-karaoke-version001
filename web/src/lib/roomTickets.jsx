// Room tickets: customer copy (with the one-time ordering QR) + staff copy, and the time-adjustment slip.
// Data always comes from the real session on the server (start / end / extensions / opener / ref no).
import { api } from './api.js';
import { usePrint } from '../components/PrintPreview.jsx';
import { useToast } from '../components/ui.jsx';

export function usePrintRoomTickets() {
  const { print, preview } = usePrint();
  const toast = useToast();
  /** auto = right after the room starts (respects the ticket + routing settings); only = 'CUSTOMER' | 'STAFF'. */
  return async (sessionId, { auto = false, only = null } = {}) => {
    try {
      const data = await api.get(`/sessions/${sessionId}/ticket`);
      const tk = data.ticket || {};
      if (auto && tk.printOnOpen === false) return;
      const docs = [];
      if (only ? only === 'CUSTOMER' : tk.customerCopy !== false) docs.push({ docType: 'ROOM_TICKET_CUSTOMER', data });
      if (only ? only === 'STAFF' : tk.storeCopy !== false) docs.push({ docType: 'ROOM_TICKET_STAFF', data });
      if (!docs.length) return;
      // both tickets are one job → they print together, in order, on the same printer
      if (auto) await print(docs, { reference: data.refNo || data.sessionNo, clientJobId: `tickets:${data.sessionId}:${new Date(data.startAt).getTime()}` });
      else preview(docs, { reference: data.refNo || data.sessionNo, title: 'ใบเปิดห้อง' });
    } catch (e) {
      toast.error(e);
    }
  };
}

/** Time-adjustment slip for one adjustment (or the latest one). */
export function usePrintTimeAdjust() {
  const { print, preview } = usePrint();
  const toast = useToast();
  return async (sessionId, { adjustmentId = null, auto = false } = {}) => {
    try {
      const data = await api.get(`/sessions/${sessionId}/ticket`);
      const list = (data.adjustments || []).filter((a) => ['EXTEND', 'ADJUST'].includes(a.type));
      const adjust = adjustmentId ? list.find((a) => a.id === adjustmentId) : list[list.length - 1];
      if (!adjust) return;
      const doc = { docType: 'TIME_ADJUST', data: { ...data, adjust } };
      if (auto) await print(doc, { reference: data.refNo, clientJobId: `adjust:${adjust.id}` });
      else preview(doc, { reference: data.refNo, clientJobId: `adjust:${adjust.id}:${Date.now()}` });
    } catch (e) {
      toast.error(e);
    }
  };
}

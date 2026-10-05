import { useState } from 'react';
import { LayoutDashboard, DollarSign, DoorOpen, Package, Banknote, QrCode, Wallet, Receipt, Users, UserPlus, Clock, Timer, TrendingUp, Trophy, AlertTriangle, CalendarClock, Globe, Percent, Gift, Coins, Star } from 'lucide-react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, LineChart, Line, PieChart, Pie, Cell, Legend, AreaChart, Area } from 'recharts';
import { PageHead, StatCard, Input, Loading, money } from '../../components/ui.jsx';
import { useT } from '../../lib/i18n.jsx';
import { api } from '../../lib/api.js';
import { useLive } from '../../lib/socket.js';
import { bkkDateStr } from '@beatbox/shared/format.js';
import { PAYMENT_METHODS } from '@beatbox/shared/constants.js';

const PALETTE = ['#8b5cf6', '#ec4899', '#22c55e', '#3b82f6', '#f97316', '#eab308', '#14b8a6', '#ef4444'];
const tip = { contentStyle: { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, color: 'var(--text)' } };

function ChartCard({ title, children, height = 260 }) {
  const { t } = useT();
  return (
    <div className="card">
      <div className="card-title">{t(title)}</div>
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">{children}</ResponsiveContainer>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { t } = useT();
  const [date, setDate] = useState(bkkDateStr());
  const { data, loading } = useLive(() => api.get(`/dashboard?date=${date}`, { passive: true }), ['orders', 'rooms', 'reservations', 'dashboard'], [date], { poll: 60000 });
  if (loading || !data) return <Loading />;
  const k = data.kpi;
  const c = data.charts;
  const fmtDay = (d) => String(d).slice(5, 10);
  return (
    <div>
      <PageHead icon={LayoutDashboard} title="Dashboard">
        <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: 170 }} />
      </PageHead>
      <div className="grid grid-4">
        <StatCard icon={DollarSign} label="ยอดขายรวม" value={`฿${money(k.totalSales, 0)}`} color="var(--primary)" sub={`${t('ยอดเฉลี่ยต่อบิล')} ฿${money(k.avgBill, 0)}`} />
        <StatCard icon={DoorOpen} label="ยอดขายค่าห้อง" value={`฿${money(k.roomSales, 0)}`} />
        <StatCard icon={Package} label="ยอดขายสินค้า" value={`฿${money(k.productSales, 0)}`} />
        <StatCard icon={Receipt} label="จำนวนใบเสร็จ" value={k.receipts} />
        <StatCard icon={Banknote} label="ยอดเงินสด" value={`฿${money(k.cash, 0)}`} />
        <StatCard icon={QrCode} label="ยอด QR Code" value={`฿${money(k.qr, 0)}`} sub={`${t('โอน')} ${money(k.transfer, 0)} · ${t('บัตร')} ${money(k.card, 0)}`} />
        <StatCard icon={Wallet} label="ยอดมัดจำ" value={`฿${money(k.deposits, 0)}`} sub={`${t('ออนไลน์')} ฿${money(k.onlineDeposits, 0)}`} />
        <StatCard icon={Users} label="จำนวนลูกค้า" value={k.customers} sub={`${t('สมาชิกใหม่')} ${k.newMembers}`} />
        <StatCard icon={DoorOpen} label="ห้องที่ใช้งาน" value={k.roomsInUse} color="#db2777" sub={`${t('ว่าง')} ${k.roomsAvailable} · ${t('จอง')} ${k.roomsReserved} · ${t('ทำความสะอาด')} ${k.roomsCleaning}`} />
        <StatCard icon={AlertTriangle} label="ใกล้หมดเวลา / หมดเวลา" value={`${k.roomsNearEnd} / ${k.roomsTimeUp}`} color="var(--warn)" />
        <StatCard icon={Clock} label="ชั่วโมงที่ขายได้" value={k.hoursSold} sub={`${k.halfHourBlocks} ${t('ช่วง 30 นาที')}`} />
        <StatCard icon={Trophy} label="ห้องที่สร้างรายได้สูงสุด" value={k.topRoom?.name || '-'} sub={k.topRoom ? `฿${money(k.topRoom.amount, 0)}` : ''} />
        <StatCard icon={Globe} label="Online Booking วันนี้ / เดือนนี้" value={`${k.onlineToday} / ${k.onlineMonth}`} sub={`Conversion ${k.conversionRate}%`} />
        <StatCard icon={CalendarClock} label="Booking ยังไม่ชำระ / ยืนยันแล้ว" value={`${k.unpaidBookings} / ${k.confirmedBookings}`} />
        <StatCard icon={Percent} label="Cancellation / No-show (30 วัน)" value={`${k.cancellationRate}% / ${k.noShowRate}%`} />
        <StatCard icon={Star} label="สมาชิกจาก LINE" value={k.lineMembers} />
        <StatCard icon={Coins} label="Point Issued / Redeemed" value={`${k.pointsIssued} / ${k.pointsRedeemed}`} />
        <StatCard icon={Gift} label="ยอดขายสมาชิก / Non-member" value={`${money(k.memberSales, 0)} / ${money(k.nonMemberSales, 0)}`} />
        <StatCard icon={TrendingUp} label="Average Room Utilization" value={`${k.utilization}%`} sub={`RevPARH ฿${money(k.revPARH)}`} />
        <StatCard icon={Timer} label="ช่วงเวลาที่ลูกค้าใช้บริการมากที่สุด" value={k.peakHour != null ? `${String(k.peakHour).padStart(2, '0')}:00` : '-'} />
      </div>
      <div className="grid grid-2 mt">
        <ChartCard title="ยอดขายรายชั่วโมง">
          <BarChart data={c.hourly}><CartesianGrid strokeDasharray="3 3" stroke="var(--border)" /><XAxis dataKey="hour" stroke="var(--muted)" /><YAxis stroke="var(--muted)" /><Tooltip {...tip} /><Bar dataKey="amount" fill="#8b5cf6" radius={[6, 6, 0, 0]} /></BarChart>
        </ChartCard>
        <ChartCard title="ยอดขายรายวัน (30 วัน)">
          <AreaChart data={c.daily.map((d) => ({ ...d, day: fmtDay(d.day) }))}><CartesianGrid strokeDasharray="3 3" stroke="var(--border)" /><XAxis dataKey="day" stroke="var(--muted)" /><YAxis stroke="var(--muted)" /><Tooltip {...tip} /><Area dataKey="amount" stroke="#ec4899" fill="#ec489944" /></AreaChart>
        </ChartCard>
        <ChartCard title="ยอดขายรายเดือน">
          <BarChart data={c.monthly}><CartesianGrid strokeDasharray="3 3" stroke="var(--border)" /><XAxis dataKey="month" stroke="var(--muted)" /><YAxis stroke="var(--muted)" /><Tooltip {...tip} /><Bar dataKey="amount" fill="#22c55e" radius={[6, 6, 0, 0]} /></BarChart>
        </ChartCard>
        <ChartCard title="จำนวนชั่วโมงที่ขาย">
          <LineChart data={c.daily.map((d) => ({ ...d, day: fmtDay(d.day), hours: Number(d.hours) }))}><CartesianGrid strokeDasharray="3 3" stroke="var(--border)" /><XAxis dataKey="day" stroke="var(--muted)" /><YAxis stroke="var(--muted)" /><Tooltip {...tip} /><Line dataKey="hours" stroke="#3b82f6" strokeWidth={2} /></LineChart>
        </ChartCard>
        <ChartCard title="ยอดขายแยกตาม Type ห้อง">
          <PieChart><Pie data={c.byType.map((x) => ({ ...x, amount: Number(x.amount) }))} dataKey="amount" nameKey="name" outerRadius={90} label>{c.byType.map((x, i) => <Cell key={i} fill={x.color || PALETTE[i % 8]} />)}</Pie><Tooltip {...tip} /><Legend /></PieChart>
        </ChartCard>
        <ChartCard title="ยอดขายแยกตามช่องทางชำระเงิน">
          <PieChart><Pie data={c.byMethod.map((x) => ({ name: t(PAYMENT_METHODS[x.method] || x.method), amount: Number(x.amount) }))} dataKey="amount" nameKey="name" outerRadius={90} label>{c.byMethod.map((x, i) => <Cell key={i} fill={PALETTE[i % 8]} />)}</Pie><Tooltip {...tip} /><Legend /></PieChart>
        </ChartCard>
        <ChartCard title="ยอดขายแยกตามพนักงาน">
          <BarChart data={c.byEmployee} layout="vertical"><CartesianGrid strokeDasharray="3 3" stroke="var(--border)" /><XAxis type="number" stroke="var(--muted)" /><YAxis type="category" dataKey="name" width={110} stroke="var(--muted)" /><Tooltip {...tip} /><Bar dataKey="amount" fill="#f97316" radius={[0, 6, 6, 0]} /></BarChart>
        </ChartCard>
        <ChartCard title="Booking ตามวัน">
          <BarChart data={c.bookingsDaily.map((d) => ({ ...d, day: fmtDay(d.day) }))}><CartesianGrid strokeDasharray="3 3" stroke="var(--border)" /><XAxis dataKey="day" stroke="var(--muted)" /><YAxis stroke="var(--muted)" /><Tooltip {...tip} /><Legend /><Bar dataKey="n" name={t('ทั้งหมด')} fill="#8b5cf6" /><Bar dataKey="online" name="Online" fill="#ec4899" /></BarChart>
        </ChartCard>
        <ChartCard title="Booking ตามช่วงเวลา">
          <BarChart data={c.bookingsHourly}><CartesianGrid strokeDasharray="3 3" stroke="var(--border)" /><XAxis dataKey="hour" stroke="var(--muted)" /><YAxis stroke="var(--muted)" /><Tooltip {...tip} /><Bar dataKey="n" fill="#14b8a6" /></BarChart>
        </ChartCard>
        <ChartCard title="Room Utilization (%)">
          <LineChart data={c.utilization.map((d) => ({ ...d, day: fmtDay(d.day) }))}><CartesianGrid strokeDasharray="3 3" stroke="var(--border)" /><XAxis dataKey="day" stroke="var(--muted)" /><YAxis stroke="var(--muted)" /><Tooltip {...tip} /><Line dataKey="percent" stroke="#eab308" strokeWidth={2} /></LineChart>
        </ChartCard>
        <ChartCard title="Online vs Walk-in">
          <PieChart><Pie data={c.sources.map((x) => ({ name: x.source, n: Number(x.n) }))} dataKey="n" nameKey="name" outerRadius={90} label>{c.sources.map((x, i) => <Cell key={i} fill={PALETTE[i % 8]} />)}</Pie><Tooltip {...tip} /><Legend /></PieChart>
        </ChartCard>
        <ChartCard title="Member vs Non-member">
          <PieChart><Pie data={c.memberSplit} dataKey="amount" nameKey="name" outerRadius={90} label><Cell fill="#8b5cf6" /><Cell fill="#6b7280" /></Pie><Tooltip {...tip} /><Legend /></PieChart>
        </ChartCard>
        <ChartCard title="Deposit Payment Method">
          <PieChart><Pie data={c.depositMethods.map((x) => ({ name: x.method, amount: Number(x.amount) }))} dataKey="amount" nameKey="name" outerRadius={90} label>{c.depositMethods.map((x, i) => <Cell key={i} fill={PALETTE[i % 8]} />)}</Pie><Tooltip {...tip} /><Legend /></PieChart>
        </ChartCard>
        <ChartCard title="Revenue by Package">
          <BarChart data={c.byPackage.map((x) => ({ ...x, amount: Number(x.amount) }))}><CartesianGrid strokeDasharray="3 3" stroke="var(--border)" /><XAxis dataKey="name" stroke="var(--muted)" /><YAxis stroke="var(--muted)" /><Tooltip {...tip} /><Bar dataKey="amount" fill="#3b82f6" radius={[6, 6, 0, 0]} /></BarChart>
        </ChartCard>
      </div>
      <div className="card mt">
        <div className="card-title">{t('สินค้าขายดี')}</div>
        {data.topProducts.length ? data.topProducts.map((p, i) => (
          <div key={p.name} className="sum-line"><span>{i + 1}. {p.name}</span><span>{Number(p.qty)} · ฿{money(p.amount, 0)}</span></div>
        )) : <div className="muted">-</div>}
      </div>
    </div>
  );
}

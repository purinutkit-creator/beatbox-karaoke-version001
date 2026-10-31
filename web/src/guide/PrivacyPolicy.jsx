// Privacy policy for the store's LINE Official Account and website (the link given to LINE for the LINE Login /
// Messaging API channels): what is collected through LINE and the website, why, who receives it, how long it is kept
// and how a customer asks to see, correct or delete it (Thailand's PDPA). The store's name and contacts come from its
// settings. ?store=<slug> picks the store.
import { useEffect, useState } from 'react';
import { Mic2, Globe } from 'lucide-react';
import { useT } from '../lib/i18n.jsx';
import { api } from '../lib/api.js';
import { Loading } from '../components/ui.jsx';

const UPDATED = '31 ตุลาคม 2569';
const UPDATED_EN = '31 October 2026';

function th(s) {
  return [
    ['1. ขอบเขตของนโยบายนี้', [`นโยบายความเป็นส่วนตัวนี้ใช้กับการให้บริการของ ${s.name} ผ่าน LINE Official Account ของร้าน (${s.oa || 'LINE OA'}) การเข้าสู่ระบบด้วย LINE (LINE Login) และเว็บไซต์ของร้าน ได้แก่ การจองห้อง การตรวจสอบการจอง ระบบสมาชิก การสะสมแต้ม การสั่งอาหารในห้อง และใบเสร็จออนไลน์`]],
    ['2. ข้อมูลที่เราเก็บ', [
      'ข้อมูลจาก LINE: LINE User ID ชื่อที่แสดง (Display Name) และรูปโปรไฟล์ ที่ LINE ส่งให้เมื่อคุณเพิ่มเพื่อน แชทกับร้าน หรือเข้าสู่ระบบด้วย LINE — เราไม่ได้รับรหัสผ่านหรืออีเมลของบัญชี LINE ของคุณ',
      'ข้อความที่คุณพิมพ์หรือปุ่มที่คุณกดในแชทของร้าน เช่น เบอร์โทรศัพท์ที่ใช้ค้นหาการจอง การยืนยันหรือยกเลิกการจอง',
      'ข้อมูลการจองและการใช้บริการ: ชื่อ เบอร์โทรศัพท์ จำนวนผู้ใช้บริการ ห้อง วันเวลา รายการอาหาร ยอดชำระ วิธีชำระเงิน และสลิปการโอน (ถ้ามี)',
      'ข้อมูลสมาชิก: ชื่อ นามสกุล เบอร์โทรศัพท์ วันเกิด อีเมล (ถ้าให้ไว้) เลขสมาชิก ระดับสมาชิก แต้มสะสม และประวัติการใช้บริการ',
      'ข้อมูลทางเทคนิคที่จำเป็นต่อความปลอดภัย เช่น เวลาที่ใช้งาน และหมายเลข IP ในบันทึกของระบบ',
    ]],
    ['3. วัตถุประสงค์การใช้ข้อมูล', [
      'แสดงการจองของคุณ ให้คุณยืนยันหรือยกเลิกการจอง และส่ง QR / บาร์โค้ดการจองสำหรับเช็กอินที่ร้าน',
      'ส่งข้อความแจ้งเตือนทาง LINE ที่เกี่ยวกับการใช้บริการของคุณ เช่น แจ้งเตือนก่อนถึงเวลาจอง แจ้งเมื่อห้องพร้อม แจ้งใกล้หมดเวลา และส่งใบเสร็จออนไลน์',
      'เชื่อมบัญชี LINE กับบัญชีสมาชิก เพื่อเข้าสู่ระบบ ดูบัตรสมาชิก สะสมและใช้แต้ม',
      'ให้บริการในห้อง เช่น การสั่งอาหารและการแจ้งปัญหา และออกใบเสร็จตามกฎหมาย',
      'ดูแลความปลอดภัยของระบบ ป้องกันการใช้งานโดยมิชอบ และแก้ไขปัญหาการให้บริการ',
      'ส่งข่าวสารหรือโปรโมชั่นเฉพาะเมื่อคุณให้ความยินยอม และยกเลิกได้ทุกเมื่อ',
    ]],
    ['4. ฐานทางกฎหมาย', ['เราประมวลผลข้อมูลเพื่อปฏิบัติตามสัญญาการให้บริการที่คุณขอ (การจอง สมาชิก ใบเสร็จ) เพื่อปฏิบัติตามกฎหมาย (เช่น เอกสารทางบัญชีและภาษี) เพื่อประโยชน์โดยชอบด้วยกฎหมายในการดูแลความปลอดภัยของระบบ และตามความยินยอมของคุณสำหรับข่าวสารและโปรโมชั่น ตามพระราชบัญญัติคุ้มครองข้อมูลส่วนบุคคล พ.ศ. 2562']],
    ['5. การเปิดเผยข้อมูล', [
      'เราไม่ขายหรือให้เช่าข้อมูลส่วนบุคคลของคุณ',
      'ข้อมูลอาจถูกส่งผ่านหรือจัดเก็บโดยผู้ให้บริการที่จำเป็นต่อการให้บริการ ได้แก่ LY Corporation (LINE) สำหรับการส่งข้อความและการเข้าสู่ระบบ ผู้ให้บริการระบบคลาวด์ที่จัดเก็บระบบและฐานข้อมูล และผู้ให้บริการตรวจสอบการชำระเงิน (ถ้ามี) โดยใช้เท่าที่จำเป็นตามวัตถุประสงค์ข้างต้น',
      'เราอาจเปิดเผยข้อมูลเมื่อกฎหมายกำหนด หรือตามคำสั่งของหน่วยงานที่มีอำนาจ',
    ]],
    ['6. ระยะเวลาการเก็บรักษา', [
      'ข้อมูลการจอง ใบเสร็จ และการชำระเงิน เก็บตามระยะเวลาที่กฎหมายบัญชีและภาษีกำหนด',
      'ข้อมูลสมาชิกและการเชื่อมบัญชี LINE เก็บตลอดระยะเวลาที่คุณเป็นสมาชิก หรือจนกว่าคุณขอให้ลบหรือยกเลิกการเชื่อมต่อ',
      'ข้อมูลการแชทเพื่อค้นหาการจองเก็บเท่าที่จำเป็นต่อการให้บริการและความปลอดภัย',
    ]],
    ['7. สิทธิของคุณ', [
      'ขอเข้าถึงหรือขอสำเนาข้อมูลของคุณ ขอแก้ไขให้ถูกต้อง ขอลบ ขอระงับ หรือคัดค้านการประมวลผล ขอโอนย้ายข้อมูล และถอนความยินยอมได้ทุกเมื่อ',
      'ยกเลิกการเชื่อมบัญชี LINE ได้ที่หน้าสมาชิกบนเว็บไซต์ของร้าน และหยุดรับข้อความได้โดยบล็อกหรือลบ LINE Official Account ของร้าน',
      'หากเห็นว่าการใช้ข้อมูลไม่เป็นไปตามกฎหมาย คุณมีสิทธิร้องเรียนต่อสำนักงานคณะกรรมการคุ้มครองข้อมูลส่วนบุคคล',
    ]],
    ['8. ความปลอดภัยของข้อมูล', ['เราใช้การเชื่อมต่อแบบเข้ารหัส (HTTPS) เก็บรหัสผ่านแบบเข้ารหัสทางเดียว เข้ารหัสข้อมูลลับของระบบ และจำกัดสิทธิ์การเข้าถึงข้อมูลเฉพาะพนักงานที่เกี่ยวข้อง']],
    ['9. การเปลี่ยนแปลงนโยบาย', ['เราอาจปรับปรุงนโยบายนี้เป็นครั้งคราว ฉบับล่าสุดจะแสดงที่หน้านี้พร้อมวันที่ปรับปรุง']],
  ];
}

function en(s) {
  return [
    ['1. Scope', [`This privacy policy covers the services of ${s.name} through the store's LINE Official Account (${s.oa || 'LINE OA'}), LINE Login and the store's website: room booking, checking bookings, membership, points, in-room ordering and online receipts.`]],
    ['2. Information we collect', [
      'From LINE: your LINE user ID, display name and profile picture, which LINE provides when you add the store as a friend, chat with it or sign in with LINE. We never receive your LINE password or e-mail.',
      'What you type or tap in the store chat, such as the phone number used to find a booking, and confirming or cancelling a booking.',
      'Booking and visit details: name, phone number, number of guests, room, date and time, items ordered, amounts paid, payment method and transfer slips (if any).',
      'Membership details: name, phone number, birthday, e-mail (if given), member number, tier, points and visit history.',
      'Technical information needed for security, such as times of use and IP addresses in system logs.',
    ]],
    ['3. How we use it', [
      'To show your bookings, let you confirm or cancel them, and send the booking QR / barcode for check-in.',
      'To send LINE messages about your visit: reminders before your booking, when your room is ready, when time is almost up, and your online receipt.',
      'To link your LINE account to your membership, to sign in, show your member card and collect or use points.',
      'To provide in-room services such as ordering food and reporting a problem, and to issue receipts as required by law.',
      'To keep the system secure, prevent misuse and fix service problems.',
      'To send news or promotions only with your consent, which you can withdraw at any time.',
    ]],
    ['4. Legal basis', ['We process data to perform the services you ask for (bookings, membership, receipts), to comply with the law (e.g. accounting and tax records), for our legitimate interest in keeping the system secure, and with your consent for news and promotions, under Thailand\'s Personal Data Protection Act B.E. 2562 (2019).']],
    ['5. Sharing', [
      'We do not sell or rent your personal data.',
      'Data may pass through or be stored by providers needed to run the service: LY Corporation (LINE) for messaging and login, the cloud provider hosting the system and database, and payment verification providers (if used), only as needed for the purposes above.',
      'We may disclose data when required by law or by order of a competent authority.',
    ]],
    ['6. How long we keep it', [
      'Booking, receipt and payment records are kept for the period required by accounting and tax law.',
      'Membership data and the LINE link are kept while you are a member, or until you ask us to delete them or unlink.',
      'Chat data used to look up bookings is kept only as long as needed for the service and security.',
    ]],
    ['7. Your rights', [
      'You may ask to access or receive a copy of your data, correct it, delete it, restrict or object to its use, move it, and withdraw consent at any time.',
      'You can unlink LINE on the member page of the store\'s website, and stop messages by blocking or removing the store\'s LINE Official Account.',
      'If you believe your data is used unlawfully, you may complain to the Office of the Personal Data Protection Committee.',
    ]],
    ['8. Security', ['We use encrypted connections (HTTPS), store passwords as one-way hashes, encrypt system secrets and limit access to staff who need it.']],
    ['9. Changes', ['We may update this policy from time to time. The latest version is always on this page with its date.']],
  ];
}

export default function PrivacyPolicy() {
  const { lang, setLang } = useT();
  const [s, setS] = useState(null);
  useEffect(() => {
    api.get('/public/settings', { auth: false }).then(setS).catch(() => setS({}));
  }, []);
  if (!s) return <Loading />;
  const store = s.store || {};
  const info = { name: store.name || 'BEATBOX Karaoke', oa: s.booking?.lineOaUrl ? s.booking.lineOaUrl.replace(/^https?:\/\/line\.me\/R\/ti\/p\//, '') : '' };
  const isEn = lang === 'en';
  const sections = isEn ? en(info) : th(info);
  const contact = [store.name, store.address, store.phone && `${isEn ? 'Tel.' : 'โทร'} ${store.phone}`, s.booking?.contactEmail && `${isEn ? 'E-mail' : 'อีเมล'} ${s.booking.contactEmail}`, s.booking?.lineOaUrl && `LINE: ${s.booking.lineOaUrl}`].filter(Boolean);
  return (
    <div className="rg pp">
      <div className="rg-head">
        {store.logoUrl ? <img src={store.logoUrl} alt="" /> : <div className="brand-logo"><Mic2 size={22} /></div>}
        <div className="grow">
          <div className="rg-store">{store.name}</div>
          <div className="rg-muted">{isEn ? 'Privacy Policy — LINE Official Account & website' : 'นโยบายความเป็นส่วนตัว — LINE Official Account และเว็บไซต์'}</div>
        </div>
        <button type="button" className="btn sm" onClick={() => setLang(isEn ? 'th' : 'en')}><Globe size={16} /> {isEn ? 'ไทย' : 'EN'}</button>
      </div>
      <div className="rg-card pp-body">
        <h1>{isEn ? 'Privacy Policy' : 'นโยบายความเป็นส่วนตัว'}</h1>
        <p className="rg-muted">{isEn ? `Last updated ${UPDATED_EN}` : `ปรับปรุงล่าสุด ${UPDATED}`}</p>
        {sections.map(([title, items]) => (
          <section key={title}>
            <h2>{title}</h2>
            {items.length === 1 ? <p>{items[0]}</p> : <ul>{items.map((x) => <li key={x}>{x}</li>)}</ul>}
          </section>
        ))}
        <section>
          <h2>{isEn ? '10. Contact us' : '10. ติดต่อเรา'}</h2>
          <p>{isEn ? 'For questions or requests about your personal data, contact:' : 'หากมีคำถามหรือต้องการใช้สิทธิเกี่ยวกับข้อมูลส่วนบุคคล ติดต่อ:'}</p>
          <ul>{contact.map((x) => <li key={x}>{x}</li>)}</ul>
        </section>
      </div>
    </div>
  );
}

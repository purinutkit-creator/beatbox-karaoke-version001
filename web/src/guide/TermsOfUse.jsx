// Terms of use of the store's LINE Official Account and website (the link given to LINE for the channels): the
// services, bookings and deposits (the store's own cancellation tiers, hold time and late arrival grace from its
// settings), member accounts and points, LINE messages, acceptable use, liability and Thai law.
import { LegalPage } from './PrivacyPolicy.jsx';

const UPDATED = { th: '31 ตุลาคม 2569', en: '31 October 2026' };

/** "ยกเลิกล่วงหน้า 24 ชม. ขึ้นไป คืน 100%" … from the store's cancellation settings. */
function refundRules(c = {}, isEn) {
  const tiers = [...(c.tiers || [])].sort((a, b) => b.hoursBefore - a.hoursBefore);
  const lines = tiers.map((t) => (isEn ? `Cancelled ${t.hoursBefore} hours or more before the start: ${t.percent}% of the deposit refunded` : `ยกเลิกล่วงหน้า ${t.hoursBefore} ชั่วโมงขึ้นไป: คืนเงินมัดจำ ${t.percent}%`));
  lines.push(isEn ? `Cancelled later than that: ${Number(c.defaultPercent || 0)}% refunded` : `ยกเลิกน้อยกว่านั้น: คืนเงินมัดจำ ${Number(c.defaultPercent || 0)}%`);
  return lines;
}

function th(info, s) {
  const b = s.booking || {};
  const p = s.points || {};
  return [
    ['1. การยอมรับข้อกำหนด', [`ข้อกำหนดนี้ใช้กับการใช้บริการของ ${info.name} ผ่าน LINE Official Account ของร้าน (${info.oa || 'LINE OA'}) การเข้าสู่ระบบด้วย LINE และเว็บไซต์ของร้าน เมื่อคุณเพิ่มเพื่อน แชท จองห้อง สมัครสมาชิก หรือใช้บริการใดๆ ถือว่าคุณยอมรับข้อกำหนดนี้และนโยบายความเป็นส่วนตัวของร้าน`]],
    ['2. บริการ', ['ดูห้องว่างและจองห้องคาราโอเกะ ตรวจสอบ ยืนยัน หรือยกเลิกการจองผ่านแชท LINE รับ QR / บาร์โค้ดการจอง รับการแจ้งเตือนเกี่ยวกับการใช้บริการ ระบบสมาชิกและแต้มสะสม การสั่งอาหารและแจ้งปัญหาในห้อง และใบเสร็จออนไลน์ ร้านอาจเพิ่ม ปรับ หรือหยุดบริการบางส่วนได้']],
    ['3. การจองและเงินมัดจำ', [
      'ข้อมูลการจอง (ชื่อ เบอร์โทรศัพท์ จำนวนคน) ต้องเป็นข้อมูลจริงของผู้จอง การจองจะสมบูรณ์เมื่อร้านยืนยัน หรือได้รับเงินมัดจำครบตามที่ร้านกำหนด',
      `การจองออนไลน์ที่ยังไม่ชำระมัดจำจะถูกกันห้องไว้ ${Number(b.holdMinutes || 10)} นาที หากไม่ชำระภายในเวลา ระบบจะปล่อยห้องให้ผู้อื่น`,
      `กรุณามาถึงก่อนเวลา และแสดง QR หรือบาร์โค้ดการจองที่เคาน์เตอร์ หากมาช้าเกิน ${Number(b.gracePeriodMinutes || 15)} นาทีโดยไม่แจ้งร้าน ร้านอาจถือว่าไม่มาใช้บริการและนำห้องไปให้บริการผู้อื่น`,
      'เวลาใช้ห้องนับตามเวลาที่จอง การมาช้าไม่ขยายเวลาสิ้นสุด การต่อเวลาขึ้นกับห้องว่างและคิดค่าบริการตามอัตราของร้าน',
    ]],
    ['4. การยกเลิกและการคืนเงิน', [
      b.cancellation?.allowOnline !== false ? 'ยกเลิกการจองได้ด้วยตัวเองผ่านแชท LINE หรือเว็บไซต์ ก่อนถึงเวลาจอง' : 'การยกเลิกการจองกรุณาติดต่อร้าน',
      ...refundRules(b.cancellation, false),
      'การคืนเงินมัดจำร้านจะติดต่อและโอนคืนตามช่องทางที่ตกลงกัน การไม่มาใช้บริการโดยไม่ยกเลิก ร้านอาจไม่คืนเงินมัดจำ',
    ]],
    ['5. บัญชีสมาชิกและการเชื่อม LINE', [
      'สมาชิกต้องให้ข้อมูลที่ถูกต้อง และเก็บรักษารหัสผ่านไว้เป็นความลับ การกระทำผ่านบัญชีของคุณถือเป็นความรับผิดชอบของคุณ',
      'บัญชี LINE หนึ่งบัญชีเชื่อมกับสมาชิกได้หนึ่งคน คุณยกเลิกการเชื่อมได้ที่หน้าสมาชิกบนเว็บไซต์ของร้าน',
      'การจองที่ค้นหาด้วยเบอร์โทรในแชทจะผูกกับบัญชี LINE ที่ค้นหาเป็นคนแรก หากพบว่าการจองของคุณถูกผูกกับบัญชีอื่น กรุณาติดต่อร้าน',
    ]],
    ['6. แต้มสะสมและของรางวัล', [
      p.enabled !== false ? `สะสมแต้มจากยอดใช้บริการ (ทุก ${Number(p.amountPerPoint || 25)} บาท ได้ ${Number(p.pointsPerUnit || 1)} แต้ม หรือตามที่ร้านประกาศ) แต้มมีอายุและเงื่อนไขตามที่ร้านกำหนด` : 'ร้านอาจเปิดระบบแต้มสะสมในอนาคต',
      'บิลที่ชำระโดยยังไม่ได้ระบุสมาชิก สามารถกดรับแต้มจากใบเสร็จออนไลน์ได้ครั้งเดียว ภายในเวลาที่ร้านกำหนด',
      'แต้มและของรางวัลไม่สามารถแลกเป็นเงินสดหรือโอนให้ผู้อื่น และจะถูกหักคืนหากบิลถูกยกเลิกหรือคืนเงิน',
    ]],
    ['7. ข้อความทาง LINE', ['เมื่อคุณเพิ่มเพื่อนหรือเชื่อมบัญชี ร้านจะส่งข้อความที่เกี่ยวกับการใช้บริการของคุณ เช่น การจอง การแจ้งเตือนก่อนถึงเวลา ห้องพร้อม ใกล้หมดเวลา และใบเสร็จ ข่าวสารและโปรโมชั่นส่งเฉพาะเมื่อคุณยินยอม คุณหยุดรับข้อความได้โดยบล็อก LINE Official Account ของร้าน']],
    ['8. การใช้งานที่ไม่อนุญาต', [
      'ใช้เบอร์โทรหรือข้อมูลของผู้อื่นเพื่อดู ยืนยัน หรือยกเลิกการจองที่ไม่ใช่ของตน',
      'จองโดยไม่ตั้งใจใช้บริการ ส่งสลิปหรือข้อมูลการชำระเงินปลอม',
      'พยายามเข้าถึงระบบโดยไม่ได้รับอนุญาต รบกวนการทำงานของระบบ หรือส่งข้อความที่ผิดกฎหมาย หยาบคาย หรือก่อความรำคาญ',
      'ร้านอาจระงับการจอง บัญชีสมาชิก หรือการให้บริการผ่าน LINE ของผู้ที่ฝ่าฝืน',
    ]],
    ['9. ข้อจำกัดความรับผิด', ['ร้านพยายามให้ข้อมูลและระบบทำงานถูกต้องต่อเนื่อง แต่ไม่รับประกันว่าบริการผ่าน LINE หรือเว็บไซต์จะไม่ขัดข้อง ข้อความแจ้งเตือนอาจล่าช้าหรือไม่ถึงตามสภาพเครือข่ายหรือบริการของ LINE กรุณาตรวจสอบเวลาจองของคุณเสมอ ร้านไม่รับผิดชอบต่อความเสียหายทางอ้อมจากการใช้งานระบบ เว้นแต่เกิดจากความจงใจหรือประมาทเลินเล่ออย่างร้ายแรงของร้าน']],
    ['10. ทรัพย์สินทางปัญญา', ['ชื่อร้าน โลโก้ รูปภาพ และเนื้อหาบนเว็บไซต์และ LINE Official Account เป็นของร้านหรือผู้อนุญาต ห้ามนำไปใช้โดยไม่ได้รับอนุญาต LINE เป็นเครื่องหมายการค้าของ LY Corporation']],
    ['11. การเปลี่ยนแปลงข้อกำหนดและกฎหมายที่ใช้บังคับ', ['ร้านอาจปรับปรุงข้อกำหนดนี้ ฉบับล่าสุดจะแสดงที่หน้านี้ การใช้บริการต่อหลังการเปลี่ยนแปลงถือว่าคุณยอมรับข้อกำหนดฉบับใหม่ ข้อกำหนดนี้อยู่ภายใต้กฎหมายแห่งราชอาณาจักรไทย']],
  ];
}

function en(info, s) {
  const b = s.booking || {};
  const p = s.points || {};
  return [
    ['1. Acceptance', [`These terms apply to the services of ${info.name} through the store's LINE Official Account (${info.oa || 'LINE OA'}), LINE Login and the store's website. By adding the store as a friend, chatting, booking, becoming a member or using any service, you accept these terms and the store's privacy policy.`]],
    ['2. Services', ['Viewing available rooms and booking karaoke rooms; checking, confirming or cancelling bookings in the LINE chat; booking QR / barcode; service notifications; membership and points; in-room ordering and problem reports; online receipts. The store may add, change or stop parts of the service.']],
    ['3. Bookings and deposits', [
      'Booking details (name, phone number, number of guests) must be true details of the person booking. A booking is complete when the store confirms it or receives the required deposit.',
      `An online booking without a deposit holds the room for ${Number(b.holdMinutes || 10)} minutes; if unpaid in time the room is released.`,
      `Please arrive on time and show the booking QR or barcode at the counter. If you are more than ${Number(b.gracePeriodMinutes || 15)} minutes late without telling the store, the booking may be treated as a no-show and the room given to others.`,
      'Room time runs by the booked time; arriving late does not move the end time. Extra time depends on availability and is charged at the store\'s rates.',
    ]],
    ['4. Cancellations and refunds', [
      b.cancellation?.allowOnline !== false ? 'You can cancel a booking yourself in the LINE chat or on the website before it starts.' : 'To cancel a booking, please contact the store.',
      ...refundRules(b.cancellation, true),
      'Deposits are refunded by the store through the agreed channel. A no-show without cancelling may forfeit the deposit.',
    ]],
    ['5. Member accounts and LINE linking', [
      'Members must give correct details and keep their password secret; actions through your account are your responsibility.',
      'One LINE account can be linked to one member. You can unlink on the member page of the store\'s website.',
      'A booking looked up by phone number in the chat is tied to the first LINE account that looks it up. If your booking is tied to another account, please contact the store.',
    ]],
    ['6. Points and rewards', [
      p.enabled !== false ? `Points are earned on spending (${Number(p.pointsPerUnit || 1)} point per ${Number(p.amountPerPoint || 25)} baht, or as announced by the store); points expire and have conditions set by the store.` : 'The store may offer points in the future.',
      'A bill paid without a member can have its points collected once from the online receipt, within the time set by the store.',
      'Points and rewards cannot be exchanged for cash or transferred, and are taken back if a bill is voided or refunded.',
    ]],
    ['7. LINE messages', ['When you add the store as a friend or link your account, the store sends messages about your visits: bookings, reminders, room ready, time almost up and receipts. News and promotions are sent only with your consent. You can stop messages by blocking the store\'s LINE Official Account.']],
    ['8. Prohibited use', [
      'Using another person\'s phone number or details to view, confirm or cancel bookings that are not yours.',
      'Booking without intending to come, or sending fake slips or payment details.',
      'Trying to access the system without permission, disrupting it, or sending unlawful, abusive or nuisance messages.',
      'The store may suspend bookings, member accounts or LINE services of anyone who breaks these rules.',
    ]],
    ['9. Limitation of liability', ['The store tries to keep information and systems accurate and available but does not guarantee uninterrupted service through LINE or the website. Notifications may be delayed or not delivered depending on networks or LINE\'s service; please always check your booking time. The store is not liable for indirect damages from using the system except through its wilful misconduct or gross negligence.']],
    ['10. Intellectual property', ['The store\'s name, logo, images and content on the website and LINE Official Account belong to the store or its licensors and may not be used without permission. LINE is a trademark of LY Corporation.']],
    ['11. Changes and governing law', ['The store may update these terms; the latest version is on this page. Continuing to use the service after a change means you accept the new terms. These terms are governed by the laws of the Kingdom of Thailand.']],
  ];
}

export default function TermsOfUse() {
  return (
    <LegalPage
      content={(info, s, isEn) => ({
        title: isEn ? 'Terms of Use' : 'ข้อกำหนดการใช้งาน',
        subtitle: isEn ? 'Terms of Use — LINE Official Account & website' : 'ข้อกำหนดการใช้งาน — LINE Official Account และเว็บไซต์',
        updated: UPDATED,
        sections: isEn ? en(info, s) : th(info, s),
        contactNote: isEn ? 'For questions about these terms, contact:' : 'หากมีคำถามเกี่ยวกับข้อกำหนดนี้ ติดต่อ:',
      })}
    />
  );
}

# BEATBOX Karaoke — ระบบบริหารร้านคาราโอเกะ + POS + เว็บไซต์จองห้องออนไลน์

A full-stack karaoke management system: back-office + touch POS, a **Customer Display**, and a mobile-first
**online booking website**. All three share one backend and one PostgreSQL database.

| URL | Purpose |
| --- | --- |
| `/login`, `/admin/*` | Back office + POS (staff 4-digit PIN, or store owner e-mail + password) |
| `/register` | New store sign-up (e-mail + password, no OTP) |
| `/platform` | Super Owner console (all stores, plans, trials, renewals, enter a store) |
| `/display` | Customer Display (pair with the 4–6 digit code shown on the POS) |
| `/book/*` | Customer online booking website; `/book/signup?store=<slug>` member sign-up (phone + password, no OTP) |

## Quick start

```bash
# PostgreSQL 14+ with the btree_gist extension (installed automatically by the migration)
cp .env.example .env            # edit DATABASE_URL, secrets, …
npm install
npm run build                   # builds the web app (served by the API server)
npm start                       # runs migrations + seed, then http://localhost:4000
```

Development (hot reload): `npm run dev` (API on :4000, Vite on :5173 with proxy).
Docker: `docker compose up --build`.

## Deploy on Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/purinutkit-creator/beatbox-karaoke-version001)

`render.yaml` is a Render Blueprint: one Docker web service (`beatbox-pos`) and one PostgreSQL 16 database (`beatbox-db`) in Singapore.

1. Click the button above, or in the Render dashboard choose **New → Blueprint** and pick this repository and branch.
2. When asked, enter **ADMIN_PIN** (the first admin's 4-digit login code). Leave the other prompted values (slip, SMS, LINE keys) empty until you have them.
3. Click **Apply**. The first deploy builds the image, runs the migrations and seeds the demo rooms and products. Then open
   `https://<service>.onrender.com/admin` (POS), `/book` (booking website) and `/display` (Customer Display).

Notes:
* The app is stateless. Uploaded slips and imported fonts are stored in PostgreSQL, so no Render disk is needed.
* The Blueprint uses the **free** plans so the first deploy costs nothing. Free web services sleep after 15 minutes without traffic
  (the first visit takes about a minute to wake, and room-time alerts don't run while asleep), and free databases expire after 30 days.
  For a real store, change the web service to **Starter** or higher and the database to **Basic** or higher (Render dashboard or `plan:` in `render.yaml`).
* Before going live, set `PAYMENT_MODE=PRODUCTION` with `SLIP_PROVIDER`/`SLIP_API_KEY` (or `manual`), configure SMS and set `OTP_DEBUG=false`,
  and add the LINE keys. With a custom domain, also set `PUBLIC_URL`. The LINE callback URL is `PUBLIC_URL/api/public/auth/line/callback`.
* Demo staff accounts (2222/3333/4444) are not created on Render (`SEED_DEMO_STAFF=false`). Add staff in Admin → พนักงาน.

Default seeded staff codes: **1234** Admin · 2222 Manager · 3333 Cashier · 4444 Staff (`ADMIN_PIN` sets the admin code; `SEED_DEMO=false` seeds only the admin).

Tests: `npm test` runs the calculation-engine unit tests plus end-to-end API tests on a throw-away database (`TEST_DATABASE_URL`).

## Architecture

```
shared/   Calculation engine used by server AND browser (room pricing, VAT/SC, discounts, deposits,
          points, cancellation policy, PromptPay QR, numbering, promotions)
server/   Node.js (Express 5) + Socket.IO + PostgreSQL
  src/db/migrations   SQL schema (all entities, constraints, triggers)
  src/routes          REST API (staff, public booking, reports …)
  src/services        business logic (orders/checkout, availability, scheduler, points, stock …)
  src/providers       pluggable adapters: slip verification, payment (PromptPay), LINE, SMS
web/      React (Vite): admin/POS, Customer Display, booking website, receipts, printing
```

### Correctness & safety guarantees
* **Server-authoritative time.** Rooms store `started_at`, `scheduled_end_at`, `paused_at`, `total_paused_seconds` and `status`.
  Clients only render countdowns from the server clock offset. The scheduler (every 5s) decides near-end / time-up,
  sends alerts (sound + speech + popup) and updates room status on every device through Socket.IO.
* **No double booking.** The database rejects overlapping reservations with a PostgreSQL `EXCLUDE USING gist` constraint, and every
  booking/session change locks the room row (`SELECT … FOR UPDATE`) to check active sessions. A partial unique index
  prevents the same room being opened twice from different devices. Online holds (default 10 min) are reservations in `HOLD`
  status and expire automatically.
* **Idempotency.** Payments, deposits, refunds, redemptions, booking creation and offline sync use `Idempotency-Key`
  (stored responses), and payment rows have unique keys. The pay button is disabled while processing.
* **Slip reuse impossible.** A verified transaction reference / slip hash has a unique index (`result = 'PASSED'`).
  Demo mode simulates verification. Production mode needs a real provider (SlipOK / EasySlip adapters) or a manual staff review,
  and never marks a payment PAID because a timer ran out.
* **Immutable money trail.** Payments, refunds, receipts, orders and point ledgers can't be deleted (DB triggers), and activity logs
  are append-only. Voids and refunds create their own records. Points live in a ledger with balance before/after.
* **One Calculation Engine** (`shared/calc.js`) for POS, booking, Customer Display, receipts and reports. Every order stores a
  snapshot of the VAT/Service Charge settings and the full calculation, so changing settings never changes old receipts.
  Calculation order: line discount → bill discounts/promotions/rewards → Service Charge → VAT (inclusive/exclusive) → rounding → deposit.
* **Half-hour price** = hourly ÷ 2, rounded up (399 → 200; 1h30 = 599; 2h30 = 998). Leftover minutes under 30 are charged by setting:
  no charge / round up to 30 / per minute / grace period.

### Fonts & language (Admin → ตั้งค่าร้าน → ภาษา ฟอนต์ และธีม)
* TH/EN switch on every site (POS, Customer Display, booking website). The admin sets the default language.
* Separate **Thai font** and **English font** for all websites (defaults Sarabun / Poppins), plus separate **receipt fonts**
  (default Kanit). Presets include Kanit, Prompt, Noto Sans Thai, Sarabun, IBM Plex Sans Thai, Mitr …, Poppins, Inter, Roboto …;
  **any Google Font** can be typed by name.
* **Sukhumvit Set** is an Apple system font and isn't on Google Fonts. It works on Apple devices out of the box; other devices need the
  admin to **import the font file**. Admins can upload `.woff2/.woff/.ttf/.otf` files or register a font/CSS URL.
* Images (logo, rooms, products, promotions, QR, background) are always **image URLs**. Payment slips are the only uploads besides font files:
  they are transaction documents, stored privately in the database and visible only to staff with `slip.verify`.

### Connections (Admin → ตั้งค่าร้าน → การเชื่อมต่อ)
All keys are entered on the website. Secrets are AES-256-GCM encrypted in the database (key from `SETTINGS_ENCRYPTION_KEY`, or derived from
`JWT_SECRET`) and are never sent back to the browser; environment variables still work as fallbacks.
* **Slip verification — real money check.** Every slip's bank mini-QR is decoded on the server (transaction reference + sending bank), so a
  re-used slip is rejected even if it is photographed again. The reference is then checked with the bank or a verification service:
  **SlipOK**, **EasySlip**, **RDCW Slip Verify**, **SCB Open API** (the bank's own API — verifies transfers from every Thai bank), or a custom
  webhook. Amount, receiving account / PromptPay and slip date are checked against the order. "Manual" = staff check the bank app.
  A test box lets the admin upload a real slip and see what was read. Demo Mode (every slip passes) is a switch on the same page.
* **Payment terminal.** Beam Bolt+ (Beam Checkout Bolt Intent API, webhook + polling), any bank EDC through a small HTTP "EDC bridge"
  (`POST /sale`, `GET /sale/{id}`), or "manual" (cashier enters the EDC approval code). When a terminal is set, QR/card payments are sent to it and
  the Customer Display shows "pay on the terminal"; otherwise the PromptPay QR is shown on the Customer Display.
* **LINE** Login channel ID/secret + Messaging API token, with test buttons. **SMS** provider (THSMS, ThaiBulkSMS, SMSMKT, Twilio or webhook),
  on/off switch, sender name, editable OTP / booking confirmation / reminder messages, test SMS.

### Room tickets, in-room QR ordering and problem reports
* Opening a room prints two tickets: **store copy** (room, start, end, hours, guests, extra mics) and **customer copy** with a QR to `/order/<token>`.
  The token belongs to that session only and expires when the room is closed.
* The in-room page shows the remaining time and the menu. Customers pay **now** (PromptPay QR with a save button + slip upload) or **at the counter**.
  Pay-now slips are checked by the slip provider; otherwise the cashier gets a sound + popup with the slip. If nobody checks within the configured
  time (default 60 s) the customer sees "paid" and the kitchen ticket prints, but the prepayment is only deducted after the cashier verifies it,
  and checkout is blocked until every pending slip is verified or rejected.
* Kitchen/bar tickets of QR orders are claimed by one POS device and printed exactly once.
* **Report a problem:** admin-defined buttons + "Other" with free text. The POS plays a sound, shows a popup, and the room card flashes
  red "ลูกค้าพบปัญหา กดเพื่อดู" until staff acknowledge and resolve it.

### Extra guests & extra mics
More people than the room capacity can book (up to the admin's limit) and pay the per-person fee; extra microphones have an admin-set price.
Both can be chosen on the booking website, in the staff booking form and when opening a room, and flow through the one calculation engine.

### Customer Display check-in
From Check-in, staff can hand over to the Customer Display: the customer scans their booking QR with the display's camera or types their phone
number on a keypad, and the result appears on both screens.

### Printing (store font, real paper width)
See **Printing setup** below. Documents are built from the store's layout (Admin → ออกแบบเอกสาร/ใบเสร็จ) and printed in the store's
receipt font, either **straight over the USB cable** (like the previous system: the document is drawn in the store font and sent to the
printer as ESC/POS image rows — no driver, no print dialog), or as real text through the operating-system printer driver. ESC/POS text with
the printer's own fonts is available only when the admin picks it.

### Integrations (ready to plug in)
* LINE Login (OAuth 2.1/OIDC). The first LINE login is linked by **logging in with the member's phone + password** (or signing up) — never
  merged by name. A LINE user ID is never the member ID.
  Without credentials in development, a LINE simulator page is used.
* LINE Messaging API notifications (booking confirmed, deposit, reminder, room change, cancel, refund …) respect consent and
  record status PENDING/SENT/FAILED/SKIPPED.
* Payment provider abstraction (`server/src/providers/payment.js`), dynamic PromptPay QR (EMVCo) with the amount built in.
* All secrets live in server environment variables only.

### Offline
The POS shows **OFFLINE**, queues allowed operations (adding items to rooms) in local storage with idempotency keys, and syncs them when
back online. Risky operations (payments, online booking locks, slip checks, availability) are never faked offline.

---

## Multi-store, plans and Super Owner (update 2026-10)

Everything that existed keeps working; the original store and all of its data became **store #1** (`slug = beatbox`).

### Database update steps
Nothing to run by hand: on start the server applies the new migrations in order, inside transactions, and never deletes data.

| Migration | What it does |
| --- | --- |
| `004_multistore.sql` | `store_id` on every business table (existing rows → store #1), per-store unique numbers, **PostgreSQL row-level security** (FORCE) so every query only sees the current store |
| `005_platform.sql` | Super Owner accounts, 4 plans (features + limits), store subscriptions + history, renewal requests. Existing stores get the top plan, active, no expiry |
| `006_payments_members_printing.sql` | Prepay room status (`PENDING_PAYMENT`), prepaid room charge on the bill, member password fields, printer paper/print-area settings, print-job queue fields, and **database triggers that refuse any reference to another store's row** |
| `007_platform_email.sql` | E-mail sign-in for the Super Owner (Super Admin) account |
| `008_usb_printing.sql` | Direct-cable printing in the store font (`RASTER` mode; USB/Serial/Bluetooth/Network printers are switched to it), the USB printer's vendor/product/serial, and real printer delete (`deleted_at`; past print jobs keep their history) |
| `009_bonus_time_kitchen_beep.sql` | Free extra minutes (`bonus_minutes`, never charged), printer beep on kitchen tickets |
| `010_smart_devices.sql` | Smart devices (Tuya): named systems, the device of each room, run log, automations already run per session |

Back up first (Render: Database → Backups, or `pg_dump`). The server connects with a non-superuser role so RLS always applies
(locally it switches to the restricted role `beatbox_app` automatically).

### Store isolation
* Every request runs inside one store: staff/member tokens carry their store; public pages use `?store=<slug>` (or the `X-Store` header).
* PostgreSQL row-level security (FORCE) + a per-row trigger on every foreign key → changing an id in a URL or body cannot read or attach
  another store's data (tested). API responses never include password/PIN hashes.

### Super Owner
* Created on start from `SUPER_OWNER_USERNAME` and/or `SUPER_OWNER_EMAIL` + `SUPER_OWNER_PASSWORD` (server environment only,
  bcrypt-hashed, never sent to the browser or returned by the API). Sign in with the **e-mail or the login name** (free text, no OTP) at
  `/platform`, or with the e-mail on the normal `/login` page (เจ้าของร้าน (อีเมล)), which opens the central console. The Super Admin's
  e-mail cannot be used to register a store. Adding `SUPER_OWNER_EMAIL` later adds the e-mail to the existing account without touching the password. Change the password in `/platform` → บัญชีของฉัน
  (other sessions are signed out). Changing the environment variable later does **not** overwrite an existing account.
* `/platform`: all stores (search, status, plan, expiry, time left, counts), add / edit stores, trial (days **or** end date-time),
  add trial days, renew (billing periods or end date), change plan, set expiry, suspend (reason required) / activate, full history with
  actor and time, renewal requests, sign-up settings and contact details, **plan editor**.
* **เข้าจัดการร้าน** opens the store as a hidden admin linked to the Super Owner account; an orange banner shows the store, every action is
  logged under the Super Owner's own name, and **กลับสู่หน้าจัดการส่วนกลาง** returns to the console.

### Plans (packages) — how to configure
`/platform` → แพ็กเกจและสิทธิ์ → pick one of the 4 plans and edit: name, description, price, billing cycle (day / month / year × N),
trial days, open for sign-up, **feature switches** (POS, rooms, booking, members, promotions, stock, reports, customer display,
receipt settings, printing, staff & roles, multi-branch) and optional limits (branches, rooms, staff, POS devices; empty = unlimited).
Saving applies immediately to every store on that plan (open screens refresh). Effective right = **plan feature AND the staff member's
permission**, enforced by the API (403 `FEATURE_NOT_IN_PLAN` / `PLAN_LIMIT`), not only by hiding menus.

### Trial, expiry, renewal
* The server clock decides. When a plan expires or a store is suspended, every business API returns **402** and every open screen
  switches to the expired page (ดูแพ็กเกจ / ต่ออายุ / ติดต่อผู้ดูแล). Data is kept; renewing restores everything immediately.
* Payments already sent before expiry still complete exactly once (idempotent replays, verified slips issued before expiry, terminal
  payments started before expiry, in-room QR payments).
* Top-right widget: store, plan, trial/paid, expiry date-time and remaining **years / months / days / hours / minutes** counted on the
  real calendar in the store time zone (whole years, then whole months with their real length — 31 Jan + 1 month = 28/29 Feb — then
  days/hours/minutes). Orange ≤ 7 days, red ≤ 1 day, clickable for details and a renewal request.

### Store owners
`/register`: store name, owner first/last name, e-mail, phone, password + confirm, plan → creates the owner account and the store's own
data space and logs in (trial of the chosen plan). Owners log in at `/login` → เจ้าของร้าน (อีเมล); 5 wrong passwords → 15 minutes lock.

## Rooms: pay before entering (default) or pay when closing
Admin → ตั้งค่าร้าน → ห้อง เวลา & แจ้งเตือน → รูปแบบการชำระค่าห้อง.
* **จ่ายก่อนเข้าห้อง (default):** open room → status **รอชำระค่าห้อง** (room held, clock not running) → collect the full room charge
  (cash with change, QR/transfer with slip check, card/other with reference) → the clock starts at the confirmed time and both tickets
  print. The prepaid amount is recorded on the same bill and deducted at checkout, never charged twice. "ยกเลิก" releases the room.
* **เข้าห้องก่อน:** the room starts at once and everything goes on the room bill.
* **ปิดห้อง** always asks the server what is still owed. If anything is due a breakdown appears (room, extensions, items with qty and
  price, discounts/VAT/service, total, paid, remaining) with **ไปชำระเงิน / กลับไปหน้าห้อง**; the bill and the room stay open.
  If nothing is due the room closes and the **full receipt prints automatically** (prepaid + paid at close per method, cash and change,
  "ชำระครบแล้ว · ยอดค้างชำระ 0.00 บาท", member info or the sign-up QR). Double clicks / retries never create a second payment,
  receipt or print job; a printer error never touches the payment and offers **พิมพ์ใหม่**.

## Smart devices (Tuya)
Admin → **อุปกรณ์อัจฉริยะ (Tuya)**:
1. Create a Cloud Project at iot.tuya.com (same Data Center as the Smart Life / Tuya app account), enable the **IoT Core** and
   **Authorization** APIs, link the app account (Devices → Link App Account), then paste the **Access ID / Access Secret**, pick the
   Data Center and press **ทดสอบการเชื่อมต่อ**. The secret is encrypted and never sent back to the browser.
2. **ระบบ** — name each system yourself and choose when it runs: manual button only · when the room clock starts (and again when
   time is added after it ran out) · when *N* minutes are left · when time is up (automatic cut) · when the room is closed/cancelled.
   Command = Tuya data point code (`switch_1`, `switch_2`, `switch_led` …) + on / off / other value. "แสดงเป็นปุ่ม" adds a button
   on the room screen.
3. **อุปกรณ์ของแต่ละห้อง** — the Tuya device of every room for every system (type the Device ID or load the list from Tuya;
   ⚡ sends a test command). Each automation runs once per session and end time (the server claims it atomically); every run is in
   the log, and a failure notifies the staff. The switch at the top turns the whole feature on or off.

## Room time shortcuts
* **+5 นาที** asks for a reason (quick reasons provided). Free by default — the end time moves but nothing is charged
  (`bonus_minutes`) — or switch on "คิดค่าบริการ" to charge it like any extension. Shown in the room history, the time slip and the
  Activity Log.

## Kitchen / bar tickets
Every order prints its kitchen/bar ticket by itself: a POS sale immediately, items added to a room (room screen or "เพิ่มเข้าห้อง")
a few seconds after the last item (default 5 s, so one round is one ticket), customer QR orders as before. Each ticket prints once
(one POS claims the job). Printers connected directly (USB/LAN/…) **beep** on kitchen tickets (`ESC B n t`, beep count per printer).
On/off and the batch time: เครื่องพิมพ์ → เอกสาร → เครื่องพิมพ์.

## Printing setup
1. Admin → เครื่องพิมพ์ → add the printer:
   * **USB cable (recommended, like the previous system):** plug in the printer, press **ค้นหาเครื่องพิมพ์ USB**, pick it in the
     browser's list, then **ใช้เครื่องนี้กับทุกเอกสาร** — it becomes the main printer and the route of every document type (receipts,
     room tickets, kitchen/bar, shift close …). Every document prints in the store font (e.g. Kanit) at the paper's printable width
     (80 mm → 576 dots) with the cut / drawer commands. Needs Google Chrome or Microsoft Edge on a computer (WebUSB); the browser asks for
     permission once. On Windows, if the message says the printer is in use by the Windows driver, switch the printer to the WinUSB driver
     with Zadig once — or use the "ไดรเวอร์ระบบ" connection instead. Serial, Bluetooth and Network (IP:9100) printers use the same mode.
   * Any printer row: **ใช้กับทุกเอกสาร** (one printer for everything) and the bin button to **delete** it (it disappears from the list
     and from document routing).
   * **ไดรเวอร์ระบบ:** install the printer's Windows/macOS driver, choose the connection "ไดรเวอร์ระบบ", paper 80 / 58 mm
     or custom, printable width (blank = 72 / 48 mm), margins and a font scale (raise to 1.1–1.3 if text looks small).
     In the driver: roll paper 80 (or 58) mm with continuous length, **cut every page**, no "fit to page" scaling.
     For printing without a dialog start Chrome/Edge with `--kiosk-printing` and make the receipt printer the default printer.
   * **ESC/POS ข้อความ (optional):** prints with the printer's built-in fonts only; you must pick this mode, tick
     "ยอมรับการใช้ฟอนต์ของเครื่องพิมพ์" and set the Thai code page from the printer manual. Logos are skipped; QR codes use the printer's
     own QR command (`GS ( k`).
2. Press **ทดสอบพิมพ์** — the test page shows Thai/English text, the left/right edges and the print area.
3. **เอกสาร → เครื่องพิมพ์:** every document type → printer, copies, cut, auto print. By default **one printer prints everything**.
   All documents go through one queue (in order, never interleaved). **คิวและสถานะงานพิมพ์** shows status and errors, **พิมพ์ใหม่** for
   failed jobs and **พิมพ์สำเนา** for reprints (marked "สำเนา"); reprints never create a bill, payment or room opening.
4. **ออกแบบเอกสาร/ใบเสร็จ:** per document (customer / staff room ticket, time-adjustment slip, receipt, food & drink list, kitchen ticket,
   member sign-up slip, deposit, void, shift report …) set each element's font, size (pt), bold, alignment, spacing, show/hide and order,
   with a live preview on the real paper width.

How it prints over USB: the document is rendered off-screen at the printable width in the store font, drawn at 8 dots/mm and sent as
`GS v 0` raster bands followed by feed + cut (and the drawer kick after cash). Verified with a simulated USB printer: the bytes sent decode
back to the receipt / room tickets in Kanit with the QR code, 576 dots wide.

How it prints through the OS driver: each document becomes one page exactly as wide as the paper and exactly as long as its content (CSS `@page` per document),
in the store's font (Kanit is bundled with the app, so it never depends on a font CDN). If a chosen font cannot be loaded the job stops
with a message — the font is never swapped silently. Verified: the generated print/PDF contains selectable text with the font embedded
and **no images** (receipt 80 × 213 mm, room tickets 80 × 121 mm + 80 × 80 mm in the test run).

**Printers that print the store's font (OS driver):** Epson TM-T82III / TM-T82X / TM-T88VI / TM-T88VII / TM-m30II / TM-m30III,
Star TSP143IIIU / TSP143IV / mC-Print3 / TSP654II, Bixolon SRP-330II / SRP-350III / SRP-E300, Xprinter XP-Q80 / XP-N160II / XP-58IIH
(POS-80/58 driver). Android POS terminals (Sunmi, iMin) only when Chrome and an Android print service for the printer are installed —
test first. Any ESC/POS printer can be used in ESC/POS text mode, but with its own fonts (Thai requires a Thai code page in the printer).

## Room tickets and receipts
* Header = **room name, type and number** (not the queue number); both tickets show date, start, end, duration, reference no and the staff
  who opened the room. Across midnight both dates are printed (เริ่ม 12/10/2026 เวลา 23:00 · สิ้นสุด 13/10/2026 เวลา 01:00).
* Times come from the real session; extending moves the end time and a **time-adjustment slip** can be printed from the history.
* Receipts of bills **without a member** end with a sign-up QR (`/book/signup?store=<slug>`, no personal data in the link) and the note
  "สำหรับการสมัครสมาชิกครั้งแรก รหัสผ่านเริ่มต้นคือเลข 4 ตัวท้ายของเบอร์โทรศัพท์ …". Bills with a member show the member instead.

## Members: phone + password (no OTP)
* Sign-up: phone, first name, last name + extra fields defined by the store (Admin → ตั้งค่าร้าน → สมัครสมาชิก). The same phone in the
  same store goes to login instead.
* First password = **last 4 digits of the phone** (kept as text, so 0099 stays 0099). After sign-up: "สมัครสมาชิกสำเร็จ รหัสผ่านเริ่มต้นของคุณ
  คือเลข 4 ตัวท้ายของเบอร์โทรศัพท์ กรุณาเปลี่ยนรหัสผ่านเมื่อเข้าสู่ระบบครั้งแรก". The first login must set a new password before any member
  data; members can change it later. 5 wrong passwords → 15 minutes lock. Passwords are bcrypt hashes; the default is never stored.
* Staff (Admin → สมาชิก → member) see the login phone, whether the password is still the default or was changed, last change / reset
  (who and when) — never the password — and can **รีเซ็ตรหัสผ่าน** (permission `member.edit`): back to the default, forced change at next login,
  logged in the activity log.

## Booking calendar
* **สลับแนวตาราง:** time horizontal / rooms vertical, or time vertical / rooms horizontal (display only; each device remembers its choice;
  the store default is in Admin → ตั้งค่าร้าน → ตารางการจอง). Sticky headers both ways, room name + number + type, click a free slot to book,
  click a booking to open it, drag to move it (the server re-checks overlaps), works on desktop, tablet and phone.
* **Current-time line** (vertical when time runs horizontally, horizontal when vertical) with the label "เวลาปัจจุบัน HH:mm" and a soft glow;
  colour, on/off and speed in the same settings page. It follows the server clock in the store time zone (default Asia/Bangkok), is shown
  only on today's business day (a night past midnight still counts) and **ไปยังเวลาปัจจุบัน** scrolls to it.

## Test results (this update)
* `npm test`: calculation engine (shared) + API end-to-end suites — store registration without OTP, duplicate e-mail, store isolation
  (ids/URLs/headers, plus the cross-store reference guard), Super Owner + plan features/limits, expiry → 402 with in-flight payment and
  renewal, suspend/activate, enter-store audit, owner lockout, prepay (amount check, double click, idempotent replay, shift totals),
  close-room outstanding check, postpay, cancel before paying, ticket data, print job idempotency/reprint, printer route checks, member
  sign-up/login/forced change/lockout/staff reset, receipt sign-up QR only without a member.
* Browser (Chromium): store sign-up → widget → expired screen → renewal → Super Owner enter/return; prepay → tickets → extension →
  outstanding modal → payment → automatic receipt; print output rendered to PDF and inspected (page sizes, embedded Kanit, text, 0 images);
  calendar both orientations + now line + sticky headers + mobile; member sign-up via QR link, default-password login, forced change,
  staff reset.

# BEATBOX Karaoke — ระบบบริหารร้านคาราโอเกะ + POS + เว็บไซต์จองห้องออนไลน์

A full-stack karaoke management system: back-office + touch POS, a **Customer Display**, and a mobile-first
**online booking website**. All three share one backend and one PostgreSQL database.

| URL | Purpose |
| --- | --- |
| `/login`, `/admin/*` | Back office + POS (staff 4-digit PIN login) |
| `/display` | Customer Display (pair with the 4–6 digit code shown on the POS) |
| `/book/*` | Customer online booking website (members: phone OTP / LINE) |

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
* Images (logo, rooms, products, promotions, QR, background) are always **image URLs**. Payment slips are the only uploads:
  they are transaction documents, stored privately and visible only to staff with `slip.verify`.

### Printing (80 mm thermal)
* **Browser/USB via OS driver** (`window.print`, `@page 80mm`), **WebUSB**, **Web Serial**, **Web Bluetooth**, and **Network (IP:9100)**,
  where the server sends ESC/POS raw data.
* Receipts are rendered from HTML (with the chosen Thai font) to a 1-bit raster image and sent as ESC/POS `GS v 0`, with auto-cut and
  cash-drawer kick. Every print shows a preview first. Reprints are marked **สำเนา / COPY** and need the `receipt.reprint` permission.
* Templates: full and short receipts, kitchen/bar tickets, deposit receipt, deposit refund, void slip, shift report, report slip, test page.

### Integrations (ready to plug in)
* LINE Login (OAuth 2.1/OIDC) with **phone-OTP verification before linking** to an existing member. A LINE user ID is never the member ID.
  Without credentials in development, a LINE simulator page is used.
* LINE Messaging API notifications (booking confirmed, deposit, reminder, room change, cancel, refund …) respect consent and
  record status PENDING/SENT/FAILED/SKIPPED.
* Payment provider abstraction (`server/src/providers/payment.js`), dynamic PromptPay QR (EMVCo) with the amount built in.
* All secrets live in server environment variables only.

### Offline
The POS shows **OFFLINE**, queues allowed operations (adding items to rooms) in local storage with idempotency keys, and syncs them when
back online. Risky operations (payments, online booking locks, slip checks, availability) are never faked offline.

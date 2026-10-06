# QuickCash — Short-Term Loan App

An InstaMoney-style lending app for small short-term loans of **₹5,000 to ₹10,000**. The amount a customer can borrow depends on their **monthly salary and other monthly income**, along with their existing EMIs.

| Part | URL | Who uses it |
|------|-----|-------------|
| Customer app (installable PWA) | `/app` | Borrowers, on their phones |
| Admin panel (web) | `/admin` | Your team, on a computer or phone |
| Landing page + eligibility calculator | `/` | Visitors |

**Customer app:** mobile number + OTP login → personal details → work & income (shows the eligible limit) → KYC uploads (PAN, Aadhaar front/back, selfie, salary slip or bank statement) → bank account → choose amount & tenure → track approval → pay EMIs by UPI and submit the UTR. Customers can install it from the browser (**Add to Home screen**), and it opens full-screen like a native app.

**Admin panel:** dashboard counts, search and filter, and a detail view per application showing the KYC photos, applicant, income decision, bank account and repayment schedule. Admins can approve, reject (with a reason the customer sees), mark as disbursed (with the bank UTR), confirm or reject customer EMI payments, and record payments themselves. A loan closes automatically when every EMI is confirmed.

Built with Node.js and Express. Data is stored in SQLite (Node's built-in `node:sqlite`), and KYC files are saved on disk.

## Quick start

Requires Node.js 22.5 or later.

```bash
npm install
ADMIN_TOKEN=change-me npm start
```

Open http://localhost:3000/app for the customer app and http://localhost:3000/admin for the admin panel. Run the tests with `npm test`.

| Env var | Purpose |
|---------|---------|
| `PORT` | HTTP port (default `3000`) |
| `ADMIN_TOKEN` | Admin login password (dev default `admin123`) |
| `DB_FILE` | SQLite database path (default `data/loans.db`) |
| `UPLOAD_DIR` | KYC file folder (default `data/uploads`) |
| `MSG91_AUTH_KEY`, `MSG91_TEMPLATE_ID` | Real SMS OTPs via MSG91. **Without these the app runs in demo mode and shows the OTP on screen.** |
| `LENDER_UPI_ID` | UPI ID customers pay EMIs to (powers the "Pay with UPI app" button) |
| `LENDER_NAME` | Payee name shown in UPI apps (default `QuickCash`) |
| `LENDER_BANK_DETAILS` | Optional bank transfer details shown on the pay screen |
| `SUPPORT_PHONE`, `SUPPORT_EMAIL` | Shown under Help & support in the app |

## Eligibility rules

All rules live in `POLICY` in [`src/eligibility.js`](src/eligibility.js) so they're easy to change.

| Rule | Value |
|------|-------|
| Loan amount | ₹5,000 – ₹10,000, in steps of ₹500 |
| Age | 21 – 58 years |
| Assessed income | Net salary + **50%** of other monthly income |
| Minimum assessed income | ₹15,000 / month |
| Income limit | Loan ≤ **40%** of assessed monthly income |
| Repayment capacity (FOIR) | Existing EMIs + this loan's monthly instalment ≤ **50%** of assessed income |
| Time in current job | Salaried ≥ 3 months, self-employed ≥ 6 months |
| Tenure | 30, 60 or 90 days (1, 2 or 3 monthly instalments) |
| Interest | 2% per month, flat |
| Processing fee | 2% of the loan, deducted at disbursal |

**Eligible amount** = the lowest of ₹10,000, the income limit and the FOIR limit, rounded down to ₹500. If that is below ₹5,000, or any other rule fails, the application is rejected automatically with reasons. If someone asks for more than they're eligible for, they're offered the eligible maximum.

Examples (no existing EMIs):

| Salary | Other income | Assessed | Max loan |
|--------|--------------|----------|----------|
| ₹14,000 | – | ₹14,000 | Not eligible |
| ₹15,000 | – | ₹15,000 | ₹6,000 |
| ₹18,000 | – | ₹18,000 | ₹7,000 |
| ₹22,000 | ₹4,000 | ₹24,000 | ₹9,500 |
| ₹25,000+ | – | ₹25,000+ | ₹10,000 |

## Application lifecycle

```
PENDING ──approve──▶ APPROVED ──disburse (UTR)──▶ DISBURSED ──all EMIs confirmed──▶ CLOSED
   │                    │
   └──reject──▶ REJECTED ◀──reject──┘
```

- Applications that fail the rules are saved as `REJECTED` straight away, with reasons.
- Approval is blocked until all 5 KYC documents are uploaded.
- EMI due dates are counted from the disbursal date.
- A customer (and a PAN) can have only one active loan at a time, and a PAN can be registered to only one mobile number.

## API

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/policy` | – | Loan policy |
| POST | `/api/eligibility` | – | Public eligibility calculator |
| POST | `/api/auth/otp` | – | Send login OTP |
| POST | `/api/auth/verify` | – | Verify OTP → session token |
| POST | `/api/auth/logout` | customer | End session |
| GET | `/api/me` | customer | Profile, onboarding steps, limit, loans |
| PUT | `/api/me/personal` · `/employment` · `/bank` | customer | Save onboarding steps |
| POST | `/api/me/documents` | customer | Upload KYC file (`{type, dataUrl}`) |
| POST | `/api/me/quote` | customer | Price an amount and tenure |
| POST | `/api/me/loans` | customer | Apply |
| GET | `/api/me/loans/:id` | customer | Loan with schedule and payments |
| POST | `/api/me/loans/:id/repayments` | customer | Submit an EMI payment UTR |
| GET | `/api/admin/applications[?status=]` | admin | List and stats |
| GET | `/api/admin/applications/:id` | admin | Full detail incl. documents |
| GET | `/api/admin/documents/:id` | admin | View a KYC file |
| POST | `/api/admin/applications/:id/{approve,reject,disburse,close}` | admin | Status change (`note`, `reference`) |
| POST | `/api/admin/applications/:id/repayments` | admin | Record an EMI payment |
| POST | `/api/admin/repayments/:id/{confirm,reject}` | admin | Review a customer payment |

Customer endpoints use `Authorization: Bearer <session token>`, and admin endpoints use `Authorization: Bearer <ADMIN_TOKEN>`.

## Project layout

```
src/
  eligibility.js   loan policy, eligibility engine, quotes and schedules
  validation.js    input validation (PAN, mobile, IFSC, amounts, …)
  db.js            SQLite storage: customers, OTPs, sessions, documents, loans, repayments
  sms.js           OTP sender (MSG91 or demo mode)
  app.js           Express routes
  server.js        entry point and config
public/
  index.html, landing.js     landing page and calculator
  app.html, customer.js      customer app (PWA: manifest.webmanifest, sw.js, icons/)
  admin.html, admin.js       admin panel
  common.js, styles.css      shared helpers and styles
test/              unit and API tests (node:test)
```

## Before going live

This is a working base. Before lending real money you still need:

- **SMS:** a MSG91 account with a DLT-approved OTP template (set `MSG91_*`). Until then, anyone can see the OTP on screen.
- **Storage that survives restarts** for the database and KYC files (see the Render section).
- **KYC verification:** PAN/Aadhaar checks via a provider (e.g. Digio, Signzy, Karza) and a credit bureau pull, plus bank account verification (penny drop).
- **Payments:** a payment gateway or UPI autopay/e-mandate for disbursal and automatic EMI collection, instead of manual UTR entry.
- **Admin accounts:** individual admin logins and an audit log instead of one shared token.
- **Compliance:** an RBI-registered NBFC or lending partner, and a Key Fact Statement, terms and privacy policy that meet the RBI Digital Lending Guidelines.

## Deploy to Render (free)

The repo includes a [`render.yaml`](render.yaml) blueprint.

1. Sign in at https://render.com with GitHub.
2. **New → Blueprint**, pick this repository and branch, then **Apply**.
3. When the deploy finishes, open the `https://quickcash-loan-….onrender.com` URL.
4. Your admin token is under the service's **Environment** tab (`ADMIN_TOKEN`). Set `LENDER_UPI_ID` and the support contacts there too.

On the free plan the service sleeps after about 15 minutes idle (the first visit then takes around a minute), and **the database and KYC uploads are wiped on every restart or redeploy**. For real customers, switch to a paid instance, uncomment the `disk` block in `render.yaml`, and set `DB_FILE=/var/data/loans.db` and `UPLOAD_DIR=/var/data/uploads`.

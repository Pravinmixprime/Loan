# QuickCash — Short-Term Loan App

A web application for small short-term loans of **₹5,000 to ₹10,000**. The amount a person can borrow depends on their **monthly salary and other monthly income**, along with their existing EMIs.

- **Applicants** check eligibility, choose an amount, see the full cost and repayment schedule, apply, and track their application.
- **Admins** review applications and move them through approve → disburse → repaid (or reject).

Built with Node.js and Express. Data is stored in SQLite using Node's built-in `node:sqlite` module, so there are no native dependencies.

## Quick start

Requires Node.js 22.5 or later.

```bash
npm install
ADMIN_TOKEN=change-me npm start
```

- Applicant site: http://localhost:3000
- Admin panel: http://localhost:3000/admin.html (log in with `ADMIN_TOKEN`)

| Env var       | Default            | Purpose                       |
|---------------|--------------------|-------------------------------|
| `PORT`        | `3000`             | HTTP port                     |
| `ADMIN_TOKEN` | `admin123` (dev)   | Bearer token for admin API    |
| `DB_FILE`     | `data/loans.db`    | SQLite database path          |

Run tests with `npm test`.

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
PENDING ──approve──▶ APPROVED ──disburse──▶ DISBURSED ──close──▶ CLOSED
   │                    │
   └──reject──▶ REJECTED ◀──reject──┘
```

Ineligible applications are saved as `REJECTED` right away. A PAN can have only one active (pending, approved or disbursed) application at a time.

## API

| Method | Path | Description |
|--------|------|-------------|
| GET  | `/api/policy` | Current loan policy |
| POST | `/api/eligibility` | Eligibility check and quote (nothing is saved) |
| POST | `/api/applications` | Submit an application |
| GET  | `/api/applications/:id?mobile=…` | Applicant status lookup |
| GET  | `/api/admin/applications?status=…` | List applications and stats (admin) |
| POST | `/api/admin/applications/:id/{approve,reject,disburse,close}` | Change status; optional `{ "note": "…" }` (admin) |

Admin endpoints require `Authorization: Bearer <ADMIN_TOKEN>`.

## Project layout

```
src/
  eligibility.js   loan policy, eligibility engine, quotes and schedules
  validation.js    input validation (PAN, mobile, amounts, …)
  db.js            SQLite storage and status transitions
  app.js           Express routes
  server.js        entry point
public/            applicant site (index.html) and admin panel (admin.html)
test/              unit and API tests (node:test)
```

## Before going live

This is a working base, not a production lending system. Before taking real customers you would still need:

- Real KYC (PAN/Aadhaar verification) and a credit bureau check
- Bank account capture and verification, plus a payment gateway for disbursal and repayment
- Proper admin user accounts instead of a shared token, plus HTTPS and rate limiting
- Review of interest, fees and disclosures against RBI digital lending guidelines

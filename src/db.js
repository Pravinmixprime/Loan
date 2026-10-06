'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { quote } = require('./eligibility');

const ACTIVE_STATUSES = ['PENDING', 'APPROVED', 'DISBURSED'];
const DOCUMENT_TYPES = ['pan', 'aadhaar_front', 'aadhaar_back', 'selfie', 'income_proof'];

// Allowed admin transitions between application statuses.
const TRANSITIONS = {
  PENDING: ['APPROVED', 'REJECTED'],
  APPROVED: ['DISBURSED', 'REJECTED'],
  DISBURSED: ['CLOSED'],
  REJECTED: [],
  CLOSED: [],
};

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS customers (
    id               TEXT PRIMARY KEY,
    mobile           TEXT NOT NULL UNIQUE,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    full_name        TEXT,
    email            TEXT,
    date_of_birth    TEXT,
    pan              TEXT UNIQUE,
    employment_type  TEXT,
    employer_name    TEXT,
    months_in_job    INTEGER,
    monthly_salary   INTEGER,
    other_income     INTEGER,
    existing_emi     INTEGER,
    bank_holder      TEXT,
    bank_account     TEXT,
    bank_ifsc        TEXT
  );

  CREATE TABLE IF NOT EXISTS otps (
    mobile      TEXT PRIMARY KEY,
    code_hash   TEXT NOT NULL,
    expires_at  INTEGER NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    sent_at     INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash   TEXT PRIMARY KEY,
    customer_id  TEXT NOT NULL REFERENCES customers(id),
    expires_at   INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS documents (
    id           TEXT PRIMARY KEY,
    customer_id  TEXT NOT NULL REFERENCES customers(id),
    type         TEXT NOT NULL,
    mime         TEXT NOT NULL,
    file         TEXT NOT NULL,
    size         INTEGER NOT NULL,
    uploaded_at  TEXT NOT NULL,
    UNIQUE (customer_id, type)
  );

  CREATE TABLE IF NOT EXISTS applications (
    id                  TEXT PRIMARY KEY,
    customer_id         TEXT REFERENCES customers(id),
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    status              TEXT NOT NULL,
    full_name           TEXT NOT NULL,
    mobile              TEXT NOT NULL,
    email               TEXT NOT NULL,
    pan                 TEXT NOT NULL,
    date_of_birth       TEXT NOT NULL,
    employment_type     TEXT NOT NULL,
    employer_name       TEXT NOT NULL,
    months_in_job       INTEGER NOT NULL,
    monthly_salary      INTEGER NOT NULL,
    other_income        INTEGER NOT NULL,
    existing_emi        INTEGER NOT NULL,
    requested_amount    INTEGER NOT NULL,
    tenure_days         INTEGER NOT NULL,
    assessed_income     INTEGER NOT NULL,
    max_eligible_amount INTEGER NOT NULL,
    approved_amount     INTEGER NOT NULL,
    decision_reasons    TEXT NOT NULL,
    quote               TEXT,
    admin_note          TEXT,
    bank_holder         TEXT,
    bank_account        TEXT,
    bank_ifsc           TEXT,
    disbursal_ref       TEXT,
    disbursed_at        TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_applications_customer ON applications (customer_id);
  CREATE INDEX IF NOT EXISTS idx_applications_status ON applications (status);

  CREATE TABLE IF NOT EXISTS repayments (
    id              TEXT PRIMARY KEY,
    application_id  TEXT NOT NULL REFERENCES applications(id),
    installment     INTEGER NOT NULL,
    amount          INTEGER NOT NULL,
    reference       TEXT NOT NULL,
    status          TEXT NOT NULL,
    source          TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    reviewed_at     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_repayments_application ON repayments (application_id);
`;

// Columns added after the first release; ALTERed in if an older database is opened.
const LATER_APPLICATION_COLUMNS = {
  customer_id: 'TEXT',
  bank_holder: 'TEXT',
  bank_account: 'TEXT',
  bank_ifsc: 'TEXT',
  disbursal_ref: 'TEXT',
  disbursed_at: 'TEXT',
};

const now = () => new Date().toISOString();
const newId = (prefix, bytes = 5) => prefix + crypto.randomBytes(bytes).toString('hex').toUpperCase();
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function openDb({
  file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'loans.db'),
  uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'data', 'uploads'),
} = {}) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(uploadDir, { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  const existing = new Set(db.prepare('PRAGMA table_info(applications)').all().map((c) => c.name));
  for (const [name, type] of Object.entries(LATER_APPLICATION_COLUMNS)) {
    if (!existing.has(name)) db.exec(`ALTER TABLE applications ADD COLUMN ${name} ${type}`);
  }
  return createRepo(db, uploadDir);
}

function rowToCustomer(row) {
  if (!row) return null;
  return {
    id: row.id,
    mobile: row.mobile,
    createdAt: row.created_at,
    fullName: row.full_name,
    email: row.email,
    dateOfBirth: row.date_of_birth,
    pan: row.pan,
    employmentType: row.employment_type,
    employerName: row.employer_name,
    monthsInCurrentJob: row.months_in_job,
    monthlySalary: row.monthly_salary,
    otherMonthlyIncome: row.other_income,
    existingEmi: row.existing_emi,
    bank: row.bank_account
      ? { accountHolder: row.bank_holder, accountNumber: row.bank_account, ifsc: row.bank_ifsc }
      : null,
  };
}

function rowToApplication(row) {
  if (!row) return null;
  return {
    id: row.id,
    customerId: row.customer_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    status: row.status,
    fullName: row.full_name,
    mobile: row.mobile,
    email: row.email,
    pan: row.pan,
    dateOfBirth: row.date_of_birth,
    employmentType: row.employment_type,
    employerName: row.employer_name,
    monthsInCurrentJob: row.months_in_job,
    monthlySalary: row.monthly_salary,
    otherMonthlyIncome: row.other_income,
    existingEmi: row.existing_emi,
    requestedAmount: row.requested_amount,
    tenureDays: row.tenure_days,
    assessedIncome: row.assessed_income,
    maxEligibleAmount: row.max_eligible_amount,
    approvedAmount: row.approved_amount,
    reasons: JSON.parse(row.decision_reasons),
    quote: row.quote ? JSON.parse(row.quote) : null,
    adminNote: row.admin_note,
    bank: row.bank_account
      ? { accountHolder: row.bank_holder, accountNumber: row.bank_account, ifsc: row.bank_ifsc }
      : null,
    disbursalRef: row.disbursal_ref,
    disbursedAt: row.disbursed_at,
  };
}

function rowToRepayment(row) {
  return {
    id: row.id,
    applicationId: row.application_id,
    installment: row.installment,
    amount: row.amount,
    reference: row.reference,
    status: row.status,
    source: row.source,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
  };
}

function createRepo(db, uploadDir) {
  const q = {
    customerById: db.prepare('SELECT * FROM customers WHERE id = ?'),
    customerByMobile: db.prepare('SELECT * FROM customers WHERE mobile = ?'),
    customerByPan: db.prepare('SELECT id FROM customers WHERE pan = ?'),
    insertCustomer: db.prepare(
      'INSERT INTO customers (id, mobile, created_at, updated_at) VALUES (?, ?, ?, ?)'
    ),
    otpByMobile: db.prepare('SELECT * FROM otps WHERE mobile = ?'),
    upsertOtp: db.prepare(`
      INSERT INTO otps (mobile, code_hash, expires_at, attempts, sent_at) VALUES (?, ?, ?, 0, ?)
      ON CONFLICT (mobile) DO UPDATE SET code_hash = excluded.code_hash,
        expires_at = excluded.expires_at, attempts = 0, sent_at = excluded.sent_at`),
    otpAttempt: db.prepare('UPDATE otps SET attempts = attempts + 1 WHERE mobile = ?'),
    deleteOtp: db.prepare('DELETE FROM otps WHERE mobile = ?'),
    insertSession: db.prepare('INSERT INTO sessions (token_hash, customer_id, expires_at) VALUES (?, ?, ?)'),
    sessionByHash: db.prepare('SELECT * FROM sessions WHERE token_hash = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    documentsByCustomer: db.prepare(
      'SELECT * FROM documents WHERE customer_id = ? ORDER BY uploaded_at'
    ),
    documentByType: db.prepare('SELECT * FROM documents WHERE customer_id = ? AND type = ?'),
    documentById: db.prepare('SELECT * FROM documents WHERE id = ?'),
    upsertDocument: db.prepare(`
      INSERT INTO documents (id, customer_id, type, mime, file, size, uploaded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (customer_id, type) DO UPDATE SET id = excluded.id, mime = excluded.mime,
        file = excluded.file, size = excluded.size, uploaded_at = excluded.uploaded_at`),
    applicationById: db.prepare('SELECT * FROM applications WHERE id = ?'),
    applicationsByCustomer: db.prepare(
      'SELECT * FROM applications WHERE customer_id = ? ORDER BY created_at DESC'
    ),
    activeByCustomer: db.prepare(
      `SELECT id FROM applications WHERE customer_id = ?
       AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})`
    ),
    activeByPan: db.prepare(
      `SELECT id FROM applications WHERE pan = ?
       AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})`
    ),
    insertApplication: db.prepare(`
      INSERT INTO applications (
        id, customer_id, created_at, updated_at, status, full_name, mobile, email, pan, date_of_birth,
        employment_type, employer_name, months_in_job, monthly_salary, other_income, existing_emi,
        requested_amount, tenure_days, assessed_income, max_eligible_amount, approved_amount,
        decision_reasons, quote, bank_holder, bank_account, bank_ifsc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    updateStatus: db.prepare(
      'UPDATE applications SET status = ?, admin_note = COALESCE(?, admin_note), updated_at = ? WHERE id = ?'
    ),
    markDisbursed: db.prepare(`
      UPDATE applications SET status = 'DISBURSED', disbursal_ref = ?, disbursed_at = ?, quote = ?,
        admin_note = COALESCE(?, admin_note), updated_at = ? WHERE id = ?`),
    repaymentsByApplication: db.prepare(
      'SELECT * FROM repayments WHERE application_id = ? ORDER BY installment, created_at'
    ),
    repaymentById: db.prepare('SELECT * FROM repayments WHERE id = ?'),
    insertRepayment: db.prepare(`
      INSERT INTO repayments (id, application_id, installment, amount, reference, status, source, created_at, reviewed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    reviewRepayment: db.prepare('UPDATE repayments SET status = ?, reviewed_at = ? WHERE id = ?'),
  };

  const repo = {
    db,
    uploadDir,

    // ----- customers & auth -----

    getCustomer(id) {
      return rowToCustomer(q.customerById.get(id));
    },

    findOrCreateCustomer(mobile) {
      const found = q.customerByMobile.get(mobile);
      if (found) return rowToCustomer(found);
      const id = newId('CU');
      const ts = now();
      q.insertCustomer.run(id, mobile, ts, ts);
      return this.getCustomer(id);
    },

    panTakenByOther(pan, customerId) {
      const row = q.customerByPan.get(pan);
      return Boolean(row && row.id !== customerId);
    },

    updateCustomer(id, fields) {
      const columns = {
        fullName: 'full_name',
        email: 'email',
        dateOfBirth: 'date_of_birth',
        pan: 'pan',
        employmentType: 'employment_type',
        employerName: 'employer_name',
        monthsInCurrentJob: 'months_in_job',
        monthlySalary: 'monthly_salary',
        otherMonthlyIncome: 'other_income',
        existingEmi: 'existing_emi',
        bankHolder: 'bank_holder',
        bankAccount: 'bank_account',
        bankIfsc: 'bank_ifsc',
      };
      const keys = Object.keys(fields).filter((k) => k in columns);
      if (!keys.length) return this.getCustomer(id);
      const sets = keys.map((k) => `${columns[k]} = ?`).join(', ');
      db.prepare(`UPDATE customers SET ${sets}, updated_at = ? WHERE id = ?`).run(
        ...keys.map((k) => fields[k]),
        now(),
        id
      );
      return this.getCustomer(id);
    },

    listCustomers() {
      return db.prepare('SELECT * FROM customers ORDER BY created_at DESC').all().map(rowToCustomer);
    },

    saveOtp(mobile, code, ttlMs) {
      const t = Date.now();
      q.upsertOtp.run(mobile, sha256(`${mobile}:${code}`), t + ttlMs, t);
    },

    getOtp(mobile) {
      return q.otpByMobile.get(mobile) || null;
    },

    /** Returns 'ok', 'expired', 'invalid' or 'locked'. Consumes the OTP on success. */
    checkOtp(mobile, code, maxAttempts) {
      const row = q.otpByMobile.get(mobile);
      if (!row || row.expires_at < Date.now()) return 'expired';
      if (row.attempts >= maxAttempts) return 'locked';
      q.otpAttempt.run(mobile);
      const a = Buffer.from(row.code_hash);
      const b = Buffer.from(sha256(`${mobile}:${code}`));
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return 'invalid';
      q.deleteOtp.run(mobile);
      return 'ok';
    },

    createSession(customerId, ttlMs) {
      const token = crypto.randomBytes(32).toString('base64url');
      q.insertSession.run(sha256(token), customerId, Date.now() + ttlMs);
      return token;
    },

    customerForToken(token) {
      const row = q.sessionByHash.get(sha256(token));
      if (!row) return null;
      if (row.expires_at < Date.now()) {
        q.deleteSession.run(row.token_hash);
        return null;
      }
      return this.getCustomer(row.customer_id);
    },

    deleteSession(token) {
      q.deleteSession.run(sha256(token));
    },

    // ----- documents -----

    saveDocument(customerId, type, mime, buffer) {
      const dir = path.join(uploadDir, customerId);
      fs.mkdirSync(dir, { recursive: true });
      const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' }[mime];
      const id = newId('DOC', 8);
      const file = path.join(customerId, `${type}-${id}.${ext}`);
      fs.writeFileSync(path.join(uploadDir, file), buffer);

      const previous = q.documentByType.get(customerId, type);
      q.upsertDocument.run(id, customerId, type, mime, file, buffer.length, now());
      if (previous) fs.rmSync(path.join(uploadDir, previous.file), { force: true });
      return this.getDocument(id);
    },

    listDocuments(customerId) {
      return q.documentsByCustomer.all(customerId).map((d) => ({
        id: d.id,
        type: d.type,
        mime: d.mime,
        size: d.size,
        uploadedAt: d.uploaded_at,
      }));
    },

    getDocument(id) {
      const d = q.documentById.get(id);
      return d ? { id: d.id, customerId: d.customer_id, type: d.type, mime: d.mime, path: path.join(uploadDir, d.file) } : null;
    },

    getDocumentByType(customerId, type) {
      const d = q.documentByType.get(customerId, type);
      return d ? this.getDocument(d.id) : null;
    },

    // ----- applications -----

    createApplication(customer, request, decision) {
      const id = newId('QL');
      const ts = now();
      q.insertApplication.run(
        id, customer.id, ts, ts,
        decision.eligible ? 'PENDING' : 'REJECTED',
        customer.fullName, customer.mobile, customer.email, customer.pan, customer.dateOfBirth,
        customer.employmentType, customer.employerName, customer.monthsInCurrentJob,
        customer.monthlySalary, customer.otherMonthlyIncome, customer.existingEmi,
        request.requestedAmount, request.tenureDays,
        decision.assessedIncome, decision.maxEligibleAmount, decision.approvedAmount,
        JSON.stringify(decision.reasons),
        decision.quote ? JSON.stringify(decision.quote) : null,
        customer.bank.accountHolder, customer.bank.accountNumber, customer.bank.ifsc
      );
      return this.getApplication(id);
    },

    getApplication(id) {
      return rowToApplication(q.applicationById.get(id));
    },

    /** Application plus its repayments and per-installment payment status. */
    getLoanDetails(id) {
      const app = this.getApplication(id);
      if (!app) return null;
      const repayments = q.repaymentsByApplication.all(id).map(rowToRepayment);
      const schedule = (app.quote ? app.quote.schedule : []).map((s) => {
        const forInstallment = repayments.filter((r) => r.installment === s.installment);
        const status = forInstallment.some((r) => r.status === 'CONFIRMED')
          ? 'PAID'
          : forInstallment.some((r) => r.status === 'SUBMITTED')
            ? 'VERIFYING'
            : app.status === 'DISBURSED' && s.dueDate < now().slice(0, 10)
              ? 'OVERDUE'
              : 'DUE';
        return { ...s, status };
      });
      const paid = schedule.filter((s) => s.status === 'PAID').reduce((sum, s) => sum + s.amount, 0);
      const outstanding = app.quote && app.status === 'DISBURSED' ? app.quote.totalRepayable - paid : 0;
      return { ...app, schedule, repayments, paidAmount: paid, outstandingAmount: outstanding };
    },

    listCustomerApplications(customerId) {
      return q.applicationsByCustomer.all(customerId).map(rowToApplication);
    },

    findActiveApplication(customerId, pan) {
      return (
        q.activeByCustomer.get(customerId, ...ACTIVE_STATUSES) ||
        (pan && q.activeByPan.get(pan, ...ACTIVE_STATUSES)) ||
        null
      );
    },

    list({ status } = {}) {
      const rows = status
        ? db.prepare('SELECT * FROM applications WHERE status = ? ORDER BY created_at DESC').all(status)
        : db.prepare('SELECT * FROM applications ORDER BY created_at DESC').all();
      const pending = new Map(
        db
          .prepare(`SELECT application_id, COUNT(*) AS n FROM repayments WHERE status = 'SUBMITTED' GROUP BY application_id`)
          .all()
          .map((r) => [r.application_id, r.n])
      );
      return rows.map((r) => ({ ...rowToApplication(r), paymentsToVerify: pending.get(r.id) || 0 }));
    },

    stats() {
      const rows = db
        .prepare(
          `SELECT status, COUNT(*) AS count, COALESCE(SUM(approved_amount), 0) AS amount
           FROM applications GROUP BY status`
        )
        .all();
      const stats = Object.fromEntries(rows.map((r) => [r.status, { count: r.count, amount: r.amount }]));
      stats.paymentsToVerify = db
        .prepare(`SELECT COUNT(*) AS n FROM repayments WHERE status = 'SUBMITTED'`)
        .get().n;
      stats.customers = db.prepare('SELECT COUNT(*) AS n FROM customers').get().n;
      return stats;
    },

    /** Moves an application to a new status if the transition is allowed. */
    transition(id, nextStatus, { note = null, reference = null } = {}) {
      const current = this.getApplication(id);
      if (!current) return { error: 'not_found' };
      if (!TRANSITIONS[current.status].includes(nextStatus)) {
        return { error: 'invalid_transition', from: current.status, to: nextStatus };
      }
      const ts = now();
      if (nextStatus === 'DISBURSED') {
        // EMI dates count from the day the money is actually sent.
        const fresh = quote(current.approvedAmount, current.tenureDays, new Date());
        q.markDisbursed.run(reference, ts, JSON.stringify(fresh), note, ts, id);
      } else {
        q.updateStatus.run(nextStatus, note, ts, id);
      }
      return { application: this.getLoanDetails(id) };
    },

    // ----- repayments -----

    addRepayment(applicationId, { installment, reference, source }) {
      const loan = this.getLoanDetails(applicationId);
      const item = loan.schedule.find((s) => s.installment === installment);
      const confirmed = source === 'admin';
      const id = newId('PAY', 6);
      const ts = now();
      q.insertRepayment.run(
        id, applicationId, installment, item.amount, reference,
        confirmed ? 'CONFIRMED' : 'SUBMITTED', source, ts, confirmed ? ts : null
      );
      if (confirmed) this.closeIfFullyPaid(applicationId);
      return this.getLoanDetails(applicationId);
    },

    getRepayment(id) {
      const row = q.repaymentById.get(id);
      return row ? rowToRepayment(row) : null;
    },

    reviewRepayment(id, approve) {
      const r = this.getRepayment(id);
      q.reviewRepayment.run(approve ? 'CONFIRMED' : 'REJECTED', now(), id);
      if (approve) this.closeIfFullyPaid(r.applicationId);
      return this.getLoanDetails(r.applicationId);
    },

    closeIfFullyPaid(applicationId) {
      const loan = this.getLoanDetails(applicationId);
      if (loan.status === 'DISBURSED' && loan.schedule.length && loan.schedule.every((s) => s.status === 'PAID')) {
        q.updateStatus.run('CLOSED', 'All EMIs paid', now(), applicationId);
      }
    },
  };
  return repo;
}

module.exports = { openDb, TRANSITIONS, DOCUMENT_TYPES };

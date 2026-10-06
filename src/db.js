'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ACTIVE_STATUSES = ['PENDING', 'APPROVED', 'DISBURSED'];

// Allowed admin transitions between application statuses.
const TRANSITIONS = {
  PENDING: ['APPROVED', 'REJECTED'],
  APPROVED: ['DISBURSED', 'REJECTED'],
  DISBURSED: ['CLOSED'],
  REJECTED: [],
  CLOSED: [],
};

function openDb(file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'loans.db')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS applications (
      id                  TEXT PRIMARY KEY,
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
      admin_note          TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_applications_pan ON applications (pan);
    CREATE INDEX IF NOT EXISTS idx_applications_status ON applications (status);
  `);
  return createRepo(db);
}

function newId() {
  return 'QL' + crypto.randomBytes(5).toString('hex').toUpperCase();
}

function rowToApplication(row) {
  if (!row) return null;
  return {
    id: row.id,
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
  };
}

function createRepo(db) {
  const insert = db.prepare(`
    INSERT INTO applications (
      id, created_at, updated_at, status, full_name, mobile, email, pan, date_of_birth,
      employment_type, employer_name, months_in_job, monthly_salary, other_income, existing_emi,
      requested_amount, tenure_days, assessed_income, max_eligible_amount, approved_amount,
      decision_reasons, quote
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const byId = db.prepare('SELECT * FROM applications WHERE id = ?');
  const activeByPan = db.prepare(
    `SELECT id FROM applications WHERE pan = ? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})`
  );
  const updateStatus = db.prepare(
    'UPDATE applications SET status = ?, admin_note = ?, updated_at = ? WHERE id = ?'
  );

  return {
    db,

    create(app, decision) {
      const id = newId();
      const now = new Date().toISOString();
      insert.run(
        id, now, now,
        decision.eligible ? 'PENDING' : 'REJECTED',
        app.fullName, app.mobile, app.email, app.pan, app.dateOfBirth,
        app.employmentType, app.employerName, app.monthsInCurrentJob,
        app.monthlySalary, app.otherMonthlyIncome, app.existingEmi,
        app.requestedAmount, app.tenureDays,
        decision.assessedIncome, decision.maxEligibleAmount, decision.approvedAmount,
        JSON.stringify(decision.reasons),
        decision.quote ? JSON.stringify(decision.quote) : null
      );
      return this.get(id);
    },

    get(id) {
      return rowToApplication(byId.get(id));
    },

    findActiveByPan(pan) {
      return activeByPan.get(pan, ...ACTIVE_STATUSES) || null;
    },

    list({ status } = {}) {
      const rows = status
        ? db.prepare('SELECT * FROM applications WHERE status = ? ORDER BY created_at DESC').all(status)
        : db.prepare('SELECT * FROM applications ORDER BY created_at DESC').all();
      return rows.map(rowToApplication);
    },

    stats() {
      const rows = db
        .prepare(
          `SELECT status, COUNT(*) AS count, COALESCE(SUM(approved_amount), 0) AS amount
           FROM applications GROUP BY status`
        )
        .all();
      return Object.fromEntries(rows.map((r) => [r.status, { count: r.count, amount: r.amount }]));
    },

    /** Moves an application to a new status if the transition is allowed. */
    transition(id, nextStatus, note = null) {
      const current = this.get(id);
      if (!current) return { error: 'not_found' };
      if (!TRANSITIONS[current.status].includes(nextStatus)) {
        return { error: 'invalid_transition', from: current.status, to: nextStatus };
      }
      updateStatus.run(nextStatus, note, new Date().toISOString(), id);
      return { application: this.get(id) };
    },
  };
}

module.exports = { openDb, TRANSITIONS };

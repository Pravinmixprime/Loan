'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { POLICY, evaluate } = require('./eligibility');
const {
  validateMobile,
  validateProfile,
  validatePersonal,
  validateEmployment,
  validateBank,
  validateLoanRequest,
} = require('./validation');
const { TRANSITIONS, DOCUMENT_TYPES } = require('./db');

const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_RESEND_MS = 30 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

const ACTION_TO_STATUS = {
  approve: 'APPROVED',
  reject: 'REJECTED',
  disburse: 'DISBURSED',
  close: 'CLOSED',
};

// File signatures for accepted upload types.
const MAGIC = {
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/png': [0x89, 0x50, 0x4e, 0x47],
  'image/webp': [0x52, 0x49, 0x46, 0x46],
  'application/pdf': [0x25, 0x50, 0x44, 0x46],
};

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function bearer(req) {
  const header = req.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

/** Tiny fixed-window rate limiter keyed by IP. */
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const t = Date.now();
    const key = req.ip;
    const entry = hits.get(key);
    if (!entry || entry.reset < t) {
      hits.set(key, { count: 1, reset: t + windowMs });
      if (hits.size > 10_000) hits.clear();
      return next();
    }
    if (++entry.count > max) {
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }
    next();
  };
}

function parseDataUrl(dataUrl) {
  const m = /^data:([a-z/+.-]+);base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!m || !MAGIC[m[1]]) return null;
  const buffer = Buffer.from(m[2], 'base64');
  const sig = MAGIC[m[1]];
  if (buffer.length < sig.length || !sig.every((byte, i) => buffer[i] === byte)) return null;
  return { mime: m[1], buffer };
}

const errorsResponse = (res, errors) => res.status(400).json({ errors });

function createApp({ repo, adminToken, sms, lender = {} }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use('/api/me/documents', express.json({ limit: '8mb' }));
  app.use(express.json({ limit: '20kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

  // ---------- helpers ----------

  const requireAdmin = (req, res, next) => {
    const token = bearer(req);
    if (!token || !safeEqual(token, adminToken)) return res.status(401).json({ error: 'Unauthorized' });
    next();
  };

  const requireCustomer = (req, res, next) => {
    const token = bearer(req);
    const customer = token && repo.customerForToken(token);
    if (!customer) return res.status(401).json({ error: 'Please log in again' });
    req.customer = customer;
    req.token = token;
    next();
  };

  function onboarding(customer, documents) {
    const uploaded = new Set(documents.map((d) => d.type));
    return {
      personal: Boolean(customer.fullName && customer.pan && customer.dateOfBirth && customer.email),
      employment: customer.monthlySalary !== null && Boolean(customer.employmentType && customer.employerName),
      documents: DOCUMENT_TYPES.every((t) => uploaded.has(t)),
      bank: Boolean(customer.bank),
    };
  }

  function eligibilityFor(customer, extra = {}) {
    return evaluate({
      monthlySalary: customer.monthlySalary,
      otherMonthlyIncome: customer.otherMonthlyIncome,
      existingEmi: customer.existingEmi,
      employmentType: customer.employmentType,
      monthsInCurrentJob: customer.monthsInCurrentJob,
      dateOfBirth: customer.dateOfBirth,
      tenureDays: 30,
      ...extra,
    });
  }

  function summary(customer) {
    const documents = repo.listDocuments(customer.id);
    const steps = onboarding(customer, documents);
    const loans = repo.listCustomerApplications(customer.id);
    const active = loans.find((l) => ['PENDING', 'APPROVED', 'DISBURSED'].includes(l.status));
    // Eligibility limit shown on the home screen is the best across tenures.
    let eligibility = null;
    if (steps.personal && steps.employment) {
      const byTenure = POLICY.tenureOptions.map((t) => eligibilityFor(customer, { tenureDays: t }));
      const best = byTenure.reduce((a, b) => (b.maxEligibleAmount > a.maxEligibleAmount ? b : a));
      eligibility = {
        eligible: byTenure.some((e) => e.eligible),
        maxEligibleAmount: best.maxEligibleAmount,
        assessedIncome: best.assessedIncome,
        reasons: best.eligible ? [] : byTenure[byTenure.length - 1].reasons,
        byTenure: Object.fromEntries(POLICY.tenureOptions.map((t, i) => [t, byTenure[i].maxEligibleAmount])),
      };
    }
    return {
      customer,
      documents,
      requiredDocuments: DOCUMENT_TYPES,
      steps,
      eligibility,
      activeLoan: active ? repo.getLoanDetails(active.id) : null,
      loans,
      payTo: lender,
    };
  }

  // ---------- public ----------

  app.get('/api/policy', (req, res) => res.json(POLICY));

  app.post('/api/eligibility', (req, res) => {
    const { profile, errors } = validateProfile(req.body || {});
    if (Object.keys(errors).length) return errorsResponse(res, errors);
    res.json(evaluate(profile));
  });

  // ---------- customer auth ----------

  app.post('/api/auth/otp', rateLimit({ windowMs: 15 * 60 * 1000, max: 10 }), async (req, res, next) => {
    try {
      const mobile = validateMobile(req.body && req.body.mobile);
      if (!mobile) return errorsResponse(res, { mobile: 'Enter a valid 10-digit mobile number' });

      const existing = repo.getOtp(mobile);
      if (existing && Date.now() - existing.sent_at < OTP_RESEND_MS) {
        return res.status(429).json({ error: 'Please wait a few seconds before requesting another OTP.' });
      }
      const otp = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
      repo.saveOtp(mobile, otp, OTP_TTL_MS);
      await sms.sendOtp(mobile, otp);
      res.json({ sent: true, resendAfterSeconds: OTP_RESEND_MS / 1000, ...(sms.demo ? { demoOtp: otp } : {}) });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/auth/verify', rateLimit({ windowMs: 15 * 60 * 1000, max: 30 }), (req, res) => {
    const mobile = validateMobile(req.body && req.body.mobile);
    const otp = String((req.body && req.body.otp) || '').trim();
    if (!mobile || !/^\d{6}$/.test(otp)) return errorsResponse(res, { otp: 'Enter the 6-digit OTP' });

    const result = repo.checkOtp(mobile, otp, OTP_MAX_ATTEMPTS);
    if (result === 'expired') return errorsResponse(res, { otp: 'OTP expired. Please request a new one.' });
    if (result === 'locked') return errorsResponse(res, { otp: 'Too many wrong attempts. Request a new OTP.' });
    if (result === 'invalid') return errorsResponse(res, { otp: 'Incorrect OTP' });

    const customer = repo.findOrCreateCustomer(mobile);
    const token = repo.createSession(customer.id, SESSION_TTL_MS);
    res.json({ token, ...summary(customer) });
  });

  app.post('/api/auth/logout', requireCustomer, (req, res) => {
    repo.deleteSession(req.token);
    res.json({ ok: true });
  });

  // ---------- customer app ----------

  app.get('/api/me', requireCustomer, (req, res) => res.json(summary(req.customer)));

  app.put('/api/me/personal', requireCustomer, (req, res) => {
    const { value, errors, ok } = validatePersonal(req.body || {});
    if (!ok) return errorsResponse(res, errors);
    if (req.customer.pan && req.customer.pan !== value.pan && repo.findActiveApplication(req.customer.id)) {
      return errorsResponse(res, { pan: 'PAN cannot be changed while you have an active loan' });
    }
    if (repo.panTakenByOther(value.pan, req.customer.id)) {
      return errorsResponse(res, { pan: 'This PAN is already registered with another mobile number' });
    }
    res.json(summary(repo.updateCustomer(req.customer.id, value)));
  });

  app.put('/api/me/employment', requireCustomer, (req, res) => {
    const { value, errors, ok } = validateEmployment(req.body || {});
    if (!ok) return errorsResponse(res, errors);
    res.json(summary(repo.updateCustomer(req.customer.id, value)));
  });

  app.put('/api/me/bank', requireCustomer, (req, res) => {
    const { value, errors, ok } = validateBank(req.body || {});
    if (!ok) return errorsResponse(res, errors);
    res.json(summary(repo.updateCustomer(req.customer.id, value)));
  });

  app.post('/api/me/documents', requireCustomer, (req, res) => {
    const type = req.body && req.body.type;
    if (!DOCUMENT_TYPES.includes(type)) return errorsResponse(res, { type: 'Unknown document type' });
    const file = parseDataUrl(req.body.dataUrl);
    if (!file) return errorsResponse(res, { [type]: 'Upload a JPG, PNG, WEBP or PDF file' });
    if (file.buffer.length > MAX_UPLOAD_BYTES) return errorsResponse(res, { [type]: 'File must be under 5 MB' });
    if (type !== 'income_proof' && file.mime === 'application/pdf') {
      return errorsResponse(res, { [type]: 'Please upload a photo for this document' });
    }
    repo.saveDocument(req.customer.id, type, file.mime, file.buffer);
    res.json(summary(req.customer));
  });

  app.get('/api/me/documents/:type', requireCustomer, (req, res) => {
    const doc = repo.getDocumentByType(req.customer.id, req.params.type);
    if (!doc || !fs.existsSync(doc.path)) return res.status(404).json({ error: 'Not found' });
    res.type(doc.mime).sendFile(doc.path);
  });

  app.post('/api/me/quote', requireCustomer, (req, res) => {
    const { value, errors } = validateLoanRequest({ ...(req.body || {}), consent: true });
    if (Object.keys(errors).length) return errorsResponse(res, errors);
    res.json(eligibilityFor(req.customer, value));
  });

  app.post('/api/me/loans', requireCustomer, (req, res) => {
    const c = req.customer;
    const steps = onboarding(c, repo.listDocuments(c.id));
    const missing = Object.entries(steps).filter(([, done]) => !done).map(([k]) => k);
    if (missing.length) {
      return res.status(409).json({ error: `Please complete your profile first: ${missing.join(', ')}` });
    }
    const { value, errors, ok } = validateLoanRequest(req.body || {});
    if (!ok) return errorsResponse(res, errors);

    const existing = repo.findActiveApplication(c.id, c.pan);
    if (existing) {
      return res.status(409).json({ error: 'You already have an active loan application.', applicationId: existing.id });
    }
    const decision = eligibilityFor(c, value);
    const created = repo.createApplication(c, value, decision);
    res.status(201).json(repo.getLoanDetails(created.id));
  });

  app.get('/api/me/loans/:id', requireCustomer, (req, res) => {
    const loan = repo.getLoanDetails(req.params.id);
    if (!loan || loan.customerId !== req.customer.id) return res.status(404).json({ error: 'Loan not found' });
    res.json(loan);
  });

  app.post('/api/me/loans/:id/repayments', requireCustomer, (req, res) => {
    const loan = repo.getLoanDetails(req.params.id);
    if (!loan || loan.customerId !== req.customer.id) return res.status(404).json({ error: 'Loan not found' });
    if (loan.status !== 'DISBURSED') return res.status(409).json({ error: 'This loan is not open for repayment' });

    const installment = Number(req.body && req.body.installment);
    const reference = String((req.body && req.body.reference) || '').trim();
    const item = loan.schedule.find((s) => s.installment === installment);
    if (!item) return errorsResponse(res, { installment: 'Unknown EMI' });
    if (item.status === 'PAID' || item.status === 'VERIFYING') {
      return res.status(409).json({ error: 'This EMI is already paid or being verified' });
    }
    if (!/^[A-Za-z0-9-]{6,30}$/.test(reference)) {
      return errorsResponse(res, { reference: 'Enter the UPI / bank transaction reference (UTR)' });
    }
    res.status(201).json(repo.addRepayment(loan.id, { installment, reference, source: 'customer' }));
  });

  // ---------- admin ----------

  app.get('/api/admin/applications', requireAdmin, (req, res) => {
    const status = req.query.status ? String(req.query.status).toUpperCase() : undefined;
    if (status && !(status in TRANSITIONS)) return res.status(400).json({ error: 'Unknown status' });
    res.json({ applications: repo.list({ status }), stats: repo.stats() });
  });

  app.get('/api/admin/applications/:id', requireAdmin, (req, res) => {
    const loan = repo.getLoanDetails(req.params.id);
    if (!loan) return res.status(404).json({ error: 'Application not found' });
    const customer = loan.customerId ? repo.getCustomer(loan.customerId) : null;
    const documents = customer ? repo.listDocuments(customer.id) : [];
    const history = customer
      ? repo.listCustomerApplications(customer.id).filter((a) => a.id !== loan.id)
      : [];
    res.json({ loan, customer, documents, requiredDocuments: DOCUMENT_TYPES, history });
  });

  app.get('/api/admin/documents/:id', requireAdmin, (req, res) => {
    const doc = repo.getDocument(req.params.id);
    if (!doc || !fs.existsSync(doc.path)) return res.status(404).json({ error: 'Not found' });
    res.type(doc.mime).sendFile(doc.path);
  });

  app.post('/api/admin/applications/:id/repayments', requireAdmin, (req, res) => {
    const loan = repo.getLoanDetails(req.params.id);
    if (!loan) return res.status(404).json({ error: 'Application not found' });
    if (loan.status !== 'DISBURSED') return res.status(409).json({ error: 'Loan is not disbursed' });
    const installment = Number(req.body && req.body.installment);
    const item = loan.schedule.find((s) => s.installment === installment);
    if (!item) return res.status(400).json({ error: 'Unknown EMI' });
    if (item.status === 'PAID') return res.status(409).json({ error: 'EMI already paid' });
    const reference = String((req.body && req.body.reference) || '').trim().slice(0, 60) || 'Recorded by admin';
    res.json(repo.addRepayment(loan.id, { installment, reference, source: 'admin' }));
  });

  app.post('/api/admin/repayments/:id/:decision', requireAdmin, (req, res) => {
    const decision = req.params.decision;
    if (!['confirm', 'reject'].includes(decision)) return res.status(400).json({ error: 'Unknown action' });
    const r = repo.getRepayment(req.params.id);
    if (!r) return res.status(404).json({ error: 'Payment not found' });
    if (r.status !== 'SUBMITTED') return res.status(409).json({ error: 'Payment already reviewed' });
    res.json(repo.reviewRepayment(r.id, decision === 'confirm'));
  });

  app.post('/api/admin/applications/:id/:action', requireAdmin, (req, res) => {
    const nextStatus = ACTION_TO_STATUS[req.params.action];
    if (!nextStatus) return res.status(400).json({ error: 'Unknown action' });

    const note = req.body && req.body.note ? String(req.body.note).slice(0, 500) : null;
    const reference = req.body && req.body.reference ? String(req.body.reference).trim().slice(0, 60) : null;
    if (nextStatus === 'DISBURSED' && (!reference || reference.length < 4)) {
      return res.status(400).json({ error: 'Enter the bank transfer reference (UTR) for the disbursal' });
    }
    if (nextStatus === 'APPROVED') {
      const app0 = repo.getApplication(req.params.id);
      if (app0 && app0.customerId) {
        const uploaded = new Set(repo.listDocuments(app0.customerId).map((d) => d.type));
        const missing = DOCUMENT_TYPES.filter((t) => !uploaded.has(t));
        if (missing.length) {
          return res.status(409).json({ error: `KYC documents missing: ${missing.join(', ')}` });
        }
      }
    }

    const result = repo.transition(req.params.id, nextStatus, { note, reference });
    if (result.error === 'not_found') return res.status(404).json({ error: 'Application not found' });
    if (result.error) {
      return res.status(409).json({ error: `Cannot move application from ${result.from} to ${result.to}` });
    }
    res.json(result.application);
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'File is too large' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });

  return app;
}

module.exports = { createApp };

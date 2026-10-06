'use strict';

const { POLICY, EMPLOYMENT_TYPES } = require('./eligibility');

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const MOBILE_RE = /^[6-9][0-9]{9}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function toNumber(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

function money(errors, body, field, { required = false, max = 10_000_000 } = {}) {
  const n = toNumber(body[field]);
  if (n === undefined) {
    if (required) errors[field] = 'Required';
    return 0;
  }
  if (Number.isNaN(n) || n < 0 || n > max) errors[field] = 'Must be a valid non-negative amount';
  return Math.round(n);
}

/** Validates the financial fields used for an eligibility check. */
function validateProfile(body, errors = {}) {
  const profile = {
    monthlySalary: money(errors, body, 'monthlySalary', { required: true }),
    otherMonthlyIncome: money(errors, body, 'otherMonthlyIncome'),
    existingEmi: money(errors, body, 'existingEmi'),
    employmentType: body.employmentType,
    dateOfBirth: body.dateOfBirth,
    monthsInCurrentJob: toNumber(body.monthsInCurrentJob),
    tenureDays: toNumber(body.tenureDays) ?? 30,
    requestedAmount: toNumber(body.requestedAmount),
  };

  if (!EMPLOYMENT_TYPES.includes(profile.employmentType)) {
    errors.employmentType = `Must be one of: ${EMPLOYMENT_TYPES.join(', ')}`;
  }
  if (!DATE_RE.test(profile.dateOfBirth || '') || Number.isNaN(Date.parse(profile.dateOfBirth))) {
    errors.dateOfBirth = 'Must be a date in YYYY-MM-DD format';
  }
  if (
    profile.monthsInCurrentJob === undefined ||
    !Number.isInteger(profile.monthsInCurrentJob) ||
    profile.monthsInCurrentJob < 0 ||
    profile.monthsInCurrentJob > 600
  ) {
    errors.monthsInCurrentJob = 'Must be a whole number of months';
  }
  if (!POLICY.tenureOptions.includes(profile.tenureDays)) {
    errors.tenureDays = `Must be one of: ${POLICY.tenureOptions.join(', ')} days`;
  }
  if (profile.requestedAmount !== undefined) {
    const r = profile.requestedAmount;
    if (Number.isNaN(r) || r < POLICY.minLoan || r > POLICY.maxLoan || r % POLICY.amountStep !== 0) {
      errors.requestedAmount = `Must be between ₹${POLICY.minLoan} and ₹${POLICY.maxLoan} in steps of ₹${POLICY.amountStep}`;
    }
  }

  return { profile, errors };
}

/** Validates a full loan application (personal details + financial profile). */
function validateApplication(body) {
  const errors = {};
  const { profile } = validateProfile(body, errors);

  const fullName = String(body.fullName || '').trim();
  const mobile = String(body.mobile || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const pan = String(body.pan || '').trim().toUpperCase();
  const employerName = String(body.employerName || '').trim();

  if (fullName.length < 2 || fullName.length > 100) errors.fullName = 'Enter your full name';
  if (!MOBILE_RE.test(mobile)) errors.mobile = 'Enter a valid 10-digit mobile number';
  if (!EMAIL_RE.test(email) || email.length > 200) errors.email = 'Enter a valid email address';
  if (!PAN_RE.test(pan)) errors.pan = 'Enter a valid PAN (e.g. ABCDE1234F)';
  if (employerName.length < 2 || employerName.length > 150) {
    errors.employerName = 'Enter your employer or business name';
  }
  if (profile.requestedAmount === undefined && !errors.requestedAmount) {
    errors.requestedAmount = 'Required';
  }
  if (body.consent !== true && body.consent !== 'true' && body.consent !== 'on') {
    errors.consent = 'You must agree to the terms and the credit check';
  }

  return {
    application: { fullName, mobile, email, pan, employerName, ...profile },
    errors,
  };
}

module.exports = { validateProfile, validateApplication };

'use strict';

const { POLICY, EMPLOYMENT_TYPES } = require('./eligibility');

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const MOBILE_RE = /^[6-9][0-9]{9}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCOUNT_RE = /^[0-9]{9,18}$/;

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

const str = (v) => String(v ?? '').trim();
const done = (value, errors) => ({ value, errors, ok: Object.keys(errors).length === 0 });

function validateMobile(mobile) {
  const m = str(mobile).replace(/^(\+?91)/, '');
  return MOBILE_RE.test(m) ? m : null;
}

function validateDateOfBirth(errors, dob) {
  if (!DATE_RE.test(dob || '') || Number.isNaN(Date.parse(dob))) {
    errors.dateOfBirth = 'Must be a date in YYYY-MM-DD format';
  }
}

function validateTenure(errors, tenureDays) {
  if (!POLICY.tenureOptions.includes(tenureDays)) {
    errors.tenureDays = `Must be one of: ${POLICY.tenureOptions.join(', ')} days`;
  }
}

function validateAmount(errors, amount, { required = false } = {}) {
  if (amount === undefined) {
    if (required) errors.requestedAmount = 'Required';
    return;
  }
  if (
    Number.isNaN(amount) ||
    amount < POLICY.minLoan ||
    amount > POLICY.maxLoan ||
    amount % POLICY.amountStep !== 0
  ) {
    errors.requestedAmount = `Must be between ₹${POLICY.minLoan} and ₹${POLICY.maxLoan} in steps of ₹${POLICY.amountStep}`;
  }
}

/** Income & employment fields shared by the public calculator and the customer profile. */
function validateIncome(body, errors = {}) {
  const value = {
    monthlySalary: money(errors, body, 'monthlySalary', { required: true }),
    otherMonthlyIncome: money(errors, body, 'otherMonthlyIncome'),
    existingEmi: money(errors, body, 'existingEmi'),
    employmentType: body.employmentType,
    monthsInCurrentJob: toNumber(body.monthsInCurrentJob),
  };
  if (!EMPLOYMENT_TYPES.includes(value.employmentType)) {
    errors.employmentType = `Must be one of: ${EMPLOYMENT_TYPES.join(', ')}`;
  }
  if (
    value.monthsInCurrentJob === undefined ||
    !Number.isInteger(value.monthsInCurrentJob) ||
    value.monthsInCurrentJob < 0 ||
    value.monthsInCurrentJob > 600
  ) {
    errors.monthsInCurrentJob = 'Must be a whole number of months';
  }
  return value;
}

/** Public eligibility calculator input (no personal details). */
function validateProfile(body, errors = {}) {
  const profile = {
    ...validateIncome(body, errors),
    dateOfBirth: body.dateOfBirth,
    tenureDays: toNumber(body.tenureDays) ?? 30,
    requestedAmount: toNumber(body.requestedAmount),
  };
  validateDateOfBirth(errors, profile.dateOfBirth);
  validateTenure(errors, profile.tenureDays);
  validateAmount(errors, profile.requestedAmount);
  return { profile, errors };
}

function validatePersonal(body) {
  const errors = {};
  const value = {
    fullName: str(body.fullName),
    email: str(body.email).toLowerCase(),
    dateOfBirth: str(body.dateOfBirth),
    pan: str(body.pan).toUpperCase(),
  };
  if (value.fullName.length < 2 || value.fullName.length > 100) errors.fullName = 'Enter your full name';
  if (!EMAIL_RE.test(value.email) || value.email.length > 200) errors.email = 'Enter a valid email address';
  if (!PAN_RE.test(value.pan)) errors.pan = 'Enter a valid PAN (e.g. ABCDE1234F)';
  validateDateOfBirth(errors, value.dateOfBirth);
  return done(value, errors);
}

function validateEmployment(body) {
  const errors = {};
  const value = validateIncome(body, errors);
  value.employerName = str(body.employerName);
  if (value.employerName.length < 2 || value.employerName.length > 150) {
    errors.employerName = 'Enter your employer or business name';
  }
  return done(value, errors);
}

function validateBank(body) {
  const errors = {};
  const value = {
    bankHolder: str(body.accountHolder),
    bankAccount: str(body.accountNumber).replace(/\s+/g, ''),
    bankIfsc: str(body.ifsc).toUpperCase(),
  };
  if (value.bankHolder.length < 2 || value.bankHolder.length > 100) {
    errors.accountHolder = 'Enter the account holder name';
  }
  if (!ACCOUNT_RE.test(value.bankAccount)) errors.accountNumber = 'Enter a valid account number (9–18 digits)';
  if (body.confirmAccountNumber !== undefined && str(body.confirmAccountNumber).replace(/\s+/g, '') !== value.bankAccount) {
    errors.confirmAccountNumber = 'Account numbers do not match';
  }
  if (!IFSC_RE.test(value.bankIfsc)) errors.ifsc = 'Enter a valid IFSC (e.g. HDFC0001234)';
  return done(value, errors);
}

function validateLoanRequest(body) {
  const errors = {};
  const value = {
    requestedAmount: toNumber(body.requestedAmount),
    tenureDays: toNumber(body.tenureDays),
  };
  validateAmount(errors, value.requestedAmount, { required: true });
  validateTenure(errors, value.tenureDays);
  if (body.consent !== true) errors.consent = 'You must agree to the loan terms and the credit check';
  return done(value, errors);
}

module.exports = {
  validateMobile,
  validateProfile,
  validatePersonal,
  validateEmployment,
  validateBank,
  validateLoanRequest,
};

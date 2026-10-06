'use strict';

/**
 * Loan policy. All money values are in INR (whole rupees).
 * Kept in one place so the rules are easy to review and tune.
 */
const POLICY = Object.freeze({
  minLoan: 5000,
  maxLoan: 10000,
  amountStep: 500,
  minAge: 21,
  maxAge: 58,
  minMonthlyIncome: 15000,
  // Other (non-salary) income is less stable, so only part of it is counted.
  otherIncomeWeight: 0.5,
  // A new loan can be at most this share of assessed monthly income.
  incomeMultiplier: 0.4,
  // Fixed obligations to income ratio: all EMIs incl. this loan must stay under this share.
  maxFoir: 0.5,
  minMonthsEmployed: { salaried: 3, self_employed: 6 },
  tenureOptions: [30, 60, 90], // days
  monthlyInterestRate: 0.02, // 2% per month, flat
  processingFeeRate: 0.02, // 2% of principal, deducted at disbursal
});

const EMPLOYMENT_TYPES = Object.keys(POLICY.minMonthsEmployed);

function roundDownToStep(value, step) {
  return Math.floor(value / step) * step;
}

function ageOn(dateOfBirth, today) {
  const dob = new Date(dateOfBirth);
  let age = today.getUTCFullYear() - dob.getUTCFullYear();
  const beforeBirthday =
    today.getUTCMonth() < dob.getUTCMonth() ||
    (today.getUTCMonth() === dob.getUTCMonth() && today.getUTCDate() < dob.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

/** Income the lender relies on: full salary plus a weighted share of other income. */
function assessedIncome(monthlySalary, otherMonthlyIncome) {
  return Math.round(monthlySalary + otherMonthlyIncome * POLICY.otherIncomeWeight);
}

/** Cost breakdown and repayment schedule for a principal over a tenure in days. */
function quote(principal, tenureDays, startDate = new Date()) {
  const months = tenureDays / 30;
  const interest = Math.round(principal * POLICY.monthlyInterestRate * months);
  const processingFee = Math.round(principal * POLICY.processingFeeRate);
  const totalRepayable = principal + interest;

  const schedule = [];
  let remaining = totalRepayable;
  for (let i = 1; i <= months; i++) {
    const due = new Date(startDate);
    due.setUTCDate(due.getUTCDate() + i * 30);
    const amount = i === months ? remaining : Math.round(totalRepayable / months);
    remaining -= amount;
    schedule.push({ installment: i, dueDate: due.toISOString().slice(0, 10), amount });
  }

  return {
    principal,
    tenureDays,
    interest,
    processingFee,
    disbursedAmount: principal - processingFee,
    totalRepayable,
    monthlyInstallment: schedule[0].amount,
    schedule,
  };
}

/**
 * Largest principal (before rounding) whose monthly installment fits the
 * applicant's remaining FOIR headroom for the given tenure.
 */
function foirCap(income, existingEmi, tenureDays) {
  const months = tenureDays / 30;
  const headroom = income * POLICY.maxFoir - existingEmi;
  if (headroom <= 0) return 0;
  return (headroom * months) / (1 + POLICY.monthlyInterestRate * months);
}

/**
 * Evaluate an applicant's eligibility.
 *
 * @param {object} a applicant financial profile (already validated)
 * @param {Date} [today]
 * @returns {{eligible: boolean, maxEligibleAmount: number, approvedAmount: number,
 *            reasons: string[], assessedIncome: number, quote: object|null}}
 */
function evaluate(a, today = new Date()) {
  const reasons = [];
  const income = assessedIncome(a.monthlySalary, a.otherMonthlyIncome || 0);
  const existingEmi = a.existingEmi || 0;
  const tenureDays = a.tenureDays || 30;

  const age = ageOn(a.dateOfBirth, today);
  if (age < POLICY.minAge || age > POLICY.maxAge) {
    reasons.push(`Applicant age must be between ${POLICY.minAge} and ${POLICY.maxAge} (is ${age}).`);
  }

  if (income < POLICY.minMonthlyIncome) {
    reasons.push(
      `Assessed monthly income ₹${income.toLocaleString('en-IN')} is below the minimum of ₹${POLICY.minMonthlyIncome.toLocaleString('en-IN')}.`
    );
  }

  const minMonths = POLICY.minMonthsEmployed[a.employmentType];
  if (a.monthsInCurrentJob < minMonths) {
    reasons.push(
      `At least ${minMonths} months in current ${a.employmentType === 'salaried' ? 'job' : 'business'} required.`
    );
  }

  const byIncome = income * POLICY.incomeMultiplier;
  const byFoir = foirCap(income, existingEmi, tenureDays);
  const maxEligibleAmount = Math.max(
    0,
    roundDownToStep(Math.min(POLICY.maxLoan, byIncome, byFoir), POLICY.amountStep)
  );

  if (maxEligibleAmount < POLICY.minLoan) {
    if (byFoir < POLICY.minLoan && byFoir <= byIncome) {
      reasons.push(
        'Existing EMIs leave too little repayment capacity for this tenure. Try a longer tenure or reduce existing obligations.'
      );
    } else {
      reasons.push(
        `Income supports at most ₹${maxEligibleAmount.toLocaleString('en-IN')}, below the minimum loan of ₹${POLICY.minLoan.toLocaleString('en-IN')}.`
      );
    }
  }

  const eligible = reasons.length === 0;
  const requested = a.requestedAmount || maxEligibleAmount;
  const approvedAmount = eligible ? Math.min(requested, maxEligibleAmount) : 0;

  return {
    eligible,
    assessedIncome: income,
    maxEligibleAmount: eligible ? maxEligibleAmount : 0,
    approvedAmount,
    reasons,
    quote: eligible ? quote(approvedAmount, tenureDays, today) : null,
  };
}

module.exports = { POLICY, EMPLOYMENT_TYPES, evaluate, quote, assessedIncome, ageOn };

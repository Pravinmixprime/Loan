'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate, quote, assessedIncome, ageOn } = require('../src/eligibility');

const TODAY = new Date('2026-10-06T00:00:00Z');
const base = {
  monthlySalary: 30000,
  otherMonthlyIncome: 0,
  existingEmi: 0,
  employmentType: 'salaried',
  monthsInCurrentJob: 12,
  dateOfBirth: '1995-05-10',
  tenureDays: 30,
};

test('assessed income counts half of other income', () => {
  assert.equal(assessedIncome(20000, 10000), 25000);
});

test('age is computed relative to birthday', () => {
  assert.equal(ageOn('2005-10-06', TODAY), 21);
  assert.equal(ageOn('2005-10-07', TODAY), 20);
});

test('higher income is capped at the ₹10,000 maximum', () => {
  const r = evaluate({ ...base, monthlySalary: 80000 }, TODAY);
  assert.equal(r.eligible, true);
  assert.equal(r.maxEligibleAmount, 10000);
});

test('loan amount scales with income (40%, rounded down to ₹500)', () => {
  // 18,000 * 0.4 = 7,200 -> 7,000
  const r = evaluate({ ...base, monthlySalary: 18000 }, TODAY);
  assert.equal(r.eligible, true);
  assert.equal(r.maxEligibleAmount, 7000);
});

test('other income raises the eligible amount', () => {
  const withoutOther = evaluate({ ...base, monthlySalary: 16000 }, TODAY);
  const withOther = evaluate({ ...base, monthlySalary: 16000, otherMonthlyIncome: 6000 }, TODAY);
  assert.equal(withoutOther.maxEligibleAmount, 6000); // 16,000 * 0.4 = 6,400
  assert.equal(withOther.maxEligibleAmount, 7500); // 19,000 * 0.4 = 7,600
});

test('income below ₹15,000 is rejected', () => {
  const r = evaluate({ ...base, monthlySalary: 14000 }, TODAY);
  assert.equal(r.eligible, false);
  assert.equal(r.maxEligibleAmount, 0);
  assert.match(r.reasons.join(' '), /below the minimum/);
});

test('heavy existing EMIs reduce or block eligibility', () => {
  // income 30,000: FOIR headroom 15,000 - 9,000 = 6,000 -> 6,000 / 1.02 = 5,882 -> 5,500
  const reduced = evaluate({ ...base, existingEmi: 9000 }, TODAY);
  assert.equal(reduced.maxEligibleAmount, 5500);

  const blocked = evaluate({ ...base, existingEmi: 12000 }, TODAY);
  assert.equal(blocked.eligible, false);
  assert.match(blocked.reasons.join(' '), /repayment capacity/);

  // a longer tenure spreads the repayment and restores eligibility
  const longer = evaluate({ ...base, existingEmi: 12000, tenureDays: 90 }, TODAY);
  assert.equal(longer.eligible, true);
  assert.equal(longer.maxEligibleAmount, 8000); // 3,000 * 3 / 1.06 = 8,490 -> 8,000
});

test('age and job tenure rules are enforced', () => {
  assert.equal(evaluate({ ...base, dateOfBirth: '2008-01-01' }, TODAY).eligible, false);
  assert.equal(evaluate({ ...base, dateOfBirth: '1960-01-01' }, TODAY).eligible, false);
  assert.equal(evaluate({ ...base, monthsInCurrentJob: 2 }, TODAY).eligible, false);
  assert.equal(
    evaluate({ ...base, employmentType: 'self_employed', monthsInCurrentJob: 5 }, TODAY).eligible,
    false
  );
  assert.equal(
    evaluate({ ...base, employmentType: 'self_employed', monthsInCurrentJob: 6 }, TODAY).eligible,
    true
  );
});

test('requested amount above the limit is reduced to the eligible maximum', () => {
  const r = evaluate({ ...base, monthlySalary: 18000, requestedAmount: 10000 }, TODAY);
  assert.equal(r.approvedAmount, 7000);
  const smaller = evaluate({ ...base, monthlySalary: 18000, requestedAmount: 5000 }, TODAY);
  assert.equal(smaller.approvedAmount, 5000);
});

test('quote computes interest, fee and schedule', () => {
  const q = quote(10000, 90, TODAY);
  assert.equal(q.interest, 600); // 2% * 3 months
  assert.equal(q.processingFee, 200);
  assert.equal(q.disbursedAmount, 9800);
  assert.equal(q.totalRepayable, 10600);
  assert.equal(q.schedule.length, 3);
  assert.equal(q.schedule.reduce((s, i) => s + i.amount, 0), 10600);
  assert.equal(q.schedule[0].dueDate, '2026-11-05');

  const single = quote(5000, 30, TODAY);
  assert.equal(single.schedule.length, 1);
  assert.equal(single.schedule[0].amount, 5100);
});

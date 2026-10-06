'use strict';

/* Landing page: public eligibility calculator that hands off to the app. */

const eligibilityForm = document.getElementById('eligibility-form');
const eligibilityResult = document.getElementById('eligibility-result');
let policy = null;

async function loadPolicy() {
  const { data } = await api('/api/policy');
  policy = data;
  document.getElementById('highlights').innerHTML = `
    <div class="highlight"><strong>${inr(policy.minLoan)} – ${inr(policy.maxLoan)}</strong><span>Loan amount</span></div>
    <div class="highlight"><strong>${policy.tenureOptions[0]}–${policy.tenureOptions.at(-1)} days</strong><span>Repayment</span></div>
    <div class="highlight"><strong>${policy.monthlyInterestRate * 100}% / month</strong><span>Flat interest</span></div>
    <div class="highlight"><strong>${inr(policy.minMonthlyIncome)}+</strong><span>Min. monthly income</span></div>`;
  document.getElementById('tenureOptions').innerHTML = policy.tenureOptions
    .map((d, i) => `<label><input type="radio" name="tenureDays" value="${d}"${i === 0 ? ' checked' : ''}>
      <span>${d} days<small>${d / 30} EMI${d > 30 ? 's' : ''}</small></span></label>`)
    .join('');
}

eligibilityForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(eligibilityForm);
  const body = {
    monthlySalary: f.get('monthlySalary'),
    otherMonthlyIncome: f.get('otherMonthlyIncome') || 0,
    existingEmi: f.get('existingEmi') || 0,
    employmentType: f.get('employmentType'),
    monthsInCurrentJob: f.get('monthsInCurrentJob') === '' ? undefined : Number(f.get('monthsInCurrentJob')),
    dateOfBirth: f.get('dateOfBirth'),
    tenureDays: Number(f.get('tenureDays')),
  };
  const { ok, data } = await api('/api/eligibility', { method: 'POST', body });
  showFieldErrors(eligibilityForm, data.errors);
  if (!ok) {
    eligibilityResult.innerHTML = '';
    return;
  }
  eligibilityResult.innerHTML = data.eligible
    ? `<div class="result ok">
        <h3>Good news — you are eligible!</h3>
        <p>You can borrow up to</p>
        <div class="amount-big">${inr(data.maxEligibleAmount)}</div>
        <p class="muted small-text">Based on assessed monthly income of ${inr(data.assessedIncome)}
          (salary + ${policy.otherIncomeWeight * 100}% of other income) over ${body.tenureDays} days.</p>
        ${quoteHtml(data.quote)}
        <div class="actions"><a class="btn" href="/app">Apply now in the app</a></div>
      </div>`
    : `<div class="result fail">
        <h3>Sorry, you are not eligible right now</h3>
        <p>Assessed monthly income: <strong>${inr(data.assessedIncome)}</strong></p>
        <ul>${data.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>
      </div>`;
  eligibilityResult.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

loadPolicy();

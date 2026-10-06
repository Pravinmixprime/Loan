'use strict';

const eligibilityForm = document.getElementById('eligibility-form');
const eligibilityResult = document.getElementById('eligibility-result');
const applySection = document.getElementById('apply');
const applicationForm = document.getElementById('application-form');
const applicationResult = document.getElementById('application-result');
const amountSlider = document.getElementById('requestedAmount');
const amountLabel = document.getElementById('requestedAmountLabel');
const liveQuote = document.getElementById('live-quote');
const statusForm = document.getElementById('status-form');
const statusResult = document.getElementById('status-result');

let policy = null;
let profile = null; // last profile that passed the eligibility check

function readProfile() {
  const f = new FormData(eligibilityForm);
  return {
    monthlySalary: f.get('monthlySalary'),
    otherMonthlyIncome: f.get('otherMonthlyIncome') || 0,
    existingEmi: f.get('existingEmi') || 0,
    employmentType: f.get('employmentType'),
    monthsInCurrentJob: f.get('monthsInCurrentJob') === '' ? undefined : Number(f.get('monthsInCurrentJob')),
    dateOfBirth: f.get('dateOfBirth'),
    tenureDays: Number(f.get('tenureDays')),
  };
}

async function loadPolicy() {
  const { data } = await api('/api/policy');
  policy = data;
  document.getElementById('highlights').innerHTML = `
    <div class="highlight"><strong>${inr(policy.minLoan)} – ${inr(policy.maxLoan)}</strong><span>Loan amount</span></div>
    <div class="highlight"><strong>${policy.tenureOptions.join(' / ')} days</strong><span>Tenure options</span></div>
    <div class="highlight"><strong>${policy.monthlyInterestRate * 100}% / month</strong><span>Flat interest</span></div>
    <div class="highlight"><strong>${inr(policy.minMonthlyIncome)}+</strong><span>Min. monthly income</span></div>`;
  document.getElementById('tenureDays').innerHTML = policy.tenureOptions
    .map((d) => `<option value="${d}">${d} days · ${d / 30} EMI${d > 30 ? 's' : ''}</option>`)
    .join('');
}

eligibilityForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = readProfile();
  const { ok, data } = await api('/api/eligibility', { method: 'POST', body });
  showFieldErrors(eligibilityForm, data.errors);
  if (!ok) {
    eligibilityResult.innerHTML = '';
    return;
  }

  if (!data.eligible) {
    profile = null;
    applySection.classList.add('hidden');
    eligibilityResult.innerHTML = `
      <div class="result fail">
        <h3>Sorry, you are not eligible right now</h3>
        <p>Assessed monthly income: <strong>${inr(data.assessedIncome)}</strong></p>
        <ul>${data.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>
      </div>`;
    return;
  }

  profile = body;
  eligibilityResult.innerHTML = `
    <div class="result ok">
      <h3>Good news — you are eligible!</h3>
      <p>You can borrow up to</p>
      <div class="amount-big">${inr(data.maxEligibleAmount)}</div>
      <p class="muted small-text">Based on assessed monthly income of ${inr(data.assessedIncome)}
        (salary + ${policy.otherIncomeWeight * 100}% of other income) over ${body.tenureDays} days.</p>
    </div>`;

  amountSlider.min = policy.minLoan;
  amountSlider.max = data.maxEligibleAmount;
  amountSlider.value = data.maxEligibleAmount;
  amountSlider.disabled = data.maxEligibleAmount === policy.minLoan;
  updateAmount();
  applicationResult.innerHTML = '';
  applicationForm.classList.remove('hidden');
  applySection.classList.remove('hidden');
  applySection.scrollIntoView({ behavior: 'smooth' });
});

let quoteTimer;
function updateAmount() {
  amountLabel.textContent = inr(amountSlider.value);
  clearTimeout(quoteTimer);
  quoteTimer = setTimeout(async () => {
    if (!profile) return;
    const { ok, data } = await api('/api/eligibility', {
      method: 'POST',
      body: { ...profile, requestedAmount: Number(amountSlider.value) },
    });
    liveQuote.innerHTML = ok && data.quote ? quoteHtml(data.quote) : '';
  }, 150);
}
amountSlider.addEventListener('input', updateAmount);

document.getElementById('edit-eligibility').addEventListener('click', () => {
  document.getElementById('check').scrollIntoView({ behavior: 'smooth' });
});

applicationForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!profile) return;
  const f = new FormData(applicationForm);
  const body = {
    ...profile,
    requestedAmount: Number(amountSlider.value),
    fullName: f.get('fullName'),
    mobile: f.get('mobile'),
    email: f.get('email'),
    pan: String(f.get('pan') || '').toUpperCase(),
    employerName: f.get('employerName'),
    consent: document.getElementById('consent').checked,
  };

  const button = applicationForm.querySelector('button[type="submit"]');
  button.disabled = true;
  const { ok, status, data } = await api('/api/applications', { method: 'POST', body });
  button.disabled = false;
  showFieldErrors(applicationForm, data.errors);

  if (status === 409) {
    applicationResult.innerHTML = `<div class="result info"><h3>Application already in progress</h3>
      <p>${escapeHtml(data.error)} Reference: <strong>${escapeHtml(data.applicationId)}</strong></p></div>`;
    return;
  }
  if (!ok) {
    applicationResult.innerHTML = data.errors
      ? ''
      : `<div class="result fail">${escapeHtml(data.error || 'Something went wrong')}</div>`;
    return;
  }

  applicationForm.classList.add('hidden');
  applicationResult.innerHTML = applicationHtml(data);
  document.getElementById('statusId').value = data.id;
  document.getElementById('statusMobile').value = body.mobile;
});

function applicationHtml(app) {
  if (app.status === 'REJECTED') {
    return `<div class="result fail">
      <h3>Application ${escapeHtml(app.id)} — not approved</h3>
      <ul>${app.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>
      ${app.adminNote ? `<p>${escapeHtml(app.adminNote)}</p>` : ''}
    </div>`;
  }
  const messages = {
    PENDING: 'Your application is submitted and under review. We will verify your details shortly.',
    APPROVED: 'Your loan is approved and will be disbursed to your bank account soon.',
    DISBURSED: 'Your loan has been disbursed. Please repay as per the schedule below.',
    CLOSED: 'This loan is fully repaid and closed. Thank you!',
  };
  return `<div class="result ok">
    <h3>Application ${escapeHtml(app.id)} <span class="badge ${app.status}">${app.status}</span></h3>
    <p>${messages[app.status] || ''}</p>
    ${app.requestedAmount !== app.approvedAmount
      ? `<p class="small-text">Requested ${inr(app.requestedAmount)}; offered ${inr(app.approvedAmount)} based on your eligibility.</p>`
      : ''}
    ${app.adminNote ? `<p class="small-text"><strong>Note:</strong> ${escapeHtml(app.adminNote)}</p>` : ''}
    ${app.quote ? quoteHtml(app.quote) : ''}
    <p class="small-text muted">Save your reference number <strong>${escapeHtml(app.id)}</strong> to track your application.</p>
  </div>`;
}

statusForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('statusId').value.trim();
  const mobile = document.getElementById('statusMobile').value.trim();
  if (!id || !mobile) return;
  const { ok, data } = await api(
    `/api/applications/${encodeURIComponent(id)}?mobile=${encodeURIComponent(mobile)}`
  );
  statusResult.innerHTML = ok
    ? applicationHtml(data)
    : `<div class="result fail">${escapeHtml(data.error || 'Not found')}</div>`;
});

loadPolicy();

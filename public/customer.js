'use strict';

/* QuickCash customer app — a small hash-routed single-page app. */

const view = document.getElementById('view');
const titleEl = document.getElementById('title');
const backBtn = document.getElementById('back');
const tabbar = document.getElementById('tabbar');
const toastEl = document.getElementById('toast');

const BRAND_TITLE = titleEl.innerHTML;
const TOKEN_KEY = 'qc_token';

const DOCS = {
  pan: { label: 'PAN card', hint: 'Clear photo of the front', capture: 'environment' },
  aadhaar_front: { label: 'Aadhaar – front', hint: 'Photo of the front side', capture: 'environment' },
  aadhaar_back: { label: 'Aadhaar – back', hint: 'Photo of the back side', capture: 'environment' },
  selfie: { label: 'Selfie', hint: 'Face clearly visible, no cap or glasses', capture: 'user' },
  income_proof: { label: 'Salary slip / bank statement', hint: 'Latest month · photo or PDF', capture: '', pdf: true },
};
const STEPS = [
  ['personal', 'Personal details'],
  ['employment', 'Work & income'],
  ['documents', 'KYC documents'],
  ['bank', 'Bank account'],
];
const STATUS_TEXT = {
  PENDING: 'Under review',
  APPROVED: 'Approved',
  DISBURSED: 'Active',
  CLOSED: 'Closed',
  REJECTED: 'Not approved',
};

const storage = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } },
};

let token = storage.get(TOKEN_KEY);
let me = null; // latest /api/me summary
let policy = null;
let pendingMobile = '';

// ---------- utilities ----------

function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.remove('hidden');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => toastEl.classList.add('hidden'), 2600);
}

async function authed(path, opts = {}) {
  const res = await api(path, { ...opts, token });
  if (res.status === 401 && token) {
    logout(false);
    toast('Session expired. Please log in again.');
  }
  return res;
}

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

function setChrome({ title = null, back = null, tab = null }) {
  titleEl.innerHTML = title ? escapeHtml(title) : BRAND_TITLE;
  backBtn.classList.toggle('hidden', !back);
  backBtn.onclick = back ? () => go(back) : null;
  tabbar.classList.toggle('hidden', !tab);
  tabbar.querySelectorAll('a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  window.scrollTo(0, 0);
}

function busy(button, on) {
  if (!button) return;
  button.disabled = on;
  if (on) {
    button.dataset.label = button.textContent;
    button.textContent = 'Please wait…';
  } else if (button.dataset.label) {
    button.textContent = button.dataset.label;
  }
}

function formJson(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function mask(account) {
  return account ? '•••• ' + account.slice(-4) : '';
}

function firstIncompleteStep() {
  const s = STEPS.find(([key]) => !me.steps[key]);
  return s ? s[0] : null;
}

function logout(callApi = true) {
  if (callApi && token) api('/api/auth/logout', { method: 'POST', token });
  token = null;
  me = null;
  storage.del(TOKEN_KEY);
  go('#/login');
}

async function refresh() {
  const { ok, data } = await authed('/api/me');
  if (ok) me = data;
  return ok;
}

/** Shrinks camera photos before upload so they send quickly on mobile data. */
async function fileToDataUrl(file, allowPdf) {
  if (file.type === 'application/pdf') {
    if (!allowPdf) throw new Error('Please upload a photo for this document');
    if (file.size > 5 * 1024 * 1024) throw new Error('PDF must be under 5 MB');
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error('Could not read the file'));
      r.readAsDataURL(file);
    });
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('Unsupported image. Please use a JPG or PNG photo.');
  }
  const max = 1600;
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.82);
}

// ---------- screens ----------

function renderLogin() {
  setChrome({});
  view.innerHTML = `
    <section class="welcome">
      <div class="welcome-art">₹</div>
      <h1>Instant loans up to ₹10,000</h1>
      <p class="muted">Based on your salary. 100% online, money straight to your bank account.</p>
      <ul class="trust trust-left">
        <li>Approval in minutes after KYC</li>
        <li>Repay in 30, 60 or 90 days</li>
        <li>No hidden charges</li>
      </ul>
    </section>
    <form id="login-form" class="card" novalidate>
      <label for="mobile">Mobile number</label>
      <div class="phone-input">
        <span>+91</span>
        <input id="mobile" name="mobile" type="tel" inputmode="numeric" maxlength="10" autocomplete="tel-national" placeholder="10-digit mobile number" value="${escapeHtml(pendingMobile)}" required>
      </div>
      <div class="field-error" data-for="mobile"></div>
      <div class="actions"><button type="submit">Get OTP</button></div>
      <p class="small-text muted center">By continuing you agree to our terms and privacy policy.</p>
    </form>`;

  const form = document.getElementById('login-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button');
    busy(btn, true);
    const mobile = form.mobile.value.trim();
    const { ok, status, data } = await api('/api/auth/otp', { method: 'POST', body: { mobile } });
    busy(btn, false);
    showFieldErrors(form, data.errors);
    if (!ok) {
      if (!data.errors) toast(data.error || 'Could not send OTP');
      if (status !== 429) return;
    }
    pendingMobile = mobile;
    sessionStorage.setItem('qc_demo_otp', data.demoOtp || '');
    go('#/otp');
  });
}

function renderOtp() {
  if (!pendingMobile) return go('#/login');
  setChrome({ title: 'Verify mobile', back: '#/login' });
  const demoOtp = sessionStorage.getItem('qc_demo_otp');
  view.innerHTML = `
    <form id="otp-form" class="card" novalidate>
      <h2>Enter OTP</h2>
      <p class="sub">Sent to +91 ${escapeHtml(pendingMobile)}</p>
      ${demoOtp ? `<div class="result info small-text">Demo mode (no SMS set up yet): your OTP is <strong>${escapeHtml(demoOtp)}</strong></div>` : ''}
      <input id="otp" name="otp" class="otp-input" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="••••••" required>
      <div class="field-error" data-for="otp"></div>
      <div class="actions"><button type="submit">Verify &amp; continue</button></div>
      <p class="center small-text"><button type="button" class="link-btn" id="resend" disabled>Resend OTP in <span id="count">30</span>s</button></p>
    </form>`;

  const form = document.getElementById('otp-form');
  const otpInput = form.otp;
  otpInput.focus();
  otpInput.addEventListener('input', () => {
    otpInput.value = otpInput.value.replace(/\D/g, '').slice(0, 6);
    if (otpInput.value.length === 6) form.requestSubmit();
  });

  const resend = document.getElementById('resend');
  let left = 30;
  clearInterval(renderOtp.timer);
  renderOtp.timer = setInterval(() => {
    left -= 1;
    const count = document.getElementById('count');
    if (!count) return clearInterval(renderOtp.timer);
    if (left <= 0) {
      clearInterval(renderOtp.timer);
      resend.disabled = false;
      resend.textContent = 'Resend OTP';
    } else {
      count.textContent = left;
    }
  }, 1000);
  resend.addEventListener('click', async () => {
    const { ok, data } = await api('/api/auth/otp', { method: 'POST', body: { mobile: pendingMobile } });
    if (!ok) return toast(data.error || 'Could not resend OTP');
    sessionStorage.setItem('qc_demo_otp', data.demoOtp || '');
    toast('OTP sent again');
    renderOtp();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    busy(btn, true);
    const { ok, data } = await api('/api/auth/verify', {
      method: 'POST',
      body: { mobile: pendingMobile, otp: otpInput.value },
    });
    busy(btn, false);
    showFieldErrors(form, data.errors);
    if (!ok) return;
    token = data.token;
    storage.set(TOKEN_KEY, token);
    sessionStorage.removeItem('qc_demo_otp');
    me = data;
    const next = firstIncompleteStep();
    go(next ? `#/onboarding/${next}` : '#/home');
  });
}

function stepHeader(key) {
  const index = STEPS.findIndex(([k]) => k === key);
  const done = STEPS.filter(([k]) => me.steps[k]).length;
  return `
    <div class="stepper">
      <div class="stepper-bar"><span style="width:${((index + 1) / STEPS.length) * 100}%"></span></div>
      <div class="small-text muted">Step ${index + 1} of ${STEPS.length} · ${done} completed</div>
    </div>`;
}

function nextStepAfter(key) {
  const order = STEPS.map(([k]) => k);
  const rest = order.slice(order.indexOf(key) + 1).concat(order.slice(0, order.indexOf(key)));
  const pending = rest.find((k) => !me.steps[k]);
  return pending ? `#/onboarding/${pending}` : '#/home';
}

function renderOnboarding(step) {
  const meta = STEPS.find(([k]) => k === step);
  if (!meta) return go('#/home');
  const fromProfile = new URLSearchParams(location.hash.split('?')[1] || '').has('edit');
  setChrome({ title: meta[1], back: fromProfile ? '#/profile' : '#/home' });
  const c = me.customer;

  const forms = {
    personal: () => `
      <p class="sub">Enter details exactly as on your PAN card.</p>
      <div class="grid">
        <div><label for="fullName">Full name</label>
          <input id="fullName" name="fullName" autocomplete="name" value="${escapeHtml(c.fullName || '')}" required>
          <div class="field-error" data-for="fullName"></div></div>
        <div><label for="pan">PAN</label>
          <input id="pan" name="pan" maxlength="10" autocapitalize="characters" autocomplete="off" spellcheck="false" style="text-transform:uppercase" placeholder="ABCDE1234F" value="${escapeHtml(c.pan || '')}" required>
          <div class="field-error" data-for="pan"></div></div>
        <div><label for="dateOfBirth">Date of birth</label>
          <input id="dateOfBirth" name="dateOfBirth" type="date" value="${escapeHtml(c.dateOfBirth || '')}" required>
          <div class="field-error" data-for="dateOfBirth"></div></div>
        <div><label for="email">Email</label>
          <input id="email" name="email" type="email" autocomplete="email" autocapitalize="off" value="${escapeHtml(c.email || '')}" required>
          <div class="field-error" data-for="email"></div></div>
      </div>`,
    employment: () => `
      <p class="sub">Your loan limit is based on your monthly income.</p>
      <div class="grid">
        <div><label>I am</label>
          <div class="segmented">
            <label><input type="radio" name="employmentType" value="salaried" ${c.employmentType !== 'self_employed' ? 'checked' : ''}><span>Salaried</span></label>
            <label><input type="radio" name="employmentType" value="self_employed" ${c.employmentType === 'self_employed' ? 'checked' : ''}><span>Self-employed</span></label>
          </div></div>
        <div><label for="employerName">Employer / business name</label>
          <input id="employerName" name="employerName" autocomplete="organization" value="${escapeHtml(c.employerName || '')}" required>
          <div class="field-error" data-for="employerName"></div></div>
        <div><label for="monthsInCurrentJob">Months in current job / business</label>
          <input id="monthsInCurrentJob" name="monthsInCurrentJob" type="number" inputmode="numeric" min="0" value="${c.monthsInCurrentJob ?? ''}" required>
          <div class="field-error" data-for="monthsInCurrentJob"></div></div>
        <div><label for="monthlySalary">Monthly salary <span class="hint">(in-hand)</span></label>
          <div class="money"><input id="monthlySalary" name="monthlySalary" type="number" inputmode="numeric" min="0" value="${c.monthlySalary ?? ''}" required></div>
          <div class="field-error" data-for="monthlySalary"></div></div>
        <div><label for="otherMonthlyIncome">Other monthly income <span class="hint">(optional)</span></label>
          <div class="money"><input id="otherMonthlyIncome" name="otherMonthlyIncome" type="number" inputmode="numeric" min="0" value="${c.otherMonthlyIncome || ''}" placeholder="0"></div>
          <div class="field-error" data-for="otherMonthlyIncome"></div></div>
        <div><label for="existingEmi">Current EMIs per month <span class="hint">(if any)</span></label>
          <div class="money"><input id="existingEmi" name="existingEmi" type="number" inputmode="numeric" min="0" value="${c.existingEmi || ''}" placeholder="0"></div>
          <div class="field-error" data-for="existingEmi"></div></div>
      </div>`,
    documents: () => {
      const uploaded = Object.fromEntries(me.documents.map((d) => [d.type, d]));
      return `
        <p class="sub">Take clear photos in good light. All 5 are required for approval.</p>
        <div class="doc-list">
          ${me.requiredDocuments.map((type) => {
            const d = DOCS[type];
            const has = uploaded[type];
            return `
              <label class="doc-tile ${has ? 'done' : ''}">
                <span class="doc-status">${has ? '✓' : '+'}</span>
                <span class="doc-text"><strong>${d.label}</strong><small>${has ? 'Uploaded · tap to replace' : d.hint}</small></span>
                <input type="file" data-type="${type}" accept="${d.pdf ? 'image/*,application/pdf' : 'image/*'}" ${d.capture ? `capture="${d.capture}"` : ''} hidden>
              </label>
              <div class="field-error" data-for="${type}"></div>`;
          }).join('')}
        </div>`;
    },
    bank: () => `
      <p class="sub">Your loan will be sent to this account. It must be in your name.</p>
      <div class="grid">
        <div><label for="accountHolder">Account holder name</label>
          <input id="accountHolder" name="accountHolder" value="${escapeHtml(c.bank?.accountHolder || c.fullName || '')}" required>
          <div class="field-error" data-for="accountHolder"></div></div>
        <div><label for="accountNumber">Account number</label>
          <input id="accountNumber" name="accountNumber" inputmode="numeric" autocomplete="off" value="${escapeHtml(c.bank?.accountNumber || '')}" required>
          <div class="field-error" data-for="accountNumber"></div></div>
        <div><label for="confirmAccountNumber">Confirm account number</label>
          <input id="confirmAccountNumber" name="confirmAccountNumber" inputmode="numeric" autocomplete="off" value="${escapeHtml(c.bank?.accountNumber || '')}" required>
          <div class="field-error" data-for="confirmAccountNumber"></div></div>
        <div><label for="ifsc">IFSC code</label>
          <input id="ifsc" name="ifsc" maxlength="11" autocapitalize="characters" autocomplete="off" spellcheck="false" style="text-transform:uppercase" placeholder="HDFC0001234" value="${escapeHtml(c.bank?.ifsc || '')}" required>
          <div class="field-error" data-for="ifsc"></div></div>
      </div>`,
  };

  const isDocs = step === 'documents';
  view.innerHTML = `
    ${fromProfile ? '' : stepHeader(step)}
    <form id="step-form" class="card" novalidate>
      ${forms[step]()}
      <div id="step-result"></div>
      <div class="actions">
        <button type="submit" ${isDocs && !me.steps.documents ? 'disabled' : ''}>${isDocs ? 'Continue' : 'Save & continue'}</button>
      </div>
    </form>`;

  const form = document.getElementById('step-form');

  if (isDocs) {
    form.querySelectorAll('input[type=file]').forEach((input) => {
      input.addEventListener('change', async () => {
        const file = input.files[0];
        if (!file) return;
        const type = input.dataset.type;
        const tile = input.closest('.doc-tile');
        tile.classList.add('uploading');
        tile.querySelector('small').textContent = 'Uploading…';
        try {
          const dataUrl = await fileToDataUrl(file, DOCS[type].pdf);
          const { ok, data } = await authed('/api/me/documents', { method: 'POST', body: { type, dataUrl } });
          if (!ok) throw new Error((data.errors && data.errors[type]) || data.error || 'Upload failed');
          me = data;
          renderOnboarding(step);
        } catch (err) {
          tile.classList.remove('uploading');
          tile.querySelector('small').textContent = DOCS[type].hint;
          showFieldErrors(form, { [type]: err.message });
        }
      });
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      go(fromProfile ? '#/profile' : nextStepAfter(step));
    });
    return;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    busy(btn, true);
    const { ok, data } = await authed(`/api/me/${step}`, { method: 'PUT', body: formJson(form) });
    busy(btn, false);
    showFieldErrors(form, data.errors);
    if (!ok) return;
    me = data;
    if (step === 'employment' && data.eligibility) {
      const el = data.eligibility;
      document.getElementById('step-result').innerHTML = el.eligible
        ? `<div class="result ok"><h3>You're eligible for up to</h3><div class="amount-big">${inr(el.maxEligibleAmount)}</div></div>`
        : `<div class="result fail"><h3>Not eligible right now</h3><ul>${el.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul></div>`;
      setTimeout(() => go(fromProfile ? '#/profile' : nextStepAfter(step)), el.eligible ? 1400 : 3500);
      return;
    }
    toast('Saved');
    go(fromProfile ? '#/profile' : nextStepAfter(step));
  });
}

function tracker(status) {
  const stages = ['Applied', 'Approved', 'Money sent', 'Repaid'];
  const reached = { PENDING: 1, APPROVED: 2, DISBURSED: 3, CLOSED: 4 }[status] || 1;
  return `<ol class="tracker">${stages
    .map((s, i) => `<li class="${i < reached ? 'done' : ''} ${i === reached - 1 ? 'current' : ''}"><span></span>${s}</li>`)
    .join('')}</ol>`;
}

function nextDue(loan) {
  return loan.schedule.find((s) => s.status === 'DUE' || s.status === 'OVERDUE');
}

function renderHome() {
  setChrome({ tab: 'home' });
  const c = me.customer;
  const name = (c.fullName || '').split(' ')[0];
  const done = STEPS.filter(([k]) => me.steps[k]).length;
  const next = firstIncompleteStep();
  const loan = me.activeLoan;
  const el = me.eligibility;
  let main = '';

  if (loan) {
    const due = nextDue(loan);
    const messages = {
      PENDING: 'We are verifying your details and documents. This usually takes a few hours.',
      APPROVED: 'Approved! The money will reach your bank account shortly.',
      DISBURSED: '',
    };
    main = `
      <section class="limit-card">
        <div class="small-text">${loan.status === 'DISBURSED' ? 'Outstanding amount' : 'Loan amount'}</div>
        <div class="limit-amount">${inr(loan.status === 'DISBURSED' ? loan.outstandingAmount : loan.approvedAmount)}</div>
        <div class="small-text">Ref ${escapeHtml(loan.id)} · ${loan.tenureDays} days</div>
      </section>
      <section class="card">
        ${tracker(loan.status)}
        ${messages[loan.status] ? `<p class="small-text muted">${messages[loan.status]}</p>` : ''}
        ${due ? `
          <div class="due-row ${due.status === 'OVERDUE' ? 'overdue' : ''}">
            <div><span class="small-text muted">${due.status === 'OVERDUE' ? 'Overdue since' : 'Next EMI due'} ${fmtDate(due.dueDate)}</span>
              <strong>${inr(due.amount)}</strong></div>
            <a class="btn" href="#/pay/${encodeURIComponent(loan.id)}/${due.installment}">Pay now</a>
          </div>` : ''}
        ${loan.status === 'DISBURSED' && !due ? '<p class="small-text muted">All EMIs submitted. We are verifying your payment.</p>' : ''}
        <div class="actions"><a class="btn secondary" href="#/loan/${encodeURIComponent(loan.id)}">View loan details</a></div>
      </section>`;
  } else if (next) {
    main = `
      <section class="limit-card">
        <div class="small-text">Get up to</div>
        <div class="limit-amount">${inr(policy ? policy.maxLoan : 10000)}</div>
        <div class="small-text">Complete your profile to see your limit</div>
      </section>
      <section class="card">
        <h2>Complete your profile</h2>
        <div class="stepper-bar"><span style="width:${(done / STEPS.length) * 100}%"></span></div>
        <ul class="checklist">
          ${STEPS.map(([k, label]) => `<li class="${me.steps[k] ? 'done' : ''}"><a href="#/onboarding/${k}">${label}<span>${me.steps[k] ? '✓' : '›'}</span></a></li>`).join('')}
        </ul>
        <div class="actions"><a class="btn" href="#/onboarding/${next}">Continue</a></div>
      </section>`;
  } else if (el && el.eligible) {
    main = `
      <section class="limit-card">
        <div class="small-text">Your available limit</div>
        <div class="limit-amount">${inr(el.maxEligibleAmount)}</div>
        <div class="small-text">Based on monthly income of ${inr(el.assessedIncome)}</div>
        <a class="btn light" href="#/apply">Get money now</a>
      </section>`;
  } else {
    main = `
      <section class="card">
        <div class="result fail" style="margin-top:0">
          <h3>Not eligible right now</h3>
          <ul>${(el ? el.reasons : []).map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>
        </div>
        <div class="actions"><a class="btn secondary" href="#/onboarding/employment?edit">Update income details</a></div>
      </section>`;
  }

  view.innerHTML = `
    <p class="greeting">Hi${name ? ` ${escapeHtml(name)}` : ''} 👋</p>
    ${main}
    <section class="card how">
      <h2>How it works</h2>
      <ol class="how-list">
        <li><strong>Complete KYC</strong><span>PAN, Aadhaar, selfie and income proof</span></li>
        <li><strong>Choose amount</strong><span>₹5,000 – ₹10,000 for 30–90 days</span></li>
        <li><strong>Get money</strong><span>Sent straight to your bank account</span></li>
        <li><strong>Repay by UPI</strong><span>Pay EMIs from the app</span></li>
      </ol>
    </section>`;
}

function renderApply() {
  const el = me.eligibility;
  if (me.activeLoan || !el || !el.eligible || firstIncompleteStep()) return go('#/home');
  setChrome({ title: 'Get money', back: '#/home' });
  const tenures = policy.tenureOptions.filter((t) => el.byTenure[t] >= policy.minLoan);
  let tenure = tenures.includes(30) ? 30 : tenures[0];

  view.innerHTML = `
    <form id="apply-form" class="card" novalidate>
      <label>Repay in</label>
      <div class="segmented">
        ${tenures.map((t) => `<label><input type="radio" name="tenureDays" value="${t}" ${t === tenure ? 'checked' : ''}><span>${t} days<small>${t / 30} EMI${t > 30 ? 's' : ''}</small></span></label>`).join('')}
      </div>
      <div class="amount-picker" style="margin-top:16px">
        <div class="muted small-text center">Loan amount</div>
        <div class="value" id="amountLabel"></div>
        <input id="amount" type="range" step="${policy.amountStep}" aria-label="Loan amount">
        <div class="range-labels"><span>${inr(policy.minLoan)}</span><span id="amountMax"></span></div>
      </div>
      <div id="quote"></div>
      <div class="bank-line small-text">Money will be sent to <strong>${escapeHtml(me.customer.bank.accountHolder)}</strong> · ${mask(me.customer.bank.accountNumber)} · ${escapeHtml(me.customer.bank.ifsc)}</div>
      <label class="checkbox">
        <input type="checkbox" id="consent">
        <span>I agree to the loan terms, the repayment schedule above and a credit check.</span>
      </label>
      <div class="field-error" data-for="consent"></div>
      <div class="actions"><button type="submit">Submit application</button></div>
    </form>`;

  const form = document.getElementById('apply-form');
  const slider = document.getElementById('amount');
  const setRange = () => {
    const max = el.byTenure[tenure];
    slider.min = policy.minLoan;
    slider.max = max;
    slider.value = Math.min(Number(slider.value) || max, max);
    slider.disabled = max === policy.minLoan;
    document.getElementById('amountMax').textContent = inr(max);
  };
  let timer;
  const update = () => {
    document.getElementById('amountLabel').textContent = inr(slider.value);
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const { ok, data } = await authed('/api/me/quote', {
        method: 'POST',
        body: { requestedAmount: Number(slider.value), tenureDays: tenure },
      });
      document.getElementById('quote').innerHTML = ok && data.quote ? quoteHtml(data.quote) : '';
    }, 150);
  };
  form.querySelectorAll('input[name=tenureDays]').forEach((r) =>
    r.addEventListener('change', () => {
      tenure = Number(r.value);
      setRange();
      update();
    })
  );
  slider.addEventListener('input', update);
  setRange();
  slider.value = slider.max;
  update();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    busy(btn, true);
    const { ok, data } = await authed('/api/me/loans', {
      method: 'POST',
      body: { requestedAmount: Number(slider.value), tenureDays: tenure, consent: document.getElementById('consent').checked },
    });
    busy(btn, false);
    showFieldErrors(form, data.errors);
    if (!ok) {
      if (!data.errors) toast(data.error || 'Could not submit');
      return;
    }
    await refresh();
    toast(data.status === 'REJECTED' ? 'Application not approved' : 'Application submitted!');
    go(`#/loan/${encodeURIComponent(data.id)}`);
  });
}

function statusChip(s) {
  const map = { PAID: ['Paid', 'CLOSED'], VERIFYING: ['Verifying', 'PENDING'], OVERDUE: ['Overdue', 'REJECTED'], DUE: ['Due', 'APPROVED'] };
  const [text, cls] = map[s];
  return `<span class="badge ${cls}">${text}</span>`;
}

async function renderLoan(id) {
  setChrome({ title: 'Loan details', back: '#/loans' });
  view.innerHTML = '<div class="loading">Loading…</div>';
  const { ok, data: loan } = await authed(`/api/me/loans/${encodeURIComponent(id)}`);
  if (!ok) {
    view.innerHTML = '<div class="card">Loan not found.</div>';
    return;
  }
  const q = loan.quote;
  view.innerHTML = `
    <section class="card">
      <div class="row-between">
        <div><div class="small-text muted">Ref ${escapeHtml(loan.id)}</div>
          <div class="amount-mid">${inr(loan.approvedAmount || loan.requestedAmount)}</div></div>
        <span class="badge ${loan.status}">${STATUS_TEXT[loan.status]}</span>
      </div>
      ${loan.status !== 'REJECTED' ? tracker(loan.status) : ''}
      ${loan.status === 'REJECTED'
        ? `<div class="result fail"><ul>${loan.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>${loan.adminNote ? `<p>${escapeHtml(loan.adminNote)}</p>` : ''}</div>`
        : ''}
      ${loan.status === 'DISBURSED' ? `
        <div class="summary">
          <div><span>Paid so far</span><strong>${inr(loan.paidAmount)}</strong></div>
          <div><span>Outstanding</span><strong>${inr(loan.outstandingAmount)}</strong></div>
        </div>` : ''}
      ${loan.disbursedAt ? `<p class="small-text muted">Sent ${fmtDate(loan.disbursedAt.slice(0, 10))} to ${mask(loan.bank?.accountNumber)} · Ref ${escapeHtml(loan.disbursalRef)}</p>` : ''}
    </section>
    ${q ? `
      <section class="card">
        <h2>Repayment schedule</h2>
        <ul class="emi-list">
          ${loan.schedule.map((s) => `
            <li>
              <div><strong>EMI ${s.installment} · ${inr(s.amount)}</strong><span class="small-text muted">Due ${fmtDate(s.dueDate)}</span></div>
              ${loan.status === 'DISBURSED' && (s.status === 'DUE' || s.status === 'OVERDUE')
                ? `<a class="btn small" href="#/pay/${encodeURIComponent(loan.id)}/${s.installment}">Pay</a>`
                : loan.status === 'DISBURSED' || loan.status === 'CLOSED' ? statusChip(s.status) : ''}
            </li>`).join('')}
        </ul>
        ${summaryHtml(q)}
      </section>` : ''}`;
}

async function renderPay(id, installment) {
  setChrome({ title: 'Pay EMI', back: `#/loan/${id}` });
  const { ok, data: loan } = await authed(`/api/me/loans/${encodeURIComponent(id)}`);
  const item = ok && loan.schedule.find((s) => s.installment === Number(installment));
  if (!item) return go('#/home');
  const payTo = me.payTo || {};
  const note = `${loan.id} EMI ${item.installment}`;
  const upiLink = payTo.upiId
    ? `upi://pay?${new URLSearchParams({ pa: payTo.upiId, pn: payTo.name || 'QuickCash', am: String(item.amount), cu: 'INR', tn: note })}`
    : '';

  view.innerHTML = `
    <section class="card center">
      <div class="small-text muted">EMI ${item.installment} · due ${fmtDate(item.dueDate)}</div>
      <div class="amount-big" style="color:var(--text)">${inr(item.amount)}</div>
      ${upiLink ? `<a class="btn" href="${escapeHtml(upiLink)}">Pay with UPI app</a>` : ''}
    </section>
    <section class="card">
      <h2>Payment details</h2>
      ${payTo.upiId ? `<div class="copy-row"><span>UPI ID</span><strong>${escapeHtml(payTo.upiId)}</strong><button type="button" class="small secondary" data-copy="${escapeHtml(payTo.upiId)}">Copy</button></div>` : ''}
      ${payTo.bankDetails ? `<p class="small-text pre">${escapeHtml(payTo.bankDetails)}</p>` : ''}
      ${!payTo.upiId && !payTo.bankDetails ? '<p class="small-text muted">Payment details will be shared by our team. Contact support below.</p>' : ''}
      <div class="copy-row"><span>Remark</span><strong>${escapeHtml(note)}</strong><button type="button" class="small secondary" data-copy="${escapeHtml(note)}">Copy</button></div>
    </section>
    <form id="pay-form" class="card" novalidate>
      <h2>Already paid?</h2>
      <p class="sub">Enter the UPI / bank transaction reference (UTR) so we can confirm your payment.</p>
      <input name="reference" autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="e.g. 412345678901" required>
      <div class="field-error" data-for="reference"></div>
      <div class="actions"><button type="submit">Submit payment</button></div>
    </form>`;

  view.querySelectorAll('[data-copy]').forEach((b) =>
    b.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(b.dataset.copy);
        toast('Copied');
      } catch {
        toast(b.dataset.copy);
      }
    })
  );
  const form = document.getElementById('pay-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button');
    busy(btn, true);
    const res = await authed(`/api/me/loans/${encodeURIComponent(id)}/repayments`, {
      method: 'POST',
      body: { installment: item.installment, reference: form.reference.value.trim() },
    });
    busy(btn, false);
    showFieldErrors(form, res.data.errors);
    if (!res.ok) {
      if (!res.data.errors) toast(res.data.error || 'Could not submit');
      return;
    }
    await refresh();
    toast('Payment submitted. We will confirm it shortly.');
    go(`#/loan/${encodeURIComponent(id)}`);
  });
}

function renderLoans() {
  setChrome({ title: 'My loans', tab: 'loans' });
  view.innerHTML = me.loans.length
    ? `<ul class="loan-list">${me.loans.map((l) => `
        <li><a href="#/loan/${encodeURIComponent(l.id)}">
          <div><strong>${inr(l.approvedAmount || l.requestedAmount)}</strong>
            <span class="small-text muted">${fmtDate(l.createdAt.slice(0, 10))} · ${l.tenureDays} days · ${escapeHtml(l.id)}</span></div>
          <span class="badge ${l.status}">${STATUS_TEXT[l.status]}</span>
        </a></li>`).join('')}</ul>`
    : `<div class="card center"><p class="muted">No loans yet.</p><a class="btn" href="#/home">Get started</a></div>`;
}

function renderProfile() {
  setChrome({ title: 'Profile', tab: 'profile' });
  const c = me.customer;
  const uploaded = new Set(me.documents.map((d) => d.type));
  const locked = Boolean(me.activeLoan);
  const editLink = (step) => (locked ? '' : `<a class="small-text" href="#/onboarding/${step}?edit">Edit</a>`);
  const support = me.payTo || {};
  view.innerHTML = `
    <section class="card profile-head">
      <div class="avatar">${escapeHtml((c.fullName || '?').charAt(0).toUpperCase())}</div>
      <div><strong>${escapeHtml(c.fullName || 'Your name')}</strong><div class="small-text muted">+91 ${escapeHtml(c.mobile)}</div></div>
    </section>
    ${locked ? '<p class="small-text muted center">Details are locked while you have an active loan.</p>' : ''}
    <section class="card">
      <div class="row-between"><h2>Personal</h2>${editLink('personal')}</div>
      <dl class="kv">
        <dt>PAN</dt><dd>${escapeHtml(c.pan || '—')}</dd>
        <dt>Date of birth</dt><dd>${c.dateOfBirth ? fmtDate(c.dateOfBirth) : '—'}</dd>
        <dt>Email</dt><dd>${escapeHtml(c.email || '—')}</dd>
      </dl>
    </section>
    <section class="card">
      <div class="row-between"><h2>Work & income</h2>${editLink('employment')}</div>
      <dl class="kv">
        <dt>Employer</dt><dd>${escapeHtml(c.employerName || '—')}</dd>
        <dt>Monthly salary</dt><dd>${c.monthlySalary != null ? inr(c.monthlySalary) : '—'}</dd>
        <dt>Other income</dt><dd>${inr(c.otherMonthlyIncome)}</dd>
        <dt>Current EMIs</dt><dd>${inr(c.existingEmi)}</dd>
      </dl>
    </section>
    <section class="card">
      <div class="row-between"><h2>Bank account</h2>${editLink('bank')}</div>
      <dl class="kv">
        <dt>Account</dt><dd>${c.bank ? `${escapeHtml(c.bank.accountHolder)} · ${mask(c.bank.accountNumber)}` : '—'}</dd>
        <dt>IFSC</dt><dd>${escapeHtml(c.bank?.ifsc || '—')}</dd>
      </dl>
    </section>
    <section class="card">
      <div class="row-between"><h2>KYC documents</h2>${editLink('documents')}</div>
      <ul class="checklist plain">
        ${me.requiredDocuments.map((t) => `<li class="${uploaded.has(t) ? 'done' : ''}">${DOCS[t].label}<span>${uploaded.has(t) ? '✓' : 'Missing'}</span></li>`).join('')}
      </ul>
    </section>
    ${support.supportPhone || support.supportEmail ? `
      <section class="card">
        <h2>Help & support</h2>
        ${support.supportPhone ? `<p><a href="tel:${escapeHtml(support.supportPhone)}">📞 ${escapeHtml(support.supportPhone)}</a></p>` : ''}
        ${support.supportEmail ? `<p><a href="mailto:${escapeHtml(support.supportEmail)}">✉️ ${escapeHtml(support.supportEmail)}</a></p>` : ''}
      </section>` : ''}
    <div class="actions"><button type="button" class="secondary" id="logout">Log out</button></div>
    <p class="center small-text muted" id="install-hint"></p>`;
  document.getElementById('logout').addEventListener('click', () => logout());
  showInstallHint();
}

// ---------- install prompt (PWA) ----------

let deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
  showInstallHint();
});

function showInstallHint() {
  const el = document.getElementById('install-hint');
  if (!el || window.matchMedia('(display-mode: standalone)').matches) return;
  if (deferredInstall) {
    el.innerHTML = '<button type="button" class="secondary" id="install">Install QuickCash app</button>';
    document.getElementById('install').addEventListener('click', async () => {
      deferredInstall.prompt();
      deferredInstall = null;
      el.innerHTML = '';
    });
  } else if (/iphone|ipad/i.test(navigator.userAgent)) {
    el.textContent = 'Tip: tap Share → "Add to Home Screen" to install the app.';
  }
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

// ---------- router ----------

async function render() {
  const [route, ...params] = location.hash.replace(/^#\/?/, '').split('?')[0].split('/');

  if (!token) {
    if (route === 'otp') return renderOtp();
    return renderLogin();
  }
  if (!me && !(await refresh())) return;
  if (!policy) policy = (await api('/api/policy')).data;

  switch (route) {
    case 'onboarding': return renderOnboarding(params[0]);
    case 'apply': return renderApply();
    case 'loan': return renderLoan(decodeURIComponent(params[0] || ''));
    case 'pay': return renderPay(decodeURIComponent(params[0] || ''), params[1]);
    case 'loans': await refresh(); return renderLoans();
    case 'profile': return renderProfile();
    case 'home':
      await refresh();
      return renderHome();
    default:
      return go('#/home');
  }
}

window.addEventListener('hashchange', render);
render();

'use strict';

const loginSection = document.getElementById('login');
const dashboard = document.getElementById('dashboard');
const logoutLink = document.getElementById('logout');
const rowsEl = document.getElementById('rows');
const statsEl = document.getElementById('stats');
const filterEl = document.getElementById('status-filter');
const searchEl = document.getElementById('search');
const drawer = document.getElementById('drawer');
const drawerBody = document.getElementById('drawer-body');
const drawerTitle = document.getElementById('drawer-title');
const backdrop = document.getElementById('backdrop');

const DOC_LABELS = {
  pan: 'PAN card',
  aadhaar_front: 'Aadhaar front',
  aadhaar_back: 'Aadhaar back',
  selfie: 'Selfie',
  income_proof: 'Income proof',
};
const STATUS_LABEL = {
  PENDING: 'Pending review',
  APPROVED: 'Approved',
  DISBURSED: 'Active',
  CLOSED: 'Closed',
  REJECTED: 'Rejected',
};

let token = sessionStorage.getItem('adminToken') || '';
let applications = [];
let openId = null;
let blobUrls = [];

const adminApi = (path, opts = {}) => api(path, { ...opts, token });

function logout(message = '') {
  token = '';
  sessionStorage.removeItem('adminToken');
  document.getElementById('login-error').textContent = message;
  dashboard.classList.add('hidden');
  logoutLink.classList.add('hidden');
  loginSection.classList.remove('hidden');
  closeDrawer();
}

function ageFrom(dob) {
  if (!dob) return '';
  const d = new Date(dob);
  const t = new Date();
  let age = t.getFullYear() - d.getFullYear();
  if (t < new Date(t.getFullYear(), d.getMonth(), d.getDate())) age -= 1;
  return age;
}

// ---------- list ----------

async function load() {
  const qs = filterEl.value ? `?status=${filterEl.value}` : '';
  const { ok, status, data } = await adminApi(`/api/admin/applications${qs}`);
  if (status === 401) return logout('Invalid admin token');
  if (!ok) return;

  loginSection.classList.add('hidden');
  dashboard.classList.remove('hidden');
  logoutLink.classList.remove('hidden');

  const s = data.stats;
  const count = (k) => (s[k] ? s[k].count : 0);
  statsEl.innerHTML = `
    <button class="stat" data-filter="PENDING"><span>Pending review</span><strong>${count('PENDING')}</strong></button>
    <button class="stat ${s.paymentsToVerify ? 'alert' : ''}" data-filter="DISBURSED"><span>Payments to verify</span><strong>${s.paymentsToVerify}</strong></button>
    <button class="stat" data-filter="APPROVED"><span>To disburse</span><strong>${count('APPROVED')}</strong></button>
    <button class="stat" data-filter="DISBURSED"><span>Active loans</span><strong>${count('DISBURSED')}</strong></button>
    <button class="stat" data-filter="DISBURSED"><span>Active principal</span><strong>${inr(s.DISBURSED ? s.DISBURSED.amount : 0)}</strong></button>
    <div class="stat"><span>Customers</span><strong>${s.customers}</strong></div>`;

  applications = data.applications;
  renderRows();
}

function renderRows() {
  const q = searchEl.value.trim().toLowerCase();
  const list = q
    ? applications.filter((a) =>
        [a.id, a.fullName, a.mobile, a.pan, a.email].some((v) => String(v || '').toLowerCase().includes(q)))
    : applications;
  rowsEl.innerHTML = list.length
    ? list.map(rowHtml).join('')
    : '<tr><td colspan="6" class="muted">No applications found.</td></tr>';
}

function rowHtml(a) {
  return `<tr data-open="${escapeHtml(a.id)}" class="clickable">
    <td data-label="Reference"><strong>${escapeHtml(a.id)}</strong>
      <div class="small-text muted">${new Date(a.createdAt).toLocaleString('en-IN')}</div></td>
    <td data-label="Applicant">${escapeHtml(a.fullName)}
      <div class="small-text muted">${escapeHtml(a.mobile)} · PAN ${escapeHtml(a.pan)}</div></td>
    <td data-label="Income">${inr(a.assessedIncome)}<span class="small-text muted"> /mo</span>
      <div class="small-text muted">${a.employmentType === 'salaried' ? 'Salaried' : 'Self-employed'} · EMI ${inr(a.existingEmi)}</div></td>
    <td data-label="Loan">${inr(a.approvedAmount || a.requestedAmount)}
      <div class="small-text muted">${a.tenureDays} days${a.quote ? ` · repay ${inr(a.quote.totalRepayable)}` : ''}</div></td>
    <td data-label="Status"><span class="badge ${a.status}">${STATUS_LABEL[a.status]}</span>
      ${a.paymentsToVerify ? `<div><span class="badge PENDING">${a.paymentsToVerify} payment to verify</span></div>` : ''}</td>
    <td class="actions-cell"><button class="small secondary" data-open="${escapeHtml(a.id)}">Open</button></td>
  </tr>`;
}

rowsEl.addEventListener('click', (e) => {
  const el = e.target.closest('[data-open]');
  if (el) openDrawer(el.dataset.open);
});
statsEl.addEventListener('click', (e) => {
  const el = e.target.closest('[data-filter]');
  if (!el) return;
  filterEl.value = el.dataset.filter;
  load();
});
filterEl.addEventListener('change', load);
searchEl.addEventListener('input', renderRows);

// ---------- detail drawer ----------

function closeDrawer() {
  openId = null;
  drawer.classList.add('hidden');
  backdrop.classList.add('hidden');
  document.body.classList.remove('no-scroll');
  blobUrls.forEach((u) => URL.revokeObjectURL(u));
  blobUrls = [];
}
document.getElementById('drawer-close').addEventListener('click', closeDrawer);
backdrop.addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openId) closeDrawer();
});

async function openDrawer(id) {
  openId = id;
  drawer.classList.remove('hidden');
  backdrop.classList.remove('hidden');
  document.body.classList.add('no-scroll');
  drawerTitle.textContent = id;
  drawerBody.innerHTML = '<p class="muted">Loading…</p>';
  const { ok, data } = await adminApi(`/api/admin/applications/${encodeURIComponent(id)}`);
  if (!ok || openId !== id) return;
  renderDetail(data);
}

function actionsHtml(loan, docsComplete) {
  switch (loan.status) {
    case 'PENDING':
      return `
        ${docsComplete ? '' : '<div class="result fail small-text" style="margin-top:0">KYC documents are incomplete. Approval is blocked until all 5 are uploaded.</div>'}
        <div class="action-row">
          <button data-act="approve" ${docsComplete ? '' : 'disabled'}>Approve ${inr(loan.approvedAmount)}</button>
          <button class="danger" data-act="reject">Reject</button>
        </div>`;
    case 'APPROVED':
      return `
        <label for="utr">Bank transfer reference (UTR) after sending ${inr(loan.quote.disbursedAmount)}</label>
        <input id="utr" placeholder="e.g. NEFT / IMPS UTR number" autocomplete="off">
        <div class="action-row">
          <button data-act="disburse">Mark as disbursed</button>
          <button class="danger" data-act="reject">Reject</button>
        </div>`;
    case 'DISBURSED': {
      const waiting = loan.repayments.filter((r) => r.status === 'SUBMITTED');
      return `
        ${waiting.map((r) => `
          <div class="verify-box">
            <div><strong>Customer paid EMI ${r.installment} · ${inr(r.amount)}</strong>
              <div class="small-text">UTR <strong>${escapeHtml(r.reference)}</strong> · ${new Date(r.createdAt).toLocaleString('en-IN')}</div>
              <div class="small-text muted">Check this UTR in your bank statement before confirming.</div></div>
            <div class="action-row">
              <button data-pay="${escapeHtml(r.id)}" data-decision="confirm">Confirm payment</button>
              <button class="danger" data-pay="${escapeHtml(r.id)}" data-decision="reject">Not received</button>
            </div>
          </div>`).join('')}
        <p class="small-text" style="margin:0">Paid ${inr(loan.paidAmount)} · Outstanding <strong>${inr(loan.outstandingAmount)}</strong></p>
        <div class="action-row"><button class="secondary" data-act="close">Close loan manually</button></div>`;
    }
    default:
      return '';
  }
}

function renderDetail({ loan, customer, documents, requiredDocuments, history }) {
  const uploaded = Object.fromEntries(documents.map((d) => [d.type, d]));
  const docsComplete = requiredDocuments.every((t) => uploaded[t]);
  const q = loan.quote;
  const nameMismatch =
    loan.bank && loan.bank.accountHolder.trim().toLowerCase() !== loan.fullName.trim().toLowerCase();

  drawerTitle.innerHTML = `${escapeHtml(loan.id)} <span class="badge ${loan.status}">${STATUS_LABEL[loan.status]}</span>`;
  drawerBody.innerHTML = `
    <section class="panel">
      ${actionsHtml(loan, docsComplete)}
      <div id="action-msg"></div>
      ${loan.adminNote ? `<p class="small-text"><strong>Note:</strong> ${escapeHtml(loan.adminNote)}</p>` : ''}
    </section>

    <section class="panel">
      <h3>KYC documents</h3>
      <div class="doc-grid">
        ${requiredDocuments.map((t) => {
          const d = uploaded[t];
          return `<figure class="doc-thumb ${d ? '' : 'missing'}" ${d ? `data-doc="${escapeHtml(d.id)}" data-mime="${escapeHtml(d.mime)}"` : ''}>
            <div class="thumb">${d ? '<span class="muted small-text">Loading…</span>' : '<span>Missing</span>'}</div>
            <figcaption>${DOC_LABELS[t]}</figcaption>
          </figure>`;
        }).join('')}
      </div>
    </section>

    <section class="panel">
      <h3>Applicant</h3>
      <dl class="kv">
        <dt>Name</dt><dd>${escapeHtml(loan.fullName)}</dd>
        <dt>Mobile</dt><dd><a href="tel:+91${escapeHtml(loan.mobile)}">${escapeHtml(loan.mobile)}</a></dd>
        <dt>Email</dt><dd>${escapeHtml(loan.email)}</dd>
        <dt>PAN</dt><dd>${escapeHtml(loan.pan)}</dd>
        <dt>Date of birth</dt><dd>${fmtDate(loan.dateOfBirth)} (${ageFrom(loan.dateOfBirth)} yrs)</dd>
        <dt>Work</dt><dd>${escapeHtml(loan.employerName)} · ${loan.employmentType === 'salaried' ? 'Salaried' : 'Self-employed'} · ${loan.monthsInCurrentJob} mo</dd>
      </dl>
    </section>

    <section class="panel">
      <h3>Income &amp; decision</h3>
      <dl class="kv">
        <dt>Salary</dt><dd>${inr(loan.monthlySalary)}</dd>
        <dt>Other income</dt><dd>${inr(loan.otherMonthlyIncome)}</dd>
        <dt>Existing EMIs</dt><dd>${inr(loan.existingEmi)}</dd>
        <dt>Assessed income</dt><dd>${inr(loan.assessedIncome)}</dd>
        <dt>Max eligible</dt><dd>${inr(loan.maxEligibleAmount)}</dd>
        <dt>Requested</dt><dd>${inr(loan.requestedAmount)} · ${loan.tenureDays} days</dd>
      </dl>
      ${loan.reasons.length ? `<div class="result fail small-text"><ul>${loan.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul></div>` : ''}
    </section>

    ${loan.bank ? `
      <section class="panel">
        <h3>Bank account</h3>
        <dl class="kv">
          <dt>Holder</dt><dd>${escapeHtml(loan.bank.accountHolder)}</dd>
          <dt>Account no.</dt><dd>${escapeHtml(loan.bank.accountNumber)}</dd>
          <dt>IFSC</dt><dd>${escapeHtml(loan.bank.ifsc)}</dd>
          ${loan.disbursalRef ? `<dt>Disbursal ref</dt><dd>${escapeHtml(loan.disbursalRef)} · ${fmtDate(loan.disbursedAt.slice(0, 10))}</dd>` : ''}
        </dl>
        ${nameMismatch ? '<p class="small-text warn-text">⚠ Account holder name differs from the PAN name. Check before disbursing.</p>' : ''}
      </section>` : ''}

    ${q ? `
      <section class="panel">
        <h3>Loan &amp; repayments</h3>
        ${summaryHtml(q)}
        <ul class="emi-list">
          ${loan.schedule.map((s) => `
            <li>
              <div><strong>EMI ${s.installment} · ${inr(s.amount)}</strong><span class="small-text muted">Due ${fmtDate(s.dueDate)}</span></div>
              <div class="emi-actions">
                ${loan.status === 'DISBURSED' || loan.status === 'CLOSED' ? `<span class="badge ${{ PAID: 'CLOSED', VERIFYING: 'PENDING', OVERDUE: 'REJECTED', DUE: 'APPROVED' }[s.status]}">${s.status}</span>` : ''}
                ${loan.status === 'DISBURSED' && s.status !== 'PAID' && s.status !== 'VERIFYING' ? `<button class="small secondary" data-record="${s.installment}">Record payment</button>` : ''}
              </div>
            </li>`).join('')}
        </ul>
        ${loan.repayments.length ? `
          <h4>Payments</h4>
          <ul class="emi-list">
            ${loan.repayments.map((r) => `
              <li>
                <div><strong>EMI ${r.installment} · ${inr(r.amount)}</strong>
                  <span class="small-text muted">UTR ${escapeHtml(r.reference)} · ${r.source === 'admin' ? 'recorded by admin' : 'submitted by customer'} · ${new Date(r.createdAt).toLocaleString('en-IN')}</span></div>
                <div class="emi-actions">
                  ${r.status === 'SUBMITTED'
                    ? `<button class="small" data-pay="${escapeHtml(r.id)}" data-decision="confirm">Confirm</button>
                       <button class="small danger" data-pay="${escapeHtml(r.id)}" data-decision="reject">Reject</button>`
                    : `<span class="badge ${r.status === 'CONFIRMED' ? 'CLOSED' : 'REJECTED'}">${r.status}</span>`}
                </div>
              </li>`).join('')}
          </ul>` : ''}
      </section>` : ''}

    ${history.length ? `
      <section class="panel">
        <h3>Previous applications</h3>
        <ul class="emi-list">
          ${history.map((h) => `<li><div><strong>${escapeHtml(h.id)}</strong><span class="small-text muted">${fmtDate(h.createdAt.slice(0, 10))} · ${inr(h.approvedAmount || h.requestedAmount)}</span></div><span class="badge ${h.status}">${STATUS_LABEL[h.status]}</span></li>`).join('')}
        </ul>
      </section>` : ''}

    ${customer ? `<p class="small-text muted">Customer ${escapeHtml(customer.id)} · joined ${fmtDate(customer.createdAt.slice(0, 10))}</p>` : ''}`;

  loadThumbnails();
}

async function loadThumbnails() {
  for (const fig of drawerBody.querySelectorAll('[data-doc]')) {
    const res = await fetch(`/api/admin/documents/${encodeURIComponent(fig.dataset.doc)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) continue;
    const url = URL.createObjectURL(await res.blob());
    blobUrls.push(url);
    const thumb = fig.querySelector('.thumb');
    thumb.innerHTML = fig.dataset.mime === 'application/pdf'
      ? '<span class="pdf-badge">PDF</span>'
      : `<img src="${url}" alt="">`;
    fig.addEventListener('click', () => window.open(url, '_blank', 'noopener'));
  }
}

drawerBody.addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]');
  const record = e.target.closest('[data-record]');
  const pay = e.target.closest('[data-pay]');
  if (!act && !record && !pay) return;

  let res;
  if (act) {
    const action = act.dataset.act;
    const body = {};
    if (action === 'reject') {
      const note = prompt('Reason for rejection (shown to the customer):');
      if (note === null) return;
      body.note = note;
    }
    if (action === 'disburse') {
      body.reference = document.getElementById('utr').value.trim();
      if (!body.reference) return showMsg('Enter the UTR of the bank transfer first.');
    }
    if (action === 'close' && !confirm('Close this loan even though not all EMIs are confirmed?')) return;
    act.disabled = true;
    res = await adminApi(`/api/admin/applications/${encodeURIComponent(openId)}/${action}`, { method: 'POST', body });
  } else if (record) {
    const reference = prompt(`Payment reference for EMI ${record.dataset.record} (UTR, or "cash"):`);
    if (reference === null) return;
    res = await adminApi(`/api/admin/applications/${encodeURIComponent(openId)}/repayments`, {
      method: 'POST',
      body: { installment: Number(record.dataset.record), reference },
    });
  } else {
    pay.disabled = true;
    res = await adminApi(`/api/admin/repayments/${encodeURIComponent(pay.dataset.pay)}/${pay.dataset.decision}`, {
      method: 'POST',
    });
  }

  if (!res.ok) {
    showMsg(res.data.error || 'Action failed');
    if (act) act.disabled = false;
    if (pay) pay.disabled = false;
    return;
  }
  await openDrawer(openId);
  load();
});

function showMsg(text) {
  const el = document.getElementById('action-msg');
  if (el) el.innerHTML = `<div class="result fail small-text">${escapeHtml(text)}</div>`;
}

// ---------- auth ----------

document.getElementById('login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  token = document.getElementById('token').value;
  sessionStorage.setItem('adminToken', token);
  load();
});
logoutLink.addEventListener('click', (e) => {
  e.preventDefault();
  logout();
});

if (token) load();
setInterval(() => {
  if (token && !openId && !document.hidden) load();
}, 60_000);

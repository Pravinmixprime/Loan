'use strict';

const loginSection = document.getElementById('login');
const dashboard = document.getElementById('dashboard');
const logoutLink = document.getElementById('logout');
const rowsEl = document.getElementById('rows');
const statsEl = document.getElementById('stats');
const filterEl = document.getElementById('status-filter');

const ACTIONS = {
  PENDING: [['approve', 'Approve', ''], ['reject', 'Reject', 'danger']],
  APPROVED: [['disburse', 'Mark disbursed', ''], ['reject', 'Reject', 'danger']],
  DISBURSED: [['close', 'Mark repaid', 'secondary']],
};

let token = sessionStorage.getItem('adminToken') || '';

async function load() {
  const qs = filterEl.value ? `?status=${filterEl.value}` : '';
  const { ok, status, data } = await api(`/api/admin/applications${qs}`, { token });
  if (status === 401) return logout('Invalid admin token');
  if (!ok) return;

  loginSection.classList.add('hidden');
  dashboard.classList.remove('hidden');
  logoutLink.classList.remove('hidden');

  const s = data.stats;
  const count = (k) => (s[k] ? s[k].count : 0);
  const disbursed = (s.DISBURSED ? s.DISBURSED.amount : 0);
  statsEl.innerHTML = `
    <div class="stat"><span>Pending review</span><strong>${count('PENDING')}</strong></div>
    <div class="stat"><span>Approved</span><strong>${count('APPROVED')}</strong></div>
    <div class="stat"><span>Outstanding loans</span><strong>${count('DISBURSED')}</strong></div>
    <div class="stat"><span>Outstanding principal</span><strong>${inr(disbursed)}</strong></div>
    <div class="stat"><span>Closed</span><strong>${count('CLOSED')}</strong></div>
    <div class="stat"><span>Rejected</span><strong>${count('REJECTED')}</strong></div>`;

  rowsEl.innerHTML = data.applications.length
    ? data.applications.map(rowHtml).join('')
    : '<tr><td colspan="6" class="muted">No applications yet.</td></tr>';
}

function rowHtml(a) {
  const buttons = (ACTIONS[a.status] || [])
    .map(([action, label, cls]) =>
      `<button class="small ${cls}" data-id="${escapeHtml(a.id)}" data-action="${action}">${label}</button>`)
    .join(' ');
  const reasons = a.reasons.length
    ? `<div class="small-text muted">${a.reasons.map(escapeHtml).join('<br>')}</div>`
    : '';
  return `<tr>
    <td data-label="Reference"><strong>${escapeHtml(a.id)}</strong><div class="small-text muted">${new Date(a.createdAt).toLocaleString('en-IN')}</div></td>
    <td data-label="Applicant">${escapeHtml(a.fullName)}
      <div class="small-text muted">${escapeHtml(a.mobile)} · ${escapeHtml(a.email)}<br>
      PAN ${escapeHtml(a.pan)} · ${escapeHtml(a.employerName)} (${a.employmentType === 'salaried' ? 'Salaried' : 'Self-employed'}, ${a.monthsInCurrentJob} mo)</div></td>
    <td data-label="Income">Salary ${inr(a.monthlySalary)}
      <div class="small-text muted">Other ${inr(a.otherMonthlyIncome)} · EMI ${inr(a.existingEmi)}<br>Assessed ${inr(a.assessedIncome)}</div></td>
    <td data-label="Loan">${inr(a.approvedAmount || a.requestedAmount)}
      <div class="small-text muted">Requested ${inr(a.requestedAmount)} · ${a.tenureDays} days
      ${a.quote ? `<br>Repay ${inr(a.quote.totalRepayable)}` : ''}</div></td>
    <td data-label="Status"><span class="badge ${a.status}">${a.status}</span>${reasons}
      ${a.adminNote ? `<div class="small-text">Note: ${escapeHtml(a.adminNote)}</div>` : ''}</td>
    <td class="actions-cell">${buttons}</td>
  </tr>`;
}

rowsEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const { id, action } = btn.dataset;
  let note = null;
  if (action === 'reject') {
    note = prompt('Reason for rejection (shown to the applicant):');
    if (note === null) return;
  }
  btn.disabled = true;
  const { ok, data } = await api(`/api/admin/applications/${encodeURIComponent(id)}/${action}`, {
    method: 'POST',
    body: { note },
    token,
  });
  if (!ok) alert(data.error || 'Action failed');
  load();
});

document.getElementById('login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  token = document.getElementById('token').value;
  sessionStorage.setItem('adminToken', token);
  load();
});

function logout(message = '') {
  token = '';
  sessionStorage.removeItem('adminToken');
  document.getElementById('login-error').textContent = message;
  dashboard.classList.add('hidden');
  logoutLink.classList.add('hidden');
  loginSection.classList.remove('hidden');
}

logoutLink.addEventListener('click', (e) => {
  e.preventDefault();
  logout();
});
filterEl.addEventListener('change', load);

if (token) load();

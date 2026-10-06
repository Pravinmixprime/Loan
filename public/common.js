'use strict';

/* Shared helpers for the applicant and admin pages. */

const inr = (n) =>
  '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });

const fmtDate = (iso) =>
  new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function api(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function showFieldErrors(form, errors = {}) {
  form.querySelectorAll('.field-error').forEach((el) => {
    const field = el.dataset.for;
    el.textContent = errors[field] || '';
    const input = form.querySelector(`[name="${field}"]`);
    if (input) input.classList.toggle('invalid', Boolean(errors[field]));
  });
}

function summaryHtml(q) {
  return `
    <div class="summary">
      <div><span>You receive</span><strong>${inr(q.disbursedAmount)}</strong></div>
      <div><span>Processing fee</span><strong>${inr(q.processingFee)}</strong></div>
      <div><span>Loan amount</span><strong>${inr(q.principal)}</strong></div>
      <div><span>Interest (${q.tenureDays} days)</span><strong>${inr(q.interest)}</strong></div>
      <div class="total"><span>Total to repay</span><strong>${inr(q.totalRepayable)}</strong></div>
    </div>`;
}

function quoteHtml(q) {
  const rows = q.schedule
    .map((s) => `<tr><td>EMI ${s.installment}</td><td>${escapeHtml(fmtDate(s.dueDate))}</td><td class="num"><strong>${inr(s.amount)}</strong></td></tr>`)
    .join('');
  return `${summaryHtml(q)}
    <div class="table-wrap schedule">
      <table>
        <thead><tr><th>Payment</th><th>Due date</th><th class="num">Amount</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

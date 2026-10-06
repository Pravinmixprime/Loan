'use strict';

/* Shared helpers for the applicant and admin pages. */

const inr = (n) =>
  '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });

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

function quoteHtml(q) {
  const rows = q.schedule
    .map((s) => `<tr><td>${s.installment}</td><td>${escapeHtml(s.dueDate)}</td><td>${inr(s.amount)}</td></tr>`)
    .join('');
  return `
    <div class="summary">
      <div><span>Loan amount</span><strong>${inr(q.principal)}</strong></div>
      <div><span>Processing fee</span><strong>${inr(q.processingFee)}</strong></div>
      <div><span>You receive</span><strong>${inr(q.disbursedAmount)}</strong></div>
      <div><span>Interest (${q.tenureDays} days)</span><strong>${inr(q.interest)}</strong></div>
      <div><span>Total repayable</span><strong>${inr(q.totalRepayable)}</strong></div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>#</th><th>Due date</th><th>Amount</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

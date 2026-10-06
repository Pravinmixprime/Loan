'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { openDb } = require('../src/db');

const ADMIN = 'test-token';
// Smallest valid JPEG header is enough for the signature check.
const JPEG = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString('base64');
const PDF = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 test').toString('base64');

let server;
let baseUrl;
let uploadDir;
let repo;

test.before(async () => {
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loan-uploads-'));
  const sms = { demo: true, sendOtp: async () => {} };
  repo = openDb({ file: ':memory:', uploadDir });
  const app = createApp({ repo, adminToken: ADMIN, sms });
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
  fs.rmSync(uploadDir, { recursive: true, force: true });
});

async function call(urlPath, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, data: type.includes('json') ? await res.json() : await res.arrayBuffer() };
}

async function login(mobile) {
  const sent = await call('/api/auth/otp', { method: 'POST', body: { mobile } });
  assert.equal(sent.status, 200);
  const verified = await call('/api/auth/verify', { method: 'POST', body: { mobile, otp: sent.data.demoOtp } });
  assert.equal(verified.status, 200);
  return verified.data.token;
}

const personal = { fullName: 'Asha Kumar', email: 'asha@example.com', dateOfBirth: '1994-02-15', pan: 'ABCDE1234F' };
const employment = {
  employmentType: 'salaried',
  employerName: 'Acme Pvt Ltd',
  monthsInCurrentJob: 24,
  monthlySalary: 22000,
  otherMonthlyIncome: 4000,
  existingEmi: 0,
};
const bank = { accountHolder: 'Asha Kumar', accountNumber: '123456789012', confirmAccountNumber: '123456789012', ifsc: 'HDFC0001234' };

async function onboard(token, overrides = {}) {
  assert.equal((await call('/api/me/personal', { method: 'PUT', token, body: { ...personal, ...overrides.personal } })).status, 200);
  assert.equal((await call('/api/me/employment', { method: 'PUT', token, body: { ...employment, ...overrides.employment } })).status, 200);
  for (const type of ['pan', 'aadhaar_front', 'aadhaar_back', 'selfie']) {
    assert.equal((await call('/api/me/documents', { method: 'POST', token, body: { type, dataUrl: JPEG } })).status, 200);
  }
  assert.equal((await call('/api/me/documents', { method: 'POST', token, body: { type: 'income_proof', dataUrl: PDF } })).status, 200);
  const r = await call('/api/me/bank', { method: 'PUT', token, body: bank });
  assert.equal(r.status, 200);
  return r.data;
}

test('public eligibility endpoint validates and evaluates', async () => {
  const bad = await call('/api/eligibility', { method: 'POST', body: {} });
  assert.equal(bad.status, 400);
  assert.ok(bad.data.errors.monthlySalary);

  const ok = await call('/api/eligibility', {
    method: 'POST',
    body: { ...employment, dateOfBirth: personal.dateOfBirth, tenureDays: 60 },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.maxEligibleAmount, 9500);
});

test('OTP login: validation, wrong code, resend cooldown, success', async () => {
  assert.equal((await call('/api/auth/otp', { method: 'POST', body: { mobile: '12345' } })).status, 400);

  const sent = await call('/api/auth/otp', { method: 'POST', body: { mobile: '9000000001' } });
  assert.match(sent.data.demoOtp, /^\d{6}$/);
  assert.equal((await call('/api/auth/otp', { method: 'POST', body: { mobile: '9000000001' } })).status, 429);

  const wrong = sent.data.demoOtp === '000000' ? '111111' : '000000';
  const bad = await call('/api/auth/verify', { method: 'POST', body: { mobile: '9000000001', otp: wrong } });
  assert.equal(bad.status, 400);
  assert.match(bad.data.errors.otp, /Incorrect/);

  const good = await call('/api/auth/verify', { method: 'POST', body: { mobile: '+919000000001', otp: sent.data.demoOtp } });
  assert.equal(good.status, 200);
  assert.ok(good.data.token);
  assert.equal(good.data.customer.mobile, '9000000001');
  assert.deepEqual(good.data.steps, { personal: false, employment: false, documents: false, bank: false });

  // OTP is single-use
  const reuse = await call('/api/auth/verify', { method: 'POST', body: { mobile: '9000000001', otp: sent.data.demoOtp } });
  assert.equal(reuse.status, 400);

  assert.equal((await call('/api/me')).status, 401);
  const me = await call('/api/me', { token: good.data.token });
  assert.equal(me.status, 200);

  await call('/api/auth/logout', { method: 'POST', token: good.data.token });
  assert.equal((await call('/api/me', { token: good.data.token })).status, 401);
});

test('onboarding validates each step and blocks loans until complete', async () => {
  const token = await login('9000000002');
  const early = await call('/api/me/loans', { method: 'POST', token, body: { requestedAmount: 5000, tenureDays: 30, consent: true } });
  assert.equal(early.status, 409);

  const badPersonal = await call('/api/me/personal', { method: 'PUT', token, body: { ...personal, pan: 'BAD' } });
  assert.ok(badPersonal.data.errors.pan);
  const badBank = await call('/api/me/bank', { method: 'PUT', token, body: { ...bank, ifsc: 'X', confirmAccountNumber: '1' } });
  assert.ok(badBank.data.errors.ifsc);
  assert.ok(badBank.data.errors.confirmAccountNumber);

  const notImage = await call('/api/me/documents', { method: 'POST', token, body: { type: 'selfie', dataUrl: 'data:image/jpeg;base64,aGVsbG8=' } });
  assert.equal(notImage.status, 400);
  const pdfSelfie = await call('/api/me/documents', { method: 'POST', token, body: { type: 'selfie', dataUrl: PDF } });
  assert.equal(pdfSelfie.status, 400);

  const done = await onboard(token, { personal: { pan: 'BBBBB2222B' } });
  assert.deepEqual(done.steps, { personal: true, employment: true, documents: true, bank: true });
  assert.equal(done.eligibility.maxEligibleAmount, 9500);

  // a PAN can belong to only one customer
  const other = await login('9000000003');
  const dupPan = await call('/api/me/personal', { method: 'PUT', token: other, body: { ...personal, pan: 'BBBBB2222B' } });
  assert.match(dupPan.data.errors.pan, /already registered/);

  // own documents can be viewed
  const doc = await call('/api/me/documents/selfie', { token });
  assert.equal(doc.status, 200);
});

test('full loan lifecycle: apply → approve → disburse → pay EMIs → closed', async () => {
  const token = await login('9000000010');
  await onboard(token);

  const quote = await call('/api/me/quote', { method: 'POST', token, body: { requestedAmount: 9000, tenureDays: 60 } });
  assert.equal(quote.data.quote.totalRepayable, 9360);

  const created = await call('/api/me/loans', { method: 'POST', token, body: { requestedAmount: 9000, tenureDays: 60, consent: true } });
  assert.equal(created.status, 201);
  assert.equal(created.data.status, 'PENDING');
  const id = created.data.id;

  const dup = await call('/api/me/loans', { method: 'POST', token, body: { requestedAmount: 5000, tenureDays: 30, consent: true } });
  assert.equal(dup.status, 409);

  // admin auth
  assert.equal((await call('/api/admin/applications')).status, 401);
  const detail = await call(`/api/admin/applications/${id}`, { token: ADMIN });
  assert.equal(detail.status, 200);
  assert.equal(detail.data.documents.length, 5);
  assert.equal(detail.data.loan.bank.ifsc, 'HDFC0001234');
  const docFile = await call(`/api/admin/documents/${detail.data.documents[0].id}`, { token: ADMIN });
  assert.equal(docFile.status, 200);

  // cannot pay before disbursal; cannot disburse without approval or reference
  assert.equal((await call(`/api/me/loans/${id}/repayments`, { method: 'POST', token, body: { installment: 1, reference: 'UTR123456' } })).status, 409);
  assert.equal((await call(`/api/admin/applications/${id}/disburse`, { method: 'POST', token: ADMIN, body: { reference: 'UTR1' } })).status, 409);

  assert.equal((await call(`/api/admin/applications/${id}/approve`, { method: 'POST', token: ADMIN, body: {} })).data.status, 'APPROVED');
  assert.equal((await call(`/api/admin/applications/${id}/disburse`, { method: 'POST', token: ADMIN, body: {} })).status, 400);
  const disbursed = await call(`/api/admin/applications/${id}/disburse`, { method: 'POST', token: ADMIN, body: { reference: 'NEFT998877' } });
  assert.equal(disbursed.data.status, 'DISBURSED');
  assert.equal(disbursed.data.disbursalRef, 'NEFT998877');
  assert.equal(disbursed.data.outstandingAmount, 9360);

  // customer pays EMI 1 → verifying → admin confirms
  assert.equal((await call(`/api/me/loans/${id}/repayments`, { method: 'POST', token, body: { installment: 1, reference: 'x' } })).status, 400);
  const paid = await call(`/api/me/loans/${id}/repayments`, { method: 'POST', token, body: { installment: 1, reference: 'UPI40012345' } });
  assert.equal(paid.status, 201);
  assert.equal(paid.data.schedule[0].status, 'VERIFYING');
  assert.equal((await call(`/api/me/loans/${id}/repayments`, { method: 'POST', token, body: { installment: 1, reference: 'UPI40012345' } })).status, 409);

  const stats = await call('/api/admin/applications', { token: ADMIN });
  assert.equal(stats.data.stats.paymentsToVerify, 1);

  const confirmed = await call(`/api/admin/repayments/${paid.data.repayments[0].id}/confirm`, { method: 'POST', token: ADMIN });
  assert.equal(confirmed.data.schedule[0].status, 'PAID');
  assert.equal(confirmed.data.outstandingAmount, 4680);
  assert.equal(confirmed.data.status, 'DISBURSED');

  // admin records the last EMI directly → loan auto-closes
  const last = await call(`/api/admin/applications/${id}/repayments`, { method: 'POST', token: ADMIN, body: { installment: 2, reference: 'CASH' } });
  assert.equal(last.data.status, 'CLOSED');

  // another customer cannot see this loan
  const stranger = await login('9000000011');
  assert.equal((await call(`/api/me/loans/${id}`, { token: stranger })).status, 404);

  // after closing, the customer can borrow again
  const again = await call('/api/me/loans', { method: 'POST', token, body: { requestedAmount: 5000, tenureDays: 30, consent: true } });
  assert.equal(again.status, 201);
});

test('approval is blocked when KYC documents are missing', async () => {
  const token = await login('9000000020');
  await onboard(token, { personal: { pan: 'CCCCC3333C' } });
  const created = await call('/api/me/loans', { method: 'POST', token, body: { requestedAmount: 5000, tenureDays: 30, consent: true } });
  // simulate a missing document
  repo.db.prepare('DELETE FROM documents WHERE customer_id = ? AND type = ?').run(created.data.customerId, 'selfie');
  const blocked = await call(`/api/admin/applications/${created.data.id}/approve`, { method: 'POST', token: ADMIN, body: {} });
  assert.equal(blocked.status, 409);
  assert.match(blocked.data.error, /selfie/);
});

test('ineligible applicants are auto-rejected with reasons', async () => {
  const token = await login('9000000030');
  await onboard(token, { personal: { pan: 'DDDDD4444D' }, employment: { monthlySalary: 12000, otherMonthlyIncome: 0 } });
  const r = await call('/api/me/loans', { method: 'POST', token, body: { requestedAmount: 5000, tenureDays: 30, consent: true } });
  assert.equal(r.status, 201);
  assert.equal(r.data.status, 'REJECTED');
  assert.ok(r.data.reasons.length > 0);
});

test('unknown API routes return JSON 404', async () => {
  assert.equal((await call('/api/nope')).status, 404);
});

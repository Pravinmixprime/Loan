'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { openDb } = require('../src/db');

const ADMIN = 'test-token';
let server;
let baseUrl;

test.before(async () => {
  const app = createApp({ repo: openDb(':memory:'), adminToken: ADMIN });
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

async function call(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(baseUrl + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

const applicant = {
  fullName: 'Asha Kumar',
  mobile: '9876543210',
  email: 'asha@example.com',
  pan: 'ABCDE1234F',
  dateOfBirth: '1994-02-15',
  employmentType: 'salaried',
  employerName: 'Acme Pvt Ltd',
  monthsInCurrentJob: 24,
  monthlySalary: 22000,
  otherMonthlyIncome: 4000,
  existingEmi: 0,
  requestedAmount: 10000,
  tenureDays: 60,
  consent: true,
};

test('eligibility endpoint validates input', async () => {
  const { status, data } = await call('/api/eligibility', { method: 'POST', body: {} });
  assert.equal(status, 400);
  assert.ok(data.errors.monthlySalary);
  assert.ok(data.errors.dateOfBirth);
});

test('eligibility endpoint returns the eligible amount', async () => {
  const { status, data } = await call('/api/eligibility', { method: 'POST', body: applicant });
  assert.equal(status, 200);
  assert.equal(data.eligible, true);
  assert.equal(data.assessedIncome, 24000);
  assert.equal(data.maxEligibleAmount, 9500); // 24,000 * 0.4 = 9,600
});

test('application validation rejects bad PAN, mobile and missing consent', async () => {
  const { status, data } = await call('/api/applications', {
    method: 'POST',
    body: { ...applicant, pan: 'BAD', mobile: '12345', consent: false },
  });
  assert.equal(status, 400);
  assert.ok(data.errors.pan);
  assert.ok(data.errors.mobile);
  assert.ok(data.errors.consent);
});

test('full application lifecycle', async () => {
  const created = await call('/api/applications', { method: 'POST', body: applicant });
  assert.equal(created.status, 201);
  assert.equal(created.data.status, 'PENDING');
  assert.equal(created.data.approvedAmount, 9500);
  assert.equal(created.data.quote.schedule.length, 2);
  assert.equal(created.data.pan, undefined, 'public view must not expose PAN');
  const id = created.data.id;

  // duplicate active application for the same PAN is blocked
  const dup = await call('/api/applications', { method: 'POST', body: applicant });
  assert.equal(dup.status, 409);
  assert.equal(dup.data.applicationId, id);

  // status lookup requires the matching mobile
  assert.equal((await call(`/api/applications/${id}?mobile=9999999999`)).status, 404);
  const looked = await call(`/api/applications/${id}?mobile=${applicant.mobile}`);
  assert.equal(looked.status, 200);
  assert.equal(looked.data.status, 'PENDING');

  // admin endpoints require the token
  assert.equal((await call('/api/admin/applications')).status, 401);
  assert.equal((await call('/api/admin/applications', { token: 'wrong' })).status, 401);

  const list = await call('/api/admin/applications', { token: ADMIN });
  assert.equal(list.status, 200);
  assert.equal(list.data.applications.length, 1);
  assert.equal(list.data.stats.PENDING.count, 1);

  // invalid transition
  const badClose = await call(`/api/admin/applications/${id}/close`, { method: 'POST', token: ADMIN });
  assert.equal(badClose.status, 409);

  for (const [action, expected] of [['approve', 'APPROVED'], ['disburse', 'DISBURSED'], ['close', 'CLOSED']]) {
    const r = await call(`/api/admin/applications/${id}/${action}`, { method: 'POST', token: ADMIN, body: {} });
    assert.equal(r.status, 200);
    assert.equal(r.data.status, expected);
  }

  // once closed, the applicant can apply again
  const again = await call('/api/applications', { method: 'POST', body: applicant });
  assert.equal(again.status, 201);
});

test('ineligible applications are auto-rejected with reasons', async () => {
  const { status, data } = await call('/api/applications', {
    method: 'POST',
    body: { ...applicant, pan: 'ZZZZZ9999Z', monthlySalary: 12000, otherMonthlyIncome: 0 },
  });
  assert.equal(status, 201);
  assert.equal(data.status, 'REJECTED');
  assert.equal(data.approvedAmount, 0);
  assert.ok(data.reasons.length > 0);
});

test('unknown API routes return JSON 404', async () => {
  const { status } = await call('/api/nope');
  assert.equal(status, 404);
});

'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { POLICY, evaluate } = require('./eligibility');
const { validateProfile, validateApplication } = require('./validation');
const { TRANSITIONS } = require('./db');

const ACTION_TO_STATUS = {
  approve: 'APPROVED',
  reject: 'REJECTED',
  disburse: 'DISBURSED',
  close: 'CLOSED',
};

/** Public view of an application: hides the full PAN and contact details. */
function publicView(app) {
  return {
    id: app.id,
    status: app.status,
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
    fullName: app.fullName,
    requestedAmount: app.requestedAmount,
    approvedAmount: app.approvedAmount,
    tenureDays: app.tenureDays,
    reasons: app.reasons,
    quote: app.quote,
    adminNote: app.adminNote,
  };
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function createApp({ repo, adminToken }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '20kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const requireAdmin = (req, res, next) => {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token || !safeEqual(token, adminToken)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  };

  app.get('/api/policy', (req, res) => {
    res.json(POLICY);
  });

  // Quick eligibility check — nothing is stored.
  app.post('/api/eligibility', (req, res) => {
    const { profile, errors } = validateProfile(req.body || {});
    if (Object.keys(errors).length) return res.status(400).json({ errors });
    res.json(evaluate(profile));
  });

  app.post('/api/applications', (req, res) => {
    const { application, errors } = validateApplication(req.body || {});
    if (Object.keys(errors).length) return res.status(400).json({ errors });

    const existing = repo.findActiveByPan(application.pan);
    if (existing) {
      return res.status(409).json({
        error: 'An active loan application already exists for this PAN.',
        applicationId: existing.id,
      });
    }

    const decision = evaluate(application);
    const saved = repo.create(application, decision);
    res.status(201).json(publicView(saved));
  });

  // Applicants look up their status with the reference ID and their mobile number.
  app.get('/api/applications/:id', (req, res) => {
    const saved = repo.get(req.params.id);
    if (!saved || !safeEqual(saved.mobile, req.query.mobile || '')) {
      return res.status(404).json({ error: 'Application not found' });
    }
    res.json(publicView(saved));
  });

  app.get('/api/admin/applications', requireAdmin, (req, res) => {
    const status = req.query.status ? String(req.query.status).toUpperCase() : undefined;
    if (status && !(status in TRANSITIONS)) {
      return res.status(400).json({ error: 'Unknown status' });
    }
    res.json({ applications: repo.list({ status }), stats: repo.stats() });
  });

  app.post('/api/admin/applications/:id/:action', requireAdmin, (req, res) => {
    const nextStatus = ACTION_TO_STATUS[req.params.action];
    if (!nextStatus) return res.status(400).json({ error: 'Unknown action' });

    const note = req.body && req.body.note ? String(req.body.note).slice(0, 500) : null;
    const result = repo.transition(req.params.id, nextStatus, note);
    if (result.error === 'not_found') return res.status(404).json({ error: 'Application not found' });
    if (result.error) {
      return res
        .status(409)
        .json({ error: `Cannot move application from ${result.from} to ${result.to}` });
    }
    res.json(result.application);
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

module.exports = { createApp };

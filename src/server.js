'use strict';

const { createApp } = require('./app');
const { openDb } = require('./db');
const { createSmsSender } = require('./sms');

const port = Number(process.env.PORT) || 3000;
let adminToken = process.env.ADMIN_TOKEN;
if (!adminToken) {
  adminToken = 'admin123';
  console.warn('ADMIN_TOKEN not set — using the development token "admin123". Set ADMIN_TOKEN in production.');
}

const sms = createSmsSender();
if (sms.demo) {
  console.warn('MSG91_AUTH_KEY / MSG91_TEMPLATE_ID not set — OTPs are shown on screen (demo mode).');
}

// Where customers send EMI payments; shown in the app's "Pay EMI" screen.
const lender = {
  name: process.env.LENDER_NAME || 'QuickCash',
  upiId: process.env.LENDER_UPI_ID || '',
  bankDetails: process.env.LENDER_BANK_DETAILS || '',
  supportPhone: process.env.SUPPORT_PHONE || '',
  supportEmail: process.env.SUPPORT_EMAIL || '',
};

const app = createApp({ repo: openDb(), adminToken, sms, lender });
app.listen(port, () => {
  console.log(`QuickCash running at http://localhost:${port}`);
  console.log(`Customer app: http://localhost:${port}/app  ·  Admin: http://localhost:${port}/admin`);
});

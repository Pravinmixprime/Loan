'use strict';

const { createApp } = require('./app');
const { openDb } = require('./db');

const port = Number(process.env.PORT) || 3000;
let adminToken = process.env.ADMIN_TOKEN;
if (!adminToken) {
  adminToken = 'admin123';
  console.warn('ADMIN_TOKEN not set — using the development token "admin123". Set ADMIN_TOKEN in production.');
}

const app = createApp({ repo: openDb(), adminToken });
app.listen(port, () => {
  console.log(`QuickCash loan app running at http://localhost:${port}`);
  console.log(`Admin panel: http://localhost:${port}/admin.html`);
});

#!/usr/bin/env node
require('dotenv').config();

const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const key = String(process.env.INVENTORY_JOB_SECRET || '').trim();

if (!key) {
  console.error('INVENTORY_JOB_SECRET is required to trigger low-stock summary job.');
  process.exit(1);
}

async function run() {
  const url = `${BASE_URL.replace(/\/$/, '')}/api/jobs/low-stock-summary/run`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-job-secret': key,
    },
    body: JSON.stringify({}),
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`Low-stock job failed (${res.status})`, payload.error || payload);
    process.exit(1);
  }

  const summary = payload?.data?.summary || {};
  console.log(`Low-stock job ok: ${summary.lowStockCount || 0} alert(s) out of ${summary.totalInStockProducts || 0} in-stock products`);
}

run().catch((err) => {
  console.error('Low-stock job trigger failed', err.message || err);
  process.exit(1);
});

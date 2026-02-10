# Render Go-Live Checklist (Vicbest)

Use this as the final pre-launch check on Render.

## 1) Required environment variables

Set these in Render service settings:

- `NODE_ENV=production`
- `PORT` (Render provides this automatically)
- `BASE_URL=https://<your-render-domain>`
- `SQLITE_PATH=/var/data/vicbest.db`
- `SQLITE_BACKUP_DIR=/var/data/backups`
- `SQLITE_BACKUP_KEEP=14` (or your retention target)
- `ADMIN_PASSWORD=<strong-random-password>`
- `ADMIN_TOKEN_SECRET=<long-random-secret>`
- `USER_TOKEN_SECRET=<long-random-secret>`
- `PAYSTACK_SECRET_KEY=<live-or-test-key>`
- `PAYSTACK_PUBLIC_KEY=<live-or-test-key>`
- `PAYSTACK_WEBHOOK_SECRET=<match-paystack-webhook-secret>`
- `INVENTORY_JOB_SECRET=<long-random-secret>`

Optional notifications (recommended):

- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`
- `ADMIN_NOTIFICATION_EMAILS` (comma-separated)
- `STORE_WHATSAPP_NUMBER`

## 2) Persistent disk

- Attach a Render persistent disk.
- Confirm `SQLITE_PATH` and `SQLITE_BACKUP_DIR` both point to disk-backed paths under `/var/data`.
- Restart once after setting vars and verify startup log prints the expected DB path.

## 3) Scheduler / cron

Schedule daily low-stock summary (example 8:00 AM):

- Endpoint: `POST /api/jobs/low-stock-summary/run`
- Auth: header `x-job-secret: <INVENTORY_JOB_SECRET>` (or `?key=`)

If using Render Cron or external scheduler, ensure secret is injected securely.

## 4) Backups

- Manual test once after deploy: run `npm run db:backup`.
- Confirm a new snapshot appears under `/var/data/backups`.
- Verify retention pruning aligns with `SQLITE_BACKUP_KEEP`.
- Add an external backup copy policy (e.g., nightly off-platform sync).

## 5) Smoke checks after deploy

Run this minimum flow:

1. `GET /api/products` returns seeded/catalog data.
2. Admin login works (`/api/admin/login`).
3. Create + update product from admin.
4. Upload one-row CSV via `/api/admin/products/bulk-upload`.
5. Create WhatsApp checkout order.
6. Card checkout initialize returns Paystack auth URL (with valid key).
7. Add admin note + status change on order; timeline updates.
8. Public tracking page works: `/track/<reference>`.
9. Run low-stock summary (`/api/admin/products/low-stock-summary/run`).
10. Run backup (`npm run db:backup`) and verify output file.

## 6) Webhook sanity

- Configure Paystack webhook to: `https://<your-render-domain>/api/paystack/webhook`
- Verify webhook signature secret matches `PAYSTACK_WEBHOOK_SECRET`.
- Confirm paid transactions move order state and write timeline event.

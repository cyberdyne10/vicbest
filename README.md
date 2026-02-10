# Vicbest Store — Phase 3 (Auth + Accounts)

Vicbest Store is a full-stack ecommerce app with storefront/checkout, admin dashboard, and user authentication.

## Stack

- **Node.js + Express**
- **SQLite**
- **Vanilla JS + Tailwind CDN**
- **Paystack**
- **bcrypt** password hashing

## Features

### Storefront + Checkout

- Product catalog (`/api/products`) with seeded cars and groceries
- Cart in browser + optional server sync (`/api/cart/sync`)
- Checkout (`/checkout`) with location-based delivery fees + Paystack initialization
- Delivery zone config seeded in SQLite (`delivery_zones`) with defaults: Lagos Mainland, Lagos Island, Abuja, Outside Coverage
- Delivery quote endpoints: `GET /api/delivery/zones`, `POST /api/delivery/calculate`
- Payment verification (`/api/paystack/verify/:reference`) + webhook (`/api/paystack/webhook`)
- Automated notifications on new orders (customer + admin) with graceful fallback when SMTP is not configured
- Automated customer status-update notifications for `processing`, `delivered`, and `cancelled`
- Threshold-aware low-stock tracking per product (`stock_quantity <= low_stock_threshold`, default threshold = 5)
- Daily low-stock summary endpoint + manual/scheduler run endpoints (cron-ready)
- Notification event logs stored in SQLite (`notification_logs`) and visible in admin UI

### User Accounts (Phase 3)

- Sign up / login / logout
- Password hashing with bcrypt (cost 12)
- Signed auth token stored as **HTTP-only cookie**
- Current user endpoint + profile endpoint
- User-owned orders supported (`orders.user_id`) while preserving guest checkout
- Navbar auth state on storefront/checkout pages

### Admin Dashboard (Phase 2)

- Admin login (`/api/admin/login`)
- Manage products (`/api/admin/products` CRUD)
- Simple admin product form with quick category selector (Cars/Groceries), optional image file upload, and URL fallback
- View/update orders (`/api/admin/orders`, `/api/admin/orders/:id/status`) with quick status buttons + grouped status filters (`new`, `processing`, `delivered`, `cancelled`)
- Order export now includes delivery location, subtotal, delivery fee, and grand total
- View recent notification logs (`/api/admin/notifications/logs`) directly in admin UI
- Bulk product CSV upload in admin with row-by-row success/error report (`/api/admin/products/bulk-upload`)
- Admin coupons (fixed/percent, active windows, optional usage limits)
- Admin order internal notes + timeline events persisted in DB
- Public order tracking page by reference (`/track/:reference`, `GET /api/orders/track/:reference`)

---

## Setup

```bash
npm install
npm start
```

Default URL: `http://localhost:3000`

## Environment Variables

Create `.env` from `.env.example`:

```env
PORT=3000
BASE_URL=http://localhost:3000
SQLITE_PATH=./data/vicbest.db
SQLITE_BACKUP_DIR=./backups
SQLITE_BACKUP_KEEP=14

PAYSTACK_SECRET_KEY=sk_test_REPLACE
PAYSTACK_PUBLIC_KEY=pk_test_REPLACE
PAYSTACK_WEBHOOK_SECRET=sk_test_REPLACE

ADMIN_PASSWORD=replace_with_strong_password
ADMIN_TOKEN_SECRET=replace_with_long_random_string

USER_TOKEN_SECRET=replace_with_another_long_random_string

# Notifications
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=notifications@example.com
SMTP_PASS=replace_with_smtp_password
SMTP_FROM="Vicbest Store <notifications@example.com>"
ADMIN_NOTIFICATION_EMAILS=owner@example.com,ops@example.com
STORE_WHATSAPP_NUMBER=2348091747685
INVENTORY_JOB_SECRET=replace_with_inventory_job_secret
```

> Never commit real secrets.
>
> If SMTP vars are missing, the app does **not** crash. It records notification attempts in `notification_logs` and returns a WhatsApp message-link fallback payload for customer confirmations.

---

## Auth Endpoints

### Register

`POST /api/auth/register`

```json
{ "name": "Jane Doe", "email": "jane@example.com", "password": "strongpass123" }
```

### Login

`POST /api/auth/login`

```json
{ "email": "jane@example.com", "password": "strongpass123" }
```

### Logout

`POST /api/auth/logout`

### Current user (nullable)

`GET /api/auth/me`

### Profile (protected)

`GET /api/profile`

### My orders (protected)

`GET /api/orders/me`

### Product image uploads (admin)

- Upload endpoint: `POST /api/admin/uploads/product-image` (admin auth required)
- Storage path: `public/uploads/`
- Returned URL format: `/uploads/<generated-file-name>`
- Supported formats: JPG, PNG, WEBP, GIF
- Upload limit: **4MB** per image
- Admin can still paste an external image URL instead of uploading

### Inventory automation endpoints

- `GET /api/admin/products/low-stock` — threshold-aware low-stock list for dashboard
- `GET /api/admin/products/low-stock-summary` — current low-stock summary payload
- `POST /api/admin/products/low-stock-summary/run` — manual run + admin email send
- `POST /api/jobs/low-stock-summary/run` — cron/scheduler trigger route (auth via `x-job-secret` header or `?key=`)

### Cron automation (daily low-stock summary)

1. Set `INVENTORY_JOB_SECRET` to a long random value.
2. Use either:
   - `npm run job:low-stock` (uses `BASE_URL` + `INVENTORY_JOB_SECRET` from env)
   - direct HTTP call with `x-job-secret` header.

Example (Linux cron):

```bash
0 8 * * * cd /path/to/vicbest && /usr/bin/env NODE_ENV=production npm run job:low-stock >> logs/low-stock-cron.log 2>&1
```

Optional OpenClaw cron sample:

```bash
# Run daily at 8:00am
openclaw cron create --name vicbest-low-stock --schedule "0 8 * * *" --cwd "C:\Users\edimk\.openclaw\workspace\vicbest" --command "npm run job:low-stock"
```

### Production data safety (SQLite)

- Run backups with: `npm run db:backup`
  - Uses SQLite `VACUUM INTO` for a consistent snapshot.
  - Keeps latest `SQLITE_BACKUP_KEEP` snapshots (default 14).
- Startup safety checks now:
  - logs active DB path on boot
  - warns when `SQLITE_PATH` is missing in production
  - warns when Render appears to use an ephemeral DB path
- Render recommendation:
  - mount a persistent disk and set `SQLITE_PATH=/var/data/vicbest.db`
  - keep backups on persistent storage (`SQLITE_BACKUP_DIR=/var/data/backups`)

---

## Frontend Routes

- `/` storefront
- `/signup` user registration
- `/login` user login
- `/checkout` checkout
- `/checkout/success` payment success page
- `/admin` admin dashboard

---

## Notes on Order Access

- Guest orders still work (no account required)
- If checkout is done while logged in, the order is linked to `user_id`
- `/api/orders/:reference` is restricted for linked orders (owner only)
- Backward compatibility is preserved for older orders without delivery columns (defaults used in admin/export views)

## Deployment guide

- Render go-live checklist: `docs/RENDER-GO-LIVE.md`

## Quick test checklist

- [ ] Admin login works
- [ ] Create/update single product still works
- [ ] Bulk CSV upload creates/updates products and shows per-row report
- [ ] Homepage tabs (All/Cars/Groceries) and chip filters both work
- [ ] Create order (WhatsApp + card init), apply valid coupon, verify totals (subtotal/discount/delivery/grand total)
- [ ] Invalid/expired coupon is rejected
- [ ] Admin can add order note and sees timeline updates for note + status change
- [ ] Public tracking page `/track/:reference` shows status + key details
- [ ] Orders CSV export includes `discount_amount` and `coupon_code`

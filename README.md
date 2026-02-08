# Vicbest Store — Phase 2 Ecommerce + Admin Dashboard

Vicbest Store is now a full-stack ecommerce app with storefront/checkout + an admin dashboard.

## Stack

- **Node.js + Express** (API + server)
- **SQLite** (products, orders, order items, cart snapshots)
- **Vanilla frontend + Tailwind CDN**
- **Paystack** (initialize + verify + webhook)

## Customer Features (unchanged from Phase 1)

- Product catalog API (`/api/products`) with seeded cars + groceries
- Frontend storefront rendering from API
- Cart storage in browser + optional sync (`/api/cart/sync`)
- Checkout flow (`/checkout`) with order persistence
- Paystack initialization (`/api/checkout/initialize`)
- Verification endpoint (`/api/paystack/verify/:reference`)
- Verified webhook endpoint (`/api/paystack/webhook`)
- Success page (`/checkout/success`)

## New Phase 2 Admin Features

- Admin login API (`/api/admin/login`) with env password
- Protected admin product APIs:
  - `GET /api/admin/products`
  - `POST /api/admin/products`
  - `PUT /api/admin/products/:id`
  - `DELETE /api/admin/products/:id`
- Protected admin order APIs:
  - `GET /api/admin/orders?status=`
  - `PATCH /api/admin/orders/:id/status`
- Admin UI page at **`/admin`** to:
  - Create/update/delete products
  - View orders + items
  - Update order status

## Order Status Flow

Supported statuses:

- `pending_payment`
- `paid`
- `processing`
- `delivered`
- `cancelled`

Database migration support adds lifecycle timestamp fields:
- `processing_at`
- `delivered_at`
- `cancelled_at`

## Project Structure

- `server.js` — Express routes (storefront + admin APIs)
- `db.js` — SQLite setup, migrations, seeding
- `public/`
  - `index.html`, `main.js` — storefront
  - `checkout.html`, `checkout.js` — checkout
  - `success.html`, `success.js` — payment confirmation
  - `admin.html`, `admin.js` — admin dashboard
- `.env.example` — environment template

## Setup

```bash
npm install
npm start
```

App default URL: `http://localhost:3000`

## Environment Variables

Create `.env` in the project root:

```env
PORT=3000
BASE_URL=http://localhost:3000

PAYSTACK_SECRET_KEY=sk_test_REPLACE_WITH_YOUR_SECRET_KEY
PAYSTACK_PUBLIC_KEY=pk_test_REPLACE_WITH_YOUR_PUBLIC_KEY
PAYSTACK_WEBHOOK_SECRET=sk_test_REPLACE_WITH_WEBHOOK_SECRET

ADMIN_PASSWORD=replace_with_strong_admin_password
ADMIN_TOKEN_SECRET=replace_with_long_random_string
```

> Never commit real secrets.

## Admin Login & Usage

1. Set `ADMIN_PASSWORD` in `.env`
2. Start app: `npm start`
3. Open: `http://localhost:3000/admin`
4. Enter admin password
5. Manage products/orders from the dashboard

### Admin Auth Notes

- Login returns a signed token (12-hour expiry)
- Admin UI stores token in `localStorage`
- Protected admin routes require `Authorization: Bearer <token>`

## Paystack Webhook Setup

In Paystack dashboard, set webhook URL to:

```text
https://YOUR_DOMAIN/api/paystack/webhook
```

For local testing, expose local server (e.g. ngrok/cloudflared) and update `BASE_URL` accordingly.

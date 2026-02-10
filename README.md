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
- View/update orders (`/api/admin/orders`, `/api/admin/orders/:id/status`)
- Order export now includes delivery location, subtotal, delivery fee, and grand total

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

PAYSTACK_SECRET_KEY=sk_test_REPLACE
PAYSTACK_PUBLIC_KEY=pk_test_REPLACE
PAYSTACK_WEBHOOK_SECRET=sk_test_REPLACE

ADMIN_PASSWORD=replace_with_strong_password
ADMIN_TOKEN_SECRET=replace_with_long_random_string

USER_TOKEN_SECRET=replace_with_another_long_random_string
```

> Never commit real secrets.

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

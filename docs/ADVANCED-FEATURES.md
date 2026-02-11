# Advanced Features (Phase 4+)

This release adds an additive advanced suite while preserving existing flows.

## Included

1. **Dynamic promos**
   - `promo_rules` table + admin APIs
   - `GET/POST /api/admin/promos`
   - `PATCH /api/admin/promos/:id/toggle`
   - Checkout + WhatsApp order flow now apply promo discounts and return promo breakdown fields.

2. **Abandoned cart recovery**
   - Cart snapshots now track optional contact + restore token
   - Restore endpoint: `GET /api/cart/restore/:token`
   - Recovery job endpoint: `POST /api/jobs/abandoned-carts/run` (`x-job-secret`)

3. **Roles + audit logs**
   - `admin_users` table with role support: `super_admin`, `manager`, `inventory_staff`
   - Legacy `ADMIN_PASSWORD` login preserved (backward compatibility)
   - `audit_logs` table + `GET /api/admin/audit-logs`

4. **Advanced analytics**
   - Event sink: `POST /api/analytics/event`
   - Admin analytics: `GET /api/admin/analytics/advanced`

5. **Customer accounts 2.0**
   - `user_addresses`, `loyalty_ledger` tables
   - `GET/POST /api/me/addresses`
   - `POST /api/orders/:id/reorder`
   - `GET /api/me/loyalty`

6. **Returns/refunds workflow**
   - Customer: `POST /api/returns`
   - Admin: `GET /api/admin/returns`, `PATCH /api/admin/returns/:id`
   - Timeline table: `return_request_timeline`

7. **PWA shell**
   - `manifest.webmanifest`
   - `sw.js` with safe network-first + cache fallback
   - `offline.html`

8. **Fraud/risk checks**
   - Risk score is computed during order creation
   - Queue endpoint: `GET /api/admin/orders/risk-queue`
   - Review endpoint: `PATCH /api/admin/orders/:id/review`

9. **Multi-location inventory**
   - `inventory_locations`, `product_inventory`
   - `GET /api/inventory/locations`
   - `GET/POST /api/admin/inventory/:productId`

## Limits / Notes

- Abandoned cart job queues reminder records and restore links; actual channel dispatch can be wired to your email/WhatsApp provider.
- PWA manifest icon points to `/uploads/icon-192.png` (provide a real icon file).
- Existing API routes and checkout/admin flows remain backward compatible.

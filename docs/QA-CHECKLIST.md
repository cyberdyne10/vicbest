# Vicbest Phase 2-5 QA Checklist

Date: 2026-02-10

## End-to-end checks

| Area | Check | Result | Notes |
|---|---|---|---|
| Admin auth | Admin login still works and token persists | PASS | Existing flow unchanged |
| Low-stock summary | Manual run button triggers summary + notification log refresh | PASS | Verified UI + API wiring |
| Cron endpoint security | `/api/jobs/low-stock-summary/run` rejects missing/invalid secret | PASS | Returns 401 |
| Cron script | `npm run job:low-stock` calls scheduler endpoint with header key | PASS | Requires `INVENTORY_JOB_SECRET` |
| Orders filter | Admin orders filtered by `new/processing/delivered/cancelled` | PASS | `new` maps to `pending_payment + paid` |
| Order search | Search by order id, payment ref, customer name/email | PASS | Debounced input, server-side filter |
| Quick status actions | One-click processing/delivered/cancelled buttons work | PASS | Also keeps select fallback |
| Checkout mobile UX | Form spacing, sticky summary on desktop, compact mobile layout | PASS | No API contract changes |
| Checkout friction | Save-info toggle respects off state (clears prefs) | PASS | Behavior now explicit |
| SQLite backup | `npm run db:backup` creates timestamped snapshot | PASS | Uses `VACUUM INTO` |
| Startup checks | Logs DB path + warns on risky production path | PASS | Backward compatible defaults |

## Regression spot checks

- Product CRUD: PASS
- Order export CSV: PASS
- Existing status update API contract: PASS
- Guest checkout + account-linked checkout compatibility: PASS

## Known deferred work

- SMTP provider hardening intentionally deferred per request.

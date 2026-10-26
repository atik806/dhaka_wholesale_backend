# Admin operations

The API and frontend now support staff permissions, activity history, order review, manual courier tracking, SKU inventory, returns/exchanges/refunds, in-app notifications, and sales/profit reports.

## Activate the feature

The migrations have been tested locally. They have **not** been applied to your hosted Supabase database, and neither application has been deployed by this change.

Use a coordinated deployment window: apply the database migrations, deploy the backend, then deploy the frontend. The new database rules require the review workflow before confirming a pending order, so an older frontend cannot confirm pending orders after the migrations are applied.

Apply all previously pending migrations first, then apply these files in filename order using your existing Supabase migration process or the SQL Editor:

1. `supabase/migrations/20261026000000_admin_operations.sql`
2. `supabase/migrations/20261026010000_operations_queries.sql`
3. `supabase/migrations/20261026020000_operations_safeguards.sql`
4. `supabase/migrations/20261026030000_archive_orders.sql`

Each file is transactional. Existing administrators receive an enabled Owner access record. Existing customer accounts do not receive staff permissions. Existing orders receive review records based on their current status. Existing stock becomes the opening balance in the stock ledger.

The earlier `20260720000000_enable_realtime.sql` also contains a corrected publication-existence check for clean database installations. Reapplying that old migration is unnecessary on an installation where it already succeeded.

Set `CRON_SECRET` in the backend hosting environment to a private random value. Vercel's configured daily cron calls `GET /api/internal/operations/reminders` with `Authorization: Bearer <CRON_SECRET>`. On another host, schedule the same authenticated request. Notification reads also catch up overdue reminders, so delayed cron execution does not permanently lose them.

Keep these existing settings: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and your configured CORS origins. No service-role credential belongs in the frontend.

## Staff access

The existing Users page creates login accounts; the Staff page creates directory records. The new **Staff Access** page links them and enables one or more groups:

| Group | Access |
| --- | --- |
| Owner | All features, access management, operation rules, order archiving |
| Orders | Read/review orders, assignment, cancellation, private notes, shipments |
| Inventory | Products/categories/uploads, stock, variants, costs, activity summaries |
| Support | Order lookup, private notes, return handling, reviews/messages/bug reports |
| Finance | Orders, returns, refund approval/completion, financial reports |

Combine groups when a person needs both support and inventory access to inspect and restock returns. Enabling an account requires at least one group. Directory availability is independent of admin access. The last enabled Owner cannot be disabled, removed, or demoted. Changes take effect on subsequent protected API requests; the frontend refreshes its permission state every 30 seconds and after local access changes.

Existing admin endpoints use the same permission guard. Unknown admin routes require Owner access. Private database tables and procurement-cost columns are inaccessible to browser roles; operational data uses the backend API. Products are removed from the public Realtime publication because their rows now contain private costs. The existing polling fallback continues to refresh admin data.

## Daily workflows

### Order review

Open **Order Review**, filter by review status, staff assignment, and order date, then open an order. Record contact attempts, confirm phone/address/stock, and approve. Approval confirms a pending order. Rejecting it requires a reason and cancels it. Pending or confirmed orders can also be cancelled with a reason before dispatch.

Review, shipment, return, and access edits carry a version. Stale submissions return a conflict instead of overwriting someone else's changes. Staff notes are stored separately and never included in customer order responses.

### Delivery

On a confirmed order, save a Preparing shipment with courier and tracking details, then move it forward. A failed delivery can return to In Transit, move to Delivered, or begin Returning. A returned parcel does not automatically restore stock: create a return case, receive it, and inspect it. Actual delivery cost is optional until it is known.

Courier entry is manual. This release does not create courier bookings or ingest provider webhooks.

### Inventory

Use **Inventory** for stock changes, low-stock thresholds, and costs. A stock adjustment requires a reason, the displayed balance, and its inventory version. Cost-only changes also reject stale versions. New products record an opening balance; sales, cancellations, inspected returns, and adjustments record stock movements atomically.

To enable separate stock per SKU, allocate the product's existing quantity across its size/color combinations. Allocation must preserve the total. Complete active orders before allocation. Once allocated, use SKU adjustments; changing the original product option definitions is intentionally blocked. Historical order items keep their original details and unknown historical costs remain unknown.

The product-edit screen no longer changes stock. Checkout deducts variant and aggregate stock in the same database transaction and rejects an oversell. Cancellation credits it back once. A historical return whose item predates SKU allocation requires a deliberate inventory adjustment rather than guessing a variant.

### Returns and refunds

Customers can request item-level returns from delivered orders. Support can also create cases for parcels a courier has returned. The default return window is 14 days; an Owner can override an expired window on a staff-created case.

The workflow is Requested → Under Review → Approved/Rejected → Received → Inspected → Resolved. Restocking happens only at inspection and only for the entered sellable quantity. Partial returns cannot exceed the remaining purchased quantity. Exchanges must link a separate, valid replacement order for the same customer before resolution; replacement checkout reserves its own stock.

Refund cases require a paid order and inspection. Finance approves the amount, pays the customer outside the app, then records the payment method and unique reference. Approval does not send money. Duplicate completion is rejected. Refunds are limited to the returned merchandise's discounted value and the order's remaining refundable merchandise subtotal; shipping/tax refunds are not included in this release. Partial refunds remain visible as refund records while the original payment stays Paid.

### Notifications and activity

Notifications cover new orders, assignments, overdue review, low stock, return requests, and refund work. Read state belongs to each user. Permission and recipient filters apply to the list, count, and read action. Event rows are committed with their business transaction and repeated reminders are deduplicated.

Database triggers record successful changes and their actor/request identity. The API supplies that identity through request-local storage, avoiding cross-request actor leakage. Activity snapshots exclude customer addresses and profile contact details. Owners can inspect snapshots; other staff see summaries. Order timelines link related review, note, shipment, return, and refund events.

The Orders page archives rather than permanently deletes orders. Archiving pending/confirmed orders cancels them and restores stock once; reports, customer history, refunds, and audit records remain intact.

## Report definitions

Report periods use inclusive calendar dates in Asia/Dhaka, converted to an exclusive upper timestamp. Product/category filters select whole orders containing that product/category; all items in those orders are included. Courier filters match the recorded courier name.

- Sales: discounted merchandise subtotal of delivered orders created in the selected period.
- Refunds: completed merchandise refunds to date for those delivered orders.
- Net sales: sales minus those refunds.
- Gross profit: net sales minus historical item cost, with sellable inspected returns removed from cost of goods.
- Contribution: gross profit plus delivery fees charged, minus recorded actual delivery costs.
- Cash collected/refunded: receipts/refund payments whose actual payment timestamps fall in the period. These are separate from the sales cohort.
- Profit is Unknown when relevant historical costs are missing. Contribution is also Unknown when delivery costs are missing.
- Stock valuation is current known-cost stock, independent of the sales period. Missing costs are counted separately.
- Best-selling products show up to 100 product/SKU combinations. CSV exports use the displayed result and escape spreadsheet formulas in text fields.

## Verification

In the backend directory:

```powershell
npm run build
npm test -- --runInBand --silent
npm run test:db
```

The database tests apply every migration to an isolated PGlite PostgreSQL instance, then exercise access control, owner protection, allocation, checkout rollback, review versioning, delivery failures, partial returns/refunds, stock restoration, report calculations, and browser-role restrictions. No hosted database is used.

In the frontend directory:

```powershell
npm run test
npm run build
npm run test:ui
```

Browser tests run the production build on port 3107 with intercepted API fixtures. Chrome is the default; set `PLAYWRIGHT_CHANNEL` to `msedge` when using Edge. They verify forms, request bodies, staff navigation, reports/downloads, and mobile layout. They do not verify your deployed Supabase/PostgREST configuration or a real courier/payment provider.

Before launch, run a staging smoke test using separate Owner, Orders, Inventory, Support, and Finance accounts. Confirm an order, dispatch it, record a failed attempt and successful delivery, collect COD, return one item, inspect/restock it, record a refund, and reconcile the report. Verify that the Support account cannot access inventory costs or approve refunds.

## Recovery

Take a database backup before applying migrations. If an application deployment fails after the migrations, keep the compatible backend/frontend versions available and fix forward. Do not drop operational tables to roll back after they contain stock or refund records. The new review and stock guards deliberately reject older write paths, so reverting application code alone is not a complete rollback.

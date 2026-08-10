# Dhaka Wholesale — API

REST API powering the [Dhaka Wholesale](https://github.com) e-commerce platform. Built with NestJS, TypeScript, and Supabase (PostgreSQL + Auth + Realtime).

The API serves the customer storefront, the authenticated shopping flows (cart, checkout, orders, wishlist, reviews), and the full admin dashboard (products, orders, users, reviews, contact, bug reports).

## Tech Stack

- **NestJS 11** — modular, dependency-injected backend framework
- **TypeScript 5** with Zod for compile-time and runtime validation
- **Supabase** — PostgreSQL database, authentication (JWT), and Realtime for live admin updates
- **Helmet + compression + rate limiting** — production security & performance hardening
- **Swagger** — interactive API docs (enable via `ENABLE_SWAGGER`)

## Features

| Area | Highlights |
| --- | --- |
| **Auth** | Register / login / refresh tokens, profile updates, role-based access control (`customer` / `admin`) |
| **Products** | CRUD, search, multi-category filter, price/rating filters, sort, pagination, featured & related products, admin stock stats |
| **Categories** | Hierarchical categories with `parent_id` support and child-aware filtering |
| **Cart & Wishlist** | Add/remove/update, size & color variants, batch merge on login |
| **Checkout & Orders** | Server-authoritative quoting, stock-availability checks, oversell protection (409), order lifecycle (`pending → confirmed → shipped → delivered / cancelled`), payment status tracking |
| **Admin** | Dashboard stats & revenue trend, order/user/review/contact/bug-report management, user creation & role management |
| **Uploads** | Image uploads validated by MIME magic bytes |
| **Caching** | In-memory response cache with user-scoped keys and explicit invalidation on writes |

## Project Structure

```
src/
├── common/          # Shared guards, pipes, filters, interceptors, decorators, cache
├── config/          # Supabase client configuration
├── modules/
│   ├── admin/       # Dashboard + admin management endpoints
│   ├── auth/        # Authentication & authorization
│   ├── products/    # Catalog, search, filtering, stock stats
│   ├── categories/  # Hierarchical categories
│   ├── cart/        # Shopping cart
│   ├── checkout/    # Quote + order placement
│   ├── orders/      # Order history & status
│   ├── reviews/     # Product reviews
│   ├── wishlist/    # Favorites
│   ├── contact/     # Contact messages
│   ├── reports/     # Bug reports
│   ├── site-settings/ # Site-wide settings
│   └── upload/      # File uploads
└── main.ts          # Application entry point
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full module guide and [API.md](./API.md) for endpoint documentation.

## Getting Started

### Prerequisites

- Node.js 18+
- A Supabase project (free tier is fine)

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Copy the example and fill in your Supabase project details:

```bash
cp .env.example .env
```

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

PORT=5000
CORS_ORIGIN=http://localhost:3000

ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=your-strong-admin-password
```

### 3. Set up the database

Run `supabase-schema.sql` (and then `supabase-migration.sql`) in the Supabase SQL Editor, or apply migrations from `supabase/migrations/`. To load sample data:

```bash
npm run seed
```

### 4. Run the server

```bash
npm run start:dev        # watch mode → http://localhost:5000/api
```

### Scripts

```bash
npm run build            # compile to dist/
npm run start:prod       # run compiled output
npm run lint             # ESLint (auto-fix)
npm run test             # unit tests
npm run test:e2e         # end-to-end tests
npm run seed             # seed sample data
```

## Security

- All admin endpoints are guarded by `AuthGuard` + `RolesGuard` with the `admin` role
- CORS is fail-closed (only explicitly allowed origins)
- User-scoped response cache keys prevent cross-user data leaks
- Search inputs are sanitized to prevent PostgREST operator injection
- Order placement caps quantities and refuses overselling (HTTP 409)
- Uploaded images validated by file magic bytes, not just extension

## Deployment

The API is deployable to Vercel or any Node host.

```bash
npm run build
npm run start:prod
```

Set the production environment variables (see `.env.example`) and make sure the frontend origin is listed in `CORS_ORIGIN`.

## Related

- Frontend: [dhaka-wholesale-frontend](../dhaka-wholesale-frontend)

# Development Setup Guide

## Prerequisites
- Node.js (v18 or higher)
- npm or yarn package manager
- PostgreSQL/Supabase account

## Installation

### 1. Install Dependencies
```bash
npm install
```

### 2. Environment Configuration
Create a `.env` file in the root directory with the following variables:

```env
# Supabase Configuration
SUPABASE_URL=your_supabase_project_url
SUPABASE_ANON_KEY=your_supabase_anonymous_key
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key

# Admin credentials
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=your-strong-admin-password

# Server Configuration
PORT=5000
NODE_ENV=development

# Frontend origin(s) allowed to call the API
CORS_ORIGIN=http://localhost:3000,http://localhost:3001
```

### 3. Database Setup
Run the database schema migration:
```bash
supabase db push < supabase-schema.sql
```

Or run the seed script for initial data:
```bash
npm run seed
```

## Development

### Start Development Server
```bash
npm run start:dev
```

The server will be available at `http://localhost:3000`

### Run Tests
```bash
# Unit tests
npm run test

# E2E tests
npm run test:e2e
```

### Build for Production
```bash
npm run build
```

### Start Production Server
```bash
npm run start:prod
```

## Production Deployment

Use these environment values in production:

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=your-strong-admin-password
PORT=5000
NODE_ENV=production
CORS_ORIGIN=https://yourdomain.com
```

Deploy flow:

```bash
npm run build
npm run start:prod
```

## Project Structure

```
src/
├── common/          # Shared decorators, filters, guards, interceptors, pipes
├── config/          # Application configuration (Supabase, etc.)
├── modules/         # Feature modules (Auth, Products, Cart, Orders, etc.)
└── main.ts          # Application entry point

scripts/
└── seed.ts          # Database seeding utility

test/
└── app.e2e-spec.ts  # E2E tests
```

## Linting & Code Quality
```bash
npm run lint          # Run ESLint
npm run lint:fix      # Fix linting issues
```

## Troubleshooting

### Port Already in Use
If port 3000 is already in use, change the PORT in `.env` file

### Database Connection Issues
- Verify Supabase credentials in `.env`
- Ensure database schema is properly migrated
- Check database network policies allow your IP

### Build Errors
- Clear `node_modules` and reinstall: `rm -rf node_modules && npm install`
- Ensure TypeScript version compatibility

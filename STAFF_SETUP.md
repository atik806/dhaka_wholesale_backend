# Admin staff directory

Administrators manage team directory records at `/admin/staff` in the frontend.
The page supports adding, editing, removing, searching, filtering, and changing
availability, with a mobile card view and ten records per page.

## Database setup

Apply `supabase/migrations/20261021010000_staff_members.sql` to the same Supabase
project used by this backend. For an existing project, open the Supabase SQL
editor, paste the contents of that file, and run it. It depends on the existing
`public.update_updated_at()` and `public.is_admin()` functions from the project's
earlier migrations. The new migration can be replayed safely.

The migration adds `public.staff_members`, a case-insensitive unique email index,
timestamps, and admin-only row-level security. No existing data is changed.
Staff data is accessed through the authenticated backend and refreshed every
30 seconds; it is not added to the realtime publication.

This feature's migration has been prepared locally, not applied to the remote
database. Until it is applied, the page reports a staff loading error.

## Staff records and accounts

A staff record stores name, email, phone, job title, department, profile image
URL, start date, and availability (`active`, `inactive`, or `on_leave`).
It does not create a login or grant permissions. Login accounts are created through Users. The new Staff Access page optionally links a directory record to a login and grants permission groups; see [ADMIN_OPERATIONS.md](./ADMIN_OPERATIONS.md). Marking a directory record
inactive changes availability only; it does not disable any login account.

## API

All routes are under the backend's `/api` prefix and require an authenticated
administrator using the existing session cookies.

| Method | Route | Behavior |
| --- | --- | --- |
| GET | `/admin/staff` | List with `page`, `limit` (maximum 100), `search`, `status`, and `department` |
| POST | `/admin/staff` | Create; requires name, email, job title, department, and start date |
| PATCH | `/admin/staff/:id` | Update supplied fields without resetting other values |
| DELETE | `/admin/staff/:id` | Permanently remove the directory record |

The UI asks for confirmation before removing a record. Email is normalized to
lowercase. Duplicate email, invalid dates, invalid statuses, empty updates, and
non-HTTP image URLs are rejected.

## Verification

Backend tests cover service behavior, request validation, and administrator role
enforcement. Tests use mocked data and do not change the configured database.
Production builds verify the backend and the new frontend route.

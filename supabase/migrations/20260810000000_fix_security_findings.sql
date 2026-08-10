-- ====================================================
-- Security findings remediation (audit v1)
-- ====================================================
-- Supersedes the ad-hoc policies created in `supabase/fix_all.sql`. Depends on
-- the base schema + `20260802000000_harden_rls_and_integrity.sql`. Safe to apply
-- to the live project (idempotent drops; publication changes guarded by a DO
-- block). Backwards compatible with the API: the backend writes through the
-- service-role client, which bypasses RLS, so the stricter policies do not
-- change any backend behavior.
--
-- H1: wishlists are no longer world-readable — owner policies only.
-- H2: the public bug_reports / contact_messages INSERT policies no longer
--     allow anonymous callers to forge status, priority, admin_reply, foreign
--     user_id, or non-http screenshot_url, bypassing the API throttle.
-- H3: (adjacent) harden SECURITY DEFINER is_admin(): fix search_path and fold
--     EXECUTE grants; PUBLIC no longer gets it by default.
-- M4: (adjacent) stop publishing PII tables in realtime and stop emitting
--     full-row WAL for them (REPLICA IDENTITY back to DEFAULT). Realtime is
--     inert in the frontend (httpOnly-cookie sessions can't authenticate the
--     anon subscription), and admin data only ever flows through the backend.

-- ---------------------------------------------------------------------------
-- H1 — wishlists must not be world-readable.
-- ---------------------------------------------------------------------------
-- Owner-scoped policies already exist (initial migration: "Users can
-- view/insert/delete own wishlist"); only the wide-open read needs removing.
DROP POLICY IF EXISTS "Anyone can view wishlists" ON public.wishlists;
-- Replay guard for the policy name used in the base schema.
DROP POLICY IF EXISTS "Wishlists are viewable by owner only" ON public.wishlists;

-- ---------------------------------------------------------------------------
-- H2 — bug_reports: direct PostgREST inserts must start in a benign state.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Anyone can submit bug reports" ON public.bug_reports;
DROP POLICY IF EXISTS "Anyone can insert bug reports" ON public.bug_reports;

CREATE POLICY "Anon can submit bug reports" ON public.bug_reports
  FOR INSERT
  WITH CHECK (
    status = 'pending'
    AND admin_reply IS NULL
    AND (user_id IS NULL OR user_id = auth.uid())
    AND (screenshot_url IS NULL OR screenshot_url ~ '^https?://[^ ]+$')
  );

-- ---------------------------------------------------------------------------
-- H2 — contact_messages: anonymous inserts must start unread.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Anyone can insert contact messages" ON public.contact_messages;
DROP POLICY IF EXISTS "Anyone can submit contact messages" ON public.contact_messages;

CREATE POLICY "Anon can submit contact messages" ON public.contact_messages
  FOR INSERT
  WITH CHECK (is_read = FALSE);

-- ---------------------------------------------------------------------------
-- H3 (adjacent) — SECURITY DEFINER helper hardening.
-- ---------------------------------------------------------------------------
-- Every admin RLS policy's USING expression calls is_admin() on behalf of
-- anon/authenticated, so EXECUTE must stay open to those roles — but no longer
-- to PUBLIC. search_path is pinned to pg_catalog: all identifiers in the body
-- are schema-qualified (public.profiles, auth.uid()), so this gives maximal
-- object-hijack protection without changing behavior.
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'admin'
  );
$$;

REVOKE EXECUTE ON FUNCTION public.is_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_admin() TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- M4 (adjacent) — realtime: stop publishing PII tables.
-- ---------------------------------------------------------------------------
-- products/categories stay in the publication (public catalog data, no PII).
-- The DO block only drops members that are actually present, so it is
-- idempotent and cannot fail on a project where a table was already removed.
ALTER TABLE public.profiles          REPLICA IDENTITY DEFAULT;
ALTER TABLE public.orders            REPLICA IDENTITY DEFAULT;
ALTER TABLE public.order_items       REPLICA IDENTITY DEFAULT;
ALTER TABLE public.reviews           REPLICA IDENTITY DEFAULT;
ALTER TABLE public.bug_reports       REPLICA IDENTITY DEFAULT;
ALTER TABLE public.contact_messages  REPLICA IDENTITY DEFAULT;
ALTER TABLE public.site_settings     REPLICA IDENTITY DEFAULT;

DO $$
DECLARE
  p name := 'supabase_realtime';
  tbl text;
  to_remove text[] := ARRAY[
    'public.profiles', 'public.orders', 'public.order_items',
    'public.reviews', 'public.bug_reports', 'public.contact_messages',
    'public.site_settings'
  ];
BEGIN
  FOREACH tbl IN ARRAY to_remove LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_publication_rel pr
      JOIN pg_publication pub ON pub.oid = pr.prpubid
      JOIN pg_class c ON c.oid = pr.prrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE pub.pubname = p
        AND n.nspname = split_part(tbl, '.', 1)
        AND c.relname = split_part(tbl, '.', 2)
    ) THEN
      EXECUTE format('ALTER PUBLICATION %I DROP TABLE %s', p, tbl::regclass);
    END IF;
  END LOOP;
END $$;
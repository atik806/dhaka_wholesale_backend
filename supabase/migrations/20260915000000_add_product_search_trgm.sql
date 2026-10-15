-- =====================================================
-- Migration: Product Search Trigram Index
-- Fixes an unindexed full-table scan on product search.
--
-- products.service.ts search uses `.ilike('%term%')` on name/description
-- (a leading-wildcard pattern), which a normal btree index cannot serve —
-- it forces a sequential scan on every search request. This index existed
-- only in the legacy root-level `supabase-migration.sql` file and was never
-- applied here.
--
-- MANUAL APPLY NOTE: this file uses plain `CREATE INDEX`, which takes a
-- table-level lock for the duration of the build. On the live production
-- database, apply the two CREATE INDEX statements individually via
-- `CREATE INDEX CONCURRENTLY ...` (run outside a transaction block, e.g.
-- directly in the Supabase SQL editor or psql, one statement at a time) to
-- avoid locking `products` while the index builds.
-- =====================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_products_name_trgm
  ON products USING GIN (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_products_description_trgm
  ON products USING GIN (description gin_trgm_ops);

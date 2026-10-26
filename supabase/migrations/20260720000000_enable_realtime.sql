-- Enable Realtime for all admin-facing tables

-- Ensure the publication exists
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END $$;

-- Helper to add a table to the publication safely
DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY[
    'orders', 'order_items', 'products', 'categories',
    'profiles', 'reviews', 'bug_reports', 'contact_messages', 'site_settings'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = tbl
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE ONLY public.%I', tbl);
    END IF;
  END LOOP;
END $$;

-- Enable replica identity full on tables so old/new records are complete
DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY[
    'orders', 'order_items', 'products', 'categories',
    'profiles', 'reviews', 'bug_reports', 'contact_messages', 'site_settings'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables
  LOOP
    EXECUTE format('ALTER TABLE public.%I REPLICA IDENTITY FULL', tbl);
  END LOOP;
END $$;

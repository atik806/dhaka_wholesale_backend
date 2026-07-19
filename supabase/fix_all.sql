-- ====================================================
-- COMPREHENSIVE FIX: Run ALL of these in Supabase SQL Editor
-- ====================================================

-- FIX 1: Add delivery_zone column to orders (fixes order placement 500 error)
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS delivery_zone TEXT DEFAULT 'inside_dhaka'
  CHECK (delivery_zone IN ('inside_dhaka', 'outside_dhaka'));

-- FIX 2: Fix RLS infinite recursion caused by admin policies
-- that reference profiles table (which itself has RLS)
-- Using SECURITY DEFINER function to bypass RLS when checking admin status

-- Create admin check function that bypasses RLS
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin');
$$;

-- Drop broken policies that cause infinite recursion
DROP POLICY IF EXISTS "Admins can view all profiles" ON public.profiles;
DROP POLICY IF EXISTS "Admins can view all orders" ON public.orders;
DROP POLICY IF EXISTS "Admins can view all order items" ON public.order_items;
DROP POLICY IF EXISTS "Admins can manage bug reports" ON public.bug_reports;
DROP POLICY IF EXISTS "Admins can view contact messages" ON public.contact_messages;
DROP POLICY IF EXISTS "Admins can update site settings" ON public.site_settings;
DROP POLICY IF EXISTS "Admins can insert site settings" ON public.site_settings;
DROP POLICY IF EXISTS "Admins can manage site settings" ON public.site_settings;

-- Recreate policies using the SECURITY DEFINER function
CREATE POLICY "Admins can view all profiles" ON public.profiles
  FOR SELECT USING (public.is_admin());

CREATE POLICY "Admins can view all orders" ON public.orders
  FOR SELECT USING (public.is_admin());

CREATE POLICY "Admins can view all order items" ON public.order_items
  FOR SELECT USING (public.is_admin());

CREATE POLICY "Admins can manage bug reports" ON public.bug_reports
  FOR ALL USING (public.is_admin());

CREATE POLICY "Admins can view contact messages" ON public.contact_messages
  FOR SELECT USING (public.is_admin());

CREATE POLICY "Admins can manage site settings" ON public.site_settings
  FOR ALL USING (public.is_admin());

-- FIX 3: Ensure public read policies exist for unauthenticated users

-- Anyone can view categories
DROP POLICY IF EXISTS "Anyone can view categories" ON public.categories;
CREATE POLICY "Anyone can view categories" ON public.categories
  FOR SELECT USING (true);

-- Anyone can view products
DROP POLICY IF EXISTS "Anyone can view products" ON public.products;
CREATE POLICY "Anyone can view products" ON public.products
  FOR SELECT USING (true);

-- Anyone can view reviews
DROP POLICY IF EXISTS "Anyone can view reviews" ON public.reviews;
CREATE POLICY "Anyone can view reviews" ON public.reviews
  FOR SELECT USING (true);

-- Anyone can view wishlists (used for count/display)
DROP POLICY IF EXISTS "Anyone can view wishlists" ON public.wishlists;
CREATE POLICY "Anyone can view wishlists" ON public.wishlists
  FOR SELECT USING (true);

-- Allow unauthenticated contact form submissions
DROP POLICY IF EXISTS "Anyone can submit contact messages" ON public.contact_messages;
CREATE POLICY "Anyone can submit contact messages" ON public.contact_messages
  FOR INSERT WITH CHECK (true);

-- Allow unauthenticated bug reports
DROP POLICY IF EXISTS "Anyone can submit bug reports" ON public.bug_reports;
CREATE POLICY "Anyone can submit bug reports" ON public.bug_reports
  FOR INSERT WITH CHECK (true);

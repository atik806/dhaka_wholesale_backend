-- =====================================================
-- FIX 6: Add delivery_zone column to orders table
-- for Inside Dhaka (80) / Outside Dhaka (120) pricing
-- =====================================================
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS delivery_zone TEXT DEFAULT 'inside_dhaka'
  CHECK (delivery_zone IN ('inside_dhaka', 'outside_dhaka'));

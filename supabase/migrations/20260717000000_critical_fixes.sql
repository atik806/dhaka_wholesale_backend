-- =====================================================
-- FIX 1: orders.user_id — prevent cascade delete of order history
-- =====================================================
ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_user_id_fkey,
  ADD CONSTRAINT orders_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE SET NULL;

-- =====================================================
-- FIX 2: order_items.product_id — prevent corrupting order history
-- =====================================================
ALTER TABLE order_items
  DROP CONSTRAINT IF EXISTS order_items_product_id_fkey,
  ADD CONSTRAINT order_items_product_id_fkey
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT;

-- =====================================================
-- FIX 3: Add integer stock quantity column
-- (so we can actually track inventory)
-- =====================================================
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS stock_quantity INTEGER DEFAULT 0;

-- Seed from existing text-based stock field
UPDATE products
  SET stock_quantity = CASE
    WHEN stock = 'out-of-stock' THEN 0
    WHEN stock = 'low-stock' THEN 3
    ELSE 25
  END
  WHERE stock_quantity = 0 AND stock IS NOT NULL;

-- =====================================================
-- FIX 4: Decrement stock on order creation
-- =====================================================
CREATE OR REPLACE FUNCTION decrement_stock_on_order()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE products
  SET stock_quantity = stock_quantity - NEW.quantity,
      stock = CASE
        WHEN stock_quantity - NEW.quantity <= 0 THEN 'out-of-stock'
        WHEN stock_quantity - NEW.quantity <= 5 THEN 'low-stock'
        ELSE 'in-stock'
      END
  WHERE id = NEW.product_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS decrement_stock ON order_items;
CREATE TRIGGER decrement_stock
  AFTER INSERT ON order_items
  FOR EACH ROW EXECUTE FUNCTION decrement_stock_on_order();

-- =====================================================
-- FIX 5: Ensure site_settings table + policies exist
-- =====================================================
CREATE TABLE IF NOT EXISTS site_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE site_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can read site settings" ON site_settings;
CREATE POLICY "Anyone can read site settings" ON site_settings
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "Admins can manage site settings" ON site_settings;
CREATE POLICY "Admins can manage site settings" ON site_settings
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  );

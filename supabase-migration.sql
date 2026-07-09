-- CholoKini Database Migration: Security & Data Integrity Fixes
-- Run this after the initial supabase-schema.sql

-- 1. Fix ON DELETE CASCADE on orders.user_id
ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_user_id_fkey,
  ADD CONSTRAINT orders_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;

-- 2. Fix ON DELETE CASCADE on reviews.user_id
ALTER TABLE reviews
  DROP CONSTRAINT IF EXISTS reviews_user_id_fkey,
  ADD CONSTRAINT reviews_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;

-- 3. Add missing indexes for performance
CREATE INDEX IF NOT EXISTS idx_products_category_id ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_slug ON products(slug);
CREATE INDEX IF NOT EXISTS idx_products_is_featured ON products(is_featured);
CREATE INDEX IF NOT EXISTS idx_cart_items_user_id ON cart_items(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_product_id ON order_items(product_id);
CREATE INDEX IF NOT EXISTS idx_reviews_product_id ON reviews(product_id);
CREATE INDEX IF NOT EXISTS idx_wishlists_user_id ON wishlists(user_id);

-- 4. Add INSERT/UPDATE/DELETE RLS policies for order_items
CREATE POLICY IF NOT EXISTS "Users can insert own order items" ON order_items
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM orders WHERE orders.id = order_items.order_id AND orders.user_id = auth.uid())
  );

-- 5. Auto-update product rating via trigger
CREATE OR REPLACE FUNCTION recalc_product_rating()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE products SET
      rating = COALESCE((SELECT ROUND(AVG(rating)::numeric, 1) FROM reviews WHERE product_id = OLD.product_id), 0),
      review_count = (SELECT COUNT(*) FROM reviews WHERE product_id = OLD.product_id)
    WHERE id = OLD.product_id;
    RETURN OLD;
  ELSE
    UPDATE products SET
      rating = COALESCE((SELECT ROUND(AVG(rating)::numeric, 1) FROM reviews WHERE product_id = NEW.product_id), 0),
      review_count = (SELECT COUNT(*) FROM reviews WHERE product_id = NEW.product_id)
    WHERE id = NEW.product_id;
    RETURN NEW;
  END IF;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS review_rating_update ON reviews;
CREATE TRIGGER review_rating_update
  AFTER INSERT OR UPDATE OR DELETE ON reviews
  FOR EACH ROW EXECUTE FUNCTION recalc_product_rating();

-- 6. Contact messages table
CREATE TABLE IF NOT EXISTS contact_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE contact_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can insert contact messages" ON contact_messages
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Admin can view contact messages" ON contact_messages
  FOR SELECT USING (auth.role() = 'service_role');

-- 7. Denormalized product_count on categories via trigger
CREATE OR REPLACE FUNCTION update_category_product_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE categories SET product_count = (SELECT COUNT(*) FROM products WHERE category_id = OLD.category_id)
    WHERE id = OLD.category_id;
    RETURN OLD;
  ELSE
    UPDATE categories SET product_count = (SELECT COUNT(*) FROM products WHERE category_id = NEW.category_id)
    WHERE id = NEW.category_id;
    RETURN NEW;
  END IF;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS product_count_update ON products;
CREATE TRIGGER product_count_update
  AFTER INSERT OR UPDATE OR DELETE ON products
  FOR EACH ROW EXECUTE FUNCTION update_category_product_count();

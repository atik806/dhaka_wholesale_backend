-- Dhaka Wholesale Database Migration: Security & Data Integrity Fixes
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

-- 4. Add INSERT RLS policy for order_items
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can insert own order items' AND tablename = 'order_items') THEN
    CREATE POLICY "Users can insert own order items" ON order_items
      FOR INSERT WITH CHECK (
        EXISTS (SELECT 1 FROM orders WHERE orders.id = order_items.order_id AND orders.user_id = auth.uid())
      );
  END IF;
END $$;

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

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Anyone can insert contact messages' AND tablename = 'contact_messages') THEN
    CREATE POLICY "Anyone can insert contact messages" ON contact_messages
      FOR INSERT WITH CHECK (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Admin can view contact messages' AND tablename = 'contact_messages') THEN
    CREATE POLICY "Admin can view contact messages" ON contact_messages
      FOR SELECT USING (auth.role() = 'service_role');
  END IF;
END $$;

-- 7. Add ON DELETE actions for missing foreign keys
ALTER TABLE products
  DROP CONSTRAINT IF EXISTS products_category_id_fkey,
  ADD CONSTRAINT products_category_id_fkey
    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE RESTRICT;

ALTER TABLE cart_items
  DROP CONSTRAINT IF EXISTS cart_items_product_id_fkey,
  ADD CONSTRAINT cart_items_product_id_fkey
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE;

ALTER TABLE order_items
  DROP CONSTRAINT IF EXISTS order_items_product_id_fkey,
  ADD CONSTRAINT order_items_product_id_fkey
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL;

-- 8. Add parent_id to categories for hierarchical support
ALTER TABLE categories
  ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES categories(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_categories_parent_id ON categories(parent_id);

-- Function to get all child category IDs (recursive) for a given parent
CREATE OR REPLACE FUNCTION get_child_category_ids(p_parent_id UUID)
RETURNS UUID[] AS $$
DECLARE
  result UUID[];
BEGIN
  WITH RECURSIVE cat_tree AS (
    SELECT id FROM categories WHERE parent_id = p_parent_id
    UNION ALL
    SELECT c.id FROM categories c INNER JOIN cat_tree ct ON c.parent_id = ct.id
  )
  SELECT array_agg(id) INTO result FROM cat_tree;
  RETURN COALESCE(result, ARRAY[]::UUID[]);
END;
$$ LANGUAGE plpgsql;

-- 9. Additional performance indexes
CREATE INDEX IF NOT EXISTS idx_products_created_at ON products(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_products_rating ON products(rating DESC);
CREATE INDEX IF NOT EXISTS idx_products_review_count ON products(review_count DESC);
CREATE INDEX IF NOT EXISTS idx_contact_messages_created_at ON contact_messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cart_items_product_id ON cart_items(product_id);
CREATE INDEX IF NOT EXISTS idx_orders_payment_status ON orders(payment_status);
CREATE INDEX IF NOT EXISTS idx_reviews_user_id ON reviews(user_id);
CREATE INDEX IF NOT EXISTS idx_products_price ON products(price);
CREATE INDEX IF NOT EXISTS idx_products_stock ON products(stock);
CREATE INDEX IF NOT EXISTS idx_products_is_featured ON products(is_featured);
CREATE INDEX IF NOT EXISTS idx_contact_messages_is_read ON contact_messages(is_read);

-- 9. Denormalized product_count on categories via trigger (fixed)
CREATE OR REPLACE FUNCTION update_category_product_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE categories SET product_count = (SELECT COUNT(*) FROM products WHERE category_id = OLD.category_id)
    WHERE id = OLD.category_id;
    RETURN OLD;
  ELSIF TG_OP = 'UPDATE' AND (OLD.category_id IS DISTINCT FROM NEW.category_id) THEN
    UPDATE categories SET product_count = (SELECT COUNT(*) FROM products WHERE category_id = OLD.category_id)
    WHERE id = OLD.category_id;
    UPDATE categories SET product_count = (SELECT COUNT(*) FROM products WHERE category_id = NEW.category_id)
    WHERE id = NEW.category_id;
    RETURN NEW;
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

-- 10. Composite indexes for common query patterns (fixes N+1 / slow lookups)
CREATE INDEX IF NOT EXISTS idx_categories_slug ON categories(slug);
CREATE INDEX IF NOT EXISTS idx_cart_items_user_product ON cart_items(user_id, product_id);
CREATE INDEX IF NOT EXISTS idx_wishlists_user_product ON wishlists(user_id, product_id);
CREATE INDEX IF NOT EXISTS idx_reviews_product_created ON reviews(product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_products_category_rating ON products(category_id, rating DESC);

-- 11. Fast ILIKE search (leading-wildcard %term% currently forces a full scan)
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_products_name_trgm ON products USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_products_description_trgm ON products USING GIN (description gin_trgm_ops);

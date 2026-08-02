-- =====================================================
-- Security & integrity hardening (2026-08-02)
--
-- Closes three RLS privilege-escalation / data-integrity
-- holes and one account-deletion blocker:
--   1. profiles: users could self-upgrade role -> 'admin'
--   2. orders/order_items: users could forge paid/delivered
--      orders and insert negative quantities (inventory fraud)
--   3. order_items.quantity had no positive CHECK; the stock
--      trigger trusted a negative NEW.quantity
--   4. orders.user_id FK was ON DELETE SET NULL on a NOT NULL
--      column, making account deletion impossible for users
--      with order history
--
-- The backend talks to these tables with the service role,
-- which bypasses RLS, so the application is unaffected.
-- =====================================================

-- -----------------------------------------------------
-- 1. profiles: prevent role escalation
-- -----------------------------------------------------
DROP POLICY IF EXISTS "Users can update own profile" ON profiles;
CREATE POLICY "Users can update own profile" ON profiles
  FOR UPDATE USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id AND role = 'customer');

DROP POLICY IF EXISTS "Users can insert own profile" ON profiles;
CREATE POLICY "Users can insert own profile" ON profiles
  FOR INSERT WITH CHECK (auth.uid() = id AND role = 'customer');

-- Defense in depth: even a future policy mistake must not let
-- a client key write the role column.
REVOKE UPDATE (role) ON public.profiles FROM authenticated;

-- NOTE: audit any pre-existing rows that a user may have already
-- flipped to 'admin'. The real admin account is created by the
-- backend (ADMIN_EMAIL) via the service role. Re-apply admin to
-- that account if it was caught in the sweep below:
--   UPDATE profiles SET role = 'admin' WHERE email = '<ADMIN_EMAIL>';

-- -----------------------------------------------------
-- 2. orders / order_items: client writes disabled.
--    Orders are only ever created/updated by the backend
--    (service role). Users keep read access to their own.
-- -----------------------------------------------------
DROP POLICY IF EXISTS "Users can insert own orders" ON orders;
DROP POLICY IF EXISTS "Users can update own orders" ON orders;

REVOKE INSERT, UPDATE ON public.orders FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.order_items FROM authenticated;

-- -----------------------------------------------------
-- 3. order_items: enforce positive quantity & non-negative
--    price regardless of write path.
-- -----------------------------------------------------
ALTER TABLE order_items
  DROP CONSTRAINT IF EXISTS order_items_quantity_positive;
ALTER TABLE order_items
  ADD CONSTRAINT order_items_quantity_positive CHECK (quantity > 0);

ALTER TABLE order_items
  DROP CONSTRAINT IF EXISTS order_items_price_non_negative;
ALTER TABLE order_items
  ADD CONSTRAINT order_items_price_non_negative CHECK (price >= 0);

-- Harden the stock trigger so a negative/huge quantity can
-- never inflate or corrupt inventory (defense in depth).
CREATE OR REPLACE FUNCTION decrement_stock_on_order()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.quantity <= 0 THEN
    RAISE EXCEPTION 'Invalid order quantity %', NEW.quantity
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE products
  SET stock_quantity = stock_quantity - NEW.quantity
  WHERE id = NEW.product_id
    AND stock_quantity >= NEW.quantity;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Insufficient stock for product %', NEW.product_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS decrement_stock ON order_items;
CREATE TRIGGER decrement_stock
  AFTER INSERT ON order_items
  FOR EACH ROW EXECUTE FUNCTION decrement_stock_on_order();

-- -----------------------------------------------------
-- 4. Account deletion: orders cascade with the user so a
--    NOT NULL FK never aborts auth user deletion.
-- -----------------------------------------------------
ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_user_id_fkey,
  ADD CONSTRAINT orders_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;

-- -----------------------------------------------------
-- 5. Orders: totals must never be negative.
-- -----------------------------------------------------
ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_amounts_non_negative;
ALTER TABLE orders
  ADD CONSTRAINT orders_amounts_non_negative
  CHECK (subtotal >= 0 AND shipping_cost >= 0 AND tax >= 0 AND total >= 0);

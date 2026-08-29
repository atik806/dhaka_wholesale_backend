-- =====================================================================
-- Pending DB changes for the hosted Supabase project.
--
-- The app does NOT run migrations on deploy (Vercel only builds the code),
-- and production still shows symptoms of an un-applied inventory migration
-- (products with stock_quantity = 0 / -1 while the `stock` enum says
-- "in-stock", which broke add-to-cart and checkout before the app-side
-- `availableStock()` fallback landed).
--
-- Paste this whole file into the Supabase SQL editor (Dashboard -> SQL) and
-- run it once. Everything here is idempotent.
--
-- Covers:
--   1. supabase/migrations/20260725000000_inventory_stock_guards.sql
--   2. supabase/migrations/20260829000000_order_status_stock_integrity.sql
--   3. a one-time reconciliation of stock_quantity from the `stock` enum
-- =====================================================================

-- ---------- 1. Inventory guards ----------------------------------------

UPDATE products SET stock_quantity = 0 WHERE stock_quantity < 0;

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_stock_quantity_non_negative;
ALTER TABLE products
  ADD CONSTRAINT products_stock_quantity_non_negative CHECK (stock_quantity >= 0);

CREATE OR REPLACE FUNCTION sync_product_stock_status()
RETURNS TRIGGER AS $$
BEGIN
  NEW.stock := CASE
    WHEN COALESCE(NEW.stock_quantity, 0) <= 0 THEN 'out-of-stock'
    WHEN NEW.stock_quantity <= 5 THEN 'low-stock'
    ELSE 'in-stock'
  END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sync_product_stock_status ON products;
CREATE TRIGGER sync_product_stock_status
  BEFORE INSERT OR UPDATE OF stock_quantity ON products
  FOR EACH ROW EXECUTE FUNCTION sync_product_stock_status();

CREATE OR REPLACE FUNCTION decrement_stock_on_order()
RETURNS TRIGGER AS $$
BEGIN
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

CREATE OR REPLACE FUNCTION restock_on_order_cancel()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled' THEN
    UPDATE products p
    SET stock_quantity = p.stock_quantity + oi.quantity
    FROM order_items oi
    WHERE oi.order_id = NEW.id
      AND p.id = oi.product_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS restock_on_cancel ON orders;
CREATE TRIGGER restock_on_cancel
  AFTER UPDATE OF status ON orders
  FOR EACH ROW EXECUTE FUNCTION restock_on_order_cancel();

-- ---------- 2. Order-status / stock integrity -------------------------

CREATE OR REPLACE FUNCTION forbid_cancelled_order_reactivation()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'cancelled' AND NEW.status IS DISTINCT FROM 'cancelled' THEN
    RAISE EXCEPTION
      'A cancelled order cannot be reactivated (order %). Create a new order instead.',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS forbid_cancelled_reactivation ON orders;
CREATE TRIGGER forbid_cancelled_reactivation
  BEFORE UPDATE OF status ON orders
  FOR EACH ROW EXECUTE FUNCTION forbid_cancelled_order_reactivation();

-- ---------- 3. Reconcile stock_quantity from the `stock` enum ---------
-- The admin product form only edits the enum, so treat it as the source of
-- truth and top the counter back up wherever it has drained below what the
-- enum implies. Products the admin has genuinely marked out-of-stock go to 0.

UPDATE products SET stock_quantity = 25
  WHERE stock = 'in-stock'  AND (stock_quantity IS NULL OR stock_quantity <= 0);
UPDATE products SET stock_quantity = 3
  WHERE stock = 'low-stock' AND (stock_quantity IS NULL OR stock_quantity <= 0);
UPDATE products SET stock_quantity = 0
  WHERE stock = 'out-of-stock' AND stock_quantity <> 0;

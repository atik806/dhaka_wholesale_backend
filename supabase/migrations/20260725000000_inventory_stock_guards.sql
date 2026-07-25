-- =====================================================
-- Inventory guards: non-negative stock, sync enum from
-- quantity, reject oversell on order_items insert, restock
-- when an order is cancelled.
-- =====================================================

-- Clamp any existing negatives before adding the constraint
UPDATE products
SET stock_quantity = 0
WHERE stock_quantity < 0;

ALTER TABLE products
  DROP CONSTRAINT IF EXISTS products_stock_quantity_non_negative;

ALTER TABLE products
  ADD CONSTRAINT products_stock_quantity_non_negative
  CHECK (stock_quantity >= 0);

-- Keep text `stock` enum derived from stock_quantity
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

-- Atomic decrement that fails the order_items insert on oversell
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

-- Restock inventory when an order transitions to cancelled
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

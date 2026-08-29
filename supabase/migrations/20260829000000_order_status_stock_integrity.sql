-- =====================================================
-- Order-status / inventory integrity.
--
-- The stock model decrements once on order_items INSERT and credits back once
-- via `restock_on_cancel` when an order moves to 'cancelled'. Nothing ever
-- re-decrements, so any path that leaves a cancelled order's units credited
-- while the order is active again corrupts inventory:
--   * cancelled -> pending -> cancelled  => units credited twice
--   * cancelled -> confirmed             => active order, stock already gone
--
-- The application layer now rejects this transition, but enforce it in the DB
-- too so a direct SQL / service-role write cannot bypass it.
-- =====================================================

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

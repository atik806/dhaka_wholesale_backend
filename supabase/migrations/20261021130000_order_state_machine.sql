-- =====================================================
-- Order and payment state machine (2026-10-21)
--
-- Enforces in the database the transitions the backend allows
-- (src/modules/orders/order-state.ts), so a direct or racing write cannot
-- cancel shipped goods (which would restock them), move an order
-- backwards, or mark cash collected for an order that never shipped.
--
--   status:  pending -> confirmed -> shipped -> delivered (forward only,
--            steps may be skipped); pending|confirmed -> cancelled;
--            delivered and cancelled are final.
--   payment: pending -> paid|failed; failed -> pending|paid;
--            paid -> refunded; paid requires status shipped|delivered.
--
-- paid_at / paid_by record when and by whom COD cash was marked collected.
--
-- Supersedes forbid_cancelled_order_reactivation (20260829), which is kept
-- because it is harmless and may be the only guard on databases where this
-- migration is not yet applied.
--
-- Depends on: orders (20260701), profiles (20260701).
-- Deploy order: apply BEFORE the backend that writes paid_at/paid_by.
-- Rollback: DROP TRIGGER enforce_order_transitions ON orders; the columns
--   are nullable and can stay.
-- =====================================================

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS paid_by UUID REFERENCES profiles(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION enforce_order_transitions()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  flow CONSTANT TEXT[] := ARRAY['pending', 'confirmed', 'shipped', 'delivered'];
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'cancelled' THEN
      IF OLD.status NOT IN ('pending', 'confirmed') THEN
        RAISE EXCEPTION 'Order % cannot be cancelled from status %', OLD.id, OLD.status
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NOT (
      OLD.status = ANY (flow) AND NEW.status = ANY (flow)
      AND array_position(flow, NEW.status) > array_position(flow, OLD.status)
    ) THEN
      RAISE EXCEPTION 'Order % cannot move from % to %', OLD.id, OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.payment_status IS DISTINCT FROM OLD.payment_status THEN
    IF NOT (
      (OLD.payment_status = 'pending' AND NEW.payment_status IN ('paid', 'failed'))
      OR (OLD.payment_status = 'failed' AND NEW.payment_status IN ('pending', 'paid'))
      OR (OLD.payment_status = 'paid' AND NEW.payment_status = 'refunded')
    ) THEN
      RAISE EXCEPTION 'Order % payment cannot move from % to %',
        OLD.id, OLD.payment_status, NEW.payment_status
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.payment_status = 'paid' THEN
      IF NEW.status NOT IN ('shipped', 'delivered') THEN
        RAISE EXCEPTION 'Order % cannot be marked paid while %', OLD.id, NEW.status
          USING ERRCODE = 'check_violation';
      END IF;
      NEW.paid_at := COALESCE(NEW.paid_at, now());
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_order_transitions ON orders;
CREATE TRIGGER enforce_order_transitions
  BEFORE UPDATE OF status, payment_status ON orders
  FOR EACH ROW EXECUTE FUNCTION enforce_order_transitions();

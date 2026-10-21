-- =====================================================
-- Transactional, idempotent checkout (2026-10-21)
--
-- place_order() writes the order header and its items in ONE transaction.
-- The order_items insert fires decrement_stock (20260802), so a stock
-- failure now rolls back the header too: no half-created order, no leaked
-- stock, and no application-side "delete the order" cleanup.
--
-- A client-supplied idempotency key, unique per user, makes retries safe:
-- the same key with the same request returns the original order; the same
-- key with a different request is rejected.
--
-- The order also keeps its pricing snapshot (combo/coupon discounts) so
-- receipts, admin views and coupon accounting can explain the total.
--
-- Depends on: orders/order_items (20260701), delivery_zone (20260718),
--   decrement_stock trigger (20260802).
-- Deploy order: apply BEFORE deploying the backend that calls
--   place_order(). The frontend can deploy any time after the backend.
-- Rollback: forward-fix. New columns are nullable or defaulted and ignored
--   by older code, so rolling the backend back is safe. Drop place_order()
--   only after the backend is rolled back.
-- =====================================================

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS request_hash TEXT,
  ADD COLUMN IF NOT EXISTS original_subtotal DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS combo_discount DECIMAL(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS coupon_discount DECIMAL(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_total DECIMAL(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS coupon_code TEXT,
  ADD COLUMN IF NOT EXISTS applied_combos JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Unit price after flash sales but before combo/coupon allocation.
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS original_price DECIMAL(10,2);

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_idempotency_key_format;
ALTER TABLE orders ADD CONSTRAINT orders_idempotency_key_format
  CHECK (idempotency_key IS NULL OR idempotency_key ~ '^[A-Za-z0-9_-]{16,100}$');

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_discounts_non_negative;
ALTER TABLE orders ADD CONSTRAINT orders_discounts_non_negative
  CHECK (
    combo_discount >= 0 AND coupon_discount >= 0 AND discount_total >= 0
    AND (original_subtotal IS NULL OR original_subtotal >= 0)
  );

-- Stored totals must reconcile. NOT VALID: enforced for new and updated
-- rows without re-checking historical orders.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_totals_reconcile;
ALTER TABLE orders ADD CONSTRAINT orders_totals_reconcile
  CHECK (
    total = subtotal + shipping_cost + tax
    AND (original_subtotal IS NULL OR original_subtotal - discount_total = subtotal)
    AND discount_total = combo_discount + coupon_discount
  ) NOT VALID;

CREATE UNIQUE INDEX IF NOT EXISTS orders_user_idempotency_key
  ON orders (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE OR REPLACE FUNCTION public.place_order(
  p_user_id UUID,
  p_idempotency_key TEXT,
  p_request_hash TEXT,
  p_order JSONB,
  p_items JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order_id UUID;
  v_existing_id UUID;
  v_existing_hash TEXT;
BEGIN
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Order must contain at least one item'
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO orders (
    user_id, status, payment_status,
    subtotal, shipping_cost, tax, total,
    shipping_address, payment_method, delivery_zone,
    original_subtotal, combo_discount, coupon_discount, discount_total,
    coupon_code, applied_combos,
    idempotency_key, request_hash
  ) VALUES (
    p_user_id, 'pending', 'pending',
    (p_order->>'subtotal')::numeric,
    (p_order->>'shipping_cost')::numeric,
    (p_order->>'tax')::numeric,
    (p_order->>'total')::numeric,
    p_order->'shipping_address',
    p_order->>'payment_method',
    p_order->>'delivery_zone',
    (p_order->>'original_subtotal')::numeric,
    COALESCE((p_order->>'combo_discount')::numeric, 0),
    COALESCE((p_order->>'coupon_discount')::numeric, 0),
    COALESCE((p_order->>'discount_total')::numeric, 0),
    p_order->>'coupon_code',
    COALESCE(p_order->'applied_combos', '[]'::jsonb),
    p_idempotency_key,
    p_request_hash
  )
  -- A concurrent request with the same key waits here for the first to
  -- commit or roll back, then either replays its order or inserts.
  ON CONFLICT (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL
  DO NOTHING
  RETURNING id INTO v_order_id;

  IF v_order_id IS NULL THEN
    SELECT id, request_hash INTO v_existing_id, v_existing_hash
    FROM orders
    WHERE user_id = p_user_id AND idempotency_key = p_idempotency_key;

    IF v_existing_hash IS DISTINCT FROM p_request_hash THEN
      RAISE EXCEPTION 'idempotency_key_reused'
        USING ERRCODE = 'unique_violation';
    END IF;
    RETURN jsonb_build_object('order_id', v_existing_id, 'replayed', true);
  END IF;

  -- decrement_stock fires per row; insufficient stock aborts everything.
  INSERT INTO order_items (
    order_id, product_id, product_name, product_image,
    price, original_price, quantity, selected_size, selected_color
  )
  SELECT
    v_order_id, i.product_id, i.product_name, i.product_image,
    i.price, i.original_price, i.quantity, i.selected_size, i.selected_color
  FROM jsonb_to_recordset(p_items) AS i(
    product_id UUID,
    product_name TEXT,
    product_image TEXT,
    price NUMERIC,
    original_price NUMERIC,
    quantity INTEGER,
    selected_size TEXT,
    selected_color TEXT
  );

  RETURN jsonb_build_object('order_id', v_order_id, 'replayed', false);
END;
$$;

-- Only the backend (service role) may place orders; it supplies p_user_id
-- from the authenticated session.
REVOKE ALL ON FUNCTION public.place_order(UUID, TEXT, TEXT, JSONB, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.place_order(UUID, TEXT, TEXT, JSONB, JSONB)
  TO service_role;

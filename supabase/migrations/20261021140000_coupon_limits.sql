-- =====================================================
-- Coupon usage limits (2026-10-21)
--
-- Coupons could be reused without limit. A coupon may now carry
-- max_redemptions (total) and per_customer_limit; both live in the coupon's
-- site_settings JSON and are passed to place_order() by the backend in
-- p_order.coupon_max_redemptions / p_order.coupon_per_customer_limit.
--
-- A redemption is an order with that coupon_code (stored by 20261021120000)
-- that is not cancelled, so cancelling an order frees its redemption.
-- place_order() takes a per-coupon advisory lock before counting, so
-- concurrent checkouts cannot both take the last redemption.
--
-- Depends on: 20261021120000_transactional_checkout (place_order, coupon_code).
-- Deploy order: apply BEFORE the backend that sends coupon limits. The
--   backend from 20261021120000 keeps working (it sends no limits).
-- Rollback: re-run the place_order definition from 20261021120000.
-- =====================================================

CREATE INDEX IF NOT EXISTS orders_coupon_code_active
  ON orders (coupon_code, user_id)
  WHERE coupon_code IS NOT NULL AND status <> 'cancelled';

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
  v_coupon TEXT := p_order->>'coupon_code';
  v_max INTEGER := (p_order->>'coupon_max_redemptions')::integer;
  v_per_customer INTEGER := (p_order->>'coupon_per_customer_limit')::integer;
  v_used INTEGER;
BEGIN
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Order must contain at least one item'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Serialise checkouts that use the same limited coupon until commit.
  IF v_coupon IS NOT NULL AND (v_max IS NOT NULL OR v_per_customer IS NOT NULL) THEN
    PERFORM pg_advisory_xact_lock(hashtext('place_order:coupon:' || v_coupon));
  END IF;

  -- A retry of an order that already exists is replayed before any limit
  -- check: its own redemption must not count against it.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id, request_hash INTO v_existing_id, v_existing_hash
    FROM orders
    WHERE user_id = p_user_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
      IF v_existing_hash IS DISTINCT FROM p_request_hash THEN
        RAISE EXCEPTION 'idempotency_key_reused'
          USING ERRCODE = 'unique_violation';
      END IF;
      RETURN jsonb_build_object('order_id', v_existing_id, 'replayed', true);
    END IF;
  END IF;

  IF v_coupon IS NOT NULL AND v_max IS NOT NULL THEN
    SELECT count(*) INTO v_used FROM orders
    WHERE coupon_code = v_coupon AND status <> 'cancelled';
    IF v_used >= v_max THEN
      RAISE EXCEPTION 'coupon_limit_reached' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF v_coupon IS NOT NULL AND v_per_customer IS NOT NULL THEN
    SELECT count(*) INTO v_used FROM orders
    WHERE coupon_code = v_coupon AND user_id = p_user_id AND status <> 'cancelled';
    IF v_used >= v_per_customer THEN
      RAISE EXCEPTION 'coupon_customer_limit_reached' USING ERRCODE = 'check_violation';
    END IF;
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
    v_coupon,
    COALESCE(p_order->'applied_combos', '[]'::jsonb),
    p_idempotency_key,
    p_request_hash
  )
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

REVOKE ALL ON FUNCTION public.place_order(UUID, TEXT, TEXT, JSONB, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.place_order(UUID, TEXT, TEXT, JSONB, JSONB)
  TO service_role;

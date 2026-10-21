-- Acceptance checks for place_order() (migration 20261021120000).
-- Run ONLY against a disposable or approved test database, never production.
-- Everything happens inside one transaction that is rolled back at the end.
--
-- Concurrency (two sessions using the same key at once) needs two
-- connections: run the "same key" call from two psql sessions without
-- committing the first, then commit; the second must return replayed=true.

BEGIN;

INSERT INTO auth.users (id, email)
VALUES ('00000000-0000-4000-8000-0000000000aa', 'acceptance@example.com');
INSERT INTO profiles (id, name, email)
VALUES ('00000000-0000-4000-8000-0000000000aa', 'Acceptance', 'acceptance@example.com');
INSERT INTO categories (id, name, slug)
VALUES ('00000000-0000-4000-8000-0000000000c1', 'Acceptance', 'acceptance-category');
INSERT INTO products (id, name, slug, description, price, category_id, stock_quantity)
VALUES ('00000000-0000-4000-8000-0000000000b1', 'Acceptance item', 'acceptance-item', 'x', 100,
        '00000000-0000-4000-8000-0000000000c1', 3);

DO $$
DECLARE
  v_order JSONB := jsonb_build_object(
    'subtotal', 200, 'shipping_cost', 80, 'tax', 0, 'total', 280,
    'shipping_address', '{}'::jsonb, 'payment_method', 'cod',
    'delivery_zone', 'inside_dhaka', 'original_subtotal', 200,
    'combo_discount', 0, 'coupon_discount', 0, 'discount_total', 0);
  v_items JSONB := jsonb_build_array(jsonb_build_object(
    'product_id', '00000000-0000-4000-8000-0000000000b1', 'product_name', 'Acceptance item',
    'price', 100, 'original_price', 100, 'quantity', 2));
  r1 JSONB; r2 JSONB;
  v_stock INTEGER; v_orders INTEGER;
BEGIN
  -- 1. First call creates one order and deducts stock once.
  r1 := place_order('00000000-0000-4000-8000-0000000000aa', 'acceptance-key-000001', 'hash-a', v_order, v_items);
  ASSERT (r1->>'replayed')::boolean = false, 'first call must not be a replay';

  -- 2. Retry with the same key and hash replays the same order.
  r2 := place_order('00000000-0000-4000-8000-0000000000aa', 'acceptance-key-000001', 'hash-a', v_order, v_items);
  ASSERT (r2->>'replayed')::boolean AND r2->>'order_id' = r1->>'order_id', 'retry must replay the original order';

  SELECT stock_quantity INTO v_stock FROM products WHERE id = '00000000-0000-4000-8000-0000000000b1';
  SELECT count(*) INTO v_orders FROM orders WHERE user_id = '00000000-0000-4000-8000-0000000000aa';
  ASSERT v_stock = 1 AND v_orders = 1, format('expected stock 1 and 1 order, got %s and %s', v_stock, v_orders);

  -- 3. Same key, different request is rejected.
  BEGIN
    PERFORM place_order('00000000-0000-4000-8000-0000000000aa', 'acceptance-key-000001', 'hash-b', v_order, v_items);
    RAISE EXCEPTION 'reused key with a different hash was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- 4. Insufficient stock rolls back the header as well (no orphan order).
  BEGIN
    PERFORM place_order('00000000-0000-4000-8000-0000000000aa', 'acceptance-key-000002', 'hash-c', v_order, v_items);
    RAISE EXCEPTION 'oversell was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  SELECT count(*) INTO v_orders FROM orders WHERE user_id = '00000000-0000-4000-8000-0000000000aa';
  SELECT stock_quantity INTO v_stock FROM products WHERE id = '00000000-0000-4000-8000-0000000000b1';
  ASSERT v_orders = 1 AND v_stock = 1, 'failed placement must leave no order and unchanged stock';

  RAISE NOTICE 'place_order acceptance: all checks passed';
END $$;

ROLLBACK;

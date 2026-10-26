BEGIN;
CREATE FUNCTION ops_unread_count(p_actor uuid) RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT count(*) FROM admin_notifications n WHERE ops_has(p_actor,n.permission) AND (n.recipient_id IS NULL OR n.recipient_id=p_actor)
 AND NOT EXISTS(SELECT 1 FROM notification_reads r WHERE r.notification_id=n.id AND r.user_id=p_actor);
$$;
CREATE FUNCTION ops_read_notification(p_actor uuid,p_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM admin_notifications WHERE id=p_id AND ops_has(p_actor,permission) AND (recipient_id IS NULL OR recipient_id=p_actor)) THEN RAISE EXCEPTION 'Notification not found' USING ERRCODE='P0002'; END IF;
 INSERT INTO notification_reads(notification_id,user_id) VALUES(p_id,p_actor) ON CONFLICT DO NOTHING;
END;
$$;

CREATE FUNCTION ops_customer_return(p_actor uuid,p_order uuid,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o orders; item order_items; used integer; result jsonb;
BEGIN
 PERFORM set_config('app.actor',p_actor::text,true);
 SELECT * INTO o FROM orders WHERE id=p_order AND user_id=p_actor FOR UPDATE;
 IF o.id IS NULL THEN RAISE EXCEPTION 'Order not found' USING ERRCODE='P0002'; END IF;
 IF o.status<>'delivered' THEN RAISE EXCEPTION 'Only delivered orders are eligible for a return' USING ERRCODE='23514'; END IF;
 IF coalesce((SELECT delivered_at FROM shipments WHERE order_id=p_order),o.updated_at)<now()-make_interval(days=>(SELECT return_window_days FROM operations_settings)) THEN RAISE EXCEPTION 'Return window has expired' USING ERRCODE='23514'; END IF;
 SELECT * INTO item FROM order_items WHERE id=(p_data->>'order_item_id')::uuid AND order_id=p_order;
 IF item.id IS NULL THEN RAISE EXCEPTION 'Order item not found' USING ERRCODE='P0002'; END IF;
 SELECT coalesce(sum(quantity),0) INTO used FROM return_requests WHERE order_item_id=item.id AND status<>'rejected';
 IF used+(p_data->>'quantity')::int>item.quantity THEN RAISE EXCEPTION 'Return quantity exceeds remaining eligible quantity' USING ERRCODE='23514'; END IF;
 INSERT INTO return_requests(order_id,order_item_id,quantity,kind,reason,photos,requested_by)
 VALUES(p_order,item.id,(p_data->>'quantity')::int,p_data->>'kind',p_data->>'reason',ARRAY(SELECT jsonb_array_elements_text(coalesce(p_data->'photos','[]'))),p_actor) RETURNING to_jsonb(return_requests.*) INTO result;
 PERFORM ops_notify('return:'||(result->>'id'),'returns.read','New customer return request','/admin/returns');
 RETURN result-'requested_by';
END;
$$;

-- Cohort metrics use order creation in [from,to); cash flows use collection /
-- refund-completion timestamps in that period. They are intentionally separate.
CREATE FUNCTION ops_report(p_actor uuid,p_filters jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb; f timestamptz; t timestamptz;
BEGIN
 IF NOT ops_has(p_actor,'reports.read') THEN RAISE EXCEPTION 'Insufficient permissions' USING ERRCODE='42501'; END IF;
 f:=(p_filters->>'from')::timestamptz; t:=(p_filters->>'to')::timestamptz;
 IF f IS NULL OR t IS NULL OR t<=f OR t-f>interval '366 days' THEN RAISE EXCEPTION 'Invalid report period' USING ERRCODE='22023'; END IF;
 WITH matched AS (
  SELECT o.* FROM orders o WHERE
   (nullif(p_filters->>'courier','') IS NULL OR EXISTS(SELECT 1 FROM shipments s WHERE s.order_id=o.id AND s.courier=p_filters->>'courier')) AND
   (nullif(p_filters->>'product_id','') IS NULL OR EXISTS(SELECT 1 FROM order_items i WHERE i.order_id=o.id AND i.product_id=(p_filters->>'product_id')::uuid)) AND
   (nullif(p_filters->>'category_id','') IS NULL OR EXISTS(SELECT 1 FROM order_items i JOIN products p ON p.id=i.product_id WHERE i.order_id=o.id AND p.category_id=(p_filters->>'category_id')::uuid))
 ), cohort AS (SELECT * FROM matched WHERE created_at>=f AND created_at<t),
 sales AS (SELECT * FROM cohort WHERE status='delivered'),
 returns_by_order AS (
  SELECT r.order_id,sum(f.amount) AS refunds FROM refunds f JOIN return_requests r ON r.id=f.return_id WHERE f.status='completed' GROUP BY r.order_id
 ), costs AS (
  SELECT i.order_id,sum(i.unit_cost_snapshot*(i.quantity-coalesce(ret.restocked,0))) AS cogs,
   count(*) FILTER(WHERE i.unit_cost_snapshot IS NULL) AS missing_cost_lines
  FROM order_items i LEFT JOIN LATERAL(SELECT sum(restock_quantity) restocked FROM return_requests WHERE order_item_id=i.id AND status IN ('inspected','resolved')) ret ON true GROUP BY i.order_id
 ), totals AS (
  SELECT coalesce(sum(s.subtotal),0) sales,coalesce(sum(s.discount_total),0) discounts,coalesce(sum(s.shipping_cost),0) shipping_revenue,coalesce(sum(r.refunds),0) refunds,
   coalesce(sum(c.cogs),0) known_cogs,coalesce(sum(c.missing_cost_lines),0) missing_cost_lines,
   coalesce(sum(sh.actual_cost),0) known_delivery_costs,count(*) FILTER(WHERE sh.actual_cost IS NULL) missing_delivery_costs
  FROM sales s LEFT JOIN returns_by_order r ON r.order_id=s.id LEFT JOIN costs c ON c.order_id=s.id LEFT JOIN shipments sh ON sh.order_id=s.id
 ), products_report AS (
  SELECT i.product_id,i.product_name,i.sku_snapshot,coalesce(i.selected_size,'') size,coalesce(i.selected_color,'') color,
   sum(i.quantity) units,round(sum(i.price*i.quantity*s.subtotal/nullif(lines.value,0)),2) sales
  FROM sales s JOIN order_items i ON i.order_id=s.id
  JOIN LATERAL(SELECT sum(price*quantity) value FROM order_items WHERE order_id=s.id) lines ON true
  GROUP BY i.product_id,i.product_name,i.sku_snapshot,i.selected_size,i.selected_color ORDER BY units DESC,i.product_id LIMIT 100
 ), daily AS (
  SELECT (s.created_at AT TIME ZONE 'Asia/Dhaka')::date report_date,count(*) orders,sum(s.subtotal) sales FROM sales s GROUP BY 1 ORDER BY 1
 ), valuation AS (
  SELECT sum(value) known_value,sum(missing) missing_cost_items FROM (
   SELECT stock_quantity*unit_cost value,CASE WHEN unit_cost IS NULL AND stock_quantity>0 THEN 1 ELSE 0 END missing FROM products WHERE inventory_mode='product'
   UNION ALL SELECT stock_quantity*unit_cost,CASE WHEN unit_cost IS NULL AND stock_quantity>0 THEN 1 ELSE 0 END FROM inventory_variants
  ) stock
 )
 SELECT jsonb_build_object(
  'from',f,'to',t,'timezone','Asia/Dhaka','currency','BDT','filter_scope','Orders containing the selected product/category; all their items are included',
  'summary',(SELECT jsonb_build_object('orders',(SELECT count(*) FROM cohort),'delivered_orders',(SELECT count(*) FROM sales),
   'cancelled_orders',(SELECT count(*) FROM cohort WHERE status='cancelled'),
   'cancel_rate',coalesce((SELECT round(100.0*count(*) FILTER(WHERE status='cancelled')/nullif(count(*),0),2) FROM cohort),0),
   'returned_orders',(SELECT count(DISTINCT r.order_id) FROM return_requests r JOIN cohort c ON c.id=r.order_id WHERE r.status IN ('received','inspected','resolved')),
   'return_rate',coalesce((SELECT round(100.0*count(DISTINCT r.order_id)/nullif((SELECT count(*) FROM sales),0),2) FROM return_requests r JOIN sales s ON s.id=r.order_id WHERE r.status IN ('received','inspected','resolved')),0),
   'failed_delivery_orders',(SELECT count(*) FROM cohort c JOIN shipments s ON s.order_id=c.id WHERE s.attempts>0),
   'delivery_failure_rate',coalesce((SELECT round(100.0*count(*) FILTER(WHERE s.attempts>0)/nullif(count(*),0),2) FROM cohort c JOIN shipments s ON s.order_id=c.id),0),
   'sales',sales,'discounts',discounts,'refunds',refunds,'net_sales',sales-refunds,
   'known_cogs',known_cogs,'missing_cost_lines',missing_cost_lines,
   'estimated_gross_profit',CASE WHEN missing_cost_lines=0 THEN sales-refunds-known_cogs END,
   'shipping_revenue',shipping_revenue,'known_delivery_costs',known_delivery_costs,'missing_delivery_costs',missing_delivery_costs,
   'estimated_contribution',CASE WHEN missing_cost_lines=0 AND missing_delivery_costs=0 THEN sales-refunds-known_cogs+shipping_revenue-known_delivery_costs END,
   'cash_collected',coalesce((SELECT sum(total) FROM matched WHERE paid_at>=f AND paid_at<t),0),
   'cash_refunded',coalesce((SELECT sum(r.amount) FROM refunds r JOIN matched m ON m.id=r.order_id WHERE r.status='completed' AND r.completed_at>=f AND r.completed_at<t),0)
  ) FROM totals),
  'products',coalesce((SELECT jsonb_agg(to_jsonb(pr)) FROM products_report pr),'[]'),
  'daily',coalesce((SELECT jsonb_agg(to_jsonb(d)) FROM daily d),'[]'),
  'stock_valuation',(SELECT jsonb_build_object('known_value',coalesce(known_value,0),'missing_cost_items',coalesce(missing_cost_items,0)) FROM valuation)
 ) INTO result;
 RETURN result;
END;
$$;

-- Ensure legacy product-form changes also have an atomic stock ledger entry.
CREATE FUNCTION ops_legacy_movement() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  INSERT INTO stock_movements(product_id,delta,balance,reason,actor_id,reference) VALUES(NEW.id,coalesce(NEW.stock_quantity,0),coalesce(NEW.stock_quantity,0),'opening_balance',ops_actor(),'opening:'||NEW.id);
 ELSIF NEW.stock_quantity IS DISTINCT FROM OLD.stock_quantity AND pg_trigger_depth()=1 AND nullif(current_setting('app.actor',true),'') IS NULL THEN
  INSERT INTO stock_movements(product_id,delta,balance,reason,actor_id) VALUES(NEW.id,NEW.stock_quantity-OLD.stock_quantity,NEW.stock_quantity,'product_form_adjustment',ops_actor());
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER ledger_product_change AFTER INSERT OR UPDATE OF stock_quantity ON products FOR EACH ROW EXECUTE FUNCTION ops_legacy_movement();

CREATE FUNCTION ops_require_review() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF OLD.status='pending' AND NEW.status IN ('confirmed','shipped','delivered') AND NOT EXISTS(SELECT 1 FROM order_reviews WHERE order_id=OLD.id AND status='approved') THEN
  RAISE EXCEPTION 'Approve the order review checklist before confirming or shipping' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER require_order_review BEFORE UPDATE OF status ON orders FOR EACH ROW EXECUTE FUNCTION ops_require_review();

DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'ops_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated',f.signature);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature);
 END LOOP;
END $$;
COMMIT;

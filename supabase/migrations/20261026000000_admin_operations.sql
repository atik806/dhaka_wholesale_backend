-- Admin operations. Apply after all earlier migrations, before deploying the API.
BEGIN;

CREATE TABLE admin_access (
  user_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE RESTRICT,
  staff_id uuid UNIQUE REFERENCES staff_members(id) ON DELETE SET NULL,
  enabled boolean NOT NULL DEFAULT true,
  groups text[] NOT NULL DEFAULT '{}',
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT enabled OR cardinality(groups)>0),
  CHECK (groups <@ ARRAY['owner','orders','inventory','support','finance']::text[])
);
INSERT INTO admin_access(user_id, groups) SELECT id, ARRAY['owner'] FROM profiles WHERE role = 'admin';

CREATE FUNCTION ops_access(p_user uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT jsonb_build_object('enabled',enabled,'groups',groups,'version',version) FROM admin_access WHERE user_id=p_user), '{"enabled":false,"groups":[]}'::jsonb);
$$;

CREATE FUNCTION ops_has(p_user uuid, p_permission text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 SELECT EXISTS (SELECT 1 FROM admin_access a WHERE a.user_id=p_user AND a.enabled AND (
  'owner'=ANY(a.groups) OR
  ('orders'=ANY(a.groups) AND p_permission=ANY(ARRAY['orders.read','orders.manage','shipments.manage','activity.read'])) OR
  ('inventory'=ANY(a.groups) AND p_permission=ANY(ARRAY['inventory.read','inventory.manage','products.manage','activity.read'])) OR
  ('support'=ANY(a.groups) AND p_permission=ANY(ARRAY['orders.read','orders.notes','returns.read','returns.request','activity.read','support.manage'])) OR
  ('finance'=ANY(a.groups) AND p_permission=ANY(ARRAY['orders.read','returns.read','refunds.approve','refunds.complete','reports.read','activity.read']))
 ));
$$;

CREATE FUNCTION ops_guard_owner() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  -- Serialize access changes, including simultaneous removal of different owners.
  PERFORM pg_advisory_xact_lock(260100);
  IF OLD.enabled AND 'owner'=ANY(OLD.groups) AND
    (TG_OP='DELETE' OR NOT NEW.enabled OR NOT ('owner'=ANY(NEW.groups))) AND
    NOT EXISTS (SELECT 1 FROM admin_access WHERE user_id<>OLD.user_id AND enabled AND 'owner'=ANY(groups)) THEN
    RAISE EXCEPTION 'The last owner cannot be disabled or removed' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_last_owner BEFORE UPDATE OR DELETE ON admin_access FOR EACH ROW EXECUTE FUNCTION ops_guard_owner();

CREATE FUNCTION ops_seed_owner() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
 IF NEW.role='admin' AND (TG_OP='INSERT' OR OLD.role IS DISTINCT FROM NEW.role) THEN
   INSERT INTO admin_access(user_id,groups) VALUES(NEW.id,ARRAY['owner']) ON CONFLICT DO NOTHING;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER seed_admin_access AFTER INSERT OR UPDATE OF role ON profiles FOR EACH ROW EXECUTE FUNCTION ops_seed_owner();

CREATE TABLE admin_activity (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid, actor_name text, summary text,
 entity_type text NOT NULL, entity_id uuid, action text NOT NULL,
 before_data jsonb, after_data jsonb, request_id text,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_entity ON admin_activity(entity_type,entity_id,created_at DESC);
CREATE INDEX activity_created ON admin_activity(created_at DESC);

CREATE TABLE order_reviews (
 order_id uuid PRIMARY KEY REFERENCES orders(id) ON DELETE RESTRICT,
 status text NOT NULL DEFAULT 'awaiting' CHECK(status IN ('awaiting','in_progress','approved','rejected')),
 assigned_to uuid REFERENCES profiles(id) ON DELETE RESTRICT,
 phone_confirmed boolean NOT NULL DEFAULT false, address_checked boolean NOT NULL DEFAULT false,
 stock_checked boolean NOT NULL DEFAULT false, contact_attempts integer NOT NULL DEFAULT 0 CHECK(contact_attempts>=0),
 reason text, version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO order_reviews(order_id,status) SELECT id,CASE WHEN status='cancelled' THEN 'rejected' WHEN status='pending' THEN 'awaiting' ELSE 'approved' END FROM orders;
CREATE INDEX review_queue ON order_reviews(status,assigned_to,updated_at);
CREATE TABLE order_notes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
 actor_id uuid REFERENCES profiles(id) ON DELETE SET NULL, text text NOT NULL CHECK(length(text) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notes_order ON order_notes(order_id,created_at);
CREATE TABLE shipments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
 courier text NOT NULL, tracking_number text NOT NULL, tracking_url text,
 status text NOT NULL DEFAULT 'preparing' CHECK(status IN ('preparing','dispatched','in_transit','delivered','delivery_failed','returning','returned')),
 dispatched_at timestamptz, expected_delivery date, delivered_at timestamptz,
 attempts integer NOT NULL DEFAULT 0, reason text, actual_cost numeric(12,2) CHECK(actual_cost>=0),
 version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shipment_status ON shipments(status);

ALTER TABLE products ADD COLUMN inventory_version integer NOT NULL DEFAULT 1, ADD COLUMN inventory_mode text NOT NULL DEFAULT 'product' CHECK(inventory_mode IN ('product','variant')),
 ADD COLUMN low_stock_threshold integer NOT NULL DEFAULT 5 CHECK(low_stock_threshold>=0),
 ADD COLUMN unit_cost numeric(12,2) CHECK(unit_cost>=0);
CREATE TABLE inventory_variants (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
 inventory_version integer NOT NULL DEFAULT 1, sku text NOT NULL UNIQUE CHECK(length(sku) BETWEEN 1 AND 100), size text NOT NULL DEFAULT '', color text NOT NULL DEFAULT '',
 stock_quantity integer NOT NULL DEFAULT 0 CHECK(stock_quantity>=0),
 low_stock_threshold integer NOT NULL DEFAULT 5 CHECK(low_stock_threshold>=0), unit_cost numeric(12,2) CHECK(unit_cost>=0),
 UNIQUE(product_id,size,color)
);
ALTER TABLE order_items ADD COLUMN variant_id uuid REFERENCES inventory_variants(id) ON DELETE RESTRICT,
 ADD COLUMN sku_snapshot text, ADD COLUMN unit_cost_snapshot numeric(12,2);
CREATE TABLE stock_movements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
 variant_id uuid REFERENCES inventory_variants(id) ON DELETE RESTRICT, delta integer NOT NULL,
 balance integer NOT NULL CHECK(balance>=0), reason text NOT NULL, actor_id uuid, order_id uuid,
 reference text UNIQUE, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX movement_product ON stock_movements(product_id,created_at DESC);
INSERT INTO stock_movements(product_id,delta,balance,reason,reference)
 SELECT id,coalesce(stock_quantity,0),coalesce(stock_quantity,0),'opening_balance','opening:'||id FROM products;

CREATE TABLE return_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
 order_item_id uuid NOT NULL REFERENCES order_items(id) ON DELETE RESTRICT,
 quantity integer NOT NULL CHECK(quantity>0), kind text NOT NULL CHECK(kind IN ('refund','exchange')),
 reason text NOT NULL, photos text[] NOT NULL DEFAULT '{}',
 status text NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','under_review','approved','rejected','received','inspected','resolved')),
 decision_reason text, restock_quantity integer CHECK(restock_quantity>=0 AND restock_quantity<=quantity),
 replacement_order_id uuid REFERENCES orders(id) ON DELETE RESTRICT,
 requested_by uuid NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX returns_order ON return_requests(order_id,status);
CREATE INDEX returns_item ON return_requests(order_item_id);
CREATE TABLE refunds (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), return_id uuid NOT NULL UNIQUE REFERENCES return_requests(id) ON DELETE RESTRICT,
 order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT, amount numeric(12,2) NOT NULL CHECK(amount>0),
 status text NOT NULL DEFAULT 'approved' CHECK(status IN ('approved','completed')),
 method text, reference text UNIQUE, approved_by uuid NOT NULL, completed_by uuid, completed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE admin_notifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_key text NOT NULL UNIQUE,
 permission text NOT NULL, recipient_id uuid, title text NOT NULL, href text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_created ON admin_notifications(created_at DESC);
CREATE TABLE notification_reads (
 notification_id uuid NOT NULL REFERENCES admin_notifications(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE, read_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(notification_id,user_id)
);
CREATE TABLE operations_settings (
 id boolean PRIMARY KEY DEFAULT true CHECK(id), review_after_hours integer NOT NULL DEFAULT 24 CHECK(review_after_hours BETWEEN 1 AND 720),
 return_window_days integer NOT NULL DEFAULT 14 CHECK(return_window_days BETWEEN 1 AND 365)
);
INSERT INTO operations_settings DEFAULT VALUES;

-- Only the private API service role may access operational tables/functions.
-- Staff permissions are evaluated server-side on EVERY request. Nothing is
-- added to a public realtime publication, including notes, costs, or activity.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['admin_access','admin_activity','order_reviews','order_notes','shipments','inventory_variants','stock_movements','return_requests','refunds','admin_notifications','notification_reads','operations_settings'] LOOP
   EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
   EXECUTE format('REVOKE ALL ON %I FROM anon, authenticated',t);
   EXECUTE format('GRANT ALL ON %I TO service_role',t);
 END LOOP;
END $$;

CREATE FUNCTION ops_actor() RETURNS uuid LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE h jsonb;
BEGIN
 IF auth.role()='service_role' THEN
  IF nullif(current_setting('app.actor',true),'') IS NOT NULL THEN RETURN current_setting('app.actor',true)::uuid; END IF;
  h:=coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb;
  RETURN nullif(h->>'x-admin-actor','')::uuid;
 END IF;
 RETURN auth.uid();
END;
$$;
CREATE FUNCTION ops_notify(p_key text,p_permission text,p_title text,p_href text,p_recipient uuid DEFAULT NULL) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
 INSERT INTO admin_notifications(event_key,permission,title,href,recipient_id) VALUES(p_key,p_permission,p_title,p_href,p_recipient) ON CONFLICT(event_key) DO NOTHING;
$$;
CREATE FUNCTION ops_audit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE b jsonb; a jsonb; entity uuid;
BEGIN
 IF TG_OP<>'INSERT' THEN b:=to_jsonb(OLD); END IF;
 IF TG_OP<>'DELETE' THEN a:=to_jsonb(NEW); END IF;
 -- Intentionally allowlist fields; customer address/contact details aren't logged.
 IF TG_TABLE_NAME='profiles' THEN b:=jsonb_build_object('role',b->'role'); a:=jsonb_build_object('role',a->'role'); END IF;
 IF TG_TABLE_NAME='contact_messages' THEN b:=b-'name'-'email'-'phone'-'message'; a:=a-'name'-'email'-'phone'-'message'; END IF;
 IF TG_TABLE_NAME='bug_reports' THEN b:=b-'message'-'screenshot_url'-'page_url'; a:=a-'message'-'screenshot_url'-'page_url'; END IF;
 IF TG_TABLE_NAME='orders' THEN
  b:=b-'shipping_address'; a:=a-'shipping_address';
 END IF;
 IF TG_TABLE_NAME='staff_members' THEN b:=b-'email'-'phone'-'avatar_url'; a:=a-'email'-'phone'-'avatar_url'; END IF;
 entity:=coalesce(to_jsonb(NEW)->>'id',to_jsonb(OLD)->>'id',to_jsonb(NEW)->>'order_id',to_jsonb(OLD)->>'order_id',to_jsonb(NEW)->>'user_id',to_jsonb(OLD)->>'user_id')::uuid;
 IF TG_OP='UPDATE' AND b IS NOT DISTINCT FROM a THEN RETURN NEW; END IF;
 INSERT INTO admin_activity(actor_id,actor_name,summary,entity_type,entity_id,action,before_data,after_data,request_id)
 VALUES(ops_actor(),(SELECT name FROM profiles WHERE id=ops_actor()),CASE WHEN b->>'status' IS DISTINCT FROM a->>'status' THEN coalesce(b->>'status','created')||' -> '||coalesce(a->>'status','deleted') ELSE lower(TG_OP) END,TG_TABLE_NAME,entity,lower(TG_OP),b,a,coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb->>'x-request-id');
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END;
$$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['orders','products','categories','profiles','staff_members','site_settings','reviews','contact_messages','bug_reports','admin_access','order_reviews','order_notes','shipments','inventory_variants','return_requests','refunds','operations_settings'] LOOP
  EXECUTE format('CREATE TRIGGER operations_audit AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION ops_audit()',t);
 END LOOP;
END $$;

CREATE FUNCTION ops_order_created() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
 INSERT INTO order_reviews(order_id) VALUES(NEW.id);
 PERFORM ops_notify('order:'||NEW.id,'orders.read','New order needs review','/admin/orders/'||NEW.id);
 RETURN NEW;
END;
$$;
CREATE TRIGGER ops_new_order AFTER INSERT ON orders FOR EACH ROW EXECUTE FUNCTION ops_order_created();

-- Snapshot the cost/variant and deduct variant stock in the SAME transaction
-- as the existing order insert. Product totals continue to serve storefronts.
CREATE OR REPLACE FUNCTION decrement_stock_on_order() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE p products; v inventory_variants; remaining integer;
BEGIN
 SELECT * INTO p FROM products WHERE id=NEW.product_id FOR UPDATE;
 IF p.inventory_mode='variant' THEN
  SELECT * INTO v FROM inventory_variants WHERE product_id=p.id AND size=coalesce(NEW.selected_size,'') AND color=coalesce(NEW.selected_color,'') FOR UPDATE;
  IF v.id IS NULL OR v.stock_quantity<NEW.quantity THEN RAISE EXCEPTION 'Insufficient stock for selected variant' USING ERRCODE='23514'; END IF;
  UPDATE inventory_variants SET stock_quantity=stock_quantity-NEW.quantity WHERE id=v.id RETURNING stock_quantity INTO remaining;
  NEW.variant_id:=v.id; NEW.sku_snapshot:=v.sku; NEW.unit_cost_snapshot:=v.unit_cost;
 ELSE
  IF coalesce(p.stock_quantity,0)<NEW.quantity THEN RAISE EXCEPTION 'Insufficient stock for product' USING ERRCODE='23514'; END IF;
  remaining:=p.stock_quantity-NEW.quantity; NEW.unit_cost_snapshot:=p.unit_cost;
 END IF;
 UPDATE products SET stock_quantity=stock_quantity-NEW.quantity WHERE id=p.id;
 INSERT INTO stock_movements(product_id,variant_id,delta,balance,reason,actor_id,order_id,reference)
 VALUES(p.id,NEW.variant_id,-NEW.quantity,remaining,'sale',ops_actor(),NEW.order_id,'sale:'||NEW.id);
 RETURN NEW;
END;
$$;
DROP TRIGGER decrement_stock ON order_items;
CREATE TRIGGER decrement_stock BEFORE INSERT ON order_items FOR EACH ROW EXECUTE FUNCTION decrement_stock_on_order();

CREATE OR REPLACE FUNCTION restock_on_order_cancel() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE item order_items; remaining integer;
BEGIN
 IF NEW.status='cancelled' AND OLD.status IS DISTINCT FROM 'cancelled' THEN
  FOR item IN SELECT * FROM order_items WHERE order_id=NEW.id ORDER BY product_id,id LOOP
   PERFORM 1 FROM products WHERE id=item.product_id FOR UPDATE;
   UPDATE products SET stock_quantity=stock_quantity+item.quantity WHERE id=item.product_id RETURNING stock_quantity INTO remaining;
   IF item.variant_id IS NOT NULL THEN
    UPDATE inventory_variants SET stock_quantity=stock_quantity+item.quantity WHERE id=item.variant_id RETURNING stock_quantity INTO remaining;
   END IF;
   INSERT INTO stock_movements(product_id,variant_id,delta,balance,reason,actor_id,order_id,reference)
   VALUES(item.product_id,item.variant_id,item.quantity,remaining,'cancellation',ops_actor(),NEW.id,'cancel:'||item.id);
  END LOOP;
  UPDATE order_reviews SET status='rejected',version=version+1,updated_at=now() WHERE order_id=NEW.id;
 END IF;
 RETURN NEW;
END;
$$;

CREATE FUNCTION ops_inventory_version() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 NEW.inventory_version:=OLD.inventory_version+1;
 RETURN NEW;
END;
$$;
CREATE TRIGGER inventory_product_version BEFORE UPDATE OF stock_quantity,unit_cost,low_stock_threshold,inventory_mode ON products FOR EACH ROW EXECUTE FUNCTION ops_inventory_version();
CREATE TRIGGER inventory_variant_version BEFORE UPDATE ON inventory_variants FOR EACH ROW EXECUTE FUNCTION ops_inventory_version();

CREATE FUNCTION ops_low_stock() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.stock_quantity<=NEW.low_stock_threshold AND (TG_OP='INSERT' OR OLD.stock_quantity>OLD.low_stock_threshold) THEN
  PERFORM ops_notify('stock:'||TG_TABLE_NAME||':'||NEW.id||':'||gen_random_uuid(),'inventory.read','Low stock: '||coalesce(to_jsonb(NEW)->>'sku',to_jsonb(NEW)->>'name'),'/admin/inventory');
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER notify_product_stock AFTER INSERT OR UPDATE OF stock_quantity ON products FOR EACH ROW EXECUTE FUNCTION ops_low_stock();
CREATE TRIGGER notify_variant_stock AFTER INSERT OR UPDATE OF stock_quantity ON inventory_variants FOR EACH ROW EXECUTE FUNCTION ops_low_stock();

-- Operations dispatcher uses row locks + versions. API validation is repeated
-- here for invariants that must hold under concurrent requests.
CREATE FUNCTION ops_mutate(p_actor uuid,p_action text,p_id uuid,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o orders; r order_reviews; s shipments; p products; v inventory_variants;
 ret return_requests; item order_items; f refunds; a admin_access;
 permission text; target text; remaining integer; used integer; reserved numeric; ceiling numeric;
 payload jsonb; row_data jsonb; replacement orders;
BEGIN
 permission:=CASE p_action
  WHEN 'access.save' THEN '*' WHEN 'settings.save' THEN '*'
  WHEN 'order.cancel' THEN 'orders.manage' WHEN 'review.save' THEN 'orders.manage' WHEN 'note.add' THEN 'orders.notes'
  WHEN 'shipment.save' THEN 'shipments.manage' WHEN 'inventory.configure' THEN 'inventory.manage'
  WHEN 'inventory.adjust' THEN 'inventory.manage' WHEN 'return.create' THEN 'returns.request'
  WHEN 'return.update' THEN 'returns.request' WHEN 'refund.approve' THEN 'refunds.approve'
  WHEN 'refund.complete' THEN 'refunds.complete' ELSE NULL END;
 IF permission IS NULL OR NOT ops_has(p_actor,permission) THEN
  IF NOT (p_action='note.add' AND ops_has(p_actor,'orders.manage')) THEN RAISE EXCEPTION 'Insufficient permissions' USING ERRCODE='42501'; END IF;
 END IF;
 PERFORM set_config('app.actor',p_actor::text,true);

 IF p_action='access.save' THEN
  PERFORM pg_advisory_xact_lock(260100);
  SELECT * INTO a FROM admin_access WHERE user_id=p_id FOR UPDATE;
  IF a.user_id IS NOT NULL AND a.version<>(p_data->>'version')::int THEN RAISE EXCEPTION 'Stale record; reload and try again' USING ERRCODE='40001'; END IF;
  IF a.user_id IS NULL AND (p_data->>'version')::int<>0 THEN RAISE EXCEPTION 'Stale record' USING ERRCODE='40001'; END IF;
  INSERT INTO admin_access(user_id,staff_id,enabled,groups) VALUES(p_id,nullif(p_data->>'staff_id','')::uuid,(p_data->>'enabled')::boolean,ARRAY(SELECT jsonb_array_elements_text(p_data->'groups')))
  ON CONFLICT(user_id) DO UPDATE SET staff_id=excluded.staff_id,enabled=excluded.enabled,groups=excluded.groups,version=admin_access.version+1,updated_at=now() RETURNING to_jsonb(admin_access.*) INTO row_data;
 ELSIF p_action='settings.save' THEN
  UPDATE operations_settings SET review_after_hours=(p_data->>'review_after_hours')::int,return_window_days=(p_data->>'return_window_days')::int RETURNING to_jsonb(operations_settings.*) INTO row_data;
 ELSIF p_action='review.save' THEN
  SELECT * INTO o FROM orders WHERE id=p_id FOR UPDATE;
  SELECT * INTO r FROM order_reviews WHERE order_id=p_id FOR UPDATE;
  IF r.order_id IS NULL THEN RAISE EXCEPTION 'Order not found' USING ERRCODE='P0002'; END IF;
  IF r.version<>(p_data->>'version')::int THEN RAISE EXCEPTION 'Stale review; reload and try again' USING ERRCODE='40001'; END IF;
  IF o.status<>'pending' THEN RAISE EXCEPTION 'Only pending orders can be reviewed' USING ERRCODE='23514'; END IF;
  target:=p_data->>'status';
  IF target='approved' AND NOT ((p_data->>'phone_confirmed')::boolean AND (p_data->>'address_checked')::boolean AND (p_data->>'stock_checked')::boolean) THEN RAISE EXCEPTION 'Complete all confirmation checks first' USING ERRCODE='23514'; END IF;
  IF target='rejected' AND length(trim(coalesce(p_data->>'reason','')))=0 THEN RAISE EXCEPTION 'Cancellation reason is required' USING ERRCODE='23514'; END IF;
  IF nullif(p_data->>'assigned_to','') IS NOT NULL AND NOT ops_has((p_data->>'assigned_to')::uuid,'orders.manage') THEN RAISE EXCEPTION 'Assignee must have active order permissions' USING ERRCODE='23514'; END IF;
  UPDATE order_reviews SET status=target,assigned_to=nullif(p_data->>'assigned_to','')::uuid,phone_confirmed=(p_data->>'phone_confirmed')::boolean,address_checked=(p_data->>'address_checked')::boolean,stock_checked=(p_data->>'stock_checked')::boolean,contact_attempts=(p_data->>'contact_attempts')::int,reason=p_data->>'reason',version=version+1,updated_at=now() WHERE order_id=p_id RETURNING to_jsonb(order_reviews.*) INTO row_data;
  IF target='approved' THEN UPDATE orders SET status='confirmed' WHERE id=p_id;
  ELSIF target='rejected' THEN UPDATE orders SET status='cancelled' WHERE id=p_id; END IF;
  IF nullif(p_data->>'assigned_to','') IS NOT NULL AND r.assigned_to IS DISTINCT FROM (p_data->>'assigned_to')::uuid THEN
   PERFORM ops_notify('assign:'||p_id||':'||(r.version+1),'orders.read','Order assigned to you','/admin/orders/'||p_id,(p_data->>'assigned_to')::uuid);
  END IF;
 ELSIF p_action='order.cancel' THEN
  SELECT * INTO o FROM orders WHERE id=p_id FOR UPDATE;
  IF o.id IS NULL THEN RAISE EXCEPTION 'Order not found' USING ERRCODE='P0002'; END IF;
  IF o.status NOT IN ('pending','confirmed') OR o.status<>p_data->>'expected_status' THEN RAISE EXCEPTION 'Order changed or already dispatched' USING ERRCODE='40001'; END IF;
  IF length(trim(coalesce(p_data->>'reason','')))=0 THEN RAISE EXCEPTION 'Cancellation reason required' USING ERRCODE='23514'; END IF;
  UPDATE order_reviews SET reason=p_data->>'reason',version=version+1 WHERE order_id=p_id;
  UPDATE orders SET status='cancelled' WHERE id=p_id RETURNING to_jsonb(orders.*) INTO row_data;
 ELSIF p_action='note.add' THEN
  INSERT INTO order_notes(order_id,actor_id,text) VALUES(p_id,p_actor,p_data->>'text') RETURNING to_jsonb(order_notes.*) INTO row_data;
 ELSIF p_action='shipment.save' THEN
  SELECT * INTO o FROM orders WHERE id=p_id FOR UPDATE;
  IF o.id IS NULL THEN RAISE EXCEPTION 'Order not found' USING ERRCODE='P0002'; END IF;
  IF o.status NOT IN ('confirmed','shipped','delivered') THEN RAISE EXCEPTION 'Confirm the order before preparing a shipment' USING ERRCODE='23514'; END IF;
  SELECT * INTO s FROM shipments WHERE order_id=p_id FOR UPDATE;
  IF coalesce(s.version,0)<>(p_data->>'version')::int THEN RAISE EXCEPTION 'Stale shipment; reload and try again' USING ERRCODE='40001'; END IF;
  target:=p_data->>'status';
  IF s.id IS NULL AND target<>'preparing' THEN RAISE EXCEPTION 'Start with a preparing shipment' USING ERRCODE='23514'; END IF;
  IF s.id IS NOT NULL AND target<>s.status AND NOT (
    (s.status='preparing' AND target='dispatched') OR (s.status='dispatched' AND target IN ('in_transit','delivered','delivery_failed','returning')) OR
    (s.status='in_transit' AND target IN ('delivered','delivery_failed','returning')) OR
    (s.status='delivery_failed' AND target IN ('in_transit','delivered','returning')) OR (s.status='returning' AND target='returned')
  ) THEN RAISE EXCEPTION 'Invalid shipment transition' USING ERRCODE='23514'; END IF;
  IF target IN ('delivery_failed','returning','returned') AND length(trim(coalesce(p_data->>'reason','')))=0 THEN RAISE EXCEPTION 'Delivery reason is required' USING ERRCODE='23514'; END IF;
  INSERT INTO shipments(order_id,courier,tracking_number,tracking_url,status,expected_delivery,reason,actual_cost)
  VALUES(p_id,p_data->>'courier',p_data->>'tracking_number',nullif(p_data->>'tracking_url',''),target,nullif(p_data->>'expected_delivery','')::date,p_data->>'reason',nullif(p_data->>'actual_cost','')::numeric)
  ON CONFLICT(order_id) DO UPDATE SET courier=excluded.courier,tracking_number=excluded.tracking_number,tracking_url=excluded.tracking_url,status=excluded.status,expected_delivery=excluded.expected_delivery,reason=excluded.reason,actual_cost=excluded.actual_cost,version=shipments.version+1,updated_at=now(),
   dispatched_at=CASE WHEN target='dispatched' THEN coalesce(shipments.dispatched_at,now()) ELSE shipments.dispatched_at END,
   delivered_at=CASE WHEN target='delivered' THEN coalesce(shipments.delivered_at,now()) ELSE shipments.delivered_at END,
   attempts=shipments.attempts+CASE WHEN target='delivery_failed' AND shipments.status<>target THEN 1 ELSE 0 END RETURNING to_jsonb(shipments.*) INTO row_data;
  IF target='dispatched' AND o.status='confirmed' THEN UPDATE orders SET status='shipped' WHERE id=p_id; END IF;
  IF target='delivered' AND o.status<>'delivered' THEN UPDATE orders SET status='delivered' WHERE id=p_id; END IF;
  IF target='delivery_failed' AND s.status IS DISTINCT FROM target THEN PERFORM ops_notify('shipment:'||p_id||':'||coalesce(s.version+1,1),'shipments.manage','Delivery failed','/admin/orders/'||p_id); END IF;
 ELSIF p_action='inventory.configure' THEN
  SELECT * INTO p FROM products WHERE id=p_id FOR UPDATE;
  IF p.id IS NULL THEN RAISE EXCEPTION 'Product not found' USING ERRCODE='P0002'; END IF;
  IF p.inventory_mode='variant' OR EXISTS(SELECT 1 FROM inventory_variants WHERE product_id=p_id) THEN RAISE EXCEPTION 'Variants already allocated; use stock adjustments' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM order_items oi JOIN orders active_order ON active_order.id=oi.order_id WHERE oi.product_id=p_id AND active_order.status IN ('pending','confirmed','shipped')) THEN RAISE EXCEPTION 'Complete active orders before allocating variants' USING ERRCODE='23514'; END IF;
  IF (SELECT coalesce(sum((x->>'stock_quantity')::int),0) FROM jsonb_array_elements(p_data->'variants') x)<>coalesce(p.stock_quantity,0) THEN RAISE EXCEPTION 'Variant allocations must equal current product stock' USING ERRCODE='23514'; END IF;
  FOR payload IN SELECT * FROM jsonb_array_elements(p_data->'variants') LOOP
   IF (cardinality(p.sizes)>0 AND NOT (payload->>'size'=ANY(p.sizes))) OR (cardinality(p.sizes)=0 AND coalesce(payload->>'size','')<>'') OR
     (jsonb_array_length(p.colors)>0 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.colors) c WHERE c->>'name'=payload->>'color')) OR (jsonb_array_length(p.colors)=0 AND coalesce(payload->>'color','')<>'') THEN RAISE EXCEPTION 'Variant choices must match product sizes and colors' USING ERRCODE='23514'; END IF;
   INSERT INTO inventory_variants(product_id,sku,size,color,stock_quantity,low_stock_threshold,unit_cost)
   VALUES(p_id,payload->>'sku',coalesce(payload->>'size',''),coalesce(payload->>'color',''),(payload->>'stock_quantity')::int,(payload->>'low_stock_threshold')::int,nullif(payload->>'unit_cost','')::numeric) RETURNING * INTO v;
   INSERT INTO stock_movements(product_id,variant_id,delta,balance,reason,actor_id,reference) VALUES(p_id,v.id,v.stock_quantity,v.stock_quantity,'variant_allocation',p_actor,'allocate:'||v.id);
  END LOOP;
  IF NOT FOUND THEN RAISE EXCEPTION 'Supply at least one variant' USING ERRCODE='23514'; END IF;
  UPDATE products SET inventory_mode='variant' WHERE id=p_id RETURNING to_jsonb(products.*) INTO row_data;
 ELSIF p_action='inventory.adjust' THEN
  SELECT * INTO p FROM products WHERE id=p_id FOR UPDATE;
  IF p.id IS NULL THEN RAISE EXCEPTION 'Product not found' USING ERRCODE='P0002'; END IF;
  IF p.inventory_mode='variant' THEN
   SELECT * INTO v FROM inventory_variants WHERE id=(p_data->>'variant_id')::uuid AND product_id=p_id FOR UPDATE;
   IF v.id IS NULL THEN RAISE EXCEPTION 'Select a variant' USING ERRCODE='23514'; END IF;
   IF v.inventory_version<>(p_data->>'expected_version')::int OR v.stock_quantity<>(p_data->>'expected_quantity')::int THEN RAISE EXCEPTION 'Stock changed; reload and try again' USING ERRCODE='40001'; END IF;
   UPDATE inventory_variants SET stock_quantity=stock_quantity+(p_data->>'delta')::int,low_stock_threshold=(p_data->>'low_stock_threshold')::int,unit_cost=nullif(p_data->>'unit_cost','')::numeric WHERE id=v.id RETURNING stock_quantity INTO remaining;
  ELSE
   IF p.inventory_version<>(p_data->>'expected_version')::int OR p.stock_quantity<>(p_data->>'expected_quantity')::int THEN RAISE EXCEPTION 'Stock changed; reload and try again' USING ERRCODE='40001'; END IF;
   remaining:=p.stock_quantity+(p_data->>'delta')::int;
  END IF;
  UPDATE products SET stock_quantity=stock_quantity+(p_data->>'delta')::int,low_stock_threshold=(p_data->>'low_stock_threshold')::int,unit_cost=CASE WHEN inventory_mode='product' THEN nullif(p_data->>'unit_cost','')::numeric ELSE unit_cost END WHERE id=p_id RETURNING to_jsonb(products.*) INTO row_data;
  INSERT INTO stock_movements(product_id,variant_id,delta,balance,reason,actor_id,reference) VALUES(p_id,v.id,(p_data->>'delta')::int,remaining,p_data->>'reason',p_actor,'adjust:'||(p_data->>'request_key'));
 ELSIF p_action='return.create' THEN
  SELECT * INTO o FROM orders WHERE id=p_id FOR UPDATE;
  SELECT * INTO item FROM order_items WHERE id=(p_data->>'order_item_id')::uuid AND order_id=p_id;
  IF item.id IS NULL OR NOT (o.status='delivered' OR EXISTS(SELECT 1 FROM shipments WHERE order_id=p_id AND status='returned')) THEN RAISE EXCEPTION 'Only delivered or returned shipments are eligible' USING ERRCODE='23514'; END IF;
  IF coalesce((SELECT delivered_at FROM shipments WHERE order_id=p_id),o.updated_at) < now()-make_interval(days=>(SELECT return_window_days FROM operations_settings)) AND NOT (ops_has(p_actor,'*') AND coalesce((p_data->>'override_window')::boolean,false)) THEN RAISE EXCEPTION 'Return window has expired; an owner can override it' USING ERRCODE='23514'; END IF;
  SELECT coalesce(sum(quantity),0) INTO used FROM return_requests WHERE order_item_id=item.id AND status<>'rejected';
  IF used+(p_data->>'quantity')::int>item.quantity THEN RAISE EXCEPTION 'Return quantity exceeds remaining eligible quantity' USING ERRCODE='23514'; END IF;
  INSERT INTO return_requests(order_id,order_item_id,quantity,kind,reason,photos,requested_by) VALUES(p_id,item.id,(p_data->>'quantity')::int,p_data->>'kind',p_data->>'reason',ARRAY(SELECT jsonb_array_elements_text(coalesce(p_data->'photos','[]'))),p_actor) RETURNING to_jsonb(return_requests.*) INTO row_data;
  PERFORM ops_notify('return:'||(row_data->>'id'),'returns.read','New return request','/admin/returns');
 ELSIF p_action IN ('return.update','refund.approve','refund.complete') THEN
  -- Lock the order before the case so refunds/quantities serialize across cases.
  SELECT * INTO o FROM orders WHERE id=(SELECT order_id FROM return_requests WHERE id=p_id) FOR UPDATE;
  SELECT * INTO ret FROM return_requests WHERE id=p_id FOR UPDATE;
  IF ret.id IS NULL THEN RAISE EXCEPTION 'Return not found' USING ERRCODE='P0002'; END IF;
  SELECT * INTO item FROM order_items WHERE id=ret.order_item_id;
  IF p_action='return.update' THEN
   IF ret.version<>(p_data->>'version')::int THEN RAISE EXCEPTION 'Stale return; reload and try again' USING ERRCODE='40001'; END IF;
   target:=p_data->>'status';
   IF NOT ((ret.status='requested' AND target IN ('under_review','approved','rejected')) OR (ret.status='under_review' AND target IN ('approved','rejected')) OR (ret.status='approved' AND target='received') OR (ret.status='received' AND target='inspected') OR (ret.status='inspected' AND target='resolved')) THEN RAISE EXCEPTION 'Invalid return transition' USING ERRCODE='23514'; END IF;
   IF target IN ('approved','rejected','inspected') AND length(trim(coalesce(p_data->>'decision_reason','')))=0 THEN RAISE EXCEPTION 'Decision or inspection reason is required' USING ERRCODE='23514'; END IF;
   IF target='inspected' THEN
    IF (p_data->>'restock_quantity') IS NULL OR (p_data->>'restock_quantity')::int>ret.quantity OR (p_data->>'restock_quantity')::int<0 THEN RAISE EXCEPTION 'Invalid restock quantity' USING ERRCODE='23514'; END IF;
    IF (p_data->>'restock_quantity')::int>0 AND NOT ops_has(p_actor,'inventory.manage') THEN RAISE EXCEPTION 'Restocking requires inventory permissions' USING ERRCODE='42501'; END IF;
    IF (p_data->>'restock_quantity')::int>0 THEN
     PERFORM 1 FROM products WHERE id=item.product_id FOR UPDATE;
     UPDATE products SET stock_quantity=stock_quantity+(p_data->>'restock_quantity')::int WHERE id=item.product_id RETURNING stock_quantity INTO remaining;
     IF item.variant_id IS NOT NULL THEN UPDATE inventory_variants SET stock_quantity=stock_quantity+(p_data->>'restock_quantity')::int WHERE id=item.variant_id RETURNING stock_quantity INTO remaining;
     ELSIF EXISTS(SELECT 1 FROM products WHERE id=item.product_id AND inventory_mode='variant') THEN RAISE EXCEPTION 'Historical item needs an owner stock adjustment to allocate its returned variant' USING ERRCODE='23514'; END IF;
     INSERT INTO stock_movements(product_id,variant_id,delta,balance,reason,actor_id,order_id,reference) VALUES(item.product_id,item.variant_id,(p_data->>'restock_quantity')::int,remaining,'received_return',p_actor,o.id,'return:'||ret.id);
    END IF;
   END IF;
   IF target='resolved' THEN
    IF ret.kind='refund' AND NOT EXISTS(SELECT 1 FROM refunds WHERE return_id=ret.id AND status='completed') AND o.payment_status IN ('paid','refunded') THEN RAISE EXCEPTION 'Complete the refund before resolving' USING ERRCODE='23514'; END IF;
    IF ret.kind='exchange' THEN
     SELECT * INTO replacement FROM orders WHERE id=nullif(p_data->>'replacement_order_id','')::uuid;
     IF replacement.id IS NULL OR replacement.id=o.id OR replacement.user_id<>o.user_id OR replacement.status='cancelled' THEN RAISE EXCEPTION 'Link a valid replacement order for the same customer' USING ERRCODE='23514'; END IF;
    END IF;
   END IF;
   UPDATE return_requests SET status=target,decision_reason=p_data->>'decision_reason',restock_quantity=CASE WHEN target='inspected' THEN (p_data->>'restock_quantity')::int ELSE restock_quantity END,replacement_order_id=CASE WHEN target='resolved' AND kind='exchange' THEN replacement.id ELSE replacement_order_id END,version=version+1,updated_at=now() WHERE id=p_id RETURNING to_jsonb(return_requests.*) INTO row_data;
   IF target='inspected' AND ret.kind='refund' THEN PERFORM ops_notify('refund-needed:'||ret.id,'refunds.approve','Return inspected; refund needs approval','/admin/returns'); END IF;
  ELSIF p_action='refund.approve' THEN
   IF ret.kind<>'refund' OR ret.status<>'inspected' OR o.payment_status<>'paid' THEN RAISE EXCEPTION 'Inspect a paid refund return first' USING ERRCODE='23514'; END IF;
   SELECT coalesce(sum(amount),0) INTO reserved FROM refunds WHERE order_id=o.id;
   ceiling:=round(item.price*ret.quantity*least(1,o.subtotal/nullif((SELECT sum(price*quantity) FROM order_items WHERE order_id=o.id),0)),2);
   IF (p_data->>'amount')::numeric>ceiling OR reserved+(p_data->>'amount')::numeric>o.subtotal OR (SELECT coalesce(sum(rf.amount),0) FROM refunds rf JOIN return_requests rr ON rr.id=rf.return_id WHERE rr.order_item_id=item.id)+(p_data->>'amount')::numeric>round(item.price*item.quantity*least(1,o.subtotal/nullif((SELECT sum(price*quantity) FROM order_items WHERE order_id=o.id),0)),2) THEN RAISE EXCEPTION 'Refund exceeds remaining refundable amount or item value after discounts' USING ERRCODE='23514'; END IF;
   INSERT INTO refunds(return_id,order_id,amount,approved_by) VALUES(ret.id,o.id,(p_data->>'amount')::numeric,p_actor) RETURNING to_jsonb(refunds.*) INTO row_data;
   PERFORM ops_notify('refund-approved:'||ret.id,'refunds.complete','Approved refund awaits payment','/admin/returns');
  ELSE
   SELECT * INTO f FROM refunds WHERE return_id=ret.id FOR UPDATE;
   IF f.id IS NULL OR f.status<>'approved' THEN RAISE EXCEPTION 'Refund is missing or already completed' USING ERRCODE='23514'; END IF;
   UPDATE refunds SET status='completed',method=p_data->>'method',reference=p_data->>'reference',completed_by=p_actor,completed_at=now() WHERE id=f.id RETURNING to_jsonb(refunds.*) INTO row_data;
   IF (SELECT coalesce(sum(amount),0) FROM refunds WHERE order_id=o.id AND status='completed')>=o.total THEN UPDATE orders SET payment_status='refunded' WHERE id=o.id; END IF;
  END IF;
 END IF;
 RETURN row_data;
END;
$$;

-- Reject unaudited legacy stock edits once variants are enabled. Existing
-- aggregate updates from inventory RPCs / checkout triggers are permitted.
CREATE FUNCTION ops_protect_variant_stock() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF pg_trigger_depth()=1 AND nullif(current_setting('app.actor',true),'') IS NULL AND NEW.stock_quantity IS DISTINCT FROM OLD.stock_quantity THEN
  RAISE EXCEPTION 'Use Inventory to adjust stock with a reason' USING ERRCODE='23514';
 END IF;
 IF OLD.inventory_mode='variant' AND (NEW.sizes IS DISTINCT FROM OLD.sizes OR (SELECT jsonb_agg(c->>'name' ORDER BY c->>'name') FROM jsonb_array_elements(coalesce(NEW.colors,'[]')) c) IS DISTINCT FROM (SELECT jsonb_agg(c->>'name' ORDER BY c->>'name') FROM jsonb_array_elements(coalesce(OLD.colors,'[]')) c)) THEN RAISE EXCEPTION 'Variant choices cannot change after allocation' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER protect_variant_stock BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION ops_protect_variant_stock();

-- Age reminders are idempotent and safe to invoke from a scheduled job.
CREATE FUNCTION ops_reminders() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE inserted integer;
BEGIN
 INSERT INTO admin_notifications(event_key,permission,title,href)
 SELECT 'overdue:'||o.id,'orders.read','Order awaiting review','/admin/orders/'||o.id FROM orders o JOIN order_reviews r ON r.order_id=o.id
 WHERE o.status='pending' AND r.status IN ('awaiting','in_progress') AND o.created_at<now()-make_interval(hours=>(SELECT review_after_hours FROM operations_settings))
 ON CONFLICT(event_key) DO NOTHING;
 GET DIAGNOSTICS inserted=ROW_COUNT;
 RETURN inserted;
END;
$$;

DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'ops_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated',f.signature);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature);
 END LOOP;
END $$;
COMMIT;

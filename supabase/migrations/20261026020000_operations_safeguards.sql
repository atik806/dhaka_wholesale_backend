BEGIN;
-- Public catalog columns remain readable; procurement costs do not.
REVOKE ALL ON products FROM anon, authenticated;
GRANT SELECT(id,slug,name,description,price,original_price,images,rating,review_count,stock,stock_quantity,tags,sizes,colors,is_new,is_featured,created_at,updated_at,category_id) ON products TO anon, authenticated;
-- All private customer/admin data travels through the cookie-authenticated API.
-- This also closes legacy role='admin' RLS paths for disabled staff accounts.
REVOKE ALL ON profiles,orders,order_items,staff_members,site_settings FROM anon,authenticated;
GRANT ALL ON products,profiles,orders,order_items,staff_members,site_settings TO service_role;
REVOKE INSERT,UPDATE,DELETE ON categories FROM anon,authenticated;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='products') THEN
  ALTER PUBLICATION supabase_realtime DROP TABLE public.products;
 END IF;
END $$;

ALTER TABLE admin_activity ADD COLUMN order_id uuid;
CREATE INDEX activity_order ON admin_activity(order_id,created_at DESC);
CREATE FUNCTION ops_activity_order() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 NEW.order_id:=CASE WHEN NEW.entity_type='orders' THEN NEW.entity_id ELSE coalesce(NEW.after_data->>'order_id',NEW.before_data->>'order_id')::uuid END;
 RETURN NEW;
END;
$$;
CREATE TRIGGER activity_order_link BEFORE INSERT ON admin_activity FOR EACH ROW EXECUTE FUNCTION ops_activity_order();

CREATE FUNCTION ops_demote_access() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF OLD.role='admin' AND NEW.role<>'admin' THEN
  UPDATE admin_access SET enabled=false,version=version+1,updated_at=now() WHERE user_id=NEW.id;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER demote_legacy_admin AFTER UPDATE OF role ON profiles FOR EACH ROW EXECUTE FUNCTION ops_demote_access();

CREATE FUNCTION ops_require_refund_records() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.payment_status='refunded' AND OLD.payment_status IS DISTINCT FROM 'refunded' AND
   coalesce((SELECT sum(amount) FROM refunds WHERE order_id=NEW.id AND status='completed'),0)<NEW.total THEN
  RAISE EXCEPTION 'Complete refund records before marking the full payment refunded' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER require_refund_records BEFORE UPDATE OF payment_status ON orders FOR EACH ROW EXECUTE FUNCTION ops_require_refund_records();

CREATE FUNCTION ops_report_options(p_search text DEFAULT '') RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('products',coalesce((SELECT jsonb_agg(p) FROM (SELECT id,name FROM products WHERE name ILIKE '%'||replace(replace(p_search,'%',''),'_','')||'%' ORDER BY name,id LIMIT 50) p),'[]'),
 'categories',coalesce((SELECT jsonb_agg(c) FROM (SELECT id,name FROM categories ORDER BY name,id) c),'[]'),
 'couriers',coalesce((SELECT jsonb_agg(courier) FROM (SELECT DISTINCT courier FROM shipments ORDER BY courier) s),'[]'));
$$;
CREATE OR REPLACE FUNCTION sync_product_stock_status() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 NEW.stock:=CASE WHEN coalesce(NEW.stock_quantity,0)<=0 THEN 'out-of-stock' WHEN NEW.stock_quantity<=NEW.low_stock_threshold THEN 'low-stock' ELSE 'in-stock' END;
 RETURN NEW;
END;
$$;
DROP TRIGGER sync_product_stock_status ON products;
CREATE TRIGGER sync_product_stock_status BEFORE INSERT OR UPDATE OF stock_quantity,low_stock_threshold ON products FOR EACH ROW EXECUTE FUNCTION sync_product_stock_status();

DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'ops_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated',f.signature);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature);
 END LOOP;
END $$;
COMMIT;

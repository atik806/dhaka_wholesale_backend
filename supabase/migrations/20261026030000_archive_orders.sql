BEGIN;
ALTER TABLE orders ADD COLUMN archived_at timestamptz;
CREATE FUNCTION ops_archive_order(p_order uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o orders; actor uuid;
BEGIN
 actor:=ops_actor();
 IF NOT ops_has(actor,'*') THEN RAISE EXCEPTION 'Owner permission required' USING ERRCODE='42501'; END IF;
 SELECT * INTO o FROM orders WHERE id=p_order FOR UPDATE;
 IF o.id IS NULL THEN RAISE EXCEPTION 'Order not found' USING ERRCODE='P0002'; END IF;
 IF o.archived_at IS NOT NULL THEN RETURN jsonb_build_object('message','Order already archived'); END IF;
 IF o.status IN ('pending','confirmed') THEN
  UPDATE order_reviews SET reason='Archived by administrator',version=version+1 WHERE order_id=p_order;
  UPDATE orders SET status='cancelled' WHERE id=p_order;
 END IF;
 UPDATE orders SET archived_at=now() WHERE id=p_order;
 RETURN jsonb_build_object('message','Order archived; order and stock history retained');
END;
$$;
REVOKE ALL ON FUNCTION ops_archive_order(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION ops_archive_order(uuid) TO service_role;
COMMIT;

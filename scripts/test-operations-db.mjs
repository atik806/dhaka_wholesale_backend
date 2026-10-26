import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

test('admin operations migrations and transactional workflows', async (t) => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
   CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
   CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT null::uuid $$;
   CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT 'service_role'::text $$;`);
    for (const file of (
      await readdir(new URL('../supabase/migrations/', import.meta.url))
    ).sort()) {
      await db.exec(
        await readFile(
          new URL('../supabase/migrations/' + file, import.meta.url),
          'utf8',
        ),
      );
    }
    const first = async (sql, params = []) =>
      (await db.query(sql, params)).rows[0];
    const value = async (sql, params = []) =>
      Object.values(await first(sql, params))[0];
    const owner = randomUUID(),
      support = randomUUID(),
      customer = randomUUID(),
      inventory = randomUUID(),
      finance = randomUUID();
    for (const [id, name] of [
      [owner, 'Owner'],
      [support, 'Support'],
      [customer, 'Customer'],
      [inventory, 'Inventory'],
      [finance, 'Finance'],
    ]) {
      await db.query('INSERT INTO auth.users(id) VALUES($1)', [id]);
      await db.query(
        'INSERT INTO profiles(id,name,email,role) VALUES($1,$2,$3,$4)',
        [id, name, name + '@example.com', id === owner ? 'admin' : 'customer'],
      );
    }
    const mutate = (actor, action, id, data) =>
      value('SELECT ops_mutate($1,$2,$3,$4::jsonb)', [
        actor,
        action,
        id,
        JSON.stringify(data),
      ]);
    for (const [id, group] of [
      [support, 'support'],
      [inventory, 'inventory'],
      [finance, 'finance'],
    ])
      await mutate(owner, 'access.save', id, {
        version: 0,
        enabled: true,
        groups: [group],
      });
    const category = randomUUID(),
      product = randomUUID();
    await db.query('INSERT INTO categories(id,name,slug) VALUES($1,$2,$3)', [
      category,
      'Clothing',
      'clothing',
    ]);
    await db.query(
      `INSERT INTO products(id,name,slug,description,price,category_id,stock_quantity,sizes,colors,unit_cost) VALUES($1,'Shirt','shirt','A shirt for testing',100,$2,10,ARRAY['S','M'],'[{"name":"Red","hex":"#f00"}]',20)`,
      [product, category],
    );
    await t.test(
      'last owner and direct permission checks cannot be bypassed',
      async () => {
        await assert.rejects(
          mutate(owner, 'access.save', owner, {
            version: 1,
            enabled: false,
            groups: ['owner'],
          }),
          /last owner/,
        );
        await assert.rejects(
          mutate(support, 'inventory.adjust', product, { delta: 5 }),
          /Insufficient permissions/,
        );
        await assert.rejects(
          value('SELECT ops_report($1,$2)', [
            support,
            JSON.stringify({
              from: new Date().toISOString(),
              to: new Date(Date.now() + 1000).toISOString(),
            }),
          ]),
          /Insufficient permissions/,
        );
      },
    );
    await t.test(
      'variant allocations preserve stock and reject invented options',
      async () => {
        await assert.rejects(
          mutate(inventory, 'inventory.configure', product, {
            variants: [
              {
                sku: 'BAD',
                size: 'XL',
                color: 'Red',
                stock_quantity: 10,
                low_stock_threshold: 2,
                unit_cost: 20,
              },
            ],
          }),
          /choices/,
        );
        await assert.rejects(
          mutate(inventory, 'inventory.configure', product, {
            variants: [
              {
                sku: 'BAD',
                size: 'S',
                color: 'Red',
                stock_quantity: 20,
                low_stock_threshold: 2,
                unit_cost: 20,
              },
            ],
          }),
          /allocations/,
        );
        await mutate(inventory, 'inventory.configure', product, {
          variants: [
            {
              sku: 'SHIRT-S',
              size: 'S',
              color: 'Red',
              stock_quantity: 6,
              low_stock_threshold: 2,
              unit_cost: 20,
            },
            {
              sku: 'SHIRT-M',
              size: 'M',
              color: 'Red',
              stock_quantity: 4,
              low_stock_threshold: 2,
              unit_cost: 20,
            },
          ],
        });
        assert.equal(
          await value('SELECT stock_quantity FROM products WHERE id=$1', [
            product,
          ]),
          10,
        );
      },
    );
    await t.test(
      'allocated colours keep editable photos without changing SKU names',
      async () => {
        await db.query('UPDATE products SET colors=$1::jsonb WHERE id=$2', [
          JSON.stringify([
            {
              name: 'Red',
              hex: '#ff0000',
              image: 'https://example.test/red.webp',
            },
          ]),
          product,
        ]);
        await assert.rejects(
          db.query('UPDATE products SET colors=$1::jsonb WHERE id=$2', [
            JSON.stringify([{ name: 'Blue', hex: '#0000ff' }]),
            product,
          ]),
          /Variant choices/,
        );
      },
    );
    const place = async (quantity, key = randomUUID(), size = 'S') =>
      value('SELECT place_order($1,$2,$3,$4::jsonb,$5::jsonb)', [
        customer,
        key,
        key,
        JSON.stringify({
          subtotal: quantity * 100,
          total: quantity * 100 + 80,
          shipping_cost: 80,
          tax: 0,
          payment_method: 'cod',
          delivery_zone: 'inside_dhaka',
          shipping_address: { firstName: 'Test', lastName: 'Customer' },
          original_subtotal: quantity * 100,
          combo_discount: 0,
          coupon_discount: 0,
          discount_total: 0,
          applied_combos: [],
        }),
        JSON.stringify([
          {
            product_id: product,
            product_name: 'Shirt',
            price: 100,
            quantity,
            selected_size: size,
            selected_color: 'Red',
          },
        ]),
      ]);
    let order, item;
    await t.test(
      'checkout snapshots variant/cost and rolls back oversells and their audit events',
      async () => {
        const placed = await place(2);
        order = placed.order_id;
        item = await first('SELECT * FROM order_items WHERE order_id=$1', [
          order,
        ]);
        assert.equal(item.unit_cost_snapshot, '20.00');
        assert.equal(item.sku_snapshot, 'SHIRT-S');
        const before = await value('SELECT count(*) FROM orders');
        const audit = await value('SELECT count(*) FROM admin_activity');
        await assert.rejects(place(5), /Insufficient stock/);
        assert.equal(await value('SELECT count(*) FROM orders'), before);
        assert.equal(await value('SELECT count(*) FROM admin_activity'), audit);
        assert.equal(
          await value('SELECT stock_quantity FROM products WHERE id=$1', [
            product,
          ]),
          8,
        );
      },
    );
    await t.test(
      'review checklist, version checks and assignment validation',
      async () => {
        const review = {
          version: 1,
          status: 'approved',
          phone_confirmed: false,
          address_checked: true,
          stock_checked: true,
          contact_attempts: 1,
        };
        await assert.rejects(
          mutate(owner, 'review.save', order, review),
          /confirmation checks/,
        );
        await assert.rejects(
          db.query("UPDATE orders SET status='confirmed' WHERE id=$1", [order]),
          /checklist/,
        );
        await mutate(owner, 'review.save', order, {
          ...review,
          phone_confirmed: true,
        });
        assert.equal(
          await value('SELECT status FROM orders WHERE id=$1', [order]),
          'confirmed',
        );
        await assert.rejects(
          mutate(owner, 'review.save', order, {
            ...review,
            phone_confirmed: true,
          }),
          /Stale review/,
        );
        await mutate(support, 'note.add', order, {
          text: 'Customer called to confirm address.',
        });
        assert.equal(
          await value(
            "SELECT actor_id FROM admin_activity WHERE entity_type='order_notes' ORDER BY created_at DESC LIMIT 1",
          ),
          support,
        );
      },
    );
    await t.test(
      'delivery failures never restock and delivery can be retried',
      async () => {
        const shipment = {
          version: 0,
          courier: 'Manual courier',
          tracking_number: 'TRACK-1',
          status: 'preparing',
          actual_cost: 50,
        };
        await mutate(owner, 'shipment.save', order, shipment);
        await mutate(owner, 'shipment.save', order, {
          ...shipment,
          version: 1,
          status: 'dispatched',
        });
        await mutate(owner, 'shipment.save', order, {
          ...shipment,
          version: 2,
          status: 'delivery_failed',
          reason: 'No answer',
        });
        assert.equal(
          await value('SELECT stock_quantity FROM products WHERE id=$1', [
            product,
          ]),
          8,
        );
        await mutate(owner, 'shipment.save', order, {
          ...shipment,
          version: 3,
          status: 'in_transit',
        });
        await mutate(owner, 'shipment.save', order, {
          ...shipment,
          version: 4,
          status: 'delivered',
        });
        await db.query("UPDATE orders SET payment_status='paid' WHERE id=$1", [
          order,
        ]);
      },
    );
    let ret;
    await t.test(
      'customer ownership and remaining return quantities are enforced',
      async () => {
        const data = {
          order_item_id: item.id,
          quantity: 1,
          kind: 'refund',
          reason: 'Wrong fit',
        };
        await assert.rejects(
          value('SELECT ops_customer_return($1,$2,$3::jsonb)', [
            support,
            order,
            JSON.stringify(data),
          ]),
          /Order not found/,
        );
        ret = await value('SELECT ops_customer_return($1,$2,$3::jsonb)', [
          customer,
          order,
          JSON.stringify(data),
        ]);
        await assert.rejects(
          mutate(owner, 'return.create', order, { ...data, quantity: 2 }),
          /remaining eligible/,
        );
      },
    );
    await t.test(
      'inspection restocks once and partial refunds reserve only available money',
      async () => {
        await mutate(support, 'return.update', ret.id, {
          version: 1,
          status: 'approved',
          decision_reason: 'Eligible',
        });
        await mutate(support, 'return.update', ret.id, {
          version: 2,
          status: 'received',
        });
        await assert.rejects(
          mutate(support, 'return.update', ret.id, {
            version: 3,
            status: 'inspected',
            restock_quantity: 1,
            decision_reason: 'Sellable',
          }),
          /permissions/,
        );
        await mutate(owner, 'return.update', ret.id, {
          version: 3,
          status: 'inspected',
          restock_quantity: 1,
          decision_reason: 'Sellable',
        });
        await assert.rejects(
          mutate(owner, 'return.update', ret.id, {
            version: 3,
            status: 'inspected',
            restock_quantity: 1,
            decision_reason: 'Sellable',
          }),
          /Stale return/,
        );
        assert.equal(
          await value('SELECT stock_quantity FROM products WHERE id=$1', [
            product,
          ]),
          9,
        );
        await assert.rejects(
          mutate(finance, 'refund.approve', ret.id, { amount: 101 }),
          /exceeds/,
        );
        await mutate(finance, 'refund.approve', ret.id, { amount: 100 });
        await mutate(finance, 'refund.complete', ret.id, {
          method: 'cash',
          reference: 'REFUND-1',
        });
        await assert.rejects(
          mutate(finance, 'refund.complete', ret.id, {
            method: 'cash',
            reference: 'REFUND-1',
          }),
          /already completed/,
        );
        assert.equal(
          await value('SELECT payment_status FROM orders WHERE id=$1', [order]),
          'paid',
        );
        await mutate(support, 'return.update', ret.id, {
          version: 4,
          status: 'resolved',
        });
      },
    );
    await t.test(
      'notifications deduplicate reminders and restrict reads',
      async () => {
        await db.query('SELECT ops_reminders()');
        await db.query('SELECT ops_reminders()');
        const note = await value(
          "SELECT id FROM admin_notifications WHERE permission='refunds.complete' LIMIT 1",
        );
        await assert.rejects(
          value('SELECT ops_read_notification($1,$2)', [support, note]),
          /not found/,
        );
        await value('SELECT ops_read_notification($1,$2)', [finance, note]);
        await value('SELECT ops_read_notification($1,$2)', [finance, note]);
        assert.equal(
          await value(
            'SELECT count(*) FROM notification_reads WHERE notification_id=$1',
            [note],
          ),
          1,
        );
      },
    );
    await t.test(
      'reports reconcile sales, cash, refunds, costs and delivery charges',
      async () => {
        const report = await value('SELECT ops_report($1,$2::jsonb)', [
          finance,
          JSON.stringify({
            from: new Date(Date.now() - 86400000).toISOString(),
            to: new Date(Date.now() + 86400000).toISOString(),
          }),
        ]);
        assert.equal(report.summary.sales, 200);
        assert.equal(report.summary.refunds, 100);
        assert.equal(report.summary.net_sales, 100);
        assert.equal(report.summary.estimated_gross_profit, 80);
        assert.equal(report.summary.estimated_contribution, 110);
        assert.equal(report.summary.cash_collected, 280);
      },
    );
    await t.test('cancellation credits each variant exactly once', async () => {
      const second = await place(1);
      const review = {
        version: 1,
        status: 'rejected',
        phone_confirmed: false,
        address_checked: false,
        stock_checked: false,
        contact_attempts: 1,
        reason: 'Customer cancelled',
      };
      await mutate(owner, 'review.save', second.order_id, review);
      await assert.rejects(
        mutate(owner, 'review.save', second.order_id, review),
        /Stale review/,
      );
      assert.equal(
        await value('SELECT stock_quantity FROM products WHERE id=$1', [
          product,
        ]),
        9,
      );
      assert.equal(
        await value(
          "SELECT count(*) FROM stock_movements WHERE reason='cancellation' AND order_id=$1",
          [second.order_id],
        ),
        1,
      );
    });
    await t.test(
      'archiving retains history and releases stock only once',
      async () => {
        const pending = await place(1);
        await db.query("SELECT set_config('request.headers',$1,false)", [
          JSON.stringify({ 'x-admin-actor': owner }),
        ]);
        await value('SELECT ops_archive_order($1)', [pending.order_id]);
        await value('SELECT ops_archive_order($1)', [pending.order_id]);
        assert.equal(
          await value('SELECT status FROM orders WHERE id=$1', [
            pending.order_id,
          ]),
          'cancelled',
        );
        assert.ok(
          await value('SELECT archived_at FROM orders WHERE id=$1', [
            pending.order_id,
          ]),
        );
        assert.equal(
          await value(
            "SELECT count(*) FROM stock_movements WHERE reason='cancellation' AND order_id=$1",
            [pending.order_id],
          ),
          1,
        );
        assert.equal(
          await value('SELECT stock_quantity FROM products WHERE id=$1', [
            product,
          ]),
          9,
        );
        await db.query("SELECT set_config('request.headers','{}',false)");
      },
    );
    await t.test(
      'missing historical costs remain unknown in reports',
      async () => {
        await db.query(
          'UPDATE order_items SET unit_cost_snapshot=NULL WHERE id=$1',
          [item.id],
        );
        const report = await value('SELECT ops_report($1,$2::jsonb)', [
          finance,
          JSON.stringify({
            from: new Date(Date.now() - 86400000).toISOString(),
            to: new Date(Date.now() + 86400000).toISOString(),
          }),
        ]);
        assert.equal(report.summary.estimated_gross_profit, null);
        assert.equal(report.summary.estimated_contribution, null);
      },
    );
    await t.test(
      'inventory cost edits reject stale versions even when quantity is unchanged',
      async () => {
        const sku = await first(
          "SELECT * FROM inventory_variants WHERE product_id=$1 AND size='S'",
          [product],
        );
        const adjustment = {
          variant_id: sku.id,
          expected_quantity: sku.stock_quantity,
          expected_version: sku.inventory_version,
          delta: 0,
          unit_cost: 21,
          low_stock_threshold: 2,
          reason: 'Supplier cost updated',
          request_key: randomUUID(),
        };
        await mutate(inventory, 'inventory.adjust', product, adjustment);
        await assert.rejects(
          mutate(inventory, 'inventory.adjust', product, {
            ...adjustment,
            request_key: randomUUID(),
            unit_cost: 22,
          }),
          /Stock changed/,
        );
        assert.equal(
          await value('SELECT unit_cost FROM inventory_variants WHERE id=$1', [
            sku.id,
          ]),
          '21.00',
        );
        await assert.rejects(
          db.query(
            'UPDATE products SET stock_quantity=stock_quantity+1 WHERE id=$1',
            [product],
          ),
          /Use Inventory/,
        );
      },
    );
    await t.test(
      'private operations tables are inaccessible to browser roles',
      async () => {
        await db.exec('SET ROLE anon');
        await assert.rejects(
          db.query('SELECT unit_cost FROM products'),
          /permission denied/,
        );
        await db.query('SELECT name,price FROM products');
        await assert.rejects(
          db.query('SELECT * FROM admin_access'),
          /permission denied/,
        );
        await assert.rejects(
          db.query('SELECT ops_access($1)', [owner]),
          /permission denied/,
        );
        await db.exec('RESET ROLE');
      },
    );
  } finally {
    await db.close();
  }
});

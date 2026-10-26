import {
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { createSupabaseAdminClient } from '../../config/supabase.config.js';
import { allows, permissionsFor } from './permissions.js';
import type { ListQuery } from './operations.schemas.js';

@Injectable()
export class OperationsService {
  private get db() {
    return createSupabaseAdminClient();
  }
  private check(error: { code?: string; message: string } | null) {
    if (!error) return;
    if (['40001', '23505'].includes(error.code ?? ''))
      throw new ConflictException(
        error.code === '23505'
          ? 'This record or reference already exists'
          : error.message,
      );
    if (error.code === '42501')
      throw new ForbiddenException('Insufficient permissions');
    if (error.code === 'P0002') throw new NotFoundException(error.message);
    if (['23514', '23503', '22023'].includes(error.code ?? ''))
      throw new BadRequestException(
        error.code === '23503'
          ? 'The linked record cannot be removed or was not found'
          : error.message,
      );
    throw new InternalServerErrorException(
      'Operations storage is unavailable. Apply the admin operations migrations and retry.',
    );
  }
  async access(userId: string) {
    const { data, error } = await this.db.rpc('ops_access', { p_user: userId });
    this.check(error);
    const permissions = data?.enabled ? permissionsFor(data.groups ?? []) : [];
    if (!permissions.length)
      throw new ForbiddenException('Admin access is disabled');
    return { user_id: userId, ...data, permissions };
  }
  async mutate(actor: string, action: string, id: string, data: unknown) {
    const result = await this.db.rpc('ops_mutate', {
      p_actor: actor,
      p_action: action,
      p_id: id,
      p_data: data,
    });
    this.check(result.error);
    return result.data;
  }
  async list(resource: string, q: ListQuery, actor: string) {
    const access = await this.access(actor);
    const owner = allows(access.permissions, '*');
    const config: Record<
      string,
      { table: string; select: string; order: string; permission: string }
    > = {
      reviews: {
        table: 'order_reviews',
        select: '*, orders!inner(id,created_at,status,total,shipping_address)',
        order: 'updated_at',
        permission: 'orders.read',
      },
      shipments: {
        table: 'shipments',
        select: '*',
        order: 'updated_at',
        permission: 'orders.read',
      },
      returns: {
        table: 'return_requests',
        select:
          '*, order_items(product_name,selected_size,selected_color,price), refunds(*)',
        order: 'created_at',
        permission: 'returns.read',
      },
      inventory: {
        table: 'products',
        select:
          'id,name,slug,sizes,colors,stock_quantity,inventory_version,inventory_mode,low_stock_threshold,unit_cost,inventory_variants(*)',
        order: 'name',
        permission: 'inventory.read',
      },
      movements: {
        table: 'stock_movements',
        select: '*,inventory_variants(sku)',
        order: 'created_at',
        permission: 'inventory.read',
      },
      activity: {
        table: 'admin_activity',
        select: owner
          ? '*'
          : 'id,actor_id,actor_name,summary,entity_type,entity_id,action,created_at',
        order: 'created_at',
        permission: 'activity.read',
      },
      access: {
        table: 'profiles',
        select: 'id,name,email,role,admin_access(*)',
        order: 'name',
        permission: '*',
      },
    };
    const c = config[resource];
    if (!c || !allows(access.permissions, c.permission))
      throw new ForbiddenException('Insufficient permissions');
    let query = this.db.from(c.table).select(c.select, { count: 'exact' });
    if (q.status)
      query = query.eq(resource === 'reviews' ? 'status' : 'status', q.status);
    if (q.assigned_to && resource === 'reviews')
      query = query.eq('assigned_to', q.assigned_to);
    if (q.order_id && ['reviews', 'shipments', 'returns'].includes(resource))
      query = query.eq('order_id', q.order_id);
    if (q.product_id && resource === 'movements')
      query = query.eq('product_id', q.product_id);
    if (resource === 'activity') {
      if (q.entity_type) query = query.eq('entity_type', q.entity_type);
      if (q.entity_id) query = query.eq('entity_id', q.entity_id);
      if (q.actor_id) query = query.eq('actor_id', q.actor_id);
    }
    if (q.search && ['inventory', 'access'].includes(resource))
      query = query.ilike('name', `%${q.search.replace(/[%_]/g, '')}%`);
    if (q.from)
      query = query.gte(
        resource === 'reviews' ? 'orders.created_at' : 'created_at',
        q.from,
      );
    if (q.to)
      query = query.lt(
        resource === 'reviews' ? 'orders.created_at' : 'created_at',
        q.to,
      );
    const start = (q.page - 1) * q.limit;
    const { data, error, count } = await query
      .order(c.order, { ascending: c.order === 'name' })
      .order(
        resource === 'reviews'
          ? 'order_id'
          : resource === 'access'
            ? 'id'
            : 'id',
      )
      .range(start, start + q.limit - 1);
    this.check(error);
    const rows = (data ?? []) as unknown as Record<string, unknown>[];
    return {
      data: resource === 'returns' ? this.normalizeRefunds(rows) : rows,
      meta: {
        total: count ?? 0,
        page: q.page,
        limit: q.limit,
        totalPages: Math.ceil((count ?? 0) / q.limit),
      },
    };
  }
  async orderDetail(id: string, actor: string) {
    const access = await this.access(actor);
    const [review, notes, shipment, activity, assignees, settings] =
      await Promise.all([
        this.db.from('order_reviews').select('*').eq('order_id', id).single(),
        this.db
          .from('order_notes')
          .select('*')
          .eq('order_id', id)
          .order('created_at'),
        this.db.from('shipments').select('*').eq('order_id', id).maybeSingle(),
        this.db
          .from('admin_activity')
          .select(
            'id,actor_id,actor_name,summary,action,entity_type,created_at',
          )
          .eq('order_id', id)
          .order('created_at', { ascending: false })
          .limit(50),
        this.db
          .from('admin_access')
          .select('user_id,groups,profiles!admin_access_user_id_fkey(name)')
          .eq('enabled', true),
        this.db.from('operations_settings').select('*').single(),
      ]);
    for (const result of [
      review,
      notes,
      shipment,
      activity,
      assignees,
      settings,
    ])
      this.check(result.error);
    return {
      review: review.data,
      notes: notes.data,
      shipment: shipment.data,
      activity: activity.data,
      settings: settings.data,
      assignees: (assignees.data ?? []).filter((a) =>
        allows(permissionsFor(a.groups), 'orders.manage'),
      ),
      permissions: access.permissions,
    };
  }
  async notifications(actor: string, q: ListQuery) {
    const access = await this.access(actor);
    // A request also catches up reminders if the external scheduler was delayed.
    const reminders = await this.db.rpc('ops_reminders');
    this.check(reminders.error);
    let query = this.db
      .from('admin_notifications')
      .select('*, notification_reads!left(user_id,read_at)', {
        count: 'exact',
      });
    if (!allows(access.permissions, '*'))
      query = query.in('permission', access.permissions);
    query = query
      .or(`recipient_id.is.null,recipient_id.eq.${actor}`)
      .eq('notification_reads.user_id', actor);
    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .order('id')
      .range((q.page - 1) * q.limit, q.page * q.limit - 1);
    this.check(error);
    const unread = await this.db.rpc('ops_unread_count', { p_actor: actor });
    this.check(unread.error);
    return {
      data: data ?? [],
      meta: {
        total: count ?? 0,
        page: q.page,
        limit: q.limit,
        totalPages: Math.ceil((count ?? 0) / q.limit),
        unread: unread.data ?? 0,
      },
    };
  }
  async readNotification(actor: string, id: string) {
    const result = await this.db.rpc('ops_read_notification', {
      p_actor: actor,
      p_id: id,
    });
    this.check(result.error);
    return { read: true };
  }
  async report(actor: string, query: unknown) {
    const { data, error } = await this.db.rpc('ops_report', {
      p_actor: actor,
      p_filters: query,
    });
    this.check(error);
    return data;
  }
  async assignees() {
    const result = await this.db
      .from('admin_access')
      .select('user_id,groups,profiles!admin_access_user_id_fkey(name)')
      .eq('enabled', true);
    this.check(result.error);
    return (result.data ?? [])
      .filter((a) => allows(permissionsFor(a.groups), 'orders.manage'))
      .map((a) => ({
        id: a.user_id,
        name: (a.profiles as unknown as { name: string })?.name ?? 'Staff',
      }));
  }
  async reportOptions(search: string) {
    const result = await this.db.rpc('ops_report_options', {
      p_search: search,
    });
    this.check(result.error);
    return result.data;
  }
  async reminders() {
    const result = await this.db.rpc('ops_reminders');
    this.check(result.error);
    return { created: result.data };
  }
  async settings() {
    const result = await this.db
      .from('operations_settings')
      .select('*')
      .single();
    this.check(result.error);
    return result.data;
  }
  async customerOrder(actor: string, id: string) {
    const { data, error } = await this.db
      .from('orders')
      .select('id')
      .eq('id', id)
      .eq('user_id', actor)
      .maybeSingle();
    this.check(error);
    if (!data) throw new NotFoundException('Order not found');
    const [shipments, returns] = await Promise.all([
      this.db
        .from('shipments')
        .select(
          'courier,tracking_number,tracking_url,status,expected_delivery,dispatched_at,delivered_at',
        )
        .eq('order_id', id),
      this.db
        .from('return_requests')
        .select(
          'id,order_item_id,quantity,kind,reason,status,decision_reason,replacement_order_id,created_at,refunds(amount,status,completed_at)',
        )
        .eq('order_id', id)
        .order('created_at', { ascending: false }),
    ]);
    this.check(shipments.error);
    this.check(returns.error);
    return {
      shipments: shipments.data,
      returns: this.normalizeRefunds(returns.data ?? []),
    };
  }
  private normalizeRefunds(rows: Record<string, unknown>[]) {
    return rows.map((row) => ({
      ...row,
      refunds: Array.isArray(row.refunds)
        ? row.refunds
        : row.refunds
          ? [row.refunds]
          : [],
    }));
  }
  async customerReturn(actor: string, id: string, data: unknown) {
    const result = await this.db.rpc('ops_customer_return', {
      p_actor: actor,
      p_order: id,
      p_data: data,
    });
    this.check(result.error);
    return result.data;
  }
}

import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { createSupabaseAdminClient } from '../../config/supabase.config.js';
import {
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  canTransitionOrder,
  canTransitionPayment,
  type OrderStatus,
  type PaymentStatus,
} from '../orders/order-state.js';

const STALE_ORDER_MESSAGE =
  'This order was changed by someone else. Reload it and try again.';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);
  private supabase = createSupabaseAdminClient();

  async getDashboardStats(query?: { from?: string; to?: string }) {
    // Chart window: never pull more than 30 days of order rows for the trend
    const chartDays = 30;
    const chartFromDate = new Date();
    chartFromDate.setDate(chartFromDate.getDate() - (chartDays - 1));
    const chartFromIso = chartFromDate.toISOString();

    let revenueQuery = this.supabase
      .from('orders')
      .select('total.sum()')
      .eq('payment_status', 'paid');

    if (query?.from) {
      revenueQuery = revenueQuery.gte('created_at', query.from);
    }
    if (query?.to) {
      revenueQuery = revenueQuery.lte('created_at', query.to);
    }

    let chartQuery = this.supabase
      .from('orders')
      .select('total, created_at, payment_status')
      .gte('created_at', chartFromIso);

    if (query?.to) {
      chartQuery = chartQuery.lte('created_at', query.to);
    }

    const [
      { count: totalProducts },
      { count: totalOrders },
      { count: totalUsers },
      { data: revenueAgg, error: revenueError },
      { data: chartOrders, error: chartError },
      { data: recentOrders },
      { data: lowStockProducts },
      { count: pendingOrders },
      { count: unreadMessages },
      { count: pendingBugs },
    ] = await Promise.all([
      this.supabase
        .from('products')
        .select('id', { count: 'exact', head: true }),
      this.supabase.from('orders').select('id', { count: 'exact', head: true }),
      this.supabase
        .from('profiles')
        .select('id', { count: 'exact', head: true }),
      revenueQuery,
      chartQuery,
      this.supabase
        .from('orders')
        .select(
          'id, total, status, created_at, payment_status, profiles(name, email)',
        )
        .order('created_at', { ascending: false })
        .limit(5),
      this.supabase
        .from('products')
        .select('id, name, price, stock, images')
        .in('stock', ['low-stock', 'out-of-stock'])
        .limit(5),
      this.supabase
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending'),
      this.supabase
        .from('contact_messages')
        .select('id', { count: 'exact', head: true })
        .eq('is_read', false),
      this.supabase
        .from('bug_reports')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending'),
    ]);

    if (revenueError)
      this.logger.warn(
        `Dashboard revenue query failed: ${revenueError.message}`,
      );
    if (chartError)
      this.logger.warn(`Dashboard chart query failed: ${chartError.message}`);

    const revenueRow = Array.isArray(revenueAgg) ? revenueAgg[0] : revenueAgg;
    const rawSum =
      (revenueRow as { sum?: number; total?: number } | null | undefined)
        ?.sum ?? (revenueRow as { total?: number } | null | undefined)?.total;
    let totalRevenue = Number(rawSum);

    // Fallback if aggregate is unavailable/unsupported
    if (
      rawSum === undefined ||
      rawSum === null ||
      !Number.isFinite(totalRevenue)
    ) {
      let fallback = this.supabase
        .from('orders')
        .select('total')
        .eq('payment_status', 'paid');
      if (query?.from) fallback = fallback.gte('created_at', query.from);
      if (query?.to) fallback = fallback.lte('created_at', query.to);
      const { data: paidRows } = await fallback;
      totalRevenue = (paidRows || []).reduce(
        (sum, o) => sum + (o.total || 0),
        0,
      );
    }

    // Build daily revenue data for chart (last 30 days)
    const dailyMap: Record<string, { revenue: number; orders: number }> = {};
    const today = new Date();
    for (let i = chartDays - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      dailyMap[key] = { revenue: 0, orders: 0 };
    }

    (chartOrders || []).forEach((o) => {
      const day = (o.created_at || '').slice(0, 10);
      if (dailyMap[day]) {
        dailyMap[day].orders += 1;
        if (o.payment_status === 'paid') {
          dailyMap[day].revenue += o.total || 0;
        }
      }
    });

    const revenueData = Object.entries(dailyMap).map(([date, val]) => ({
      date,
      revenue: val.revenue,
      orders: val.orders,
    }));

    return {
      stats: {
        totalProducts: totalProducts || 0,
        totalOrders: totalOrders || 0,
        totalUsers: totalUsers || 0,
        totalRevenue,
        pendingOrders: pendingOrders || 0,
        unreadMessages: unreadMessages || 0,
        pendingBugs: pendingBugs || 0,
      },
      recentOrders: recentOrders || [],
      lowStockProducts: lowStockProducts || [],
      revenueData,
    };
  }

  async findAllOrders(query: {
    page?: number;
    limit?: number;
    status?: string;
    search?: string;
  }) {
    const page = query.page || 1;
    const limit = query.limit || 10;
    const offset = (page - 1) * limit;

    let sb = this.supabase
      .from('orders')
      .select('*, profiles(name, email)', { count: 'exact' });

    if (query.status) {
      sb = sb.eq('status', query.status);
    }

    if (query.search) {
      const raw = query.search.trim();
      // `id` is a uuid column: `id.ilike` throws and `id::text.ilike` inside
      // `.or()` is rejected by PostgREST here — so only match the id when the
      // whole uuid is given, and search the customer text fields otherwise.
      const isUuid =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          raw,
        );
      if (isUuid) {
        sb = sb.eq('id', raw);
      } else {
        const sanitized = raw.replace(/[(),.:*%]/g, '').slice(0, 200);
        sb = sb.or(
          `shipping_address->>firstName.ilike.%${sanitized}%,shipping_address->>lastName.ilike.%${sanitized}%,shipping_address->>email.ilike.%${sanitized}%`,
        );
      }
    }

    const { data, error, count } = await sb
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error)
      throw new InternalServerErrorException('An internal error occurred');

    return {
      data: data || [],
      meta: {
        total: count || 0,
        page,
        limit,
        totalPages: Math.ceil((count || 0) / limit),
      },
    };
  }

  async getOrderDetail(orderId: string) {
    const { data, error } = await this.supabase
      .from('orders')
      .select('*, order_items(*), profiles(name, email)')
      .eq('id', orderId)
      .single();

    if (error || !data) throw new NotFoundException('Order not found');
    return data;
  }

  async updateOrderStatus(orderId: string, status: string) {
    if (!ORDER_STATUSES.includes(status as OrderStatus)) {
      throw new BadRequestException('Invalid order status');
    }

    const { data: current, error: findError } = await this.supabase
      .from('orders')
      .select('*')
      .eq('id', orderId)
      .single();

    if (findError || !current) throw new NotFoundException('Order not found');
    if (current.status === status) return current;

    // Fulfilment only moves forward, and only pending/confirmed orders can be
    // cancelled (their goods are still here, so the restock trigger is
    // correct). A cancelled order is never reactivated: its units were
    // already credited back. The DB trigger enforces the same rules.
    if (!canTransitionOrder(current.status, status as OrderStatus, 'admin')) {
      throw new BadRequestException(
        `An order cannot move from ${current.status} to ${status}.`,
      );
    }

    // Conditional on the status read above, so a concurrent change (e.g. the
    // customer cancelling) is reported instead of silently overwritten.
    const { data, error } = await this.supabase
      .from('orders')
      .update({ status })
      .eq('id', orderId)
      .eq('status', current.status)
      .select()
      .maybeSingle();

    if (error) {
      this.logger.error(
        `Order ${orderId} status update failed: ${error.message}`,
      );
      throw new InternalServerErrorException('An internal error occurred');
    }
    if (!data) throw new ConflictException(STALE_ORDER_MESSAGE);
    return data;
  }

  async deleteOrder(orderId: string) {
    const { data: order } = await this.supabase
      .from('orders')
      .select('id, status')
      .eq('id', orderId)
      .single();

    if (!order) throw new NotFoundException('Order not found');

    // The restock trigger only fires on a status change to 'cancelled', never
    // on DELETE. Deleting an order whose goods never left the warehouse
    // (pending / confirmed) would silently leak the stock it decremented, so
    // cancel it first to return inventory through the tested trigger path.
    // A shipped / delivered order's goods are already gone — deleting those
    // must NOT credit stock back; a cancelled order was already restocked.
    const RESTOCK_BEFORE_DELETE = ['pending', 'confirmed'];
    if (RESTOCK_BEFORE_DELETE.includes(order.status)) {
      const { error: cancelError } = await this.supabase
        .from('orders')
        .update({ status: 'cancelled' })
        .eq('id', orderId);

      if (cancelError) {
        this.logger.error(
          `Failed to restock order ${orderId} before delete: ${cancelError.message}`,
        );
        throw new InternalServerErrorException('An internal error occurred');
      }
    }

    const { error: orderError } = await this.supabase
      .from('orders')
      .delete()
      .eq('id', orderId);

    if (orderError)
      throw new InternalServerErrorException('An internal error occurred');

    return { message: 'Order deleted successfully' };
  }

  async updatePaymentStatus(
    orderId: string,
    paymentStatus: string,
    actorId: string,
  ) {
    if (!PAYMENT_STATUSES.includes(paymentStatus as PaymentStatus)) {
      throw new BadRequestException('Invalid payment status');
    }

    const { data: current, error: findError } = await this.supabase
      .from('orders')
      .select('*')
      .eq('id', orderId)
      .single();

    if (findError || !current) throw new NotFoundException('Order not found');
    if (current.payment_status === paymentStatus) return current;

    if (
      !canTransitionPayment(
        current.payment_status,
        paymentStatus as PaymentStatus,
        current.status,
      )
    ) {
      throw new BadRequestException(
        paymentStatus === 'paid'
          ? 'Cash can only be marked collected once the order has shipped or been delivered.'
          : `Payment cannot move from ${current.payment_status} to ${paymentStatus}.`,
      );
    }

    // For cash on delivery, "paid" means cash collected: record who and when.
    const update: Record<string, unknown> = { payment_status: paymentStatus };
    if (paymentStatus === 'paid') {
      update.paid_at = new Date().toISOString();
      update.paid_by = actorId;
    }

    const { data, error } = await this.supabase
      .from('orders')
      .update(update)
      .eq('id', orderId)
      .eq('payment_status', current.payment_status)
      .eq('status', current.status)
      .select()
      .maybeSingle();

    if (error) {
      this.logger.error(
        `Order ${orderId} payment update failed: ${error.message}`,
      );
      throw new InternalServerErrorException('An internal error occurred');
    }
    if (!data) throw new ConflictException(STALE_ORDER_MESSAGE);
    return data;
  }

  async findAllUsers(query: {
    page?: number;
    limit?: number;
    search?: string;
  }) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const offset = (page - 1) * limit;

    let sb = this.supabase
      .from('profiles')
      .select('id, name, email, role, created_at', { count: 'exact' });

    if (query.search) {
      const sanitized = query.search.replace(/[(),.]/g, '').slice(0, 200);
      sb = sb.or(`name.ilike.%${sanitized}%,email.ilike.%${sanitized}%`);
    }

    const { data, error, count } = await sb
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error)
      throw new InternalServerErrorException('An internal error occurred');
    return {
      data: data || [],
      meta: {
        total: count || 0,
        page,
        limit,
        totalPages: Math.ceil((count || 0) / limit),
      },
    };
  }

  async createUser(dto: {
    name: string;
    email: string;
    password: string;
    role: string;
  }) {
    const { data: existing } = await this.supabase
      .from('profiles')
      .select('id')
      .eq('email', dto.email)
      .maybeSingle();

    if (existing) {
      throw new BadRequestException('A user with this email already exists');
    }

    const { data: authData, error: createError } =
      await this.supabase.auth.admin.createUser({
        email: dto.email,
        password: dto.password,
        email_confirm: true,
      });

    if (createError) {
      this.logger.error(`Failed to create auth user: ${createError.message}`);
      throw new InternalServerErrorException('Failed to create user');
    }

    const userId = authData.user.id;

    const { data: profile, error: profileError } = await this.supabase
      .from('profiles')
      .insert({
        id: userId,
        email: dto.email,
        name: dto.name,
        role: dto.role,
      })
      .select('id, name, email, role, created_at')
      .single();

    if (profileError) {
      this.logger.error(`Failed to create profile: ${profileError.message}`);
      await this.supabase.auth.admin.deleteUser(userId);
      throw new InternalServerErrorException('Failed to create profile');
    }

    this.logger.log(`User created successfully: ${dto.email} (${dto.role})`);

    return profile;
  }

  /** Accounts that can still sign in to the admin panel. */
  private async countAdmins() {
    const { count, error } = await this.supabase
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'admin');
    if (error)
      throw new InternalServerErrorException('An internal error occurred');
    return count ?? 0;
  }

  private async findProfileRole(userId: string) {
    const { data } = await this.supabase
      .from('profiles')
      .select('id, role')
      .eq('id', userId)
      .single();
    if (!data) throw new NotFoundException('User not found');
    return data as { id: string; role: string };
  }

  async updateUserRole(userId: string, role: string, actorId: string) {
    if (!['customer', 'admin'].includes(role)) {
      throw new BadRequestException('Role must be customer or admin');
    }

    // Never lock everyone out of the admin panel. (Two admins demoting each
    // other at the same instant could still both succeed; acceptable for
    // a small team, revisit with an RPC if that changes.)
    if (role !== 'admin') {
      if (userId === actorId)
        throw new BadRequestException(
          'You cannot remove your own admin access. Ask another admin.',
        );
      const target = await this.findProfileRole(userId);
      if (target.role === 'admin' && (await this.countAdmins()) <= 1)
        throw new ConflictException('At least one admin must remain.');
    }

    const { data, error } = await this.supabase
      .from('profiles')
      .update({ role })
      .eq('id', userId)
      .select()
      .single();

    if (error)
      throw new InternalServerErrorException('An internal error occurred');
    if (!data) throw new NotFoundException('User not found');
    return data;
  }

  async deleteUser(userId: string, actorId: string) {
    if (userId === actorId)
      throw new BadRequestException('You cannot delete your own account.');

    const target = await this.findProfileRole(userId);
    if (target.role === 'admin' && (await this.countAdmins()) <= 1)
      throw new ConflictException('At least one admin must remain.');

    // orders.user_id cascades on delete (20260802), so deleting a customer
    // with orders would silently erase their order history.
    const { count: orderCount, error: orderError } = await this.supabase
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId);
    if (orderError)
      throw new InternalServerErrorException('An internal error occurred');
    if (orderCount)
      throw new ConflictException(
        `This account has ${orderCount} order${orderCount === 1 ? '' : 's'}; deleting it would erase that order history. Keep the account instead.`,
      );

    const { error: authError } =
      await this.supabase.auth.admin.deleteUser(userId);
    if (authError) throw new InternalServerErrorException(authError.message);

    const { error: profileError } = await this.supabase
      .from('profiles')
      .delete()
      .eq('id', userId);
    if (profileError) {
      throw new InternalServerErrorException('Failed to delete user profile');
    }

    return { message: 'User deleted successfully' };
  }

  async findAllStaff(query: {
    page?: number;
    limit?: number;
    search?: string;
    status?: 'active' | 'inactive' | 'on_leave';
    department?: string;
  }) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const offset = (page - 1) * limit;

    let sb = this.supabase
      .from('staff_members')
      .select('*', { count: 'exact' });

    if (query.search) {
      const sanitized = query.search.replace(/[(),.]/g, '').slice(0, 200);
      sb = sb.or(
        `name.ilike.%${sanitized}%,email.ilike.%${sanitized}%,job_title.ilike.%${sanitized}%,department.ilike.%${sanitized}%`,
      );
    }
    if (query.status) sb = sb.eq('status', query.status);
    if (query.department) sb = sb.eq('department', query.department);

    const { data, error, count } = await sb
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      this.logger.error(`Failed to list staff: ${error.message}`);
      throw new InternalServerErrorException('Failed to load staff');
    }

    return {
      data: data || [],
      meta: {
        total: count || 0,
        page,
        limit,
        totalPages: Math.ceil((count || 0) / limit),
      },
    };
  }

  async createStaff(dto: {
    name: string;
    email: string;
    phone?: string | null;
    job_title: string;
    department: string;
    status: 'active' | 'inactive' | 'on_leave';
    avatar_url?: string | null;
    joined_at: string;
  }) {
    const { data, error } = await this.supabase
      .from('staff_members')
      .insert(dto)
      .select()
      .single();

    if (error?.code === '23505') {
      throw new BadRequestException(
        'A staff member with this email already exists',
      );
    }
    if (error) {
      this.logger.error(`Failed to create staff member: ${error.message}`);
      throw new InternalServerErrorException('Failed to create staff member');
    }
    return data;
  }

  async updateStaff(
    id: string,
    updates: Partial<{
      name: string;
      email: string;
      phone: string | null;
      job_title: string;
      department: string;
      status: 'active' | 'inactive' | 'on_leave';
      avatar_url: string | null;
      joined_at: string;
    }>,
  ) {
    const { data, error } = await this.supabase
      .from('staff_members')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error?.code === '23505') {
      throw new BadRequestException(
        'A staff member with this email already exists',
      );
    }
    if (error?.code === 'PGRST116') {
      throw new NotFoundException('Staff member not found');
    }
    if (error) {
      this.logger.error(`Failed to update staff member: ${error.message}`);
      throw new InternalServerErrorException('Failed to update staff member');
    }
    if (!data) throw new NotFoundException('Staff member not found');
    return data;
  }

  async deleteStaff(id: string) {
    const { error, count } = await this.supabase
      .from('staff_members')
      .delete({ count: 'exact' })
      .eq('id', id);

    if (error) {
      this.logger.error(`Failed to delete staff member: ${error.message}`);
      throw new InternalServerErrorException('Failed to delete staff member');
    }
    if (count === 0) throw new NotFoundException('Staff member not found');
    return { message: 'Staff member deleted successfully' };
  }

  async findAllReviews(query: { page?: number; limit?: number }) {
    const page = query.page || 1;
    const limit = query.limit || 10;
    const offset = (page - 1) * limit;

    const { data, error, count } = await this.supabase
      .from('reviews')
      .select('*, profiles(name, avatar_url), products(name, slug)', {
        count: 'exact',
      })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error)
      throw new InternalServerErrorException('An internal error occurred');

    return {
      data: data || [],
      meta: {
        total: count || 0,
        page,
        limit,
        totalPages: Math.ceil((count || 0) / limit),
      },
    };
  }

  async deleteReview(reviewId: string) {
    const { data: review } = await this.supabase
      .from('reviews')
      .select('product_id')
      .eq('id', reviewId)
      .single();

    if (!review) throw new NotFoundException('Review not found');

    const { error } = await this.supabase
      .from('reviews')
      .delete()
      .eq('id', reviewId);

    if (error)
      throw new InternalServerErrorException('An internal error occurred');

    return { message: 'Review deleted successfully' };
  }

  async findAllContactMessages(query: { page?: number; limit?: number }) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const offset = (page - 1) * limit;

    const { data, error, count } = await this.supabase
      .from('contact_messages')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error)
      throw new InternalServerErrorException('An internal error occurred');

    return {
      data: data || [],
      meta: {
        total: count || 0,
        page,
        limit,
        totalPages: Math.ceil((count || 0) / limit),
      },
    };
  }

  async markContactMessageRead(id: string) {
    const { data, error } = await this.supabase
      .from('contact_messages')
      .update({ is_read: true })
      .eq('id', id)
      .select()
      .single();

    if (error)
      throw new InternalServerErrorException('An internal error occurred');
    if (!data) throw new NotFoundException('Message not found');
    return data;
  }

  async deleteContactMessage(id: string) {
    const { error } = await this.supabase
      .from('contact_messages')
      .delete()
      .eq('id', id);

    if (error)
      throw new InternalServerErrorException('An internal error occurred');
    return { message: 'Message deleted successfully' };
  }

  async findAllBugReports(query: { page?: number; limit?: number }) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const offset = (page - 1) * limit;

    const { data, error, count } = await this.supabase
      .from('bug_reports')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error)
      throw new InternalServerErrorException('An internal error occurred');

    return {
      data: data || [],
      meta: {
        total: count || 0,
        page,
        limit,
        totalPages: Math.ceil((count || 0) / limit),
      },
    };
  }

  async updateBugReport(
    id: string,
    body: { status?: string; priority?: string; admin_reply?: string },
  ) {
    const update: Record<string, unknown> = {};
    if (body.status) update.status = body.status;
    if (body.priority) update.priority = body.priority;
    if (body.admin_reply !== undefined) update.admin_reply = body.admin_reply;

    if (Object.keys(update).length === 0) {
      throw new BadRequestException('No fields to update');
    }

    const { data, error } = await this.supabase
      .from('bug_reports')
      .update(update)
      .eq('id', id)
      .select()
      .single();

    if (error)
      throw new InternalServerErrorException('An internal error occurred');
    if (!data) throw new NotFoundException('Bug report not found');
    return data;
  }
}

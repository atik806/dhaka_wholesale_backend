import {
  Injectable,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { createSupabaseAdminClient } from '../../config/supabase.config.js';

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
      { data: revenueAgg },
      { data: chartOrders },
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

    const revenueRow = Array.isArray(revenueAgg) ? revenueAgg[0] : revenueAgg;
    const rawSum =
      (revenueRow as { sum?: number; total?: number } | null | undefined)?.sum ??
      (revenueRow as { total?: number } | null | undefined)?.total;
    let totalRevenue = Number(rawSum);

    // Fallback if aggregate is unavailable/unsupported
    if (rawSum === undefined || rawSum === null || !Number.isFinite(totalRevenue)) {
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
      const sanitized = query.search.replace(/[(),.]/g, '').slice(0, 200);
      sb = sb.or(
        `id.ilike.%${sanitized}%,shipping_address->>firstName.ilike.%${sanitized}%,shipping_address->>lastName.ilike.%${sanitized}%,shipping_address->>email.ilike.%${sanitized}%`,
      );
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
    const validStatuses = [
      'pending',
      'confirmed',
      'shipped',
      'delivered',
      'cancelled',
    ];
    if (!validStatuses.includes(status)) {
      throw new BadRequestException('Invalid order status');
    }

    const { data, error } = await this.supabase
      .from('orders')
      .update({ status })
      .eq('id', orderId)
      .select()
      .single();

    if (error)
      throw new InternalServerErrorException('An internal error occurred');
    if (!data) throw new NotFoundException('Order not found');
    return data;
  }

  async deleteOrder(orderId: string) {
    const { data: order } = await this.supabase
      .from('orders')
      .select('id')
      .eq('id', orderId)
      .single();

    if (!order) throw new NotFoundException('Order not found');

    const { error: orderError } = await this.supabase
      .from('orders')
      .delete()
      .eq('id', orderId);

    if (orderError)
      throw new InternalServerErrorException('An internal error occurred');

    return { message: 'Order deleted successfully' };
  }

  async updatePaymentStatus(orderId: string, paymentStatus: string) {
    const validStatuses = ['pending', 'paid', 'failed', 'refunded'];
    if (!validStatuses.includes(paymentStatus)) {
      throw new BadRequestException('Invalid payment status');
    }

    const { data, error } = await this.supabase
      .from('orders')
      .update({ payment_status: paymentStatus })
      .eq('id', orderId)
      .select()
      .single();

    if (error)
      throw new InternalServerErrorException('An internal error occurred');
    if (!data) throw new NotFoundException('Order not found');
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

  async updateUserRole(userId: string, role: string) {
    if (!['customer', 'admin'].includes(role)) {
      throw new BadRequestException('Role must be customer or admin');
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

  async deleteUser(userId: string) {
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

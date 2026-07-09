import {
  Injectable,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { createSupabaseAdminClient } from '../../config/supabase.config.js';

@Injectable()
export class AdminService {
  private supabase = createSupabaseAdminClient();

  async getDashboardStats() {
    const [
      { count: totalProducts },
      { count: totalOrders },
      { count: totalUsers },
      { data: revenueData },
      { data: recentOrders },
      { data: lowStockProducts },
    ] = await Promise.all([
      this.supabase
        .from('products')
        .select('*', { count: 'exact', head: true }),
      this.supabase.from('orders').select('*', { count: 'exact', head: true }),
      this.supabase
        .from('profiles')
        .select('*', { count: 'exact', head: true }),
      this.supabase.from('orders').select('total').eq('payment_status', 'paid'),
      this.supabase
        .from('orders')
        .select('*, profiles(name, email)')
        .order('created_at', { ascending: false })
        .limit(5),
      this.supabase
        .from('products')
        .select('*')
        .in('stock', ['low-stock', 'out-of-stock'])
        .limit(5),
    ]);

    const totalRevenue =
      revenueData?.reduce((sum, o) => sum + (o.total || 0), 0) || 0;

    return {
      stats: {
        totalProducts: totalProducts || 0,
        totalOrders: totalOrders || 0,
        totalUsers: totalUsers || 0,
        totalRevenue,
      },
      recentOrders: recentOrders || [],
      lowStockProducts: lowStockProducts || [],
    };
  }

  async findAllOrders(query: {
    page?: number;
    limit?: number;
    status?: string;
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

    const { data, error, count } = await sb
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw new InternalServerErrorException(error.message);

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

    if (error) throw new InternalServerErrorException(error.message);
    if (!data) throw new NotFoundException('Order not found');
    return data;
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

    if (error) throw new InternalServerErrorException(error.message);
    if (!data) throw new NotFoundException('Order not found');
    return data;
  }

  async findAllUsers() {
    const { data, error } = await this.supabase
      .from('profiles')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw new InternalServerErrorException(error.message);
    return data || [];
  }

  async createUser(dto: { name: string; email: string; password: string; role: string }) {
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
      throw new InternalServerErrorException(
        'Failed to create user: ' + createError.message,
      );
    }

    const userId = authData.user!.id;

    const { error: profileError } = await this.supabase.from('profiles').insert({
      id: userId,
      email: dto.email,
      name: dto.name,
      role: dto.role,
    });

    if (profileError) {
      await this.supabase.auth.admin.deleteUser(userId);
      throw new InternalServerErrorException(
        'Failed to create profile: ' + profileError.message,
      );
    }

    return {
      id: userId,
      email: dto.email,
      name: dto.name,
      role: dto.role,
    };
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

    if (error) throw new InternalServerErrorException(error.message);
    if (!data) throw new NotFoundException('User not found');
    return data;
  }

  async deleteUser(userId: string) {
    const { error: authError } =
      await this.supabase.auth.admin.deleteUser(userId);
    if (authError) throw new InternalServerErrorException(authError.message);

    await this.supabase.from('profiles').delete().eq('id', userId);

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

    if (error) throw new InternalServerErrorException(error.message);

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

    if (error) throw new InternalServerErrorException(error.message);

    await this.updateProductRating(review.product_id);
    return { message: 'Review deleted successfully' };
  }

  private async updateProductRating(productId: string) {
    const { data: stats } = await this.supabase
      .from('reviews')
      .select('rating')
      .eq('product_id', productId);

    if (!stats || stats.length === 0) {
      await this.supabase
        .from('products')
        .update({ rating: 0, review_count: 0 })
        .eq('id', productId);
      return;
    }

    const avgRating =
      stats.reduce((sum, r) => sum + r.rating, 0) / stats.length;
    await this.supabase
      .from('products')
      .update({
        rating: Math.round(avgRating * 10) / 10,
        review_count: stats.length,
      })
      .eq('id', productId);
  }
}

import {
  Injectable,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import type { CreateOrderDto, CheckoutOrderDto } from './dto/create-order.dto.js';
import { createSupabaseAdminClient } from '../../config/supabase.config.js';

@Injectable()
export class OrdersService {
  private supabase = createSupabaseAdminClient();

  async findByUser(userId: string, page = 1, limit = 10) {
    const from = (page - 1) * limit;
    const { data, error, count } = await this.supabase
      .from('orders')
      .select('*, order_items(*)', { count: 'exact' })
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(from, from + limit - 1);

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

  async findById(id: string, userId: string) {
    const { data, error } = await this.supabase
      .from('orders')
      .select('*, order_items(*)')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (error || !data) throw new NotFoundException('Order not found');
    return data;
  }

  async create(userId: string, dto: CreateOrderDto) {
    const { data: cartItems, error: cartError } = await this.supabase
      .from('cart_items')
      .select('*, products(*)')
      .eq('user_id', userId);

    if (cartError) throw new InternalServerErrorException(cartError.message);
    if (!cartItems || cartItems.length === 0) {
      throw new BadRequestException('Cart is empty');
    }

    const subtotal = cartItems.reduce(
      (sum, item) => sum + ((item.products as any)?.price || 0) * item.quantity,
      0,
    );
    const shippingCost = subtotal >= 50 ? 0 : 5;
    const tax = subtotal * 0.08;
    const total = subtotal + shippingCost + tax;

    const { data: order, error: orderError } = await this.supabase
      .from('orders')
      .insert({
        user_id: userId,
        status: 'pending',
        subtotal: Math.round(subtotal * 100) / 100,
        shipping_cost: shippingCost,
        tax: Math.round(tax * 100) / 100,
        total: Math.round(total * 100) / 100,
        shipping_address: dto.shipping_address,
        payment_method: dto.payment_method,
        payment_status: 'pending',
      })
      .select()
      .single();

    if (orderError) throw new InternalServerErrorException(orderError.message);

    const orderItems = cartItems.map((item) => ({
      order_id: order.id,
      product_id: item.product_id,
      product_name: (item.products as any)?.name || '',
      product_image: (item.products as any)?.images?.[0] || null,
      price: (item.products as any)?.price || 0,
      quantity: item.quantity,
      selected_size: item.selected_size,
      selected_color: item.selected_color,
    }));

    const { error: itemsError } = await this.supabase
      .from('order_items')
      .insert(orderItems);
    if (itemsError) {
      await this.supabase.from('orders').delete().eq('id', order.id);
      throw new InternalServerErrorException('Failed to create order items');
    }

    await this.supabase.from('cart_items').delete().eq('user_id', userId);
    return this.findById(order.id, userId);
  }

  private async getAdminUserId(): Promise<string> {
    const { data } = await this.supabase
      .from('profiles')
      .select('id')
      .eq('role', 'admin')
      .limit(1)
      .single();
    if (!data) {
      const { data: fallback } = await this.supabase
        .from('profiles')
        .select('id')
        .limit(1)
        .single();
      if (!fallback) throw new InternalServerErrorException('No user profile found');
      return fallback.id;
    }
    return data.id;
  }

  async checkout(userId: string, dto: CheckoutOrderDto) {
    const subtotal = dto.items.reduce(
      (sum, item) => sum + item.price * item.quantity,
      0,
    );
    const shippingCost = subtotal >= 50 ? 0 : 5;
    const tax = subtotal * 0.08;
    const total = subtotal + shippingCost + tax;

    const { data: order, error: orderError } = await this.supabase
      .from('orders')
      .insert({
        user_id: userId,
        status: 'pending',
        subtotal: Math.round(subtotal * 100) / 100,
        shipping_cost: shippingCost,
        tax: Math.round(tax * 100) / 100,
        total: Math.round(total * 100) / 100,
        shipping_address: dto.shipping_address,
        payment_method: dto.payment_method,
        payment_status: 'pending',
      })
      .select()
      .single();

    if (orderError) throw new InternalServerErrorException(orderError.message);

    const orderItems = dto.items.map((item) => ({
      order_id: order.id,
      product_id: item.product_id,
      product_name: item.product_name,
      product_image: item.product_image || null,
      price: item.price,
      quantity: item.quantity,
      selected_size: item.selected_size || null,
      selected_color: item.selected_color || null,
    }));

    const { error: itemsError } = await this.supabase
      .from('order_items')
      .insert(orderItems);
    if (itemsError) {
      await this.supabase.from('orders').delete().eq('id', order.id);
      throw new InternalServerErrorException('Failed to create order items');
    }

    await this.supabase
      .from('profiles')
      .update({ shipping_address: dto.shipping_address })
      .eq('id', userId);

    return this.findById(order.id, userId);
  }

  async cancelOrder(orderId: string, userId: string) {
    const { data: order, error: findError } = await this.supabase
      .from('orders')
      .select('*')
      .eq('id', orderId)
      .eq('user_id', userId)
      .single();

    if (findError || !order) throw new NotFoundException('Order not found');
    if (order.status !== 'pending')
      throw new BadRequestException('Only pending orders can be cancelled');

    const { data, error } = await this.supabase
      .from('orders')
      .update({ status: 'cancelled' })
      .eq('id', orderId)
      .select()
      .single();

    if (error) throw new InternalServerErrorException(error.message);
    return data;
  }
}

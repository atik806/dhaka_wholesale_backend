import {
  Injectable,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import type {
  CreateOrderDto,
  CheckoutOrderDto,
} from './dto/create-order.dto.js';
import { createSupabaseAdminClient } from '../../config/supabase.config.js';
import {
  calculateShippingCost,
  calculateTax,
  roundMoney,
} from '../../common/utils/commerce.js';

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
      .select('*, products(id, name, price, images, stock_quantity, stock)')
      .eq('user_id', userId);

    if (cartError)
      throw new InternalServerErrorException('Failed to verify products');
    if (!cartItems || cartItems.length === 0) {
      throw new BadRequestException('Cart is empty');
    }

    this.assertCartStock(cartItems);

    const subtotal = cartItems.reduce(
      (sum, item) => sum + (item.products?.price || 0) * item.quantity,
      0,
    );
    const shippingCost = calculateShippingCost(dto.delivery_zone);
    const tax = calculateTax(subtotal);
    const total = subtotal + shippingCost + tax;

    const { data: order, error: orderError } = await this.supabase
      .from('orders')
      .insert({
        user_id: userId,
        status: 'pending',
        subtotal: roundMoney(subtotal),
        shipping_cost: shippingCost,
        tax: roundMoney(tax),
        total: roundMoney(total),
        shipping_address: dto.shipping_address,
        payment_method: dto.payment_method,
        delivery_zone: dto.delivery_zone,
        payment_status: 'pending',
      })
      .select()
      .single();

    if (orderError) throw new InternalServerErrorException(orderError.message);

    const orderItems = cartItems.map((item) => ({
      order_id: order.id,
      product_id: item.product_id,
      product_name: item.products?.name || '',
      product_image: item.products?.images?.[0] || null,
      price: item.products?.price || 0,
      quantity: item.quantity,
      selected_size: item.selected_size,
      selected_color: item.selected_color,
    }));

    const { error: itemsError } = await this.supabase
      .from('order_items')
      .insert(orderItems);
    if (itemsError) {
      await this.supabase.from('orders').delete().eq('id', order.id);
      throw new BadRequestException(
        itemsError.message.includes('Insufficient stock')
          ? 'Insufficient stock for one or more items'
          : 'Failed to create order items',
      );
    }

    await this.supabase.from('cart_items').delete().eq('user_id', userId);
    return this.findById(order.id, userId);
  }

  async checkout(userId: string, dto: CheckoutOrderDto) {
    const productIds = dto.items.map((i) => i.product_id);
    const { data: products, error: prodError } = await this.supabase
      .from('products')
      .select('id, name, price, images, stock_quantity, stock')
      .in('id', productIds);

    if (prodError)
      throw new InternalServerErrorException('Failed to verify products');
    if (!products || products.length !== new Set(productIds).size) {
      throw new BadRequestException('One or more products are invalid');
    }

    const productMap = new Map(products.map((p) => [p.id, p]));
    this.assertCheckoutStock(dto.items, productMap);

    const subtotal = dto.items.reduce((sum, item) => {
      const product = productMap.get(item.product_id)!;
      return sum + product.price * item.quantity;
    }, 0);
    const shippingCost = calculateShippingCost(dto.delivery_zone);
    const tax = calculateTax(subtotal);
    const total = subtotal + shippingCost + tax;

    const { data: order, error: orderError } = await this.supabase
      .from('orders')
      .insert({
        user_id: userId,
        status: 'pending',
        subtotal: roundMoney(subtotal),
        shipping_cost: shippingCost,
        tax: roundMoney(tax),
        total: roundMoney(total),
        shipping_address: dto.shipping_address,
        payment_method: dto.payment_method,
        delivery_zone: dto.delivery_zone,
        payment_status: 'pending',
      })
      .select()
      .single();

    if (orderError)
      throw new InternalServerErrorException('Failed to create order');

    const orderItems = dto.items.map((item) => {
      const product = productMap.get(item.product_id)!;
      return {
        order_id: order.id,
        product_id: item.product_id,
        product_name: product.name,
        product_image: product.images?.[0] || null,
        price: product.price,
        quantity: item.quantity,
        selected_size: item.selected_size || null,
        selected_color: item.selected_color || null,
      };
    });

    const { error: itemsError } = await this.supabase
      .from('order_items')
      .insert(orderItems);
    if (itemsError) {
      await this.supabase.from('orders').delete().eq('id', order.id);
      throw new BadRequestException(
        itemsError.message.includes('Insufficient stock')
          ? 'Insufficient stock for one or more items'
          : 'Failed to create order items',
      );
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

    // Restock is handled by DB trigger restock_on_cancel
    const { data, error } = await this.supabase
      .from('orders')
      .update({ status: 'cancelled' })
      .eq('id', orderId)
      .select()
      .single();

    if (error)
      throw new InternalServerErrorException('An internal error occurred');
    return data;
  }

  private assertCartStock(
    cartItems: Array<{
      quantity: number;
      products?: {
        id?: string;
        name?: string;
        stock_quantity?: number | null;
        stock?: string;
      } | null;
    }>,
  ) {
    for (const item of cartItems) {
      const stockQty = item.products?.stock_quantity ?? 0;
      const name = item.products?.name || 'Product';
      if (stockQty < item.quantity) {
        throw new BadRequestException(
          `Insufficient stock for "${name}". Available: ${stockQty}, requested: ${item.quantity}`,
        );
      }
    }
  }

  private assertCheckoutStock(
    items: Array<{ product_id: string; quantity: number }>,
    productMap: Map<
      string,
      { id: string; name: string; stock_quantity: number | null }
    >,
  ) {
    const qtyByProduct = new Map<string, number>();
    for (const item of items) {
      qtyByProduct.set(
        item.product_id,
        (qtyByProduct.get(item.product_id) || 0) + item.quantity,
      );
    }

    for (const [productId, requested] of qtyByProduct) {
      const product = productMap.get(productId)!;
      const stockQty = product.stock_quantity ?? 0;
      if (stockQty < requested) {
        throw new BadRequestException(
          `Insufficient stock for "${product.name}". Available: ${stockQty}, requested: ${requested}`,
        );
      }
    }
  }
}

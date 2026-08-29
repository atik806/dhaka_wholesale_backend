import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  Logger,
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
  private readonly logger = new Logger(OrdersService.name);
  private supabase = createSupabaseAdminClient();

  /**
   * The decrement_stock trigger fails the order_items insert with a
   * check_violation when a concurrent request already took the last
   * unit. That's a stock race, not a malformed request.
   */
  private isOversellError(message?: string) {
    return (
      !!message &&
      (message.includes('Insufficient stock') ||
        message.includes('check_violation'))
    );
  }

  /**
   * Clean up a half-created order when its items fail to insert.
   * Best effort: if the cleanup itself fails there is nothing more we
   * can do here; a stale 'pending' order is safer than losing the user
   * an order that actually went through.
   */
  private async cleanupOrder(orderId: string) {
    try {
      await this.supabase.from('orders').delete().eq('id', orderId);
    } catch {
      // ignored — see method comment
    }
  }

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

    if (orderError)
      throw new InternalServerErrorException('Failed to create order');

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
      await this.cleanupOrder(order.id);
      if (this.isOversellError(itemsError.message)) {
        throw new ConflictException('Insufficient stock for one or more items');
      }
      throw new BadRequestException('Failed to create order items');
    }

    // Only empty the cart once the order and its items are durable.
    const { error: cartDeleteError } = await this.supabase
      .from('cart_items')
      .delete()
      .eq('user_id', userId);
    if (cartDeleteError) {
      // The order is placed; a leftover cart must never be reported as
      // a failed purchase. Best effort cleanup of the duplicate so the
      // user isn't charged conceptually twice.
      await this.cleanupOrder(order.id);
      throw new InternalServerErrorException(
        'Order created but cart could not be cleared. Please check your orders.',
      );
    }

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
      await this.cleanupOrder(order.id);
      if (this.isOversellError(itemsError.message)) {
        throw new ConflictException('Insufficient stock for one or more items');
      }
      throw new BadRequestException('Failed to create order items');
    }

    await this.supabase
      .from('profiles')
      .update({ shipping_address: dto.shipping_address })
      .eq('id', userId);

    // Empty the server cart now that the order is durable. Best effort: the
    // order already succeeded and the client clears its cart too, so a failure
    // here must never surface as a failed purchase.
    const { error: cartClearError } = await this.supabase
      .from('cart_items')
      .delete()
      .eq('user_id', userId);
    if (cartClearError) {
      this.logger.warn(
        `Order ${order.id} placed but cart clear failed: ${cartClearError.message}`,
      );
    }

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

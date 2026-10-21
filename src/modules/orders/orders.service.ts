import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type {
  CreateOrderDto,
  CheckoutOrderDto,
} from './dto/create-order.dto.js';
import { createSupabaseAdminClient } from '../../config/supabase.config.js';
import { OffersService } from '../offers/offers.service.js';
import { PromotionsService } from '../offers/promotions.service.js';
import {
  availableStock,
  calculateShippingCost,
  calculateTax,
  roundMoney,
} from '../../common/utils/commerce.js';

type PromotionResult = Awaited<ReturnType<PromotionsService['apply']>>;

type OrderItemSnapshot = {
  product_id: string;
  product_name: string;
  product_image: string | null;
  price: number;
  original_price: number;
  quantity: number;
  selected_size: string | null;
  selected_color: string | null;
};

type PlaceOrderInput = {
  userId: string;
  dto: Pick<
    CreateOrderDto,
    | 'idempotency_key'
    | 'expected_total'
    | 'coupon_code'
    | 'shipping_address'
    | 'payment_method'
    | 'delivery_zone'
  >;
  promotion: PromotionResult;
  items: OrderItemSnapshot[];
};

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);
  private supabase = createSupabaseAdminClient();
  constructor(
    private readonly offers: OffersService,
    private readonly promotions: PromotionsService,
  ) {}

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
   * Fingerprint of what the customer asked for. A retried request with the
   * same idempotency key must match it; expected_total is excluded because
   * it is a client-side guard, not part of the order.
   */
  private requestHash(input: PlaceOrderInput) {
    const { dto, items } = input;
    return createHash('sha256')
      .update(
        JSON.stringify({
          coupon_code: dto.coupon_code ?? null,
          shipping_address: dto.shipping_address,
          payment_method: dto.payment_method,
          delivery_zone: dto.delivery_zone,
          items: items.map((item) => [
            item.product_id,
            item.quantity,
            item.selected_size,
            item.selected_color,
          ]),
        }),
      )
      .digest('hex');
  }

  /**
   * Price check, then one place_order() transaction: the order header and
   * its items (whose insert decrements stock) commit or roll back together,
   * and a repeated idempotency key replays the original order.
   */
  private async placeOrder(input: PlaceOrderInput) {
    const { userId, dto, promotion, items } = input;
    const subtotal = promotion.subtotal;
    const shippingCost = calculateShippingCost(dto.delivery_zone);
    const tax = calculateTax(subtotal);
    const total = subtotal + shippingCost + tax;

    if (
      dto.expected_total !== undefined &&
      Math.abs(roundMoney(total) - dto.expected_total) > 0.005
    ) {
      throw new ConflictException(
        'Checkout totals changed. Review the updated total and place your order again.',
      );
    }

    const { data, error } = await this.supabase.rpc('place_order', {
      p_user_id: userId,
      p_idempotency_key: dto.idempotency_key ?? null,
      p_request_hash: this.requestHash(input),
      p_order: {
        subtotal: roundMoney(subtotal),
        shipping_cost: shippingCost,
        tax: roundMoney(tax),
        total: roundMoney(total),
        shipping_address: dto.shipping_address,
        payment_method: dto.payment_method,
        delivery_zone: dto.delivery_zone,
        original_subtotal: roundMoney(promotion.original_subtotal),
        combo_discount: roundMoney(promotion.combo_discount),
        coupon_discount: roundMoney(promotion.coupon_discount),
        discount_total: roundMoney(promotion.discount_total),
        coupon_code: promotion.coupon_code,
        applied_combos: promotion.applied_combos,
      },
      p_items: items,
    });

    if (error) {
      if (error.message?.includes('idempotency_key_reused')) {
        throw new ConflictException(
          'This checkout was already submitted with different details. Refresh the page and try again.',
        );
      }
      if (this.isOversellError(error.message)) {
        throw new ConflictException('Insufficient stock for one or more items');
      }
      this.logger.error(`place_order failed: ${error.message}`);
      throw new InternalServerErrorException('Failed to create order');
    }

    const result = data as { order_id: string; replayed: boolean };
    return { orderId: result.order_id, replayed: result.replayed };
  }

  /**
   * Empty the server cart once the order is committed. Best effort: the
   * order already succeeded, so a failure here is logged, never surfaced
   * as a failed purchase and never undoes the order.
   */
  private async clearCart(userId: string, orderId: string) {
    const { error } = await this.supabase
      .from('cart_items')
      .delete()
      .eq('user_id', userId);
    if (error) {
      this.logger.warn(
        `Order ${orderId} placed but cart clear failed: ${error.message}`,
      );
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

    const prices = await this.offers.prices();
    for (const item of cartItems) {
      if (item.products)
        item.products.price = Math.min(
          item.products.price,
          prices.get(item.products.id) ?? item.products.price,
        );
    }
    this.assertCartStock(cartItems);

    const promotion = await this.promotions.apply(
      cartItems.map((item) => ({
        product_id: item.product_id,
        price: item.products?.price || 0,
        quantity: item.quantity,
      })),
      dto.coupon_code,
    );

    const { orderId, replayed } = await this.placeOrder({
      userId,
      dto,
      promotion,
      items: promotion.priced_lines.map((priced) => {
        const item = cartItems[priced.line_index];
        return {
          product_id: item.product_id,
          product_name: item.products?.name || '',
          product_image: item.products?.images?.[0] || null,
          price: priced.price,
          original_price: item.products?.price || 0,
          quantity: priced.quantity,
          selected_size: item.selected_size ?? null,
          selected_color: item.selected_color ?? null,
        };
      }),
    });

    if (!replayed) await this.clearCart(userId, orderId);
    return this.findById(orderId, userId);
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

    const pricedProducts = await this.offers.priceProducts(products);
    const productMap = new Map(pricedProducts.map((p) => [p.id, p]));
    this.assertCheckoutStock(dto.items, productMap);

    const promotion = await this.promotions.apply(
      dto.items.map((item) => ({
        product_id: item.product_id,
        price: productMap.get(item.product_id)!.price,
        quantity: item.quantity,
      })),
      dto.coupon_code,
    );

    const { orderId, replayed } = await this.placeOrder({
      userId,
      dto,
      promotion,
      items: promotion.priced_lines.map((priced) => {
        const item = dto.items[priced.line_index];
        const product = productMap.get(item.product_id)!;
        return {
          product_id: item.product_id,
          product_name: product.name,
          product_image: product.images?.[0] || null,
          price: priced.price,
          original_price: product.price,
          quantity: priced.quantity,
          selected_size: item.selected_size || null,
          selected_color: item.selected_color || null,
        };
      }),
    });

    if (!replayed) {
      await this.supabase
        .from('profiles')
        .update({ shipping_address: dto.shipping_address })
        .eq('id', userId);
      // The client clears its own cart too; the server copy is best effort.
      await this.clearCart(userId, orderId);
    }

    return this.findById(orderId, userId);
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
      const stockQty = availableStock(
        item.products?.stock_quantity,
        item.products?.stock,
      );
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
      {
        id: string;
        name: string;
        stock_quantity: number | null;
        stock?: string;
      }
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
      const stockQty = availableStock(product.stock_quantity, product.stock);
      if (stockQty < requested) {
        throw new BadRequestException(
          `Insufficient stock for "${product.name}". Available: ${stockQty}, requested: ${requested}`,
        );
      }
    }
  }
}

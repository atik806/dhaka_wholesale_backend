import {
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  canTransitionOrder,
  canTransitionPayment,
  type OrderStatus,
  type PaymentStatus,
} from './order-state.js';

const ADMIN_ALLOWED: Record<OrderStatus, OrderStatus[]> = {
  pending: ['confirmed', 'shipped', 'delivered', 'cancelled'],
  confirmed: ['shipped', 'delivered', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: [],
};

describe('order status transitions', () => {
  const pairs = ORDER_STATUSES.flatMap((from) =>
    ORDER_STATUSES.map((to) => [from, to] as const),
  );

  it.each(pairs)('admin %s -> %s', (from, to) => {
    expect(canTransitionOrder(from, to, 'admin')).toBe(
      ADMIN_ALLOWED[from].includes(to),
    );
  });

  it.each(pairs)('customer %s -> %s', (from, to) => {
    expect(canTransitionOrder(from, to, 'customer')).toBe(
      from === 'pending' && to === 'cancelled',
    );
  });

  it('never cancels goods that have left the warehouse', () => {
    for (const from of ['shipped', 'delivered'] as const) {
      expect(canTransitionOrder(from, 'cancelled', 'admin')).toBe(false);
    }
  });
});

describe('payment status transitions', () => {
  const PAYMENT_ALLOWED: Record<PaymentStatus, PaymentStatus[]> = {
    pending: ['paid', 'failed'],
    failed: ['pending', 'paid'],
    paid: ['refunded'],
    refunded: [],
  };
  const cases = ORDER_STATUSES.flatMap((orderStatus) =>
    PAYMENT_STATUSES.flatMap((from) =>
      PAYMENT_STATUSES.map((to) => [from, to, orderStatus] as const),
    ),
  );

  it.each(cases)('%s -> %s while the order is %s', (from, to, orderStatus) => {
    const collectable =
      orderStatus === 'shipped' || orderStatus === 'delivered';
    const expected =
      PAYMENT_ALLOWED[from].includes(to) && (to !== 'paid' || collectable);
    expect(canTransitionPayment(from, to, orderStatus)).toBe(expected);
  });
});

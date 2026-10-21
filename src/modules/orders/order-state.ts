/**
 * Order and payment state machine. The same rules are enforced in the
 * database by the enforce_order_transitions trigger (migration
 * 20261021130000); keep both in sync.
 */
export const ORDER_STATUSES = [
  'pending',
  'confirmed',
  'shipped',
  'delivered',
  'cancelled',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const PAYMENT_STATUSES = [
  'pending',
  'paid',
  'failed',
  'refunded',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export type OrderActor = 'admin' | 'customer';

// Fulfilment only moves forward; steps may be skipped (e.g. a COD order
// confirmed by phone and shipped the same day).
const FLOW: OrderStatus[] = ['pending', 'confirmed', 'shipped', 'delivered'];

// Goods have not left the warehouse, so cancelling can safely restock.
const CANCELLABLE: OrderStatus[] = ['pending', 'confirmed'];

export function canTransitionOrder(
  from: OrderStatus,
  to: OrderStatus,
  actor: OrderActor,
): boolean {
  if (from === to) return false;
  if (actor === 'customer') return from === 'pending' && to === 'cancelled';
  if (to === 'cancelled') return CANCELLABLE.includes(from);
  const fromIndex = FLOW.indexOf(from);
  const toIndex = FLOW.indexOf(to);
  return fromIndex >= 0 && toIndex > fromIndex;
}

const PAYMENT_FLOW: Record<PaymentStatus, PaymentStatus[]> = {
  pending: ['paid', 'failed'],
  failed: ['pending', 'paid'],
  paid: ['refunded'],
  refunded: [],
};

/**
 * For cash on delivery, "paid" means the cash was collected, which can only
 * happen once the order has been shipped or delivered.
 */
export function canTransitionPayment(
  from: PaymentStatus,
  to: PaymentStatus,
  orderStatus: OrderStatus,
): boolean {
  if (!PAYMENT_FLOW[from].includes(to)) return false;
  if (to === 'paid')
    return orderStatus === 'shipped' || orderStatus === 'delivered';
  return true;
}

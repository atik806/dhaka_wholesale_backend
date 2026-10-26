import { z } from 'zod';
import { GROUPS } from './permissions.js';
const uuid = z.string().uuid();
const version = z.number().int().min(0);
const money = z.number().min(0).max(100_000_000).multipleOf(0.01);
const text = z.string().trim().min(1).max(2000);
const optionalId = uuid.nullable().optional();
const webUrl = z
  .string()
  .url()
  .max(2000)
  .refine((value) => /^https?:\/\//i.test(value), 'Use an http or https URL');
export const ListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  status: z.string().max(40).optional(),
  search: z.string().trim().max(120).optional(),
  assigned_to: uuid.optional(),
  order_id: uuid.optional(),
  product_id: uuid.optional(),
  entity_type: z.string().max(50).optional(),
  entity_id: uuid.optional(),
  actor_id: uuid.optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});
export type ListQuery = z.infer<typeof ListSchema>;
export const ReviewSchema = z
  .object({
    version,
    status: z.enum(['awaiting', 'in_progress', 'approved', 'rejected']),
    assigned_to: optionalId,
    phone_confirmed: z.boolean(),
    address_checked: z.boolean(),
    stock_checked: z.boolean(),
    contact_attempts: z.number().int().min(0).max(1000),
    reason: z.string().trim().max(2000).default(''),
  })
  .strict();
export const NoteSchema = z.object({ text }).strict();
export const ShipmentSchema = z
  .object({
    version,
    courier: z.string().trim().min(1).max(100),
    tracking_number: z.string().trim().min(1).max(200),
    tracking_url: z
      .union([webUrl, z.literal('')])
      .nullable()
      .optional(),
    status: z.enum([
      'preparing',
      'dispatched',
      'in_transit',
      'delivered',
      'delivery_failed',
      'returning',
      'returned',
    ]),
    expected_delivery: z.iso.date().nullable().optional(),
    reason: z.string().trim().max(2000).default(''),
    actual_cost: money.nullable().optional(),
  })
  .strict();
export const VariantSchema = z
  .object({
    sku: z.string().trim().min(1).max(100),
    size: z.string().max(100).default(''),
    color: z.string().max(100).default(''),
    stock_quantity: z.number().int().min(0).max(1_000_000),
    low_stock_threshold: z.number().int().min(0).max(1_000_000),
    unit_cost: money.nullable(),
  })
  .strict();
export const ConfigureSchema = z
  .object({ variants: z.array(VariantSchema).min(1).max(200) })
  .strict();
export const AdjustSchema = z
  .object({
    variant_id: optionalId,
    expected_quantity: z.number().int().min(0),
    expected_version: z.number().int().min(1),
    delta: z.number().int().min(-1_000_000).max(1_000_000),
    reason: text,
    request_key: uuid,
    low_stock_threshold: z.number().int().min(0).max(1_000_000),
    unit_cost: money.nullable(),
  })
  .strict();
export const ReturnCreateSchema = z
  .object({
    order_item_id: uuid,
    quantity: z.number().int().min(1).max(999),
    kind: z.enum(['refund', 'exchange']),
    reason: text,
    photos: z.array(webUrl).max(5).default([]),
    override_window: z.boolean().default(false),
  })
  .strict();
export const ReturnUpdateSchema = z
  .object({
    version,
    status: z.enum([
      'under_review',
      'approved',
      'rejected',
      'received',
      'inspected',
      'resolved',
    ]),
    decision_reason: z.string().trim().max(2000).default(''),
    restock_quantity: z.number().int().min(0).max(999).optional(),
    replacement_order_id: optionalId,
  })
  .strict();
export const RefundApproveSchema = z
  .object({ amount: money.positive() })
  .strict();
export const RefundCompleteSchema = z
  .object({
    method: z.enum(['cash', 'bank', 'bkash', 'nagad']),
    reference: z.string().trim().min(3).max(200),
  })
  .strict();
export const AccessSchema = z
  .object({
    version,
    staff_id: optionalId,
    enabled: z.boolean(),
    groups: z
      .array(z.enum(GROUPS))
      .max(5)
      .refine((g) => new Set(g).size === g.length, 'Duplicate groups'),
  })
  .strict()
  .refine(
    (a) => !a.enabled || a.groups.length > 0,
    'Select at least one group for enabled access',
  );
export const SettingsSchema = z
  .object({
    review_after_hours: z.number().int().min(1).max(720),
    return_window_days: z.number().int().min(1).max(365),
  })
  .strict();
export const ReportSchema = z
  .object({
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
    product_id: uuid.optional(),
    category_id: uuid.optional(),
    courier: z.string().trim().max(100).optional(),
  })
  .refine(
    (q) =>
      Date.parse(q.to) > Date.parse(q.from) &&
      Date.parse(q.to) - Date.parse(q.from) <= 366 * 86400000,
    'Choose a report period of 1–366 days',
  );

export const CancelSchema = z
  .object({ expected_status: z.enum(['pending', 'confirmed']), reason: text })
  .strict();

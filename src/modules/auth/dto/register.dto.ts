import { z } from 'zod';
import { isGuestEmail } from '../../orders/guest-customer.js';

export const RegisterSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').max(100),
  email: z
    .string()
    .email('Invalid email address')
    .refine((email) => !isGuestEmail(email), 'Invalid email address'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(100)
    .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
    .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
    .regex(/[0-9]/, 'Password must contain at least one number')
    .regex(
      /[^A-Za-z0-9]/,
      'Password must contain at least one special character',
    ),
});

export type RegisterDto = z.infer<typeof RegisterSchema>;

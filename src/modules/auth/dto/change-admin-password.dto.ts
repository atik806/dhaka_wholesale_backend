import { z } from 'zod';

const StrongPasswordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(100, 'Password must be at most 100 characters')
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
  .regex(/[0-9]/, 'Password must contain at least one number')
  .regex(
    /[^A-Za-z0-9]/,
    'Password must contain at least one special character',
  );

export const ChangeAdminPasswordSchema = z
  .object({
    current_password: z
      .string()
      .min(1, 'Current password is required')
      .max(100),
    new_password: StrongPasswordSchema,
  })
  .refine((value) => value.current_password !== value.new_password, {
    path: ['new_password'],
    message: 'New password must be different from the current password',
  });

export type ChangeAdminPasswordDto = z.infer<typeof ChangeAdminPasswordSchema>;
